/**
 * Checksum-based duplicate finder.
 *
 * The downloads.file_hash column has been in the schema for a while but was
 * never populated. This module:
 *   1. Walks every row whose file_hash IS NULL, opens the file from disk,
 *      streams a SHA-256, and writes the digest back.
 *   2. After hashes are caught up, GROUPs BY hash to surface duplicate sets.
 *
 * Cost is O(bytes-on-disk) for the first scan; subsequent scans only hash
 * rows that lack a hash, so re-runs are nearly instant on a steady library.
 *
 * The progress callback receives `{ stage, processed, total }` after every
 * processed file so the UI can render a determinate progress bar via WS.
 *
 * SHA-256 was picked over BLAKE2 / xxhash because it ships in Node core
 * with no extra deps and is fast enough for media files (RAM is the
 * bottleneck, not CPU). Collisions are not a real concern at this scale.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { sha256OfFile, sha256OfFileViaPool } from './checksum.js';

// Where the downloader writes by default (relative to the project root).
// `safeResolveDownload`-style resolution lives in server.js; for the CLI
// path we just rely on what the DB stored.
const DEFAULT_DOWNLOAD_ROOT = path.resolve(process.cwd(), 'data/downloads');

/**
 * Resolve a stored file_path back to an absolute disk location, tolerant
 * of the various forms downloader/integrity have written over time:
 *   - absolute path
 *   - "data/downloads/<group>/<file>"
 *   - "<group>/<file>" (most common — relative to DEFAULT_DOWNLOAD_ROOT)
 */
function resolveStoredPath(stored) {
    if (!stored) return null;
    if (path.isAbsolute(stored) && fs.existsSync(stored)) return stored;
    let s = String(stored).replace(/\\/g, '/');
    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
    const candidate = path.join(DEFAULT_DOWNLOAD_ROOT, s);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(stored)) return stored;
    return null;
}

// Wrap the canonical helper so existing call sites in this file keep
// the same name. Hashing semantics are owned by `core/checksum.js`.
// Catch-up dedup hashes thousands of multi-MB files in a row — route
// them through the worker pool so a 2-hour scan doesn't pin the event
// loop for the full duration.
async function hashFile(absPath) {
    try {
        return await sha256OfFileViaPool(absPath);
    } catch {
        return await sha256OfFile(absPath);
    }
}

/**
 * Catch-up hash pass + duplicate enumeration.
 *
 * @param {Object} [opts]
 * @param {(p: {stage:string, processed:number, total:number, hashed?:number, errored?:number}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ scanned:number, hashed:number, errored:number, duplicateSets: Array<{
 *     hash:string, fileSize:number, count:number, files: Array<{
 *       id:number, groupId:string, groupName:string, fileName:string,
 *       filePath:string, fileSize:number, fileType:string, createdAt:number
 *     }>
 *   }>
 * }>}
 */
export async function findDuplicates(opts = {}) {
    const { onProgress, signal } = opts;
    const db = getDb();

    // First pass: hash every row that doesn't have one. We hash files of
    // size > 0 only — zero-byte files would all collide on the empty hash
    // and aren't meaningful duplicates.
    const missing = db.prepare(`
        SELECT id, file_path, file_size FROM downloads
         WHERE file_hash IS NULL
           AND file_path IS NOT NULL
           AND COALESCE(file_size, 0) > 0
         ORDER BY file_size DESC
    `).all();

    const update = db.prepare('UPDATE downloads SET file_hash = ? WHERE id = ?');
    const total = missing.length;
    let processed = 0, hashed = 0, errored = 0;

    if (onProgress) onProgress({ stage: 'hashing', processed, total, hashed, errored });

    for (const row of missing) {
        if (signal?.aborted) break;
        processed++;
        const abs = resolveStoredPath(row.file_path);
        if (!abs) { errored++; continue; }
        try {
            const digest = await hashFile(abs);
            update.run(digest, row.id);
            hashed++;
        } catch {
            errored++;
        }
        if (onProgress && (processed % 25 === 0 || processed === total)) {
            onProgress({ stage: 'hashing', processed, total, hashed, errored });
        }
    }

    // Second pass: group by hash, return the duplicate sets ordered by the
    // amount of disk those duplicates are wasting (size × extra copies).
    if (onProgress) onProgress({ stage: 'grouping', processed: total, total, hashed, errored });

    const duplicates = db.prepare(`
        SELECT file_hash AS hash,
               COUNT(*)  AS cnt,
               MAX(file_size) AS max_size
          FROM downloads
         WHERE file_hash IS NOT NULL
         GROUP BY file_hash
        HAVING COUNT(*) > 1
         ORDER BY (MAX(file_size) * (COUNT(*) - 1)) DESC,
                  COUNT(*) DESC
         LIMIT 500
    `).all();

    const sets = [];
    const filesQ = db.prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_size,
               file_type, created_at
          FROM downloads
         WHERE file_hash = ?
         ORDER BY created_at ASC, id ASC
    `);
    for (const d of duplicates) {
        const files = filesQ.all(d.hash).map(r => ({
            id: r.id,
            groupId: r.group_id,
            groupName: r.group_name,
            fileName: r.file_name,
            filePath: r.file_path,
            fileSize: r.file_size,
            fileType: r.file_type,
            createdAt: r.created_at,
        }));
        sets.push({
            hash: d.hash,
            fileSize: d.max_size || 0,
            count: d.cnt,
            files,
        });
    }

    if (onProgress) onProgress({ stage: 'done', processed: total, total, hashed, errored });

    return {
        scanned: total,
        hashed,
        errored,
        duplicateSets: sets,
    };
}

/**
 * Delete the requested rows + their on-disk files in one transactional
 * sweep. Caller is the admin endpoint — UI shows the diff (kept vs
 * deleted) and an explicit confirm before reaching here.
 *
 * @param {number[]} ids
 * @returns {{ removed: number, freedBytes: number, missingFiles: number }}
 */
export function deleteByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { removed: 0, freedBytes: 0, missingFiles: 0 };
    }
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
        `SELECT id, file_path, file_size FROM downloads WHERE id IN (${placeholders})`
    ).all(...ids);

    let freed = 0;
    let missing = 0;
    for (const r of rows) {
        const abs = resolveStoredPath(r.file_path);
        if (abs) {
            try { fs.unlinkSync(abs); freed += Number(r.file_size) || 0; }
            catch (e) {
                if (e?.code === 'ENOENT') { missing++; freed += Number(r.file_size) || 0; }
                // Other errors (EPERM etc.) — skip the row, don't drop from DB
                // so the user can retry / inspect.
                else continue;
            }
        } else {
            missing++;
            freed += Number(r.file_size) || 0;
        }
    }

    // Drop only the rows whose files we successfully removed (or were
    // already missing — the row points at nothing anyway).
    const idsToDrop = [];
    for (const r of rows) {
        const abs = resolveStoredPath(r.file_path);
        const exists = abs ? fs.existsSync(abs) : false;
        if (!exists) idsToDrop.push(r.id);
    }
    let removed = 0;
    if (idsToDrop.length) {
        const ph = idsToDrop.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM downloads WHERE id IN (${ph})`).run(...idsToDrop);
        removed = r.changes;
    }
    return { removed, freedBytes: freed, missingFiles: missing };
}
