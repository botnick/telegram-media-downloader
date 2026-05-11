/**
 * Seekbar subsystem — public surface.
 *
 * Generates a WebP sprite sheet + JSON sidecar for each video so the
 * player's seekbar can paint a hover-preview thumbnail. Modelled after
 * the AI face-clustering subsystem: opt-in master toggle, a per-video
 * pregenerate hook that the downloader calls after a successful insert,
 * and a JobTracker-driven backfill scan.
 *
 *   import {
 *     pregenerateSeekbar,
 *     buildAllSeekbar,
 *     purgeAllSeekbar,
 *     purgeSeekbarForDownload,
 *     getSeekbarCacheStats,
 *     getSpritePath,
 *     getMetaForDownload,
 *   } from './core/seekbar/index.js';
 */

import { existsSync } from 'fs';
import fs from 'fs/promises';

import {
    countSeekbarSprites,
    deleteSeekbarSprite,
    getSeekbarSprite,
    sumSeekbarBytes,
} from '../db.js';
import {
    generateForDownload,
    getMetaFilePath,
    getSeekbarConfig,
    getSpritePath,
} from './generator.js';
import { buildAllSeekbar, purgeAllSeekbar } from './scan-runner.js';

export {
    buildAllSeekbar,
    generateForDownload,
    getMetaFilePath,
    getSeekbarConfig,
    getSpritePath,
    purgeAllSeekbar,
};

// ---- Background pregenerate ----------------------------------------------
//
// Two queues — same shape as `src/core/ai/index.js`. Realtime downloads
// jump ahead of history backfill so a live ingest stays responsive
// during a bulk import. Each queue caps at 200; over-cap entries drop
// silently (the next manual "Scan now" reconciles).

const _bgQueueRealtime = [];
const _bgQueueBackfill = [];
let _bgRunning = false;
const _BG_QUEUE_CAP = 200;

/**
 * Post-download hook. Best-effort, fire-and-forget — failure to
 * pregenerate just means the row gets picked up by the next manual
 * scan. Honours `cfg.advanced.seekbar.{enabled, autoOnDownload}` inside
 * the drain loop, so flipping the master toggle off stops new sprite
 * generation immediately (queued entries are dropped on the floor).
 *
 * `opts.priority`: 'realtime' jumps ahead of history backfill.
 */
export function pregenerateSeekbar(downloadId, opts = {}) {
    const priority = opts?.priority === 'realtime' ? 'realtime' : 'backfill';
    queueMicrotask(() => {
        const queue = priority === 'realtime' ? _bgQueueRealtime : _bgQueueBackfill;
        if (queue.length >= _BG_QUEUE_CAP) return;
        queue.push(downloadId);
        _drainBg();
    });
}

function _nextQueuedId() {
    if (_bgQueueRealtime.length) return _bgQueueRealtime.shift();
    if (_bgQueueBackfill.length) return _bgQueueBackfill.shift();
    return undefined;
}

function _allQueuesEmpty() {
    return _bgQueueRealtime.length === 0 && _bgQueueBackfill.length === 0;
}

async function _drainBg() {
    if (_bgRunning) return;
    _bgRunning = true;
    try {
        const { getDb } = await import('../db.js');
        const db = getDb();
        const lookupRow = db.prepare('SELECT id, file_path, file_type FROM downloads WHERE id = ?');
        while (!_allQueuesEmpty()) {
            const cfg = getSeekbarConfig();
            if (cfg.enabled !== true || cfg.autoOnDownload !== true) {
                _bgQueueRealtime.length = 0;
                _bgQueueBackfill.length = 0;
                break;
            }
            const id = _nextQueuedId();
            if (id === undefined) break;
            const row = lookupRow.get(Number(id));
            if (!row) continue;
            if (row.file_type !== 'video') continue;
            try {
                const meta = await generateForDownload(row, cfg, { overwrite: 'if-changed' });
                // Broadcast on each successful generation so the viewer's
                // WS subscription (`seekbar_sprite_ready` in viewer.js)
                // can refresh its hover tile mid-watch — important when
                // a fresh download is opened in the player while the
                // post-download pregenerate is still in flight. Skipped
                // when no meta is returned ('never' / 'if-changed' hit a
                // cached row); the viewer's existing tile is already
                // current in that case.
                if (meta) {
                    try {
                        const fn = globalThis.__tgdlBroadcast;
                        if (typeof fn === 'function') {
                            fn({ type: 'seekbar_sprite_ready', download_id: Number(id) });
                        }
                    } catch {
                        /* never crash the pregenerate drain on a broadcast error */
                    }
                }
            } catch (e) {
                console.warn(
                    '[seekbar-pregenerate] failed for download',
                    id,
                    String(e?.message || e),
                );
            }
            // Yield so realtime downloads aren't blocked behind a long
            // backfill of pregenerate work.
            await new Promise((r) => setImmediate(r));
        }
    } finally {
        _bgRunning = false;
    }
}

// ---- Per-row purge --------------------------------------------------------

export async function purgeSeekbarForDownload(downloadId) {
    const id = Number(downloadId);
    if (!Number.isInteger(id) || id <= 0) return 0;
    const row = getSeekbarSprite(id);
    if (!row) return 0;
    for (const p of [row.sprite_path, row.meta_path]) {
        if (!p) continue;
        try {
            if (existsSync(p)) await fs.unlink(p);
        } catch {
            /* best-effort */
        }
    }
    return deleteSeekbarSprite(id);
}

// ---- Cache stats ----------------------------------------------------------

export function getSeekbarCacheStats() {
    return {
        count: countSeekbarSprites(),
        bytes: sumSeekbarBytes(),
    };
}

/**
 * Resolve the on-disk metadata file path for a downloads.id and return
 * the parsed JSON (or null if missing). Used by `GET /api/seekbar/meta/:id`
 * to serve the sidecar with one read.
 */
export async function getMetaForDownload(downloadId) {
    const id = Number(downloadId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = getSeekbarSprite(id);
    if (!row) return null;
    if (!existsSync(row.meta_path)) return null;
    try {
        return JSON.parse(await fs.readFile(row.meta_path, 'utf8'));
    } catch {
        return null;
    }
}

/** For tests — clear the in-process queues + state. */
export function _resetForTests() {
    _bgQueueRealtime.length = 0;
    _bgQueueBackfill.length = 0;
    _bgRunning = false;
}
