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
import crypto from 'crypto';
import { getDb, insertDownload, purgeOrphanPeople } from './db.js';
import { statMany, uvError, walkTree } from './gocore/fs.js';
import { sanitizeName } from './downloader.js';
import { getDownloadsDir } from './paths.js';
import { purgeThumbsForDownload } from './thumbs.js';
import { purgeSeekbarForDownload, collectSeekbarPaths } from './seekbar/index.js';

const DOWNLOADS_DIR = getDownloadsDir();

let _running = false;
let _timer = null;
let _broadcast = () => {};

// Cached batch size, refreshed from config on each start() call.
let _batchSize = 64;

// Automatic runs (boot + timer) refuse to prune when more than this share
// of the library looks missing at once — that's an unmounted disk or a
// stale network share far more often than real deletions.
const AUTO_PRUNE_MAX_SHARE = 0.5;
const AUTO_PRUNE_MIN_ROWS = 20;
// Only these mean "the file is gone". EACCES / EIO / ENOTCONN / ESTALE …
// are an unreadable disk, not a deleted file.
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Walk every row, stat each file, drop rows where the file is missing
 * or zero-bytes. Returns `{ scanned, pruned, sizeFixed }`. Concurrency-
 * guarded — a second call while the first is in-flight is a no-op.
 *
 * Optional `onProgress({ processed, total, stage, sizeFixed })` fires
 * after every batch so the verify-files admin page can render a
 * determinate bar without polling.
 */
export async function sweep(onProgress, { auto = false } = {}) {
    if (_running) return { scanned: 0, pruned: 0, skipped: true };
    _running = true;
    const result = { scanned: 0, pruned: 0, sizeFixed: 0 };
    const _emit = (extra) => {
        if (typeof onProgress !== 'function') return;
        try {
            onProgress({ ...result, ...(extra || {}) });
        } catch {}
    };
    try {
        // An unmounted / unreadable downloads disk makes every file look
        // missing — never prune the library because of that.
        try {
            await fs.readdir(DOWNLOADS_DIR);
        } catch (e) {
            console.warn(
                `[integrity] downloads dir unavailable (${e?.code || e?.message}) — sweep skipped, nothing pruned`,
            );
            return { ...result, skipped: true, reason: 'downloads_dir_unavailable' };
        }

        // Use keyset-paginated `.all()` instead of `.iterate()`. A live
        // `.iterate()` cursor holds the better-sqlite3 connection open for
        // its entire lifetime — if an `await` (fs.stat, Promise.all) yields
        // control while the cursor is open, any concurrent DB write from
        // the download manager, kv flush timer, or AI pregenerate hook
        // lands on a busy connection and throws
        // "This database connection is busy executing a query".
        // Keyset paging avoids this: each `.all()` call opens and closes
        // the statement immediately, so the connection is free during the
        // async stat checks that follow.
        const db = getDb();
        const total = db
            .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE file_path IS NOT NULL`)
            .get().n;
        result.scanned = total;
        _emit({ processed: 0, total, stage: 'scanning' });

        // Limit concurrency so a 100k-row DB doesn't fork 100k stat() calls.
        // Tunable via config.advanced.integrity.batchSize (read at start()).
        const BATCH = Math.max(1, _batchSize | 0) || 64;
        const PAGE_SIZE = BATCH;
        const deleteIds = [];
        // [{id, size}, ...] — rows whose actual on-disk size differs from
        // the stored value (or whose stored value is null/0). Backfilled
        // in one transaction at the end.
        const sizeFixes = [];
        let processed = 0;
        // Keyset cursor — walk id DESC so newly inserted rows don't shift
        // the window mid-scan. Start above the highest possible id.
        let beforeId = Number.MAX_SAFE_INTEGER;
        const pageStmt = db.prepare(
            `SELECT id, file_path, file_name, group_id, file_size
               FROM downloads
              WHERE file_path IS NOT NULL
                AND id < ?
              ORDER BY id DESC
              LIMIT ?`,
        );
        // Rows are still read and decided page by page (progress, yields and
        // every rule below are per page, as before), but the stats for up
        // to STAT_AHEAD_ROWS rows come from tgdl-core in one request: a
        // round trip per page would cost more main-thread time than the
        // stats themselves.
        const STAT_AHEAD_ROWS = 1024;
        let exhausted = false;
        while (!exhausted) {
            // `.all()` opens + closes the statement synchronously; the
            // connection is free by the time the async stat checks run.
            const pages = [];
            let ahead = 0;
            while (!exhausted && (ahead === 0 || ahead + PAGE_SIZE <= STAT_AHEAD_ROWS)) {
                const page = pageStmt.all(beforeId, PAGE_SIZE);
                if (!page.length) {
                    exhausted = true;
                    break;
                }
                pages.push(page);
                ahead += page.length;
                beforeId = Number(page[page.length - 1].id);
                if (page.length < PAGE_SIZE) exhausted = true;
            }
            if (!pages.length) break;
            const targets = pages.map((page) => {
                const pageTargets = [];
                for (const r of page) {
                    let rel = String(r.file_path || '').replace(/\\/g, '/');
                    if (!rel) continue;
                    // Tolerate the legacy `data/downloads/` prefix that some
                    // older rows still carry — same fix that
                    // safeResolveDownload() does in the request path.
                    while (rel.startsWith('data/downloads/'))
                        rel = rel.slice('data/downloads/'.length);
                    // Federated-dedup rows point at a peer's copy; there is
                    // nothing local to stat.
                    if (rel.startsWith('_clusterref/')) continue;
                    // Absolute or `../` paths come from a custom download
                    // path outside DOWNLOADS_DIR — stat where they point
                    // instead of pruning them for their shape.
                    pageTargets.push({ r, abs: path.resolve(DOWNLOADS_DIR, rel) });
                }
                return pageTargets;
            });
            // fs.stat of those rows, done by tgdl-core with Node's own
            // error codes. If it can't answer, stop here: nothing has been
            // pruned or rewritten yet.
            let stats;
            try {
                stats = await statMany(targets.flat().map((t) => t.abs));
            } catch (e) {
                console.warn(
                    `[integrity] file check unavailable (${e?.message || e}) — sweep stopped, nothing pruned`,
                );
                return { ...result, skipped: true, reason: 'core_unavailable' };
            }
            let k = 0;
            for (let p = 0; p < pages.length; p++) {
                for (const { r } of targets[p]) {
                    const st = stats[k++];
                    if (st.ok) {
                        if (st.size <= 0) {
                            deleteIds.push(r.id);
                            continue;
                        }
                        // Backfill or correct the stored file_size if it's
                        // null / 0 / wrong. Tolerance > 0 for the rare case
                        // an editor / re-encode legitimately changed bytes.
                        const stored = Number(r.file_size) || 0;
                        if (stored !== st.size) sizeFixes.push({ id: r.id, size: st.size });
                    } else if (MISSING_CODES.has(st.code)) {
                        deleteIds.push(r.id);
                    }
                }
                processed += pages[p].length;
                _emit({ processed, total, stage: 'scanning' });
                await new Promise((r) => setImmediate(r));
            }
        }

        if (sizeFixes.length) {
            const upd = getDb().prepare('UPDATE downloads SET file_size = ? WHERE id = ?');
            const SIZE_BATCH = 500;
            let sizeFixed = 0;
            for (let i = 0; i < sizeFixes.length; i += SIZE_BATCH) {
                const slice = sizeFixes.slice(i, i + SIZE_BATCH);
                const tx = getDb().transaction((items) => {
                    for (const it of items) upd.run(it.size, it.id);
                });
                tx(slice);
                sizeFixed += slice.length;
                _emit({
                    processed: sizeFixed,
                    total: sizeFixes.length,
                    stage: 'fixing_sizes',
                });
                await new Promise((r) => setImmediate(r));
            }
            result.sizeFixed = sizeFixed;
        }

        if (
            auto &&
            deleteIds.length >= AUTO_PRUNE_MIN_ROWS &&
            deleteIds.length > total * AUTO_PRUNE_MAX_SHARE
        ) {
            console.warn(
                `[integrity] ${deleteIds.length} of ${total} files look missing — not pruning ` +
                    'automatically (disk unmounted?). Run Maintenance → Verify files to prune.',
            );
            result.skipped = true;
            result.reason = 'too_many_missing';
            result.missing = deleteIds.length;
            deleteIds.length = 0;
        }

        if (deleteIds.length) {
            _emit({ processed, total, stage: 'pruning' });
            const seekbarMap = collectSeekbarPaths(deleteIds);
            // One transaction per chunk with a yield in between: a single
            // transaction over every dead row (plus its cascades) blocked
            // the event loop for ~35 s at 150k rows.
            const DELETE_CHUNK = 500;
            const tx = getDb().transaction((slice) => {
                const stmt = getDb().prepare(
                    `DELETE FROM downloads WHERE id IN (${slice.map(() => '?').join(',')})`,
                );
                return stmt.run(...slice).changes;
            });
            result.pruned = 0;
            for (let i = 0; i < deleteIds.length; i += DELETE_CHUNK) {
                result.pruned += tx(deleteIds.slice(i, i + DELETE_CHUNK));
                _emit({ processed: i, total: deleteIds.length, stage: 'pruning' });
                await new Promise((r) => setImmediate(r));
            }
            for (const id of deleteIds) {
                purgeThumbsForDownload(id).catch(() => {});
                purgeSeekbarForDownload(id, seekbarMap.get(id)).catch(() => {});
            }
            try {
                purgeOrphanPeople();
            } catch {}
            try {
                _broadcast({
                    type: 'integrity_swept',
                    pruned: result.pruned,
                    scanned: result.scanned,
                });
            } catch {}
        }
        _emit({ processed: total, total, stage: 'done' });
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
        sweep(null, { auto: true })
            .then(({ scanned, pruned }) => {
                if (pruned > 0) {
                    console.log(
                        `[integrity] boot sweep — pruned ${pruned} dead rows out of ${scanned}`,
                    );
                }
            })
            .catch((e) => console.warn('[integrity] boot sweep failed:', e.message));
    }, 30 * 1000);
    _timer = setInterval(
        () => {
            sweep(null, { auto: true })
                .then(({ scanned, pruned }) => {
                    if (pruned > 0) {
                        console.log(
                            `[integrity] periodic sweep — pruned ${pruned} dead rows out of ${scanned}`,
                        );
                    }
                })
                .catch(() => {});
        },
        Math.max(60, intervalMin) * 60 * 1000,
    );
    _timer.unref?.();
}

export function stop() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

// ---- Re-index from disk --------------------------------------------------

const TYPE_FOLDER_TO_FILETYPE = {
    images: 'photo',
    videos: 'video',
    audio: 'audio',
    documents: 'document',
    gifs: 'video',
    stickers: 'photo',
    others: 'document',
};

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac']);

function fileTypeFromExt(ext) {
    if (PHOTO_EXTS.has(ext)) return 'photo';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return 'document';
}

// Filename pattern produced by `downloader.generateFilename`:
//   `<ISO timestamp>_<messageId|noid><ext>`
// Stable parser — when messageId is present we reuse it (so re-running the
// downloader on the same chat doesn't double-insert). When it's `noid` (or
// the file was renamed manually), fall back to a deterministic synthetic id
// derived from the relative path so this run matches the next.
const FILENAME_MSGID_RE = /_(\d+)\.[^.]+$/;

function deriveMessageId(relPath, fileName) {
    const m = FILENAME_MSGID_RE.exec(fileName);
    if (m) return Number(m[1]);
    // Synthetic id from a path hash. Bias negative so it can never collide
    // with a real Telegram message id (which are positive 32-bit ints).
    const h = crypto.createHash('sha256').update(relPath).digest();
    const n = h.readUInt32BE(0) || 1;
    return -n;
}

function resolveGroupId(folderName, configGroups) {
    if (!Array.isArray(configGroups)) return null;
    // 1. Exact ID match (folder name = numeric id, e.g. `-100123456`).
    for (const g of configGroups) {
        if (String(g.id) === folderName) return { id: String(g.id), name: g.name || folderName };
    }
    // 2. Sanitised-name match — what the downloader would produce.
    for (const g of configGroups) {
        const sanitised = sanitizeName(g.name || '');
        if (sanitised && sanitised === folderName) {
            return { id: String(g.id), name: g.name };
        }
    }
    return null;
}

let _reindexRunning = false;

/**
 * Walk `data/downloads/` and INSERT rows for files that the catalogue
 * doesn't already know about. Idempotent: existing `(group_id, message_id)`
 * pairs are skipped via `INSERT OR IGNORE`. Returns counts; calls
 * `onProgress` per group folder so the UI can stream a progress bar.
 *
 * Used by the Maintenance "Re-index from disk" action when files exist on
 * disk but `db.sqlite` is empty (typically after a Purge all, a fresh DB
 * after a v1 → v2 install, or a manual restore from a backups/ snapshot).
 *
 * @param {object[]} configGroups   `config.groups` — used to map folder
 *                                  names back to canonical Telegram group
 *                                  IDs. Folders without a match are stored
 *                                  with a synthetic `unknown:<name>` id so
 *                                  the gallery still surfaces them.
 * @param {(p:object) => void} [onProgress]  fires after each top-level
 *                                  folder finishes
 * @returns {Promise<{ scanned, added, skipped, errors, groups }>}
 */
export async function reindexFromDisk(configGroups, onProgress) {
    if (_reindexRunning) return { running: true };
    _reindexRunning = true;
    const result = {
        scanned: 0,
        added: 0,
        skipped: 0,
        errors: 0,
        groups: 0,
        startedAt: Date.now(),
    };
    try {
        // tgdl-core lists the tree (fs.readdir withFileTypes order and
        // kinds) and stats the files; the rules below are unchanged.
        const top = await walkTree(DOWNLOADS_DIR, { maxDepth: 1 });
        if (top.events.some((ev) => ev.t === 'e' && ev.p === '')) {
            // No downloads dir → nothing to do, succeed quietly.
            return { ...result, finishedAt: Date.now() };
        }
        const groupDirs = top.events
            .filter((ev) => ev.t === 'd' && ev.p !== '.deleted')
            .map((ev) => ev.p);
        result.groups = groupDirs.length;
        let groupsDone = 0;
        for (const folderName of groupDirs) {
            const resolved = resolveGroupId(folderName, configGroups);
            const groupId = resolved ? resolved.id : `unknown:${folderName}`;
            const groupName = resolved ? resolved.name : folderName;

            // Two-deep walk: <group>/<typeFolder>/<file>. Files at the
            // top level of <group>/ (rare, but happens with hand-pasted
            // archives) get bucketed by extension. Events arrive in the
            // order the nested readdir loops visited them.
            const groupAbs = path.join(DOWNLOADS_DIR, folderName);
            const { events } = await walkTree(groupAbs, { maxDepth: 2, stat: 'files' });
            const rootErr = events.find((ev) => ev.t === 'e' && ev.p === '');
            // An unreadable group folder fails the run, as its readdir did.
            if (rootErr) throw uvError(rootErr.code, 'scandir', groupAbs);
            let sinceYield = 0;
            for (const ev of events) {
                // Files only (links, devices and deeper folders are skipped;
                // an unreadable type folder has no entries).
                if (ev.t !== 'f' || ev.k !== 'file') continue;
                const parts = ev.p.split('/');
                const fileName = parts[parts.length - 1];
                if (fileName.endsWith('.part')) continue;
                if (parts.length === 2) {
                    const typeFolder = parts[0];
                    const folderType = TYPE_FOLDER_TO_FILETYPE[typeFolder] || null;
                    const fullAbs = path.join(DOWNLOADS_DIR, folderName, typeFolder, fileName);
                    const relPath = path.posix
                        .join(folderName, typeFolder, fileName)
                        .replace(/\\/g, '/');
                    _ingestOne({
                        result,
                        fullAbs,
                        st: ev,
                        relPath,
                        fileName,
                        groupId,
                        groupName,
                        fileType:
                            folderType || fileTypeFromExt(path.extname(fileName).toLowerCase()),
                    });
                } else if (parts.length === 1) {
                    const fullAbs = path.join(DOWNLOADS_DIR, folderName, fileName);
                    const relPath = path.posix.join(folderName, fileName).replace(/\\/g, '/');
                    _ingestOne({
                        result,
                        fullAbs,
                        st: ev,
                        relPath,
                        fileName,
                        groupId,
                        groupName,
                        fileType: fileTypeFromExt(path.extname(fileName).toLowerCase()),
                    });
                } else {
                    continue;
                }
                // Inserts are synchronous; let the event loop breathe.
                if (++sinceYield >= 256) {
                    sinceYield = 0;
                    await new Promise((r) => setImmediate(r));
                }
            }
            groupsDone++;
            try {
                if (typeof onProgress === 'function')
                    onProgress({
                        ...result,
                        processed: groupsDone,
                        total: groupDirs.length,
                        currentGroup: groupName,
                    });
            } catch {}
        }
        result.finishedAt = Date.now();
        try {
            _broadcast({ type: 'reindex_done', ...result });
        } catch {}
        return result;
    } finally {
        _reindexRunning = false;
    }
}

// `st` is the walk's fs.stat of the file: { ok, size, isFile } or { code }.
function _ingestOne({ result, fullAbs, st, relPath, fileName, groupId, groupName, fileType }) {
    result.scanned += 1;
    try {
        if (!st?.ok) throw uvError(st?.code || 'UNKNOWN', 'stat', fullAbs);
        if (!st.isFile || st.size <= 0) {
            result.skipped += 1;
            return;
        }
        const messageId = deriveMessageId(relPath, fileName);
        // INSERT OR IGNORE drops the row when (group_id, message_id) is
        // already present, so re-runs converge instead of doubling.
        const r = insertDownload({
            groupId,
            groupName,
            messageId,
            fileName,
            fileSize: st.size,
            fileType,
            filePath: relPath,
        });
        if (r && r.changes > 0) result.added += 1;
        else result.skipped += 1;
    } catch (e) {
        result.errors += 1;
        if (process.env.TGDL_DEBUG)
            console.warn('[reindex] ingest failed:', relPath, e?.message || e);
    }
}

export function isReindexRunning() {
    return _reindexRunning;
}
