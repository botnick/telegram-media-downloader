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
import { hashFilesViaCore } from './gocore/hash.js';
import * as gocoreClient from './gocore/client.js';
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

// Identity of the physical file a row points at. Download-time dedup makes
// several rows share one file, so rows — not files — can repeat within a
// hash. Rows whose file is missing fall back to their normalised stored
// path so they still group together.
function fileKey(stored) {
    const abs = resolveStoredPath(stored);
    const key = abs ? path.resolve(abs) : String(stored || '').replace(/\\/g, '/');
    return process.platform === 'win32' ? key.toLowerCase() : key;
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
    // its entire lifetime; `await hashFilesViaCore()` yields control while the
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
    // Hashing is async, but the resulting writes are kept in a short SQLite
    // transaction. This avoids one fsync per row on a first scan of a large
    // library while keeping the transaction completely off the await path.
    const updateMany = db.transaction((items) => {
        for (const item of items) update.run(item.sha256, item.id);
    });
    let processed = 0,
        hashed = 0,
        errored = 0;

    if (onProgress) onProgress({ stage: 'hashing', processed, total, hashed, errored });

    // Keyset cursor over id DESC — keeps a stable window even as hashed
    // rows are updated (file_hash no longer NULL, so they fall out of the
    // WHERE clause naturally on the next page fetch).
    const PAGE_SIZE = 200;
    // Stay well below the Go endpoint's hard limit while keeping request and
    // result memory bounded for very large libraries.
    const HASH_BATCH_SIZE = 64;
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
        const pending = [];
        for (const row of page) {
            if (signal?.aborted) break;
            const abs = resolveStoredPath(row.file_path);
            if (!abs) {
                processed++;
                errored++;
                if (onProgress && (processed % 10 === 0 || processed === total)) {
                    onProgress({ stage: 'hashing', processed, total, hashed, errored });
                }
                continue;
            }
            pending.push({ row, abs });
        }

        for (let offset = 0; offset < pending.length; offset += HASH_BATCH_SIZE) {
            if (signal?.aborted) break;
            const batch = pending.slice(offset, offset + HASH_BATCH_SIZE);
            let results;
            try {
                results = await hashFilesViaCore(
                    batch.map((item) => item.abs),
                    { sizes: batch.map((item) => item.row.file_size), signal },
                );
            } catch {
                // Leave hashes NULL when transport/core fails so a later run
                // can retry the affected rows without losing the page.
                results = batch.map(() => ({ error: true }));
            }
            const successful = results
                .map((result, i) =>
                    result?.sha256 && batch[i]
                        ? { sha256: result.sha256, id: batch[i].row.id }
                        : null,
                )
                .filter(Boolean);
            let committed = true;
            try {
                updateMany(successful);
                hashed += successful.length;
            } catch {
                committed = false;
            }
            for (let i = 0; i < batch.length; i++) {
                const result = results[i];
                processed++;
                if (!result?.sha256 || !committed) {
                    errored++;
                }
                if (onProgress && (processed % 10 === 0 || processed === total)) {
                    onProgress({ stage: 'hashing', processed, total, hashed, errored });
                }
            }
        }
        if (signal?.aborted) break;
        beforeId = Number(page[page.length - 1].id);
        await new Promise((r) => setImmediate(r));
        if (page.length < PAGE_SIZE) break;
    }

    const sets = await buildDuplicateSets({ onProgress, signal, hashed, errored });

    if (onProgress) onProgress({ stage: 'done', processed: total, total, hashed, errored });

    return {
        scanned: total,
        hashed,
        errored,
        duplicateSets: sets,
    };
}

/**
 * Group already-hashed rows into duplicate sets — the second half of
 * findDuplicates(), without hashing anything. Used to rebuild the
 * Duplicates page from stored hashes after a restart (the last scan's
 * result only lives in memory).
 *
 * @param {Object} [opts]
 * @param {Function} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.hashed]   passed through to progress events
 * @param {number} [opts.errored]  passed through to progress events
 */
export async function buildDuplicateSets({ onProgress, signal, hashed = 0, errored = 0 } = {}) {
    const db = getDb();
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

    // Build the file-detail sets for each duplicate hash — one entry per
    // physical copy (its oldest row), skipping hashes whose rows all share
    // a single file: there's nothing to reclaim there, and offering those
    // rows for deletion would delete the file the kept row uses. Yields
    // every 25 sets so WS progress events keep flowing.
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
        const seen = new Set();
        const files = [];
        for (const r of filesQ.all(d.hash)) {
            const key = fileKey(r.file_path);
            if (seen.has(key)) continue;
            seen.add(key);
            files.push({
                id: r.id,
                groupId: r.group_id,
                groupName: r.group_name,
                fileName: r.file_name,
                filePath: r.file_path,
                fileSize: r.file_size,
                fileType: r.file_type,
                createdAt: r.created_at,
            });
        }
        if (files.length > 1) {
            sets.push({
                hash: d.hash,
                fileSize: d.max_size || 0,
                count: files.length,
                files,
            });
        }
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

    // Re-rank now that counts are physical copies, not rows.
    sets.sort(
        (a, b) => b.fileSize * (b.count - 1) - a.fileSize * (a.count - 1) || b.count - a.count,
    );

    return sets;
}

// Chunk size for `IN (?,?,…)` clauses. SQLite caps bound parameters at
// SQLITE_MAX_VARIABLE_NUMBER (32766 in modern builds, 999 in older ones);
// 500 stays well clear of both and keeps each prepared statement small.
const SQL_IN_CHUNK = 500;

function selectIn(db, sqlPrefix, values) {
    const out = [];
    for (let i = 0; i < values.length; i += SQL_IN_CHUNK) {
        const slice = values.slice(i, i + SQL_IN_CHUNK);
        const ph = slice.map(() => '?').join(',');
        for (const r of db.prepare(`${sqlPrefix} (${ph})`).all(...slice)) out.push(r);
    }
    return out;
}

/**
 * Delete the requested rows and their on-disk files. Caller is an admin
 * endpoint — the UI shows the diff (kept vs deleted) and an explicit
 * confirm before reaching here.
 *
 * Several rows can point at one physical file (download-time dedup), so a
 * file is only removed once no row outside this batch still uses it.
 *
 * @param {number[]} ids
 * @returns {{ removed: number, freedBytes: number, missingFiles: number }}
 */
const ROW_COLS = 'SELECT id, file_name, file_path, file_size FROM downloads WHERE';

// Rows sharing a physical file always share its file name (the dedup'd row
// stores the existing file's name and path), so one name lookup per chunk
// finds every row that could still be using one of `rows`' files.
function rowsWithSameName(db, rows) {
    const names = [...new Set(rows.map((r) => r.file_name).filter(Boolean))];
    return selectIn(db, `${ROW_COLS} file_name IN`, names);
}

/**
 * Ids (from `ids`) whose file is still used by a row NOT in `ids` — callers
 * deleting those rows must leave the file on disk.
 * @param {number[]} ids
 * @returns {Set<number>}
 */
export function idsWithFileInUse(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return new Set();
    const db = getDb();
    const rows = selectIn(db, `${ROW_COLS} id IN`, ids);
    const batch = new Set(rows.map((r) => r.id));
    const used = new Set();
    for (const r of rowsWithSameName(db, rows)) {
        if (!batch.has(r.id)) used.add(fileKey(r.file_path));
    }
    return new Set(rows.filter((r) => used.has(fileKey(r.file_path))).map((r) => r.id));
}

/**
 * `ids` plus every other row that uses the same physical file as one of
 * them. The duplicate finder lists one row per physical copy, so removing a
 * copy has to remove all of its rows for the file to actually be freed.
 * @param {number[]} ids
 * @returns {number[]}
 */
export function expandToSharedRefs(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const db = getDb();
    const rows = selectIn(db, `${ROW_COLS} id IN`, ids);
    const keys = new Set(rows.map((r) => fileKey(r.file_path)));
    const out = new Set(rows.map((r) => r.id));
    for (const r of rowsWithSameName(db, rows)) {
        if (keys.has(fileKey(r.file_path))) out.add(r.id);
    }
    return [...out];
}

export function deleteByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { removed: 0, freedBytes: 0, missingFiles: 0 };
    }
    const db = getDb();
    const rows = selectIn(db, `${ROW_COLS} id IN`, ids);
    const sameName = rowsWithSameName(db, rows);
    const batch = new Set(rows.map((r) => r.id));
    const stillUsed = new Set();
    for (const r of sameName) {
        if (!batch.has(r.id)) stillUsed.add(fileKey(r.file_path));
    }

    let freed = 0;
    let missing = 0;
    const idsToDrop = [];
    const handled = new Set();
    for (const r of rows) {
        const key = fileKey(r.file_path);
        if (stillUsed.has(key) || handled.has(key)) {
            idsToDrop.push(r.id);
            continue;
        }
        handled.add(key);
        const abs = resolveStoredPath(r.file_path);
        if (!abs) {
            missing++;
            idsToDrop.push(r.id);
            continue;
        }
        try {
            if (deferDelete(abs)) freed += Number(r.file_size) || 0;
            else missing++;
            idsToDrop.push(r.id);
        } catch {
            // EPERM etc. — skip the row so user can retry.
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

/**
 * Delete a group's download folder, except files that rows of OTHER groups
 * still point at — download-time dedup stores a later download from another
 * group as a reference to the file already in this folder.
 *
 * @param {string} groupId
 * @param {string} folderAbs  absolute path of the group's folder
 * @returns {Promise<number>} number of files kept
 */
export async function removeGroupFolder(groupId, folderAbs) {
    const esc = (s) => s.replace(/\\/g, '/').replace(/[\\%_]/g, '\\$&');
    const rel = path.relative(DEFAULT_DOWNLOAD_ROOT, folderAbs);
    const used = new Set(
        getDb()
            .prepare(`
            SELECT file_path FROM downloads
             WHERE group_id != ?
               AND (REPLACE(file_path, '\\', '/') LIKE ? ESCAPE '\\'
                    OR REPLACE(file_path, '\\', '/') LIKE ? ESCAPE '\\')
        `)
            .all(String(groupId), `${esc(rel)}/%`, `${esc(path.resolve(folderAbs))}/%`)
            .map((r) => fileKey(r.file_path)),
    );

    // The Go walker removes the large tree without making Node recurse through
    // every directory. Keep only absolute paths that actually belong below
    // this root; unresolved legacy paths cannot name an existing file here.
    if (gocoreClient.isAvailable('remove-tree')) {
        const keep = [...used].filter((p) => {
            if (!path.isAbsolute(p)) return false;
            const rel = path.relative(folderAbs, p);
            return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        try {
            return (await gocoreClient.removeTree(folderAbs, keep)).kept;
        } catch {
            // Old cores, custom paths outside the allow-list, and transient
            // core failures use the proven Node fallback below.
        }
    }
    if (!used.size) {
        await fs.promises.rm(folderAbs, { recursive: true, force: true });
        return 0;
    }
    let kept = 0;
    const walk = async (dir) => {
        for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
            const p = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                await walk(p);
                await fs.promises.rmdir(p).catch(() => {});
            } else if (used.has(fileKey(p))) {
                kept++;
            } else {
                await fs.promises.rm(p, { force: true });
            }
        }
    };
    await walk(folderAbs);
    await fs.promises.rmdir(folderAbs).catch(() => {});
    return kept;
}
