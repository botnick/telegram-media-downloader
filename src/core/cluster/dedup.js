/**
 * Cluster-wide hash lookup — Phase 6 dedup layer 2.
 *
 * Before the downloader writes a file, the worker computes its sha256 and
 * asks `findHashAcrossCluster(hash, size)` whether another peer already
 * owns it. On a hit the downloader skips the local write and inserts a
 * "ghost" downloads row whose file_path is the synthetic
 * `_clusterref/<peerId>/<remoteId>` — the bridge resolves it to a remote
 * fetch when the user opens the file.
 *
 * Backed entirely by the local `peer_downloads` cache so the lookup is
 * one indexed SELECT (no network). Cache freshness is bounded by the
 * sync engine's poll interval; the post-download sweep covers any drift.
 */

import { findClusterByHash } from '../db.js';
import { getPeer } from './peers.js';
import { recordClusterAudit } from '../db.js';

/**
 * Look up a (hash, size) tuple across the cluster catalog. Returns an
 * array of `{peerId, peerName, remoteId, filePath, fileSize}` — empty
 * if no other peer holds the file.
 *
 * Restricted to *online* + *non-revoked* peers because there's no point
 * pointing the user at an unreachable owner.
 */
export function findHashAcrossCluster(fileHash, fileSize = null) {
    if (!fileHash) return [];
    const rows = findClusterByHash(String(fileHash), fileSize);
    if (!rows.length) return [];
    const out = [];
    for (const r of rows) {
        const peer = getPeer(r.peer_id);
        if (!peer) continue;
        if (peer.status === 'revoked') continue;
        out.push({
            peerId: peer.peerId,
            peerName: peer.name,
            peerStatus: peer.status,
            remoteId: r.remote_id,
            filePath: r.file_path,
            fileSize: r.file_size,
            fileHash: r.file_hash,
        });
    }
    return out;
}

/**
 * Compose the synthetic ghost path used to flag a row as cluster-only.
 * Decoded back to (peerId, remoteId) by the bridge resolver.
 */
export function clusterRefPath(peerId, remoteId) {
    return `_clusterref/${encodeURIComponent(peerId)}/${Number(remoteId)}`;
}

/**
 * Inverse of clusterRefPath. Returns null on a non-ref path.
 */
export function parseClusterRefPath(p) {
    if (!p || typeof p !== 'string') return null;
    const m = /^_clusterref\/([^/]+)\/(\d+)$/.exec(p);
    if (!m) return null;
    let peerId;
    try {
        peerId = decodeURIComponent(m[1]);
    } catch {
        return null;
    }
    return { peerId, remoteId: Number(m[2]) };
}

/**
 * Record a cluster dedup hit so the audit log surfaces savings.
 */
export function recordDedupHit({ peerId, fileHash, fileSize, remoteId }) {
    recordClusterAudit({
        kind: 'dedup_hit',
        ok: true,
        peerId,
        detail: `hash=${fileHash} size=${fileSize} remoteId=${remoteId}`,
    });
}
