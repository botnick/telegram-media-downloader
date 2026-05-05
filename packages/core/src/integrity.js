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
import { fileURLToPath } from 'url';
import { getDb, insertDownload } from './db.js';
import { sanitizeName } from './downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, '../../data/downloads');

let _running = false;
let _timer = null;
let _broadcast = () => {};

// Cached batch size, refreshed from config on each start() call.
let _batchSize = 64;

/**
 * Walk every row, stat each file, drop rows where the file is missing
 * or zero-bytes. Returns `{ scanned, pruned, sizeFixed }`. Concurrency-
 * guarded — a second call while the first is in-flight is a no-op.
 *
 * Optional `onProgress({ processed, total, stage, sizeFixed })` fires
 * after every batch so the verify-files admin page can render a
 * determinate bar without polling.
 */
export async function sweep(onProgress) {
    if (_running) return { scanned: 0, pruned: 0, skipped: true };
    _running = true;
    const result = { scanned: 0, pruned: 0, sizeFixed: 0 };
    const _emit = (extra) => {
        if (typeof onProgress !== 'function') return;
        try { onProgress({ ...result, ...(extra || {}) }); } catch {}
    };
    try {
        // Pull file_size too so we can repair NULL / 0 sizes from old
        // downloader versions that didn't always stat the file before
        // INSERT — that's the source of the "Disk: 1 MB for 8000 files"
        // status-bar nonsense the user kept seeing.
        const rows = getDb().prepare(
            `SELECT id, file_path, file_name, group_id, file_size FROM downloads WHERE file_path IS NOT NULL`
        ).all();
        result.scanned = rows.length;
        _emit({ processed: 0, total: rows.length, stage: 'scanning' });

        // Limit concurrency so a 100k-row DB doesn't fork 100k stat() calls.
        // Tunable via config.advanced.integrity.batchSize (read at start()).
        const BATCH = Math.max(1, _batchSize | 0) || 64;
        const deleteIds = [];
        // [{id, size}, ...] — rows whose actual on-disk size differs from
        // the stored value (or whose stored value is null/0). Backfilled
        // in one transaction at the end.
        const sizeFixes = [];
        let processed = 0;
        for (let i = 0; i < rows.length; i += BATCH) {
            const slice = rows.slice(i, i + BATCH);
            const checks = await Promise.all(slice.map(async (r) => {
                let rel = String(r.file_path || '').replace(/\\/g, '/');
                if (!rel) return null;
                // Tolerate the legacy `data/downloads/` prefix that some
                // older rows still carry — same fix that
                // safeResolveDownload() does in the request path.
                while (rel.startsWith('data/downloads/')) rel = rel.slice('data/downloads/'.length);
                // Defence-in-depth: refuse to stat anything that walks outside
                // DOWNLOADS_DIR. Rows with bogus paths get pruned.
                if (rel.includes('..') || path.isAbsolute(rel)) return r.id;
                const abs = path.join(DOWNLOADS_DIR, rel);
                try {
                    const st = await fs.stat(abs);
                    if (st.size <= 0) return r.id;
                    // Backfill or correct the stored file_size if it's
                    // null / 0 / wrong. Tolerance > 0 for the rare case
                    // an editor / re-encode legitimately changed bytes.
                    const stored = Number(r.file_size) || 0;
                    if (stored !== st.size) sizeFixes.push({ id: r.id, size: st.size });
                    return null;
                } catch {
                    return r.id;
                }
            }));
            for (const id of checks) if (id) deleteIds.push(id);
            processed += slice.length;
            _emit({ processed, total: rows.length, stage: 'scanning' });
        }

        if (sizeFixes.length) {
            _emit({ processed, total: rows.length, stage: 'fixing_sizes' });
            const upd = getDb().prepare('UPDATE downloads SET file_size = ? WHERE id = ?');
            const tx = getDb().transaction((items) => {
                for (const it of items) upd.run(it.size, it.id);
            });
            tx(sizeFixes);
            result.sizeFixed = sizeFixes.length;
        }

        if (deleteIds.length) {
            _emit({ processed, total: rows.length, stage: 'pruning' });
            const stmt = getDb().prepare(
                `DELETE FROM downloads WHERE id IN (${deleteIds.map(() => '?').join(',')})`
            );
            const r = stmt.run(...deleteIds);
            result.pruned = r.changes;
            try { _broadcast({ type: 'integrity_swept', pruned: result.pruned, scanned: result.scanned }); } catch {}
        }
        _emit({ processed: rows.length, total: rows.length, stage: 'done' });
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
    const result = { scanned: 0, added: 0, skipped: 0, errors: 0, groups: 0, startedAt: Date.now() };
    try {
        let topEntries = [];
        try {
            topEntries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
        } catch {
            // No downloads dir → nothing to do, succeed quietly.
            return { ...result, finishedAt: Date.now() };
        }
        const groupDirs = topEntries.filter((e) => e.isDirectory());
        result.groups = groupDirs.length;
        for (const gd of groupDirs) {
            const folderName = gd.name;
            const resolved = resolveGroupId(folderName, configGroups);
            const groupId = resolved ? resolved.id : `unknown:${folderName}`;
            const groupName = resolved ? resolved.name : folderName;

            // Two-deep walk: <group>/<typeFolder>/<file>. Files at the
            // top level of <group>/ (rare, but happens with hand-pasted
            // archives) get bucketed by extension.
            const subEntries = await fs.readdir(path.join(DOWNLOADS_DIR, folderName), { withFileTypes: true });
            for (const sub of subEntries) {
                if (sub.isDirectory()) {
                    const typeFolder = sub.name;
                    const folderType = TYPE_FOLDER_TO_FILETYPE[typeFolder] || null;
                    let files = [];
                    try {
                        files = await fs.readdir(path.join(DOWNLOADS_DIR, folderName, typeFolder), { withFileTypes: true });
                    } catch { continue; }
                    for (const f of files) {
                        if (!f.isFile()) continue;
                        const fullAbs = path.join(DOWNLOADS_DIR, folderName, typeFolder, f.name);
                        const relPath = path.posix.join(folderName, typeFolder, f.name).replace(/\\/g, '/');
                        await _ingestOne({ result, fullAbs, relPath, fileName: f.name,
                            groupId, groupName, fileType: folderType || fileTypeFromExt(path.extname(f.name).toLowerCase()) });
                    }
                } else if (sub.isFile()) {
                    const fullAbs = path.join(DOWNLOADS_DIR, folderName, sub.name);
                    const relPath = path.posix.join(folderName, sub.name).replace(/\\/g, '/');
                    await _ingestOne({ result, fullAbs, relPath, fileName: sub.name,
                        groupId, groupName, fileType: fileTypeFromExt(path.extname(sub.name).toLowerCase()) });
                }
            }
            try { if (typeof onProgress === 'function') onProgress({ ...result, currentGroup: groupName }); } catch {}
        }
        result.finishedAt = Date.now();
        try { _broadcast({ type: 'reindex_done', ...result }); } catch {}
        return result;
    } finally {
        _reindexRunning = false;
    }
}

async function _ingestOne({ result, fullAbs, relPath, fileName, groupId, groupName, fileType }) {
    result.scanned += 1;
    try {
        const st = await fs.stat(fullAbs);
        if (!st.isFile() || st.size <= 0) { result.skipped += 1; return; }
        const messageId = deriveMessageId(relPath, fileName);
        // INSERT OR IGNORE drops the row when (group_id, message_id) is
        // already present, so re-runs converge instead of doubling.
        const r = insertDownload({
            groupId, groupName, messageId,
            fileName, fileSize: st.size, fileType, filePath: relPath,
        });
        if (r && r.changes > 0) result.added += 1;
        else result.skipped += 1;
    } catch (e) {
        result.errors += 1;
        if (process.env.TGDL_DEBUG) console.warn('[reindex] ingest failed:', relPath, e?.message || e);
    }
}

export function isReindexRunning() { return _reindexRunning; }
