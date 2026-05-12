import { getDb } from '../db.js';

const _stmtCache = new Map();
function _prep(sql) {
    let s = _stmtCache.get(sql);
    if (!s) {
        s = getDb().prepare(sql);
        _stmtCache.set(sql, s);
    }
    return s;
}

// ---- Cluster mode (v2.9) --------------------------------------------------
//
// Thin accessors over `peers`, `peer_downloads`, `peer_groups`,
// `peer_accounts`, `peer_history`, `cluster_audit`. Higher-level
// orchestration (handshake, sync, sweep) lives in src/core/cluster/*.

export function listPeers() {
    return _prep(
        'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers ORDER BY paired_at ASC LIMIT 1000',
    ).all();
}

export function getPeerByPeerId(peerId) {
    if (!peerId) return null;
    return (
        _prep(
            'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers WHERE peer_id = ?',
        ).get(String(peerId)) || null
    );
}

export function getPeerById(id) {
    return (
        _prep(
            'SELECT id, peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes, shared_secret, role, ws_last_seen FROM peers WHERE id = ?',
        ).get(Number(id)) || null
    );
}

export function upsertPeer({
    peerId,
    name,
    url,
    fingerprint,
    version = null,
    streamMode = 'proxy',
    status = 'online',
    notes = null,
}) {
    if (!peerId || !name || !url || !fingerprint) {
        throw new Error('upsertPeer: peerId, name, url, fingerprint are required');
    }
    const now = Date.now();
    const stmt = _prep(`
        INSERT INTO peers (peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint, version, notes)
        VALUES (@peerId, @name, @url, @status, @streamMode, @now, @now, @fingerprint, @version, @notes)
        ON CONFLICT(peer_id) DO UPDATE SET
            name         = excluded.name,
            url          = excluded.url,
            status       = excluded.status,
            last_seen_at = excluded.last_seen_at,
            fingerprint  = excluded.fingerprint,
            version      = COALESCE(excluded.version, peers.version),
            notes        = COALESCE(excluded.notes, peers.notes)
    `);
    stmt.run({
        peerId: String(peerId),
        name: String(name),
        url: String(url).replace(/\/+$/, ''),
        status: String(status),
        streamMode: String(streamMode === 'direct' ? 'direct' : 'proxy'),
        now,
        fingerprint: String(fingerprint),
        version: version != null ? String(version) : null,
        notes,
    });
    return getPeerByPeerId(peerId);
}

export function updatePeer(peerId, patch) {
    const cur = getPeerByPeerId(peerId);
    if (!cur) return null;
    const fields = [];
    const args = [];
    if (patch.name !== undefined) {
        fields.push('name = ?');
        args.push(String(patch.name));
    }
    if (patch.url !== undefined) {
        fields.push('url = ?');
        args.push(String(patch.url).replace(/\/+$/, ''));
    }
    if (patch.streamMode !== undefined) {
        fields.push('stream_mode = ?');
        args.push(patch.streamMode === 'direct' ? 'direct' : 'proxy');
    }
    if (patch.status !== undefined) {
        fields.push('status = ?');
        args.push(String(patch.status));
    }
    if (patch.lastSeenAt !== undefined) {
        fields.push('last_seen_at = ?');
        args.push(Number(patch.lastSeenAt) || null);
    }
    if (patch.version !== undefined) {
        fields.push('version = ?');
        args.push(patch.version != null ? String(patch.version) : null);
    }
    if (patch.notes !== undefined) {
        fields.push('notes = ?');
        args.push(patch.notes != null ? String(patch.notes) : null);
    }
    if (!fields.length) return cur;
    args.push(String(peerId));
    getDb()
        .prepare(`UPDATE peers SET ${fields.join(', ')} WHERE peer_id = ?`)
        .run(...args);
    return getPeerByPeerId(peerId);
}

export function deletePeer(peerId) {
    const r = _prep('DELETE FROM peers WHERE peer_id = ?').run(String(peerId));
    if (r.changes > 0) {
        // Cascade-purge cached catalogs so the gallery doesn't keep showing
        // rows from a peer the operator just revoked.
        _prep('DELETE FROM peer_downloads WHERE peer_id = ?').run(String(peerId));
        _prep('DELETE FROM peer_groups WHERE peer_id = ?').run(String(peerId));
        _prep('DELETE FROM peer_accounts WHERE peer_id = ?').run(String(peerId));
        _prep('DELETE FROM peer_history WHERE peer_id = ?').run(String(peerId));
    }
    return r.changes > 0;
}

export function markPeerSeen(peerId, status = 'online') {
    return (
        _prep('UPDATE peers SET status = ?, last_seen_at = ? WHERE peer_id = ?').run(
            String(status),
            Date.now(),
            String(peerId),
        ).changes > 0
    );
}

export function recordClusterAudit({ peerId = null, kind, detail = null, ok = true }) {
    if (!kind) return;
    try {
        _prep(
            'INSERT INTO cluster_audit (ts, peer_id, kind, detail, ok) VALUES (?, ?, ?, ?, ?)',
        ).run(
            Date.now(),
            peerId ? String(peerId) : null,
            String(kind),
            detail ? String(detail).slice(0, 4096) : null,
            ok ? 1 : 0,
        );
    } catch {
        /* never fail a request because of audit write */
    }
}

export function listClusterAudit({ peerId = null, kind = null, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (peerId) {
        where.push('peer_id = ?');
        args.push(String(peerId));
    }
    if (kind) {
        where.push('kind = ?');
        args.push(String(kind));
    }
    args.push(Math.max(1, Math.min(2000, Number(limit) || 200)));
    return getDb()
        .prepare(
            `SELECT id, ts, peer_id, kind, detail, ok FROM cluster_audit ${
                where.length ? 'WHERE ' + where.join(' AND ') : ''
            } ORDER BY ts DESC LIMIT ?`,
        )
        .all(...args);
}

export function pruneClusterAudit(retainDays = 30) {
    const cutoff = Date.now() - Math.max(1, Number(retainDays)) * 24 * 60 * 60 * 1000;
    return _prep('DELETE FROM cluster_audit WHERE ts < ?').run(cutoff).changes;
}

// Cluster catalog — cached mirror of remote peers' downloads tables.
// The sync engine fills these via /api/cluster/downloads/since.

export function upsertPeerDownloadsBatch(peerId, rows = []) {
    if (!peerId || !rows.length) return 0;
    const now = Date.now();
    const stmt = _prep(`
        INSERT INTO peer_downloads (
            peer_id, remote_id, file_path, file_name, file_size, file_type, file_hash,
            group_id, group_name, message_id, created_at, status, nsfw_score, cached_at
        ) VALUES (
            @peerId, @remoteId, @filePath, @fileName, @fileSize, @fileType, @fileHash,
            @groupId, @groupName, @messageId, @createdAt, @status, @nsfwScore, @cachedAt
        )
        ON CONFLICT(peer_id, remote_id) DO UPDATE SET
            file_path  = excluded.file_path,
            file_name  = excluded.file_name,
            file_size  = excluded.file_size,
            file_type  = excluded.file_type,
            file_hash  = excluded.file_hash,
            group_id   = excluded.group_id,
            group_name = excluded.group_name,
            message_id = excluded.message_id,
            created_at = excluded.created_at,
            status     = excluded.status,
            nsfw_score = excluded.nsfw_score,
            cached_at  = excluded.cached_at
    `);
    let n = 0;
    getDb().transaction(() => {
        for (const r of rows) {
            try {
                stmt.run({
                    peerId: String(peerId),
                    remoteId: Number(r.remoteId ?? r.id),
                    filePath: r.file_path ?? r.filePath ?? null,
                    fileName: r.file_name ?? r.fileName ?? null,
                    fileSize: r.file_size ?? r.fileSize ?? null,
                    fileType: r.file_type ?? r.fileType ?? null,
                    fileHash: r.file_hash ?? r.fileHash ?? null,
                    groupId: r.group_id ?? r.groupId ?? null,
                    groupName: r.group_name ?? r.groupName ?? null,
                    messageId: r.message_id ?? r.messageId ?? null,
                    createdAt:
                        typeof r.created_at === 'string'
                            ? Date.parse(r.created_at) || null
                            : (r.created_at ?? r.createdAt ?? null),
                    status: r.status ?? null,
                    nsfwScore: r.nsfw_score ?? r.nsfwScore ?? null,
                    cachedAt: now,
                });
                n++;
            } catch {
                /* skip malformed row */
            }
        }
    })();
    return n;
}

export function deletePeerDownloadsByRemoteIds(peerId, remoteIds = []) {
    if (!peerId || !remoteIds.length) return 0;
    const stmt = _prep('DELETE FROM peer_downloads WHERE peer_id = ? AND remote_id = ?');
    let n = 0;
    getDb().transaction(() => {
        for (const id of remoteIds) {
            n += stmt.run(String(peerId), Number(id)).changes;
        }
    })();
    return n;
}

export function clearPeerDownloads(peerId) {
    if (!peerId) return 0;
    return _prep('DELETE FROM peer_downloads WHERE peer_id = ?').run(String(peerId)).changes;
}

export function listPeerDownloads(peerId, { limit = 500, offset = 0 } = {}) {
    if (!peerId) return [];
    return _prep(
        'SELECT * FROM peer_downloads WHERE peer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(String(peerId), Math.max(1, Math.min(2000, limit)), Math.max(0, offset));
}

export function setPeerCatalogBlob(table, peerId, payload) {
    const allowed = new Set(['peer_groups', 'peer_accounts', 'peer_history']);
    if (!allowed.has(table)) throw new Error(`unsupported peer-catalog table: ${table}`);
    const json = JSON.stringify(payload || []);
    const now = Date.now();
    getDb()
        .prepare(`
        INSERT INTO ${table} (peer_id, payload, cached_at) VALUES (?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at
    `)
        .run(String(peerId), json, now);
}

export function getPeerCatalogBlob(table, peerId) {
    const allowed = new Set(['peer_groups', 'peer_accounts', 'peer_history']);
    if (!allowed.has(table)) throw new Error(`unsupported peer-catalog table: ${table}`);
    const row = getDb()
        .prepare(`SELECT payload, cached_at FROM ${table} WHERE peer_id = ?`)
        .get(String(peerId));
    if (!row) return null;
    try {
        return { payload: JSON.parse(row.payload), cachedAt: row.cached_at };
    } catch {
        return null;
    }
}

/**
 * Delta query — own downloads with id > sinceId (or created_at >= sinceTs).
 * Returns at most `limit` rows ordered ASCENDING by id so the puller can
 * resume cleanly from the highest id it just saw.
 */
export function listOwnDownloadsSince({ sinceId = 0, limit = 500 } = {}) {
    const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
    const since = Math.max(0, Number(sinceId) || 0);
    return _prep(
        `SELECT id, group_id, group_name, message_id, file_name, file_size, file_type, file_path,
                file_hash, status, created_at, nsfw_score
           FROM downloads
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?`,
    ).all(since, lim);
}

/**
 * Find a row in the cluster catalog whose hash + size match. Used by the
 * pre-download dedup layer to decide whether to skip a write and ghost
 * the row instead.
 */
export function findClusterByHash(fileHash, fileSize = null) {
    if (!fileHash) return [];
    const args = [String(fileHash)];
    let where = 'file_hash = ?';
    if (fileSize != null) {
        where += ' AND file_size = ?';
        args.push(Number(fileSize));
    }
    return _prep(
        `SELECT peer_id, remote_id, file_path, file_size, file_hash FROM peer_downloads WHERE ${where} LIMIT 5`,
    ).all(...args);
}

/**
 * Cross-source duplicate set — rows that share (file_hash, file_size)
 * across either own downloads OR a peer's catalog. Used by the sweep job.
 * Returns groups with count > 1; each group lists every owner so the
 * sweeper can pick a keeper.
 */
export function findCrossClusterDuplicates({ minSize = 1, limit = 200 } = {}) {
    return _prep(
        `WITH all_rows AS (
            SELECT 'self' AS peer_id, id AS remote_id, file_hash, file_size, file_path, created_at
              FROM downloads
             WHERE file_hash IS NOT NULL AND file_size >= ?
             UNION ALL
            SELECT peer_id, remote_id, file_hash, file_size, file_path, created_at
              FROM peer_downloads
             WHERE file_hash IS NOT NULL AND file_size >= ?
         )
         SELECT file_hash, file_size, COUNT(*) AS n,
                GROUP_CONCAT(peer_id || ':' || remote_id || ':' || file_path, '|') AS owners
           FROM all_rows
          GROUP BY file_hash, file_size
         HAVING COUNT(*) > 1
          ORDER BY n DESC, file_size DESC
          LIMIT ?`,
    ).all(Number(minSize), Number(minSize), Math.max(1, Math.min(2000, limit)));
}

// ---- Cluster v2.10 accessors ---------------------------------------------

export function setPeerSharedSecret(peerId, secret) {
    if (!peerId) return false;
    if (secret == null) {
        return (
            _prep('UPDATE peers SET shared_secret = NULL WHERE peer_id = ?').run(String(peerId))
                .changes > 0
        );
    }
    const buf = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
    return (
        _prep('UPDATE peers SET shared_secret = ? WHERE peer_id = ?').run(buf, String(peerId))
            .changes > 0
    );
}

export function getPeerSharedSecret(peerId) {
    if (!peerId) return null;
    const row = _prep('SELECT shared_secret FROM peers WHERE peer_id = ?').get(String(peerId));
    return row?.shared_secret || null;
}

export function setPeerWsLastSeen(peerId, ts = Date.now()) {
    if (!peerId) return;
    _prep('UPDATE peers SET ws_last_seen = ? WHERE peer_id = ?').run(Number(ts), String(peerId));
}

export function recordFailover({ groupId, fromPeerId, toPeerId, reason = null }) {
    _prep(
        `INSERT INTO peer_failover_log (group_id, from_peer_id, to_peer_id, reason, ts)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(String(groupId), String(fromPeerId), String(toPeerId), reason, Date.now());
}

export function listFailoverLog({ limit = 100 } = {}) {
    return _prep(
        'SELECT id, group_id, from_peer_id, to_peer_id, reason, ts FROM peer_failover_log ORDER BY ts DESC LIMIT ?',
    ).all(Math.max(1, Math.min(2000, Number(limit) || 100)));
}

export function enqueuePeerDeleteJob({ peerId, remoteId, reason = null }) {
    if (!peerId || remoteId == null) return null;
    const r = _prep(
        `INSERT INTO peer_delete_jobs (peer_id, remote_id, reason, created_at)
         VALUES (?, ?, ?, ?)`,
    ).run(String(peerId), Number(remoteId), reason, Date.now());
    return r.lastInsertRowid;
}

export function claimNextPeerDeleteJob(now = Date.now()) {
    const row = _prep(
        `SELECT id, peer_id, remote_id, attempts FROM peer_delete_jobs
          WHERE status = 'pending'
          ORDER BY id ASC
          LIMIT 1`,
    ).get();
    if (!row) return null;
    _prep(`UPDATE peer_delete_jobs SET status='running', attempts = attempts + 1 WHERE id = ?`).run(
        row.id,
    );
    return row;
}

export function markPeerDeleteJob(id, status, finished_at = Date.now()) {
    _prep(`UPDATE peer_delete_jobs SET status = ?, finished_at = ? WHERE id = ?`).run(
        String(status),
        Number(finished_at),
        Number(id),
    );
}

export function listPeerDeleteJobs({ status = null, limit = 100 } = {}) {
    const args = [];
    let where = '';
    if (status) {
        where = 'WHERE status = ?';
        args.push(String(status));
    }
    args.push(Math.max(1, Math.min(2000, Number(limit) || 100)));
    return getDb()
        .prepare(
            `SELECT id, peer_id, remote_id, reason, status, attempts, created_at, finished_at
               FROM peer_delete_jobs ${where} ORDER BY id DESC LIMIT ?`,
        )
        .all(...args);
}

export function upsertPeerDiscovery({
    peerId,
    url,
    name = null,
    version = null,
    source = 'broadcast',
}) {
    if (!peerId || !url) return;
    _prep(
        `INSERT INTO peer_discoveries (peer_id, url, name, version, source, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET
            url = excluded.url,
            name = COALESCE(excluded.name, peer_discoveries.name),
            version = COALESCE(excluded.version, peer_discoveries.version),
            source = excluded.source,
            seen_at = excluded.seen_at`,
    ).run(String(peerId), String(url), name, version, String(source), Date.now());
}

export function listDiscoveredPeers({ ttlMs = 5 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - ttlMs;
    return _prep(
        'SELECT peer_id, url, name, version, source, seen_at FROM peer_discoveries WHERE seen_at >= ? ORDER BY seen_at DESC',
    ).all(cutoff);
}

export function pruneDiscoveredPeers(ttlMs = 5 * 60 * 1000) {
    const cutoff = Date.now() - ttlMs;
    return _prep('DELETE FROM peer_discoveries WHERE seen_at < ?').run(cutoff).changes;
}

export function recordEgress({ peerId = null, bytes, fromCache = false }) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    _prep(
        'INSERT INTO cluster_egress_log (peer_id, bytes, served_at, from_cache) VALUES (?, ?, ?, ?)',
    ).run(peerId ? String(peerId) : null, Number(bytes), Date.now(), fromCache ? 1 : 0);
}

export function pruneEgressLog(retainDays = 31) {
    const cutoff = Date.now() - Math.max(1, retainDays) * 24 * 3600 * 1000;
    return _prep('DELETE FROM cluster_egress_log WHERE served_at < ?').run(cutoff).changes;
}

export function aggregateEgress({ days = 30 } = {}) {
    const cutoff = Date.now() - Math.max(1, days) * 24 * 3600 * 1000;
    return _prep(
        `SELECT peer_id, SUM(bytes) AS total_bytes, COUNT(*) AS req_count, SUM(from_cache) AS cache_hits
           FROM cluster_egress_log
          WHERE served_at >= ?
          GROUP BY peer_id`,
    ).all(cutoff);
}
