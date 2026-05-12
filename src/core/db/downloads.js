import { getDb } from '../db.js';

// ---- Share links ----------------------------------------------------------

/**
 * Insert a new share-link row and return its id + creation timestamp.
 * The signed URL itself is built by `share.js` after this returns; this
 * table is purely the revocation/audit source of truth.
 */
export function createShareLink({ downloadId, expiresAt, label = null }) {
    const now = Date.now();
    const stmt = getDb().prepare(`
        INSERT INTO share_links (download_id, created_at, expires_at, label, access_count)
        VALUES (?, ?, ?, ?, 0)
    `);
    const r = stmt.run(Number(downloadId), now, Number(expiresAt), label || null);
    return { id: r.lastInsertRowid, createdAt: now };
}

/**
 * Lookup the row that backs a /share/<id> request. Returns null when the
 * row doesn't exist OR is revoked OR is expired — the verifier treats
 * "not found" as 401 across the board so an attacker can't tell the
 * three apart by timing/response shape.
 */
export function getShareLinkForServe(id, now = Date.now()) {
    const row = getDb()
        .prepare(`
        SELECT s.*, d.file_path, d.file_name, d.file_type, d.file_size
          FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         WHERE s.id = ?
    `)
        .get(Number(id));
    if (!row) return null;
    if (row.revoked_at != null) return { row, reason: 'revoked' };
    // expires_at === 0 is the "never expires" sentinel — the admin opted
    // out of the time-based gate at mint time. Revocation still works.
    if (row.expires_at !== 0 && row.expires_at <= now) {
        return { row, reason: 'expired' };
    }
    return { row, reason: null };
}

/**
 * Bump the access counter + last_accessed_at after a successful serve.
 * Cheap single-row UPDATE; safe to call inside the request handler.
 */
export function bumpShareLinkAccess(id) {
    try {
        getDb()
            .prepare(`
            UPDATE share_links
               SET access_count = access_count + 1,
                   last_accessed_at = ?
             WHERE id = ?
        `)
            .run(Date.now(), Number(id));
    } catch {
        /* non-fatal — bytes already on the wire */
    }
}

export function revokeShareLink(id) {
    const r = getDb()
        .prepare(`
        UPDATE share_links
           SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL
    `)
        .run(Date.now(), Number(id));
    return r.changes > 0;
}

/**
 * List share-links. Pass `{ downloadId }` to filter to one file (used by
 * the per-file Share sheet); omit it for the admin's "all shares" sheet.
 * Joins the underlying download so the UI can render the file name +
 * group context without a second round-trip.
 */
export function listShareLinks({
    downloadId = null,
    includeRevoked = true,
    limit = 500,
    offset = 0,
    search = null,
} = {}) {
    const where = [];
    const args = [];
    if (downloadId != null) {
        where.push('s.download_id = ?');
        args.push(Number(downloadId));
    }
    if (!includeRevoked) where.push('s.revoked_at IS NULL');
    if (typeof search === 'string' && search.trim()) {
        // Free-text filter — used by the Maintenance "Active share links"
        // sheet so a 50 k-row library can land on a specific file without
        // pulling everything across the wire. Match on file name, label,
        // group name (LIKE; case-insensitive via SQLite default collation
        // for ASCII; Thai / CJK still match substring).
        where.push('(s.label LIKE ? OR d.file_name LIKE ? OR d.group_name LIKE ?)');
        const q = `%${String(search).trim()}%`;
        args.push(q, q, q);
    }
    const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
    const off = Math.max(0, Number(offset) || 0);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sql = `
        SELECT s.id, s.download_id, s.created_at, s.expires_at, s.revoked_at,
               s.label, s.last_accessed_at, s.access_count,
               d.file_name, d.file_type, d.file_size, d.group_id, d.group_name
          FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         ${whereSql}
         ORDER BY s.created_at DESC
         LIMIT ? OFFSET ?
    `;
    return getDb()
        .prepare(sql)
        .all(...args, lim, off);
}

/**
 * Count share-links matching the same filter set as `listShareLinks`. Used
 * by the paginated `/api/share/links` endpoint to render a `total` /
 * `hasMore` envelope without a second round trip.
 */
export function countShareLinks({ downloadId = null, includeRevoked = true, search = null } = {}) {
    const where = [];
    const args = [];
    if (downloadId != null) {
        where.push('s.download_id = ?');
        args.push(Number(downloadId));
    }
    if (!includeRevoked) where.push('s.revoked_at IS NULL');
    if (typeof search === 'string' && search.trim()) {
        where.push('(s.label LIKE ? OR d.file_name LIKE ? OR d.group_name LIKE ?)');
        const q = `%${String(search).trim()}%`;
        args.push(q, q, q);
    }
    const sql = `
        SELECT COUNT(*) AS n FROM share_links s
          JOIN downloads d ON d.id = s.download_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `;
    return (
        getDb()
            .prepare(sql)
            .get(...args).n || 0
    );
}

// ---- Downloads ------------------------------------------------------------

export function insertDownload(data) {
    const row = {
        groupId: data.groupId,
        groupName: data.groupName ?? null,
        messageId: data.messageId,
        fileName: data.fileName ?? null,
        fileSize: data.fileSize ?? null,
        fileType: data.fileType ?? null,
        filePath: data.filePath ?? null,
        ttlSeconds: data.ttlSeconds ?? null,
        fileHash: data.fileHash ?? null,
        // Rescue Mode: when set, the rescue sweeper auto-deletes this row
        // after the timestamp unless the source is deleted first.
        pendingUntil: data.pendingUntil ?? null,
    };
    const stmt = getDb().prepare(`
        INSERT OR IGNORE INTO downloads (
            group_id, group_name, message_id, file_name, file_size, file_type, file_path, ttl_seconds, file_hash, pending_until
        ) VALUES (
            @groupId, @groupName, @messageId, @fileName, @fileSize, @fileType, @filePath, @ttlSeconds, @fileHash, @pendingUntil
        )
    `);
    return stmt.run(row);
}

/**
 * Mark a row as rescued — the source message was deleted on Telegram, so
 * the local file gets to live forever. Clears pending_until so the rescue
 * sweeper skips it. Idempotent: a second call with the same id is a no-op.
 *
 * @param {string|number} groupId
 * @param {number} messageId
 * @returns {number} rows updated (0 or 1; >1 only if duplicate inserts exist)
 */
export function markRescued(groupId, messageId) {
    const now = Date.now();
    const r = getDb()
        .prepare(`
            UPDATE downloads
               SET rescued_at = ?, pending_until = NULL
             WHERE group_id = ? AND message_id = ?
               AND rescued_at IS NULL
        `)
        .run(now, String(groupId), Number(messageId));
    return r.changes;
}

/**
 * Rows whose pending window has elapsed without a source-delete event.
 * The rescue sweeper unlinks the file + drops the row for each one.
 */
export function getExpiredPending(now = Date.now()) {
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, pending_until
              FROM downloads
             WHERE pending_until IS NOT NULL
               AND pending_until < ?
               AND rescued_at IS NULL
             ORDER BY pending_until ASC
             LIMIT 5000
        `)
        .all(Number(now));
}

/**
 * Counters for the Rescue panel in the SPA. `lastSweepCleared` is updated
 * by the sweeper via setRescueLastSweep().
 */
let _rescueLastSwept = 0;
export function setRescueLastSweep(n) {
    _rescueLastSwept = Number(n) || 0;
}
export function getRescueStats() {
    const db = getDb();
    const pending = db
        .prepare(
            `SELECT COUNT(*) as c FROM downloads WHERE pending_until IS NOT NULL AND rescued_at IS NULL`,
        )
        .get().c;
    const rescued = db
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE rescued_at IS NOT NULL`)
        .get().c;
    return { pending, rescued, lastSweepCleared: _rescueLastSwept };
}

/**
 * Lightweight dedup that catches the same file re-uploaded under a new
 * message_id. Returns true if (group_id, file_name, file_size) already
 * exists. Cheap thanks to the (group_id, file_name, file_size) index.
 */
export function fileAlreadyStored(groupId, fileName, fileSize) {
    if (!fileName || !fileSize) return false;
    const r = _prep(
        'SELECT 1 FROM downloads WHERE group_id = ? AND file_name = ? AND file_size = ? LIMIT 1',
    ).get(String(groupId), String(fileName), Number(fileSize));
    return !!r;
}

// Hot-path prepared-statement cache. `isDownloaded()` is called per message
// in every monitor pass and per row by the dedup pre-check, so re-preparing
// the same SQL each call was a measurable parse cost. The cache is lazily
// populated on first DB access since `getDb()` is also lazy.
const _stmtCache = new Map();
function _prep(sql) {
    let s = _stmtCache.get(sql);
    if (!s) {
        s = getDb().prepare(sql);
        _stmtCache.set(sql, s);
    }
    return s;
}

export function isDownloaded(groupId, messageId) {
    return !!_prep('SELECT 1 FROM downloads WHERE group_id = ? AND message_id = ? LIMIT 1').get(
        String(groupId),
        Number(messageId),
    );
}

/**
 * Min + max message_id for one group in the downloads table.
 *
 * Powers the v2.3.34 smart-resume path in the history backfill: we tell
 * gramJS `iterMessages({ maxId: minMessageId - 1 })` so the iterator
 * skips every message we already have on disk and resumes from the
 * oldest hole. Same idea in reverse with `minId: maxMessageId + 1` for
 * the post-monitor-restart catch-up flow.
 *
 * Returns `{ minMessageId: null, maxMessageId: null, count: 0 }` for an
 * empty group so the caller can default to "first-time backfill" (no
 * range filter, iterate from newest).
 */
export function getMessageIdRange(groupId) {
    const r = getDb()
        .prepare(`
        SELECT MIN(message_id) AS min_id, MAX(message_id) AS max_id, COUNT(*) AS n
          FROM downloads
         WHERE group_id = ?
    `)
        .get(String(groupId));
    return {
        minMessageId: r?.min_id ?? null,
        maxMessageId: r?.max_id ?? null,
        count: r?.n ?? 0,
    };
}

/**
 * All-Media query — same shape as getDownloads() but spans every group, with
 * the per-row group_id + group_name preserved so the gallery can paint the
 * right tile and the viewer can route back to the source chat. Powers the
 * `/api/downloads/all` endpoint that the All-Media surface uses for true
 * infinite-scroll across the full library (previous All-Media path was
 * capped at 20 groups × 20 files = ~400 max — see v2.3.6 blocker).
 */
export function getAllDownloads(limit = 50, offset = 0, type = 'all', opts = {}) {
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const typeMap = { images: 'photo', videos: 'video', documents: 'document', audio: 'audio' };
    const clauses = [];
    const params = [];
    if (type !== 'all' && typeMap[type]) {
        clauses.push('file_type = ?');
        params.push(typeMap[type]);
    }
    if (opts.pinnedOnly) {
        clauses.push('COALESCE(pinned, 0) = 1');
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    // `pinnedFirst` surfaces pinned rows above the rest while keeping
    // chronological order within each group. The default sort is unchanged
    // so existing callers behave identically.
    const orderBy = opts.pinnedFirst
        ? 'COALESCE(pinned, 0) DESC, datetime(created_at) DESC, id DESC'
        : 'datetime(created_at) DESC, id DESC';
    const rows = getDb()
        .prepare(`SELECT * FROM downloads${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(...params, lim, off);
    const total = getDb()
        .prepare(`SELECT COUNT(*) AS c FROM downloads${where}`)
        .get(...params).c;
    return { files: rows, total };
}

export function getDownloads(groupId, limit = 50, offset = 0, type = 'all', opts = {}) {
    let query = 'SELECT * FROM downloads WHERE group_id = ?';
    const params = [groupId];

    if (type !== 'all') {
        const typeMap = {
            images: 'photo',
            videos: 'video',
            documents: 'document',
            audio: 'audio',
        };
        // Use LIKE for flexibility or map precisely
        if (typeMap[type]) {
            query += ' AND file_type = ?';
            params.push(typeMap[type]);
        }
    }

    if (opts.pinnedOnly) query += ' AND COALESCE(pinned, 0) = 1';

    query += opts.pinnedFirst
        ? ' ORDER BY COALESCE(pinned, 0) DESC, created_at DESC LIMIT ? OFFSET ?'
        : ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = getDb().prepare(query);
    const rows = stmt.all(...params);

    // Count total for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM downloads WHERE group_id = ?';
    const countParams = [groupId];

    // We reuse the type filter logic for count but it's cleaner to separate or build dynamically
    // For simplicity here:
    if (params.length > 3) {
        // If type filter was added
        countQuery += ' AND file_type = ?';
        countParams.push(params[1]); // existing type param
    }

    const total = getDb()
        .prepare(countQuery)
        .get(...countParams).total;

    return { files: rows, total };
}

/**
 * Full-text-ish search over downloaded files. LIKE-based; cheap on the
 * sub-100k row counts we expect.
 *
 * @param {string} query  user input
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.groupId]  optional restrict to one group
 */
export function searchDownloads(query, opts = {}) {
    const limit = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const q = `%${String(query || '').trim()}%`;
    const params = [q, q];
    let where = '(file_name LIKE ? OR group_name LIKE ?)';
    if (opts.groupId) {
        where += ' AND group_id = ?';
        params.push(String(opts.groupId));
    }
    const rows = getDb()
        .prepare(`SELECT * FROM downloads WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    const total = getDb()
        .prepare(`SELECT COUNT(*) as c FROM downloads WHERE ${where}`)
        .get(...params).c;
    return { files: rows, total };
}

// ---------------------------------------------------------------------------
// Federated gallery helpers — same pagination + filter contract as the
// local-only versions above, but UNION ALL with `peer_downloads`. Each row
// carries a `peer_id` column (`'self'` for local, peer's id for federated)
// + a `peer_name` column (always NULL — server.js stamps it after the
// query by joining the in-memory peers map). Used by /api/downloads/all,
// /api/downloads/:groupId, /api/downloads/search when the caller passes
// ?include=peers or ?include=all. The local-only entry points still call
// the original helpers so non-cluster installs see no behaviour change.
//
// Column alignment notes:
//   - peer_downloads.remote_id is aliased to `id` so client-side row
//     handling can stay column-symmetric. Note: peer-side ids COLLIDE
//     with local ids (both autoincrement) — the SPA must check `peer_id`
//     before treating `id` as a local-row reference.
//   - peer_downloads has no `pinned` column → aliased to `0`. Federated
//     rows therefore never satisfy `pinnedOnly`, which is intentional —
//     peer files belong to the peer, this peer can't pin them locally.
//   - downloads.created_at is a DATETIME string ('YYYY-MM-DD HH:MM:SS');
//     peer_downloads.created_at is INTEGER unix-ms. Both are coerced to
//     unix-ms via a `sort_ts` column in the UNION so ORDER BY works
//     across both sides without parsing in JS.
// ---------------------------------------------------------------------------

const _FEDERATED_TYPE_MAP = {
    images: 'photo',
    videos: 'video',
    documents: 'document',
    audio: 'audio',
};

// Column lists shared by every federated SELECT. Kept in module scope so
// the four helpers below stay small and readable.
const _FED_COLS_LOCAL = `
    'self' AS peer_id,
    id, group_id, group_name, message_id, file_name, file_size, file_type,
    file_path, file_hash, status, created_at, nsfw_score,
    COALESCE(pinned, 0) AS pinned,
    CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS sort_ts
`;
const _FED_COLS_PEER = `
    peer_id,
    remote_id AS id, group_id, group_name, message_id, file_name, file_size, file_type,
    file_path, file_hash, status, created_at, nsfw_score,
    0 AS pinned,
    CAST(created_at AS INTEGER) AS sort_ts
`;

function _stripSortTs(rows) {
    // Drop the sort_ts column we used only for the cross-side ORDER BY.
    // Mutates in place — callers already consume the row objects directly.
    for (const r of rows) delete r.sort_ts;
    return rows;
}

/**
 * Federated equivalent of getAllDownloads — All Media gallery, optionally
 * widened to include peer_downloads.
 *
 * @param {number} limit
 * @param {number} offset
 * @param {string} type   'all' | 'images' | 'videos' | 'documents' | 'audio'
 * @param {object} [opts]
 * @param {boolean} [opts.pinnedOnly]
 * @param {boolean} [opts.pinnedFirst]
 * @param {'local'|'peers'|'all'} [opts.include='local']  scope toggle
 * @returns {{ files: Array, total: number }}
 */
export function getAllDownloadsFederated(limit = 50, offset = 0, type = 'all', opts = {}) {
    const include = opts.include === 'peers' || opts.include === 'all' ? opts.include : 'local';
    if (include === 'local') {
        return getAllDownloads(limit, offset, type, opts);
    }
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const typeFilter =
        type !== 'all' && _FEDERATED_TYPE_MAP[type] ? _FEDERATED_TYPE_MAP[type] : null;

    // Build the WHERE clause for both sides. Pinned filter only applies
    // to the local side because peer rows are always pinned=0.
    const localWhereParts = [];
    const peerWhereParts = [];
    const localParams = [];
    const peerParams = [];
    if (typeFilter) {
        localWhereParts.push('file_type = ?');
        peerWhereParts.push('file_type = ?');
        localParams.push(typeFilter);
        peerParams.push(typeFilter);
    }
    if (opts.pinnedOnly) {
        localWhereParts.push('COALESCE(pinned, 0) = 1');
        // Peer side excluded entirely under pinnedOnly — peer files can't
        // be locally pinned. Drop a never-true predicate to short-circuit.
        peerWhereParts.push('0 = 1');
    }
    const localWhere = localWhereParts.length ? ' WHERE ' + localWhereParts.join(' AND ') : '';
    const peerWhere = peerWhereParts.length ? ' WHERE ' + peerWhereParts.join(' AND ') : '';

    // pinnedFirst: COALESCE on the local side, peer side always 0 — net
    // effect is that local pinned float to the top of the merged page.
    const orderBy = opts.pinnedFirst
        ? 'pinned DESC, sort_ts DESC, id DESC'
        : 'sort_ts DESC, id DESC';

    const sql = `
        SELECT * FROM (
            SELECT ${_FED_COLS_LOCAL} FROM downloads${localWhere}
            UNION ALL
            SELECT ${_FED_COLS_PEER} FROM peer_downloads${peerWhere}
        ) ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `;
    const countSql = `
        SELECT
            (SELECT COUNT(*) FROM downloads${localWhere}) +
            (SELECT COUNT(*) FROM peer_downloads${peerWhere}) AS total
    `;
    const rows = getDb()
        .prepare(sql)
        .all(...localParams, ...peerParams, lim, off);
    const total = getDb()
        .prepare(countSql)
        .get(...localParams, ...peerParams).total;
    return { files: _stripSortTs(rows), total };
}

/**
 * Federated per-group view — same contract as getDownloads, plus include.
 */
export function getDownloadsForGroupFederated(
    groupId,
    limit = 50,
    offset = 0,
    type = 'all',
    opts = {},
) {
    const include = opts.include === 'peers' || opts.include === 'all' ? opts.include : 'local';
    if (include === 'local') {
        return getDownloads(groupId, limit, offset, type, opts);
    }
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const typeFilter =
        type !== 'all' && _FEDERATED_TYPE_MAP[type] ? _FEDERATED_TYPE_MAP[type] : null;
    const gid = String(groupId);

    const localWhereParts = ['group_id = ?'];
    const peerWhereParts = ['group_id = ?'];
    const localParams = [gid];
    const peerParams = [gid];
    if (typeFilter) {
        localWhereParts.push('file_type = ?');
        peerWhereParts.push('file_type = ?');
        localParams.push(typeFilter);
        peerParams.push(typeFilter);
    }
    if (opts.pinnedOnly) {
        localWhereParts.push('COALESCE(pinned, 0) = 1');
        peerWhereParts.push('0 = 1');
    }
    // Optional peerId filter — when caller wants only one peer's files for
    // the group (sidebar foreign-group click).
    if (opts.peerId) {
        peerWhereParts.push('peer_id = ?');
        peerParams.push(String(opts.peerId));
        // Also drop the local side entirely — caller wants only that peer.
        localWhereParts.push('0 = 1');
    }
    const localWhere = ' WHERE ' + localWhereParts.join(' AND ');
    const peerWhere = ' WHERE ' + peerWhereParts.join(' AND ');
    const orderBy = opts.pinnedFirst
        ? 'pinned DESC, sort_ts DESC, id DESC'
        : 'sort_ts DESC, id DESC';

    const sql = `
        SELECT * FROM (
            SELECT ${_FED_COLS_LOCAL} FROM downloads${localWhere}
            UNION ALL
            SELECT ${_FED_COLS_PEER} FROM peer_downloads${peerWhere}
        ) ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `;
    const countSql = `
        SELECT
            (SELECT COUNT(*) FROM downloads${localWhere}) +
            (SELECT COUNT(*) FROM peer_downloads${peerWhere}) AS total
    `;
    const rows = getDb()
        .prepare(sql)
        .all(...localParams, ...peerParams, lim, off);
    const total = getDb()
        .prepare(countSql)
        .get(...localParams, ...peerParams).total;
    return { files: _stripSortTs(rows), total };
}

/**
 * Federated full-text-ish search — same LIKE pattern as searchDownloads,
 * UNIONed with peer_downloads.
 */
export function searchDownloadsFederated(query, opts = {}) {
    const include = opts.include === 'peers' || opts.include === 'all' ? opts.include : 'local';
    if (include === 'local') {
        return searchDownloads(query, opts);
    }
    const lim = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
    const off = Math.max(0, parseInt(opts.offset, 10) || 0);
    const q = `%${String(query || '').trim()}%`;

    const localWhereParts = ['(file_name LIKE ? OR group_name LIKE ?)'];
    const peerWhereParts = ['(file_name LIKE ? OR group_name LIKE ?)'];
    const localParams = [q, q];
    const peerParams = [q, q];
    if (opts.groupId) {
        const gid = String(opts.groupId);
        localWhereParts.push('group_id = ?');
        peerWhereParts.push('group_id = ?');
        localParams.push(gid);
        peerParams.push(gid);
    }
    const localWhere = ' WHERE ' + localWhereParts.join(' AND ');
    const peerWhere = ' WHERE ' + peerWhereParts.join(' AND ');

    const sql = `
        SELECT * FROM (
            SELECT ${_FED_COLS_LOCAL} FROM downloads${localWhere}
            UNION ALL
            SELECT ${_FED_COLS_PEER} FROM peer_downloads${peerWhere}
        ) ORDER BY sort_ts DESC, id DESC LIMIT ? OFFSET ?
    `;
    const countSql = `
        SELECT
            (SELECT COUNT(*) FROM downloads${localWhere}) +
            (SELECT COUNT(*) FROM peer_downloads${peerWhere}) AS total
    `;
    const rows = getDb()
        .prepare(sql)
        .all(...localParams, ...peerParams, lim, off);
    const total = getDb()
        .prepare(countSql)
        .get(...localParams, ...peerParams).total;
    return { files: _stripSortTs(rows), total };
}

/**
 * Federated stats — local totals plus per-peer file counts + total size.
 * Used by /api/stats so the footer can render "Files: 1234 + 5678 peers"
 * when the gallery scope chip is set to "All peers".
 *
 * @returns {{
 *   totalFiles: number,
 *   totalSize: number,
 *   peerStats: Array<{peerId: string, totalFiles: number, totalSize: number}>
 * }}
 */
export function getStatsFederated() {
    const local = getStats();
    const peerRows = getDb()
        .prepare(
            `SELECT peer_id, COUNT(*) AS total_files, COALESCE(SUM(file_size), 0) AS total_size
               FROM peer_downloads
              GROUP BY peer_id`,
        )
        .all();
    return {
        ...local,
        peerStats: peerRows.map((r) => ({
            peerId: r.peer_id,
            totalFiles: Number(r.total_files) || 0,
            totalSize: Number(r.total_size) || 0,
        })),
    };
}

/**
 * Toggle / set the `pinned` flag on a download row. Pinned rows are
 * protected from auto-rotation sweeps (see disk-rotator.js) AND surface
 * at the top of gallery views when the operator opts in via Settings →
 * Library → "Surface pinned at the top".
 *
 * @param {number} id        download row id
 * @param {boolean} pinned   new state (true → 1, false → 0)
 * @returns {boolean}        true if a row was updated
 */
export function setDownloadPinned(id, pinned) {
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) return false;
    const r = getDb()
        .prepare('UPDATE downloads SET pinned = ? WHERE id = ?')
        .run(pinned ? 1 : 0, numId);
    return r.changes > 0;
}

/**
 * Lookup helper for the bulk-zip endpoint and other id-based admin tools.
 * Returns the row or null. Cheap (PK lookup); safe to call N times in a row.
 */
export function getDownloadById(id) {
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) return null;
    return getDb().prepare('SELECT * FROM downloads WHERE id = ?').get(numId) || null;
}

/** Bulk-delete by ids (preferred) or file_paths. Returns the number removed. */
export function deleteDownloadsBy(opts) {
    const db = getDb();
    if (Array.isArray(opts?.ids) && opts.ids.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE id = ?');
        const tx = db.transaction(() => opts.ids.reduce((n, id) => n + stmt.run(id).changes, 0));
        return tx();
    }
    if (Array.isArray(opts?.filePaths) && opts.filePaths.length) {
        const stmt = db.prepare('DELETE FROM downloads WHERE file_path = ?');
        const tx = db.transaction(() =>
            opts.filePaths.reduce((n, p) => n + stmt.run(p).changes, 0),
        );
        return tx();
    }
    return 0;
}

export function getStats() {
    const db = getDb();
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM downloads').get().count;
    const totalSize = db.prepare('SELECT SUM(file_size) as size FROM downloads').get().size || 0;
    return { totalFiles, totalSize };
}

/**
 * Sum of file_size across all download rows (NULL sizes are treated as 0).
 * Used by the disk rotator to decide whether the cap is exceeded.
 */
export function getTotalSizeBytes() {
    const r = getDb().prepare('SELECT COALESCE(SUM(file_size), 0) as size FROM downloads').get();
    return Number(r?.size || 0);
}

/**
 * Returns the N oldest download rows (created_at ASC), skipping pinned ones.
 * The rotator pulls from this list and deletes file + row until the cap is
 * back under the limit.
 */
export function getOldestDownloads(count = 50) {
    const limit = Math.max(1, Math.min(10000, parseInt(count, 10) || 50));
    return getDb()
        .prepare(`
            SELECT id, group_id, group_name, file_name, file_size, file_type, file_path, created_at, pinned
            FROM downloads
            WHERE COALESCE(pinned, 0) = 0
            ORDER BY datetime(created_at) ASC, id ASC
            LIMIT ?
        `)
        .all(limit);
}
