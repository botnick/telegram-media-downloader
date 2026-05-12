/**
 * AI subsystem — public surface (faces-only build).
 *
 * Search + Auto-tag were removed in this release; this module now exposes
 * face detection / clustering only. The downloader still calls
 * `pregenerateAi()` after each successful download — when face clustering
 * is on, the per-row detection runs in the background and writes the
 * face embeddings into the `faces` table for later cluster sweeps.
 *
 * Callers outside this directory import from here:
 *   import {
 *     pregenerateAi,
 *     startFacesScan,
 *     cancelScan, getScanState, isScanRunning,
 *     detectFaces, clusterFaces, dbscan, euclidean, centroid,
 *     FACE_DEFAULTS,
 *   } from './core/ai/index.js';
 */

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { deleteFacesForDownload, getDb, insertFace, setAiIndexedAt } from '../db.js';
import { detectFaces } from './faces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Float32Array → Buffer. Used to be in vector-store.js (deleted); kept
// inline because the only remaining caller is the face pre-generate hook.
function _f32ToBlob(f) {
    return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

// better-sqlite3 throws "This database connection is busy executing a
// query" when a write hits the same connection while a `.iterate()`
// from another caller (cluster sweep / dedup / integrity walk) is open.
// Mirrors the retry shape used in `kvSet` — async-friendly here so the
// drain loop's await stays well-behaved.
async function _runWithBusyRetry(fn, { retries = 4, backoffMs = 50 } = {}) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return fn();
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                e?.code === 'SQLITE_BUSY';
            if (!busy || attempt === retries - 1) throw e;
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }
}

// Re-exports — keep the import surface flat for callers outside this dir.
export {
    centroid,
    clusterFaces,
    dbscan,
    detectFaces,
    euclidean,
    FACE_DEFAULTS,
} from './faces.js';
export {
    cancelScan,
    getScanState,
    isScanRunning,
    startFacesScan,
} from './scan-runner.js';

// ---- Background pre-generate ---------------------------------------------
//
// Two queues — realtime downloads jump ahead of history backfill so a
// fresh ingest stays responsive during a bulk import. Each queue is
// capped at 200; when full, new entries drop silently (a manual scan
// reconciles). The drain alternates: realtime first, then one backfill,
// then realtime — so backfill never starves entirely but never blocks
// live work either.

const _bgQueueRealtime = [];
const _bgQueueBackfill = [];
let _bgRunning = false;
const _BG_QUEUE_CAP = 200;

/**
 * Hook called by `src/core/downloader.js` after each successful download.
 * Best-effort, fire-and-forget — failure to pregenerate just means the
 * row gets picked up by the next manual scan.
 *
 * `opts.priority`: 'realtime' jumps ahead of history backfill. Default
 * 'backfill'. The downloader passes 'realtime' for live monitor jobs;
 * the bulk history backfill leaves it default.
 */
export function pregenerateAi(downloadId, opts = {}) {
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
        const { loadConfig } = await import('../../config/manager.js');
        let cfg;
        try {
            const live = loadConfig();
            cfg = live?.advanced?.ai || {};
            if (cfg.enabled !== true) {
                _bgQueueRealtime.length = 0;
                _bgQueueBackfill.length = 0;
                return;
            }
        } catch {
            _bgQueueRealtime.length = 0;
            _bgQueueBackfill.length = 0;
            return;
        }

        const db = getDb();
        const lookupRow = db.prepare(`
            SELECT id, file_path, file_type, ai_indexed_at
              FROM downloads
             WHERE id = ?
        `);
        const fileTypeOk = new Set(
            (cfg.fileTypes || ['photo']).map((s) => String(s).toLowerCase()),
        );

        while (!_allQueuesEmpty()) {
            const id = _nextQueuedId();
            if (id === undefined) break;
            const row = lookupRow.get(Number(id));
            if (!row) continue;
            if (row.ai_indexed_at != null) continue;
            if (!fileTypeOk.has(String(row.file_type || '').toLowerCase())) continue;

            const abs = _resolveAbs(row.file_path);
            if (!abs) {
                setAiIndexedAt(row.id);
                continue;
            }

            // Per-row face detection. Clustering is a separate batch pass
            // (kicked off via the AI maintenance page), so here we only
            // populate the faces table with embeddings.
            let detected = null;
            if (cfg.faceClustering === true) {
                try {
                    detected = await detectFaces(abs, cfg);
                } catch {
                    /* swallow — clustering refresh retries */
                }
            }

            // All DB writes go through the busy-aware retry: a long-running
            // sweep / cluster iterator on the same connection will throw
            // "This database connection is busy" on any concurrent UPDATE.
            // If retries are exhausted we skip — the row stays
            // ai_indexed_at = NULL and gets re-picked by the next scan.
            try {
                await _runWithBusyRetry(() => {
                    if (Array.isArray(detected) && detected.length) {
                        deleteFacesForDownload(row.id);
                        for (const f of detected) {
                            insertFace({
                                downloadId: row.id,
                                x: f.x,
                                y: f.y,
                                w: f.w,
                                h: f.h,
                                embeddingBlob: _f32ToBlob(f.embedding),
                            });
                        }
                    }
                    setAiIndexedAt(row.id);
                });
            } catch (e) {
                console.warn(
                    '[ai-pregenerate] db write skipped for download',
                    row.id,
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

function _resolveAbs(storedPath) {
    if (!storedPath) return null;
    if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
    let s = String(storedPath).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DATA_DIR, 'downloads', s);
    if (existsSync(candidate)) return candidate;
    if (existsSync(storedPath)) return storedPath;
    return null;
}

/** For tests — clear both queues + state. */
export function _resetForTests() {
    _bgQueueRealtime.length = 0;
    _bgQueueBackfill.length = 0;
    _bgRunning = false;
}

/** Queue-length snapshot for the AI status endpoint + tests. */
export function _bgQueueDepths() {
    return {
        realtime: _bgQueueRealtime.length,
        backfill: _bgQueueBackfill.length,
    };
}
