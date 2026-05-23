/**
 * Bulk sprite backfill scan. Driven by the maintenance page's
 * `JobTracker` — receives `{ onProgress, signal }` and walks every
 * video row that doesn't already have a sprite row in the DB.
 *
 * Connection safety (hard lesson — v2.14.x incident): better-sqlite3
 * holds an exclusive lock for the entire lifetime of an open
 * `.iterate()` cursor. Awaiting `generateForDownload` (which talks to
 * the Go sidecar over HTTP, and in the CPU fallback path spawns ffmpeg)
 * between rows kept the cursor open for seconds at a time, which in
 * turn made every other writer on the DB — the downloader's
 * `insertDownload`, `kv['queue_history']` flushes, the sidecar's own
 * DB submission — throw `This database connection is busy executing a
 * query`. The fix is to NEVER hold a live cursor across an `await`:
 * snapshot a page of IDs via `.all()` (statement closes the moment it
 * returns), process them, then ask for the next page.
 */

import {
    getDb,
    countVideoDownloads,
    pageMissingSeekbarVideos,
    pageSeekbarSprites,
    upsertSeekbarSprite,
} from '../db.js';
import { generateForDownload, getSeekbarConfig } from './generator.js';

const PAGE_SIZE = 100;
const YIELD_EVERY = 5;
const PROGRESS_EVERY_MS = 1000;

export async function buildAllSeekbar({ onProgress, signal } = {}) {
    const cfg = getSeekbarConfig();
    const total = countVideoDownloads();
    let processed = 0;
    let generated = 0;
    let skipped = 0;
    let errored = 0;
    let lastEmit = 0;
    const started = Date.now();

    const emit = (stage) => {
        try {
            onProgress?.({
                stage,
                processed,
                total,
                generated,
                skipped,
                errored,
            });
        } catch {
            /* progress emission must not abort the scan */
        }
    };

    emit('start');

    let cursor = Number.MAX_SAFE_INTEGER;
    // Outer loop: each iteration pulls a page of IDs synchronously (the
    // DB statement opens + closes within this call, so the connection is
    // free while we await ffmpeg / the sidecar). The inner loop owns no
    // cursor — it walks an array.
    while (true) {
        if (signal?.aborted) break;
        const rows = pageMissingSeekbarVideos({ beforeId: cursor, limit: PAGE_SIZE });
        if (!rows.length) break;
        for (const row of rows) {
            if (signal?.aborted) break;
            try {
                const meta = await generateForDownload(row, cfg, {
                    overwrite: 'if-changed',
                    signal,
                });
                if (meta) generated++;
                else skipped++;
            } catch (_e) {
                errored++;
                if (
                    /does not contain any stream|no video stream|Invalid data found|Invalid NAL|moov atom not found/i.test(
                        _e?.message || '',
                    )
                ) {
                    try {
                        upsertSeekbarSprite({
                            downloadId: row.id,
                            spritePath: '',
                            metaPath: '',
                            durationSec: null,
                            frames: 0,
                            cols: 0,
                            rows: 0,
                            tileW: 0,
                            tileH: 0,
                            intervalSec: null,
                            format: 'failed',
                            bytes: 0,
                            sourceSize: Number(row.file_size) || null,
                            sourceMtime: null,
                            generatedAt: Date.now(),
                        });
                    } catch {}
                }
            }
            processed++;
            cursor = Number(row.id) || cursor;
            const now = Date.now();
            if (processed % YIELD_EVERY === 0 || now - lastEmit >= PROGRESS_EVERY_MS) {
                lastEmit = now;
                emit('progress');
                await new Promise((r) => setImmediate(r));
            }
        }
    }

    emit('done');
    return {
        processed,
        generated,
        skipped,
        errored,
        durationMs: Date.now() - started,
        cancelled: !!signal?.aborted,
    };
}

/**
 * Wipe every sprite. Same paging rationale as the build sweep —
 * iterator-held-across-await is the bug we're permanently done with.
 */
export async function purgeAllSeekbar({ signal } = {}) {
    const { promises: fs } = await import('fs');
    const db = getDb();
    let removed = 0;
    let bytes = 0;
    let i = 0;
    let cursor = Number.MAX_SAFE_INTEGER;
    while (true) {
        if (signal?.aborted) break;
        const rows = pageSeekbarSprites({ beforeId: cursor, limit: PAGE_SIZE });
        if (!rows.length) break;
        for (const row of rows) {
            if (signal?.aborted) break;
            for (const p of [row.sprite_path, row.meta_path]) {
                if (!p) continue;
                try {
                    await fs.unlink(p);
                } catch {
                    /* best-effort */
                }
            }
            removed++;
            bytes += Number(row.bytes) || 0;
            cursor = Number(row.download_id) || cursor;
            if (++i % 100 === 0) await new Promise((r) => setImmediate(r));
        }
    }
    db.prepare('DELETE FROM seekbar_sprites').run();
    return { removed, bytes, cancelled: !!signal?.aborted };
}
