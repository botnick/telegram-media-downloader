/**
 * Cluster dedup sweep — Phase 7 (layer 3).
 *
 * Runs periodically (default once a day) over the union of own
 * `downloads` + every peer's `peer_downloads`, finds groups of files
 * sharing the same (file_hash, file_size), and surfaces them as
 * "conflicts" that an operator can resolve in the UI.
 *
 * Resolution policy is operator-driven by default — auto-resolve is too
 * destructive for v2.9. The "keeper" is whichever (peerId, remoteId) the
 * operator picks; every other instance of the file is unlinked locally
 * (when on this peer) or recorded as a pending action for the next time
 * that peer comes online (TODO Phase 8).
 *
 * Exposes the JobTracker contract (eventPrefix='cluster_sweep'):
 *   tryStart()  /  getStatus()  /  abort()
 */

import { findCrossClusterDuplicates, recordClusterAudit, kvGet, kvSet } from '../db.js';
import { createJobTracker } from '../job-tracker.js';
import { getSelfPeerId } from './identity.js';
import fs from 'fs/promises';
import path from 'path';
import { getDownloadsDir } from '../paths.js';

const CONFLICTS_KV_KEY = 'cluster_sweep_conflicts';
const STATS_KV_KEY = 'cluster_sweep_stats';

let _tracker = null;
function _getTracker() {
    if (_tracker) return _tracker;
    _tracker = createJobTracker({
        kind: 'cluster_sweep',
        broadcast: (m) => {
            try {
                if (typeof global.__tgdlBroadcast === 'function') {
                    global.__tgdlBroadcast(m);
                }
            } catch {
                /* nothing */
            }
        },
    });
    return _tracker;
}

function _broadcast(payload) {
    try {
        if (typeof global.__tgdlBroadcast === 'function') {
            global.__tgdlBroadcast(payload);
        }
    } catch {
        /* never fail a sweep on a UI broadcast error */
    }
}

function _saveConflicts(list) {
    kvSet(CONFLICTS_KV_KEY, list || []);
}
export function listConflicts() {
    return kvGet(CONFLICTS_KV_KEY) || [];
}

function _saveStats(stats) {
    kvSet(STATS_KV_KEY, stats || {});
}
export function getSweepStats() {
    return kvGet(STATS_KV_KEY) || {};
}

export function getSweepStatus() {
    return {
        ..._getTracker().getStatus(),
        conflicts: listConflicts(),
        stats: getSweepStats(),
    };
}

/**
 * Single sweep pass — populates conflicts list. Idempotent.
 */
export async function runClusterSweep({ minSize = 1024, limit = 500, signal } = {}) {
    const start = Date.now();
    const dups = findCrossClusterDuplicates({ minSize, limit });
    const conflicts = [];
    let totalDup = 0;
    let totalBytes = 0;
    for (const row of dups) {
        if (signal?.aborted) break;
        const owners = String(row.owners || '')
            .split('|')
            .filter(Boolean)
            .map((s) => {
                const m = /^(.+?):(\d+):(.*)$/.exec(s);
                if (!m) return null;
                return { peerId: m[1], remoteId: Number(m[2]), filePath: m[3] };
            })
            .filter(Boolean);
        if (owners.length < 2) continue;
        conflicts.push({
            id: `${row.file_hash}|${row.file_size}`,
            fileHash: row.file_hash,
            fileSize: row.file_size,
            count: row.n,
            owners,
        });
        totalDup += row.n - 1;
        totalBytes += (row.n - 1) * (row.file_size || 0);
        _broadcast({ type: 'cluster_sweep_progress', conflicts: conflicts.length });
    }
    _saveConflicts(conflicts);
    _saveStats({
        lastRunAt: start,
        durationMs: Date.now() - start,
        conflicts: conflicts.length,
        duplicateRows: totalDup,
        wastedBytes: totalBytes,
    });
    recordClusterAudit({
        kind: 'sweep',
        ok: true,
        detail: `conflicts=${conflicts.length} duplicateRows=${totalDup} wastedBytes=${totalBytes}`,
    });
    _broadcast({
        type: 'cluster_sweep_done',
        conflicts: conflicts.length,
        duplicateRows: totalDup,
        wastedBytes: totalBytes,
        durationMs: Date.now() - start,
    });
    return getSweepStats();
}

/**
 * Resolve a conflict — keeps `keep = {peerId, remoteId}`, schedules
 * deletion of every other entry. For "self"-owned losers we unlink the
 * local file + delete the row. For peer-owned losers we record a hint
 * (Phase 7 stops here — actual cross-peer delete is Phase 7+ followup).
 */
export async function resolveConflict(conflictId, keep) {
    if (!conflictId || !keep?.peerId || keep?.remoteId == null) {
        const e = new Error('keep.peerId + keep.remoteId required');
        e.status = 400;
        throw e;
    }
    const conflicts = listConflicts();
    const idx = conflicts.findIndex((c) => c.id === conflictId);
    if (idx < 0) {
        const e = new Error('conflict not found (already resolved or expired)');
        e.status = 404;
        throw e;
    }
    const conflict = conflicts[idx];
    const downloadsDir = getDownloadsDir();
    const losers = conflict.owners.filter(
        (o) => !(o.peerId === keep.peerId && Number(o.remoteId) === Number(keep.remoteId)),
    );
    let unlinked = 0;
    let queued = 0;
    let remoteDeleted = 0;
    const { getDb, enqueuePeerDeleteJob } = await import('../db.js');
    const selfId = getSelfPeerId();
    for (const loser of losers) {
        if (loser.peerId === 'self' || loser.peerId === selfId) {
            // Local row — unlink + delete.
            try {
                const abs = path.join(downloadsDir, loser.filePath || '');
                await fs.unlink(abs).catch(() => {});
                getDb().prepare('DELETE FROM downloads WHERE id = ?').run(Number(loser.remoteId));
                unlinked++;
            } catch {
                /* ignore — best-effort */
            }
        } else {
            // v2.10 — remote loser. Try a signed delete to the peer that
            // holds the file. On failure, fall back to enqueueing a
            // retry job (drained by a sibling worker).
            const ok = await _attemptRemoteDelete(loser).catch(() => false);
            if (ok) {
                remoteDeleted++;
            } else {
                try {
                    enqueuePeerDeleteJob({
                        peerId: loser.peerId,
                        remoteId: loser.remoteId,
                        reason: `cluster_dedup keeper=${keep.peerId}:${keep.remoteId}`,
                    });
                    queued++;
                } catch {
                    /* nothing */
                }
            }
        }
    }
    conflicts.splice(idx, 1);
    _saveConflicts(conflicts);
    recordClusterAudit({
        kind: 'sweep',
        ok: true,
        detail: `resolve ${conflictId}: kept=${keep.peerId}:${keep.remoteId} unlinked=${unlinked} remote_deleted=${remoteDeleted} queued=${queued}`,
    });
    return { unlinked, remoteDeleted, queued };
}

async function _attemptRemoteDelete(loser) {
    try {
        const peers = await import('./peers.js');
        const peer = peers.getPeer(loser.peerId);
        if (!peer || peer.status === 'revoked') return false;
        const { signRequest } = await import('./hmac.js');
        const body = JSON.stringify({
            remote_id: Number(loser.remoteId),
            file_path: loser.filePath,
            reason: 'cluster_dedup',
        });
        const headers = signRequest({
            method: 'POST',
            path: '/api/cluster/files/delete',
            body,
            targetPeerId: peer.peerId,
        });
        headers['Content-Type'] = 'application/json';
        const r = await fetch(peer.url + '/api/cluster/files/delete', {
            method: 'POST',
            headers,
            body,
        });
        return r.ok;
    } catch {
        return false;
    }
}


/**
 * JobTracker-style tryStart so the express route can respond in <500ms
 * while the sweep runs in the background.
 */
export function tryStartSweep(opts = {}) {
    return _getTracker().tryStart(async ({ signal }) => {
        return runClusterSweep({ ...opts, signal });
    });
}

export function abortSweep() {
    return _getTracker().cancel();
}
