// Periodic + boot-time integrity sweep over the downloads DB.
//
// Goal: after a crash, a manual delete, an auto-rotator pass, or any
// event that leaves the DB referencing a path that no longer exists on
// disk, the gallery should self-heal — no manual SQL, no SSH. We walk
// every row, stat the file at row.file_path (relative to DOWNLOADS_DIR),
// and delete the row if the file is missing or zero bytes.
//
// Counterpart guards already in place:
//   - downloader.js verifies file size after every fs.rename
//   - server.js auto-prunes a single 404 served from /files
// This module is the catch-all that runs without a request to trigger it.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, '../../data/downloads');

let _running = false;
let _timer = null;
let _broadcast = () => {};

// Cached batch size, refreshed from config on each start() call.
let _batchSize = 64;

/**
 * Walk every row, stat each file, drop rows where the file is missing
 * or zero-bytes. Returns `{ scanned, pruned }`. Concurrency-guarded —
 * a second call while the first is in-flight is a no-op.
 */
export async function sweep() {
    if (_running) return { scanned: 0, pruned: 0, skipped: true };
    _running = true;
    const result = { scanned: 0, pruned: 0 };
    try {
        const rows = getDb().prepare(
            `SELECT id, file_path, file_name, group_id FROM downloads WHERE file_path IS NOT NULL`
        ).all();
        result.scanned = rows.length;

        // Limit concurrency so a 100k-row DB doesn't fork 100k stat() calls.
        // Tunable via config.advanced.integrity.batchSize (read at start()).
        const BATCH = Math.max(1, _batchSize | 0) || 64;
        const deleteIds = [];
        for (let i = 0; i < rows.length; i += BATCH) {
            const slice = rows.slice(i, i + BATCH);
            const checks = await Promise.all(slice.map(async (r) => {
                const rel = String(r.file_path || '').replace(/\\/g, '/');
                if (!rel) return null;
                // Defence-in-depth: refuse to stat anything that walks outside
                // DOWNLOADS_DIR. Rows with bogus paths get pruned.
                if (rel.includes('..') || path.isAbsolute(rel)) return r.id;
                const abs = path.join(DOWNLOADS_DIR, rel);
                try {
                    const st = await fs.stat(abs);
                    return st.size > 0 ? null : r.id;
                } catch {
                    return r.id;
                }
            }));
            for (const id of checks) if (id) deleteIds.push(id);
        }

        if (deleteIds.length) {
            const stmt = getDb().prepare(
                `DELETE FROM downloads WHERE id IN (${deleteIds.map(() => '?').join(',')})`
            );
            const r = stmt.run(...deleteIds);
            result.pruned = r.changes;
            try { _broadcast({ type: 'integrity_swept', pruned: result.pruned, scanned: result.scanned }); } catch {}
        }
    } finally {
        _running = false;
    }
    return result;
}

/**
 * Schedule the sweep on boot (after a small delay so the server has time
 * to finish its other startup tasks) and then every `intervalMin`
 * minutes thereafter. Idempotent — safe to call multiple times.
 *
 * `batchSize` is also accepted to override stat() concurrency per pass
 * (keeps the consumer-reads-config pattern in server.js consistent).
 */
export function start({ broadcast, intervalMin = 60, batchSize = 64 } = {}) {
    if (broadcast) _broadcast = broadcast;
    if (Number.isFinite(batchSize) && batchSize > 0) _batchSize = Math.floor(batchSize);
    if (_timer) clearInterval(_timer);
    setTimeout(() => {
        sweep().then(({ scanned, pruned }) => {
            if (pruned > 0) {
                console.log(`[integrity] boot sweep — pruned ${pruned} dead rows out of ${scanned}`);
            }
        }).catch((e) => console.warn('[integrity] boot sweep failed:', e.message));
    }, 30 * 1000);
    _timer = setInterval(() => {
        sweep().then(({ scanned, pruned }) => {
            if (pruned > 0) {
                console.log(`[integrity] periodic sweep — pruned ${pruned} dead rows out of ${scanned}`);
            }
        }).catch(() => {});
    }, Math.max(60, intervalMin) * 60 * 1000);
    _timer.unref?.();
}

export function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}
