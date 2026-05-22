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
import { getDownloadsDir } from './paths.js';
import { deferDelete } from './deferred-delete.js';

// Where the downloader writes by default.
// `safeResolveDownload`-style resolution lives in server.js; for the CLI
// path we just rely on what the DB stored.
const DEFAULT_DOWNLOAD_ROOT = getDownloadsDir();

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
    //
    // Use keyset-paginated `.all()` instead of `.iterate()`. A live
    // `.iterate()` cursor holds the better-sqlite3 connection open for
    // its entire lifetime; `await hashFile()` yields control while the
    // cursor is open, which lets the download manager, kv flush timer, or
    // AI pregenerate hook collide on the connection and throw
    // "This database connection is busy executing a query".
    // With keyset paging the `.all()` call opens and closes the statement
    // synchronously, so the connection is free during the async hash work.
    const total = db
        .prepare(`
        SELECT COUNT(*) AS n FROM downloads
         WHERE file_hash IS NULL
           AND file_path IS NOT NULL
           AND COALESCE(file_size, 0) > 0
    `)
        .get().n;

    const update = db.prepare('UPDATE downloads SET file_hash = ? WHERE id = ?');
    let processed = 0,
        hashed = 0,
        errored = 0;

    if (onProgress) onProgress({ stage: 'hashing', processed, total, hashed, errored });

    // Keyset cursor over id DESC — keeps a stable window even as hashed
    // rows are updated (file_hash no longer NULL, so they fall out of the
    // WHERE clause naturally on the next page fetch).
    const PAGE_SIZE = 200;
    let beforeId = Number.MAX_SAFE_INTEGER;
    const pageStmt = db.prepare(`
        SELECT id, file_path, file_size FROM downloads
         WHERE file_hash IS NULL
           AND file_path IS NOT NULL
           AND COALESCE(file_size, 0) > 0
           AND id < ?
         ORDER BY id DESC
         LIMIT ?
    `);
    while (true) {
        if (signal?.aborted) break;
        // `.all()` closes the statement before we hit any await below.
        const page = pageStmt.all(beforeId, PAGE_SIZE);
        if (!page.length) break;
        for (const row of page) {
            if (signal?.aborted) break;
            processed++;
            const abs = resolveStoredPath(row.file_path);
            if (!abs) {
                errored++;
                continue;
            }
            try {
                const digest = await hashFile(abs);
                update.run(digest, row.id);
                hashed++;
            } catch {
                errored++;
            }
            if (onProgress && (processed % 10 === 0 || processed === total)) {
                onProgress({ stage: 'hashing', processed, total, hashed, errored });
            }
        }
        beforeId = Number(page[page.length - 1].id);
        await new Promise((r) => setImmediate(r));
        if (page.length < PAGE_SIZE) break;
    }

    // Second pass: paginated GROUP BY — scan the file_hash index in order,
    // grouping 5000 distinct hashes per page. Each page blocks ~10-50ms
    // instead of the old single-query approach that blocked 3-15s on 1M rows.
    const totalHashes = db
        .prepare('SELECT COUNT(DISTINCT file_hash) AS n FROM downloads WHERE file_hash IS NOT NULL')
        .get().n;
    if (onProgress)
        onProgress({ stage: 'grouping', processed: 0, total: totalHashes, hashed, errored });
    await new Promise((r) => setImmediate(r));

    const HASH_PAGE = 5000;
    const allDupes = [];
    let afterHash = '';
    let scannedGroups = 0;

    const groupStmt = db.prepare(`
        SELECT file_hash AS hash,
               COUNT(*)  AS cnt,
               MAX(file_size) AS max_size
          FROM downloads
         WHERE file_hash IS NOT NULL
           AND file_hash > ?
         GROUP BY file_hash
         ORDER BY file_hash ASC
         LIMIT ?
    `);

    while (true) {
        if (signal?.aborted) break;
        const page = groupStmt.all(afterHash, HASH_PAGE);
        if (!page.length) break;
        for (const row of page) {
            if (row.cnt > 1) allDupes.push(row);
        }
        scannedGroups += page.length;
        afterHash = page[page.length - 1].hash;
        if (onProgress)
            onProgress({
                stage: 'grouping',
                processed: scannedGroups,
                total: totalHashes,
                hashed,
                errored,
                duplicatesFound: allDupes.length,
            });
        await new Promise((r) => setImmediate(r));
        if (page.length < HASH_PAGE) break;
    }

    // Sort by reclaimable space (size × extra copies), then by count.
    allDupes.sort((a, b) => b.max_size * (b.cnt - 1) - a.max_size * (a.cnt - 1) || b.cnt - a.cnt);
    const duplicates = allDupes;

    // Build the file-detail sets for each duplicate hash. Yields every
    // 50 sets so WS progress events keep flowing.
    const sets = [];
    const filesQ = db.prepare(`
        SELECT id, group_id, group_name, file_name, file_path, file_size,
               file_type, created_at
          FROM downloads
         WHERE file_hash = ?
         ORDER BY created_at ASC, id ASC
    `);
    const SETS_BATCH = 25;
    for (let i = 0; i < duplicates.length; i++) {
        if (signal?.aborted) break;
        const d = duplicates[i];
        const files = filesQ.all(d.hash).map((r) => ({
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
        if ((i + 1) % SETS_BATCH === 0) {
            if (onProgress)
                onProgress({
                    stage: 'building',
                    processed: sets.length,
                    total: duplicates.length,
                    hashed,
                    errored,
                });
            await new Promise((r) => setImmediate(r));
        }
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
// Chunk size for `IN (?,?,…)` clauses. SQLite caps bound parameters at
// SQLITE_MAX_VARIABLE_NUMBER (32766 in modern builds, 999 in older ones);
// 500 stays well clear of both and keeps each prepared statement small.
const SQL_IN_CHUNK = 500;

export function deleteByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { removed: 0, freedBytes: 0, missingFiles: 0 };
    }
    const db = getDb();
    const rows = [];
    for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) {
        const slice = ids.slice(i, i + SQL_IN_CHUNK);
        const ph = slice.map(() => '?').join(',');
        const part = db
            .prepare(`SELECT id, file_path, file_size FROM downloads WHERE id IN (${ph})`)
            .all(...slice);
        for (const r of part) rows.push(r);
    }

    let freed = 0;
    let missing = 0;
    const idsToDrop = [];
    for (const r of rows) {
        const abs = resolveStoredPath(r.file_path);
        if (abs) {
            try {
                const moved = deferDelete(abs);
                freed += Number(r.file_size) || 0;
                idsToDrop.push(r.id);
                if (!moved) missing++;
            } catch {
                // EPERM etc. — skip the row so user can retry.
            }
        } else {
            missing++;
            freed += Number(r.file_size) || 0;
            idsToDrop.push(r.id);
        }
    }

    let removed = 0;
    for (let i = 0; i < idsToDrop.length; i += SQL_IN_CHUNK) {
        const slice = idsToDrop.slice(i, i + SQL_IN_CHUNK);
        const ph = slice.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM downloads WHERE id IN (${ph})`).run(...slice);
        removed += r.changes;
    }
    return { removed, freedBytes: freed, missingFiles: missing };
}
