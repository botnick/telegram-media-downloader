import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import express from 'express';
import { loadConfig } from '../../config/manager.js';
import { getDb } from '../../core/db.js';
import { safeResolveDownload } from '../lib/resolve-download.js';
import { bestGroupName, formatBytes } from '../lib/format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../../data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

export function createDownloadsRouter({
    broadcast,
    log,
    jobTrackers,
    getDialogsNameCache,
    dialogsTypeFor,
}) {
    const router = express.Router();

    router.get('/downloads', async (req, res) => {
        try {
            const config = loadConfig();
            const configGroups = config.groups || [];
            const db = getDb();

            // CASE-filter "Unknown" / numeric-id placeholders BEFORE MAX so
            // a group with mixed rows ["Cool Channel", "Unknown"] returns
            // "Cool Channel" instead of the lexically-larger "Unknown".
            const rows = db
                .prepare(`
            SELECT group_id,
                   MAX(CASE
                         WHEN group_name IS NOT NULL
                          AND group_name != ''
                          AND group_name != 'Unknown'
                          AND group_name != 'unknown'
                          AND group_name NOT GLOB '-?[0-9]*'
                          AND group_name NOT GLOB 'Group [0-9]*'
                       THEN group_name END) AS best_name,
                   MAX(group_name) AS any_name,
                   COUNT(*) as count,
                   SUM(file_size) as size
              FROM downloads
             GROUP BY group_id
        `)
                .all();

            const dialogsNames = await getDialogsNameCache();

            const results = rows
                .map((r) => {
                    // Detect comment: groups and derive display info from the parent group.
                    // Telegram creates separate comment groups for channel posts; these are
                    // stored with a 'comment:' prefix in the group_id so we can distinguish
                    // them and display them as "<Channel Name> (comments)" in the sidebar.
                    const isCommentGroup =
                        typeof r.group_id === 'string' && r.group_id.startsWith('comment:');
                    const parentGroupId = isCommentGroup ? r.group_id.slice(8) : null;

                    const cfg = isCommentGroup
                        ? configGroups.find((g) => String(g.id) === parentGroupId)
                        : configGroups.find((g) => String(g.id) === r.group_id);

                    // Best-available: live Telegram dialogs name → config → DB → placeholder.
                    const name = isCommentGroup
                        ? bestGroupName(
                              parentGroupId,
                              cfg?.name,
                              r.best_name || r.any_name,
                              dialogsNames.get(String(parentGroupId)),
                          ) + ' (comments)'
                        : bestGroupName(
                              r.group_id,
                              cfg?.name,
                              r.best_name || r.any_name,
                              dialogsNames.get(String(r.group_id)),
                          );

                    const hasPhoto = isCommentGroup
                        ? existsSync(path.join(PHOTOS_DIR, `${parentGroupId}.jpg`))
                        : existsSync(path.join(PHOTOS_DIR, `${r.group_id}.jpg`));

                    return {
                        id: r.group_id,
                        name: name,
                        // Type drives the sidebar avatar's corner badge
                        // (channel = megaphone / group = group icon / user / bot).
                        // Prefer config (sticky), fall back to live-dialogs cache.
                        type: isCommentGroup
                            ? cfg?.type || dialogsTypeFor(parentGroupId)
                            : cfg?.type || dialogsTypeFor(r.group_id),
                        totalFiles: r.count,
                        sizeFormatted: formatBytes(r.size || 0),
                        photoUrl: hasPhoto
                            ? `/photos/${isCommentGroup ? parentGroupId : r.group_id}.jpg`
                            : null,
                        enabled: cfg ? cfg.enabled : false,
                    };
                })
                .filter(Boolean);

            res.json(results);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 5a. All-Media: paginated cross-group feed. Pre-v2.3.6 the SPA simulated
    // this by fanning out 20 per-group queries × 20 files = a hard cap of 400
    // files visible regardless of how big the library actually was. Now the DB
    // does the ORDER BY across every group, the SPA gets clean infinite-scroll,
    // and per-tab type filters (`?type=images|videos|documents|audio`) produce
    // accurate counts.
    router.get('/downloads/all', async (req, res) => {
        try {
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
            const type = req.query.type || 'all';
            const offset = (page - 1) * limit;
            // Pinned filter chip (`?pinned=1`) and "surface pinned at top"
            // setting (`?pinnedFirst=1`) — both opt-in, both default off so
            // existing callers behave identically.
            const pinnedOnly = req.query.pinned === '1' || req.query.pinned === 'true';
            const pinnedFirst = req.query.pinnedFirst === '1' || req.query.pinnedFirst === 'true';
            // Federation scope (Layer 1, v2.12+):
            //   ?include=local  — own files only (default; backward-compatible)
            //   ?include=peers  — own + every paired peer
            //   ?include=all    — alias for peers (kept for symmetry with the
            //                     /api/cluster/downloads contract)
            // Optional ?peerId=<id> further filters to a single peer's files —
            // sidebar foreign-group click hands the peer's id along.
            // Guest sessions are forced back to `local`: federation is admin-
            // only on the management surface (/maintenance/cluster, Settings →
            // Federation), so gallery scope follows the same rule. Without
            // this guard a guest hitting /api/downloads/all?include=peers
            // would expose every paired peer's catalog.
            const reqInclude =
                req.query.include === 'peers' || req.query.include === 'all'
                    ? req.query.include
                    : 'local';
            const include = req.role === 'guest' ? 'local' : reqInclude;
            const peerIdFilter =
                req.role !== 'guest' && req.query.peerId ? String(req.query.peerId) : null;
            const result = getAllDownloadsFederated(limit, offset, type, {
                pinnedOnly,
                pinnedFirst,
                include,
                ...(peerIdFilter ? { peerId: peerIdFilter } : {}),
            });

            // Same row → tile shape as `/api/downloads/:groupId` so the SPA
            // renderer is unchanged. Per-row group_name + group_id are
            // preserved on every tile.
            let config = {};
            try {
                config = loadConfig();
            } catch {
                /* ok — fall back to row.group_name */
            }
            const configGroups = new Map((config.groups || []).map((g) => [String(g.id), g]));
            // Build a peer-id → name lookup so federated rows can render a
            // human-readable "from {peer}" label without an extra round-trip.
            const peerNameMap = new Map();
            if (include !== 'local') {
                try {
                    for (const p of listPeers())
                        peerNameMap.set(String(p.peerId), p.name || p.peerId);
                } catch {
                    /* listPeers can throw if cluster module hasn't initialised — fall through */
                }
            }
            const files = result.files.map((row) => {
                const typeFolder =
                    row.file_type === 'photo'
                        ? 'images'
                        : row.file_type === 'video'
                          ? 'videos'
                          : row.file_type === 'audio'
                            ? 'audio'
                            : row.file_type === 'sticker'
                              ? 'stickers'
                              : 'documents';
                const stored = (row.file_path || '').replace(/\\/g, '/');
                const fallbackFolder = sanitizeName(
                    configGroups.get(String(row.group_id))?.name ||
                        row.group_name ||
                        String(row.group_id),
                );
                const fullPath =
                    stored && stored.includes('/')
                        ? stored
                        : `${fallbackFolder}/${typeFolder}/${row.file_name}`;
                const isPeerRow = row.peer_id && row.peer_id !== 'self';
                return {
                    id: row.id,
                    name: row.file_name,
                    path: row.file_path,
                    fullPath,
                    size: row.file_size,
                    sizeFormatted: formatBytes(row.file_size),
                    type: typeFolder,
                    extension: path.extname(row.file_name || ''),
                    modified: row.created_at,
                    groupId: row.group_id,
                    groupName:
                        configGroups.get(String(row.group_id))?.name || row.group_name || null,
                    pendingUntil: row.pending_until || null,
                    rescuedAt: row.rescued_at || null,
                    pinned: !!row.pinned,
                    // Federation surface — peer_id is 'self' for own rows,
                    // peer's id otherwise. peer_name is null for own; for
                    // peer rows it carries the human-readable display name
                    // (Cluster page → display name) so the SPA can render
                    // a "from {peer}" badge without /api/cluster/peers.
                    peer_id: row.peer_id || 'self',
                    peer_name: isPeerRow ? peerNameMap.get(String(row.peer_id)) || null : null,
                };
            });

            res.json({
                files,
                total: result.total,
                page,
                totalPages: Math.ceil(result.total / limit),
            });
        } catch (e) {
            console.error('GET /api/downloads/all:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // 5. Downloads Per Group (SQLite Pagination).
    // Reject the literal "search" segment up-front — Express matches routes in
    // declaration order, and there's a `GET /api/downloads/search` further down
    // that the SPA calls for free-text search. Without this guard the search
    // route would be shadowed and always return an empty group payload.
    router.get('/downloads/:groupId', async (req, res, next) => {
        if (req.params.groupId === 'search') return next();
        try {
            const { groupId } = req.params;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const type = req.query.type || 'all';
            const offset = (page - 1) * limit;

            // Find group name from config or DB to build correct folder path
            const config = loadConfig();
            const configGroup = (config.groups || []).find((g) => String(g.id) === String(groupId));
            const dbRow = getDb()
                .prepare(
                    'SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1',
                )
                .get(String(groupId));
            const groupFolder = sanitizeName(configGroup?.name || dbRow?.group_name || 'unknown');

            const pinnedOnly = req.query.pinned === '1' || req.query.pinned === 'true';
            const pinnedFirst = req.query.pinnedFirst === '1' || req.query.pinnedFirst === 'true';
            // Federation scope — same contract as /api/downloads/all. Guest
            // sessions are forced back to `local` so cluster-only data stays
            // admin-gated.
            const reqInclude =
                req.query.include === 'peers' || req.query.include === 'all'
                    ? req.query.include
                    : 'local';
            const include = req.role === 'guest' ? 'local' : reqInclude;
            const peerIdFilter =
                req.role !== 'guest' && req.query.peerId ? String(req.query.peerId) : null;
            const result = getDownloadsForGroupFederated(groupId, limit, offset, type, {
                pinnedOnly,
                pinnedFirst,
                include,
                ...(peerIdFilter ? { peerId: peerIdFilter } : {}),
            });

            // Build a peer-id → name lookup so federated rows can render a
            // human-readable "from {peer}" label.
            const peerNameMap = new Map();
            if (include !== 'local') {
                try {
                    for (const p of listPeers())
                        peerNameMap.set(String(p.peerId), p.name || p.peerId);
                } catch {
                    /* cluster not initialised — peer name stays null */
                }
            }

            // DB `file_path` stores the path RELATIVE to data/downloads (set
            // by downloader.js via path.relative(DOWNLOADS_DIR, …)). USE that
            // as the source of truth — re-deriving from sanitize(group.name)
            // breaks every file that was downloaded under a different folder
            // name (e.g. "Unknown" before the group was named, or a renamed
            // group whose old folder still has the old files).
            const files = result.files.map((row) => {
                // Map DB file_type to folder name (used only as a hint when
                // file_path is missing or invalid).
                const typeFolder =
                    row.file_type === 'photo'
                        ? 'images'
                        : row.file_type === 'video'
                          ? 'videos'
                          : row.file_type === 'audio'
                            ? 'audio'
                            : row.file_type === 'sticker'
                              ? 'stickers'
                              : 'documents';

                // Prefer the stored relative path. Normalise Windows-style
                // backslashes into forward slashes for the URL.
                const stored = (row.file_path || '').replace(/\\/g, '/');
                const fullPath =
                    stored && stored.includes('/')
                        ? stored
                        : `${groupFolder}/${typeFolder}/${row.file_name}`;

                const isPeerRow = row.peer_id && row.peer_id !== 'self';
                return {
                    id: row.id,
                    name: row.file_name,
                    path: row.file_path,
                    fullPath,
                    size: row.file_size,
                    sizeFormatted: formatBytes(row.file_size),
                    type: typeFolder,
                    extension: path.extname(row.file_name),
                    modified: row.created_at,
                    // Rescue Mode surface — null when not in rescue mode.
                    pendingUntil: row.pending_until || null,
                    rescuedAt: row.rescued_at || null,
                    pinned: !!row.pinned,
                    peer_id: row.peer_id || 'self',
                    peer_name: isPeerRow ? peerNameMap.get(String(row.peer_id)) || null : null,
                };
            });

            res.json({
                files,
                total: result.total,
                page,
                totalPages: Math.ceil(result.total / limit),
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Search across all downloads (filename + group name). Federated when the
    // caller passes ?include=peers — UNIONs filename / group_name LIKE matches
    // from peer_downloads on top of the local rows. Default is local-only so
    // non-cluster callers see no behaviour change.
    router.get('/downloads/search', async (req, res) => {
        try {
            const q = String(req.query.q || '').trim();
            if (!q) return res.json({ files: [], total: 0, page: 1, totalPages: 0 });
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
            const groupId = req.query.groupId ? String(req.query.groupId) : undefined;
            const reqInclude =
                req.query.include === 'peers' || req.query.include === 'all'
                    ? req.query.include
                    : 'local';
            // Guest sessions stay local-only — federation is admin-gated.
            const include = req.role === 'guest' ? 'local' : reqInclude;
            const r = searchDownloadsFederated(q, {
                limit,
                offset: (page - 1) * limit,
                groupId,
                include,
            });

            const config = loadConfig();
            const groupFolderById = new Map();
            for (const g of config.groups || [])
                groupFolderById.set(String(g.id), sanitizeName(g.name));

            // Peer name lookup for federated rows.
            const peerNameMap = new Map();
            if (include !== 'local') {
                try {
                    for (const p of listPeers())
                        peerNameMap.set(String(p.peerId), p.name || p.peerId);
                } catch {
                    /* cluster module not loaded — peer name stays null */
                }
            }

            const files = r.files.map((row) => {
                const folder =
                    groupFolderById.get(String(row.group_id)) ||
                    sanitizeName(row.group_name || 'unknown');
                const typeFolder =
                    row.file_type === 'photo'
                        ? 'images'
                        : row.file_type === 'video'
                          ? 'videos'
                          : row.file_type === 'audio'
                            ? 'audio'
                            : row.file_type === 'sticker'
                              ? 'stickers'
                              : 'documents';
                // Use the stored relative path when present (matches the actual
                // on-disk location even if the group has since been renamed).
                const stored = (row.file_path || '').replace(/\\/g, '/');
                const fullPath =
                    stored && stored.includes('/')
                        ? stored
                        : `${folder}/${typeFolder}/${row.file_name}`;
                const isPeerRow = row.peer_id && row.peer_id !== 'self';
                return {
                    id: row.id,
                    groupId: row.group_id,
                    groupName: row.group_name,
                    name: row.file_name,
                    fullPath,
                    size: row.file_size,
                    sizeFormatted: formatBytes(row.file_size),
                    type: typeFolder,
                    modified: row.created_at,
                    pendingUntil: row.pending_until || null,
                    rescuedAt: row.rescued_at || null,
                    peer_id: row.peer_id || 'self',
                    peer_name: isPeerRow ? peerNameMap.get(String(row.peer_id)) || null : null,
                };
            });
            res.json({ files, total: r.total, page, totalPages: Math.ceil(r.total / limit), q });
        } catch (e) {
            console.error('GET /api/downloads/search:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // Bulk delete by id list or fullPath list.
    // Bulk-delete by id and/or path — used by the gallery selection bar.
    // At N=5000 the unlink loop runs minutes; converted to fire-and-forget
    // so a Cloudflare timeout can't kill the request mid-stream. Shares the
    // `dedupDelete` tracker with the duplicate finder + gallery selection
    // (semantically same op, single-flight is the right behaviour).
    router.post('/downloads/bulk-delete', async (req, res) => {
        const { ids, paths } = req.body || {};
        const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
        const pathList = Array.isArray(paths) ? paths : [];
        if (!idList.length && !pathList.length) {
            return res.status(400).json({ error: 'ids or paths required' });
        }
        const tracker = jobTrackers.dedupDelete;
        const r = tracker.tryStart(async ({ onProgress }) => {
            // path → id resolution. Frontend sends forward-slash strings; the
            // downloader writes file_path with the OS-native separator (which
            // on Windows is `\`), so `DELETE WHERE file_path = ?` against the
            // raw frontend string never matches the row. Resolve to ids up
            // front via a slash-insensitive comparison, then merge into the
            // id-keyed delete path that already works everywhere. Files still
            // unlink off disk via the path because the OS treats `/` and `\`
            // identically on Windows path resolution.
            const resolvedIdsFromPaths = [];
            if (pathList.length) {
                const db = getDb();
                const stmt = db.prepare(
                    "SELECT id FROM downloads WHERE REPLACE(file_path, '\\', '/') = ?",
                );
                for (const p of pathList) {
                    const norm = String(p || '').replace(/\\/g, '/');
                    if (!norm) continue;
                    const row = stmt.get(norm);
                    if (row?.id) resolvedIdsFromPaths.push(row.id);
                }
            }
            const total = idList.length + pathList.length;
            let processed = 0;
            let unlinked = 0;
            onProgress({ processed: 0, total, stage: 'deleting_files' });
            for (const p of pathList) {
                const sr = await safeResolveDownload(p);
                if (sr.ok) {
                    try {
                        await fs.unlink(sr.real);
                        unlinked++;
                    } catch (e) {
                        if (e.code !== 'ENOENT') throw e;
                    }
                }
                processed += 1;
                if (processed % 50 === 0 || processed === total) {
                    onProgress({ processed, total, stage: 'deleting_files' });
                }
            }
            if (idList.length) {
                const db = getDb();
                // SELECT `file_path` so we use the same on-disk path the
                // downloader / thumbs / bulk-zip rely on. The previous
                // implementation re-built `<group>/<typeFolder>/<file_name>`
                // from scratch — that path matched ONLY when group rename,
                // sanitizeName output, and original folder layout all aligned;
                // any drift (group renamed in UI, special chars sanitised
                // differently, custom file_path from the downloader) made
                // safeResolveDownload return ENOENT and the file survived
                // on disk while the DB row got dropped.
                const rows = db
                    .prepare(
                        `SELECT id, group_id, group_name, file_name, file_type, file_path FROM downloads WHERE id IN (${idList.map(() => '?').join(',')})`,
                    )
                    .all(...idList);
                const config = loadConfig();
                const folderById = new Map();
                for (const g of config.groups || [])
                    folderById.set(String(g.id), sanitizeName(g.name));
                for (const row of rows) {
                    // Prefer the stored file_path — it's the authoritative
                    // record of where the downloader wrote the file. Fall back
                    // to the reconstructed candidate ONLY when file_path is
                    // missing (legacy rows pre-v1.x that never had the column).
                    const stored = (row.file_path || '').replace(/\\/g, '/');
                    let candidate = stored;
                    if (!candidate || !candidate.includes('/')) {
                        const folder =
                            folderById.get(String(row.group_id)) ||
                            sanitizeName(row.group_name || 'unknown');
                        const typeFolder =
                            row.file_type === 'photo'
                                ? 'images'
                                : row.file_type === 'video'
                                  ? 'videos'
                                  : row.file_type === 'audio'
                                    ? 'audio'
                                    : row.file_type === 'sticker'
                                      ? 'stickers'
                                      : 'documents';
                        candidate = `${folder}/${typeFolder}/${row.file_name}`;
                    }
                    const sr = await safeResolveDownload(candidate);
                    if (sr.ok) {
                        try {
                            await fs.unlink(sr.real);
                            unlinked++;
                        } catch (e) {
                            if (e.code !== 'ENOENT') throw e;
                        }
                    }
                    processed += 1;
                    if (processed % 50 === 0 || processed === total) {
                        onProgress({ processed, total, stage: 'deleting_files' });
                    }
                }
            }
            // Merge frontend ids + ids we just resolved from paths into a
            // single dedup set so we do not delete a row twice + so the
            // thumb purge loop hits every removed download.
            const allIds = Array.from(new Set([...idList, ...resolvedIdsFromPaths]));
            const dbDeleted = deleteDownloadsBy({ ids: allIds });
            onProgress({ processed: total, total, stage: 'purging_thumbs' });
            for (const id of allIds) {
                try {
                    await purgeThumbsForDownload(id);
                } catch {}
            }
            broadcast({ type: 'bulk_delete', unlinked, dbDeleted, ids: allIds });
            return { unlinked, dbDeleted, requested: total };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'A bulk delete is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true, queued: idList.length + pathList.length });
    });

    // Toggle the `pinned` flag on a single download row. Pinned rows survive
    // auto-rotation and (optionally) sort to the top of the gallery. Body is
    // `{ pinned: true | false }` — explicit boolean so a missing key is a 400
    // rather than a silent no-op.
    router.post('/downloads/:id/pin', async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
        const { pinned } = req.body || {};
        if (typeof pinned !== 'boolean') {
            return res.status(400).json({ error: 'Body must include `pinned` (boolean)' });
        }
        const row = getDownloadById(id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        const ok = setDownloadPinned(id, pinned);
        if (!ok) return res.status(500).json({ error: 'Update failed' });
        broadcast({ type: 'download_pinned', id, pinned });
        res.json({ success: true, id, pinned });
    });

    // Streaming bulk download as a ZIP. Body: `{ ids: [1,2,3] }`. Server walks
    // each id, resolves its on-disk file via the same safe-resolver every other
    // route uses, and pipes a STORE-mode (no compression) ZIP to the response.
    // Filename: `tgdl-<groupNameOr"library">-<count>files-<timestamp>.zip`.
    //
    // Cross-platform: pure JS, no native deps, no archiver package. Streams
    // each file from disk so a 5 GB selection doesn't OOM the server.
    router.post('/downloads/bulk-zip', async (req, res) => {
        try {
            const { ids } = req.body || {};
            const idList = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
            if (idList.length === 0) return res.status(400).json({ error: 'ids required' });

            // Lazy-load to keep the cold start cheap when the bulk-zip endpoint
            // is never called.
            const { ZipStream, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, safeArchiveName } = await import(
                '../../core/zip-stream.js'
            );

            if (idList.length > ZIP_MAX_ENTRIES) {
                return res.status(413).json({
                    error: `Too many files in one ZIP (cap ${ZIP_MAX_ENTRIES}). Split into smaller batches.`,
                });
            }

            // Resolve everything up-front so we can size-check + stream sensibly.
            const db = getDb();
            const placeholders = idList.map(() => '?').join(',');
            const rows = db
                .prepare(
                    `SELECT id, group_id, group_name, file_name, file_size, file_type, file_path FROM downloads WHERE id IN (${placeholders})`,
                )
                .all(...idList);

            if (rows.length === 0) return res.status(404).json({ error: 'No matching files' });

            let configGroups = new Map();
            try {
                const cfg = loadConfig();
                for (const g of cfg.groups || []) configGroups.set(String(g.id), g);
            } catch {
                /* fall back to row.group_name */
            }

            // Build resolved entries. Each entry knows its abs path, the
            // archive-relative name we want to store it under, and the size.
            const entries = [];
            let totalBytes = 0;
            const seenNames = new Set();
            for (const row of rows) {
                const folder = sanitizeName(
                    configGroups.get(String(row.group_id))?.name ||
                        row.group_name ||
                        String(row.group_id || 'group'),
                );
                const typeFolder =
                    row.file_type === 'photo'
                        ? 'images'
                        : row.file_type === 'video'
                          ? 'videos'
                          : row.file_type === 'audio'
                            ? 'audio'
                            : row.file_type === 'sticker'
                              ? 'stickers'
                              : 'documents';
                const stored = (row.file_path || '').replace(/\\/g, '/');
                const candidate =
                    stored && stored.includes('/')
                        ? stored
                        : `${folder}/${typeFolder}/${row.file_name}`;
                const sr = await safeResolveDownload(candidate);
                if (!sr.ok) continue;

                const baseName = safeArchiveName(row.file_name || `file-${row.id}`);
                // Name collisions get a numeric suffix so two photos with the
                // same Telegram filename land as `foo.jpg` and `foo (1).jpg`.
                let archiveName = `${folder}/${baseName}`;
                let n = 1;
                while (seenNames.has(archiveName)) {
                    const ext = path.extname(baseName);
                    const stem = baseName.slice(0, baseName.length - ext.length);
                    archiveName = `${folder}/${stem} (${n})${ext}`;
                    n++;
                }
                seenNames.add(archiveName);
                entries.push({ absPath: sr.real, archiveName, size: row.file_size || 0 });
                totalBytes += row.file_size || 0;
            }

            if (entries.length === 0) {
                return res.status(404).json({ error: 'No accessible files in selection' });
            }
            if (totalBytes > ZIP_MAX_BYTES) {
                return res.status(413).json({
                    error: `Selection exceeds 4 GiB ZIP cap (${formatBytes(totalBytes)}). Split into smaller batches.`,
                });
            }

            // Pretty filename for the download. Use the first entry's group
            // folder when every file is from the same group, otherwise fall
            // back to "library".
            const firstGroup = entries[0].archiveName.split('/')[0];
            const allSameGroup = entries.every((e) => e.archiveName.startsWith(firstGroup + '/'));
            const labelGroup = allSameGroup ? firstGroup : 'library';
            const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
            const archiveBase = `tgdl-${safeArchiveName(labelGroup)}-${entries.length}files-${ts}.zip`;

            res.setHeader('Content-Type', 'application/zip');
            // Node HTTP setHeader() rejects non-Latin1 characters in header
            // values — a Thai/CJK group name would throw ERR_INVALID_CHAR.
            // RFC 5987: send a sanitised ASCII fallback in `filename=` AND
            // the UTF-8 percent-encoded original in `filename*=`. Modern
            // browsers pick the latter; ancient ones fall back to the ASCII.
            const asciiArchive = archiveBase.replace(/[^\x20-\x7e]/g, '_');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${asciiArchive}"; filename*=UTF-8''${encodeURIComponent(archiveBase)}`,
            );
            // Streaming archive — no Content-Length, must disable any
            // intermediate buffering. Cache-Control no-store so a CDN doesn't
            // try to cache a multi-GB blob keyed on the POST body.
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Transfer-Encoding', 'chunked');

            const zip = new ZipStream();
            zip.pipe(res);
            try {
                for (const e of entries) {
                    if (res.destroyed || res.writableEnded) break;
                    await zip.addFile(e.absPath, e.archiveName);
                }
                await zip.finalize();
            } catch (err) {
                if (!res.headersSent) res.status(500).json({ error: err.message });
                else res.destroy(err);
            }
        } catch (err) {
            console.error('POST /api/downloads/bulk-zip:', err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
            else res.destroy(err);
        }
    });

    // 6. Delete File (Physical + DB)
    router.delete('/file', async (req, res) => {
        try {
            const filePath = req.query.path;
            if (!filePath) return res.status(400).json({ error: 'Path required' });

            const r = await safeResolveDownload(filePath);
            if (!r.ok) {
                const status = r.reason === 'missing' ? 404 : 403;
                return res
                    .status(status)
                    .json({ error: r.reason === 'missing' ? 'File not found' : 'Access denied' });
            }

            await fs.unlink(r.real);
            console.log(`🗑️ Deleted: ${filePath}`);

            // Remove from DB (by basename — the DB stores filenames, not paths).
            // Capture matching ids first so we can wipe their cached thumbnails;
            // a stale thumb pointing at a deleted file would otherwise serve
            // bytes from cache until the next "Rebuild thumbnails".
            const db = getDb();
            const fileName = path.basename(r.real);
            const matchingIds = db
                .prepare('SELECT id FROM downloads WHERE file_name = ?')
                .all(fileName)
                .map((row) => row.id);
            db.prepare('DELETE FROM downloads WHERE file_name = ?').run(fileName);
            for (const id of matchingIds) {
                try {
                    await purgeThumbsForDownload(id);
                } catch {}
            }

            broadcast({ type: 'file_deleted', path: filePath });
            res.json({ success: true });
        } catch (error) {
            if (error.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
            console.error('DELETE /api/file:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // 6a. Archive listing — used by the in-app viewer to preview the
    // contents of `.zip` / `.tar` / `.tar.gz` / `.tgz` / `.7z` / `.rar`
    // downloads inline (a tree of names + sizes) instead of forcing the
    // operator to download the whole archive first.
    //
    // Strategy: shell out to whichever extractor is available on the host
    // (`unzip -l` for zip, `tar -tvf` for tarballs, `7z l` for 7z / rar).
    // `execFile` with a fixed argv vector means the resolved disk path is
    // passed as a single argument — no shell interpolation, so a filename
    // that contains shell metacharacters is impossible to weaponise. The
    // only path that ever reaches the binary is one safeResolveDownload
    // has already cleared (no `..`, no symlink escape, anchored inside
    // `data/downloads/`). 5 s timeout caps a hostile archive that prints
    // 100k entries; output is hard-capped at 8 MB stdout / 256 KB stderr.
    //
    // Admin-only by virtue of the default-deny guest gate — this is a
    // metadata read, but it spawns a process so we treat it as an admin
    // surface for safety.
    router.get('/files/archive-list', async (req, res) => {
        try {
            const filePath = req.query.path;
            if (typeof filePath !== 'string' || !filePath) {
                return res.status(400).json({ error: 'path required' });
            }
            const r = await safeResolveDownload(filePath);
            if (!r.ok) {
                const status = r.reason === 'missing' ? 404 : 403;
                return res
                    .status(status)
                    .json({ error: r.reason === 'missing' ? 'File not found' : 'Forbidden' });
            }

            const lower = r.real.toLowerCase();
            let cmd;
            let args;
            let parser;
            if (lower.endsWith('.zip')) {
                cmd = 'unzip';
                args = ['-l', '--', r.real];
                parser = _parseUnzipOutput;
            } else if (
                lower.endsWith('.tar') ||
                lower.endsWith('.tar.gz') ||
                lower.endsWith('.tgz') ||
                lower.endsWith('.tar.bz2') ||
                lower.endsWith('.tbz') ||
                lower.endsWith('.tbz2') ||
                lower.endsWith('.tar.xz') ||
                lower.endsWith('.txz')
            ) {
                cmd = 'tar';
                args = ['-tvf', r.real];
                parser = _parseTarOutput;
            } else if (lower.endsWith('.7z') || lower.endsWith('.rar')) {
                cmd = '7z';
                args = ['l', '-slt', '--', r.real];
                parser = _parse7zOutput;
            } else if (lower.endsWith('.gz') || lower.endsWith('.bz2') || lower.endsWith('.xz')) {
                // Single-stream compression (no archive index). We can't list
                // contents — surface a friendly placeholder so the client can
                // render "single-stream compression; download to expand".
                return res.json({
                    entries: [],
                    supported: false,
                    reason: 'single_stream',
                    name: path.basename(r.real),
                });
            } else {
                return res.json({
                    entries: [],
                    supported: false,
                    reason: 'unknown_format',
                    name: path.basename(r.real),
                });
            }

            const { execFile } = await import('node:child_process');
            const { stdout, stderr, code } = await new Promise((resolve) => {
                try {
                    execFile(
                        cmd,
                        args,
                        { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
                        (err, stdout, stderr) => {
                            resolve({
                                stdout: String(stdout || ''),
                                stderr: String(stderr || ''),
                                code: err ? err.code || 1 : 0,
                                spawnErr: err && err.code === 'ENOENT' ? err : null,
                            });
                        },
                    );
                } catch (spawnErr) {
                    resolve({ stdout: '', stderr: '', code: 1, spawnErr });
                }
            });

            if (code !== 0 && (!stdout || stdout.length === 0)) {
                // Tool is missing or the archive is malformed. Either way, give
                // the operator a graceful fallback instead of a stack trace.
                const missing = String(stderr).includes('ENOENT') || stderr.includes('not found');
                return res.json({
                    entries: [],
                    supported: false,
                    reason: missing ? 'tool_missing' : 'list_failed',
                    tool: cmd,
                    name: path.basename(r.real),
                });
            }

            const entries = parser(stdout).slice(0, 5000); // cap rendered rows
            res.json({
                entries,
                supported: true,
                total: entries.length,
                name: path.basename(r.real),
                tool: cmd,
            });
        } catch (error) {
            console.error('GET /api/files/archive-list:', error);
            res.status(500).json({ error: error?.message || 'Internal error' });
        }
    });

    // Parse `unzip -l` output:
    //     Archive:  foo.zip
    //       Length      Date    Time    Name
    //     ---------  ---------- -----   ----
    //          1234  2024-04-01 12:00   path/to/file.txt
    //             0  2024-04-01 12:00   path/to/
    //     ---------                     -------
    //          1234                     1 file
    function _parseUnzipOutput(text) {
        const lines = String(text).split(/\r?\n/);
        const out = [];
        let inBody = false;
        for (const line of lines) {
            if (/^-+\s+-+/.test(line)) {
                inBody = !inBody;
                continue;
            }
            if (!inBody) continue;
            // `length date time name` — name may contain spaces.
            const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/);
            if (!m) continue;
            const size = Number(m[1]);
            const name = m[2];
            if (!name) continue;
            out.push({ name, size: Number.isFinite(size) ? size : 0, isDir: name.endsWith('/') });
        }
        return out;
    }

    // Parse `tar -tvf` output, both BSD + GNU dialects:
    //     -rw-r--r--  0 user  staff   1234 Apr 01 12:00 path/to/file.txt
    //     drwxr-xr-x  0 user  staff      0 Apr 01 12:00 path/to/
    function _parseTarOutput(text) {
        const lines = String(text).split(/\r?\n/);
        const out = [];
        for (const line of lines) {
            if (!line.trim()) continue;
            // Split on whitespace, last token (or trailing slash-token group) is the name.
            // tar's verbose format has the name as the LAST whitespace-delimited
            // field except when there's a link target (`-> dst`). Grab everything
            // after the size+date timestamp.
            //   <mode> <links> <owner> <size> <month> <day> <year-or-time> <name>
            const m = line.match(
                /^(\S)\S*\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+?)(\s+->\s+.+)?$/,
            );
            if (!m) continue;
            const isDir = m[1] === 'd' || m[3].endsWith('/');
            out.push({ name: m[3], size: Number(m[2]) || 0, isDir });
        }
        return out;
    }

    // Parse `7z l -slt` output (line-tagged form):
    //     Path = path/to/file.txt
    //     Size = 1234
    //     ...
    //     Attributes = A
    function _parse7zOutput(text) {
        const lines = String(text).split(/\r?\n/);
        const out = [];
        let cur = null;
        let inBody = false;
        for (const line of lines) {
            if (/^---/.test(line)) {
                inBody = true;
                continue;
            }
            if (!inBody) continue;
            if (!line.trim()) {
                if (cur && cur.name) out.push(cur);
                cur = null;
                continue;
            }
            const m = line.match(/^(\w[\w ]*?)\s*=\s*(.*)$/);
            if (!m) continue;
            if (!cur) cur = { name: '', size: 0, isDir: false };
            const key = m[1];
            const val = m[2];
            if (key === 'Path') cur.name = val;
            else if (key === 'Size') cur.size = Number(val) || 0;
            else if (key === 'Attributes' && val.includes('D')) cur.isDir = true;
        }
        if (cur && cur.name) out.push(cur);
        return out;
    }

    // 6b. Purge Group (Files + DB + Config + Photo — No Trace)
    //
    // Fire-and-forget — a chat with 10k files takes minutes of disk I/O to
    // rm. POST returns immediately; per-group tracker key (`group_purge_*`)
    // allows multi-flight across distinct groups while preventing a
    // double-click on the same row from firing twice. Status endpoint:
    // `GET /api/groups/:id/purge/status`.

    return router;
}
