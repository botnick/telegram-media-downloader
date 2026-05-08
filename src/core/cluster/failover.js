/**
 * Backup-peer failover — Phase E (v2.10).
 *
 * For every group with `groups[i].ownerPeerId !== self`, watch the
 * owner's WS heartbeat. If the owner has been silent for more than
 * `cluster.failover_grace_minutes` (default 5), and `groups[i].backupPeerId`
 * matches this peer, we atomically take ownership: write
 * `groups[i].ownerPeerId = self.peerId` to local config, broadcast a
 * `failover_completed` event over /ws/cluster, append an audit row.
 *
 * Hand-back is operator-driven — when the original owner returns, the
 * UI surfaces a "former owner is back online; click to hand back"
 * banner. Auto hand-back risks flapping under flaky networks.
 *
 * The watcher is started by server.js once `runtime` is up.
 */

import { listPeers, getPeer } from './peers.js';
import { getSelfPeerId } from './identity.js';
import { broadcastClusterEvent } from './ws-channel.js';
import { recordFailover, recordClusterAudit } from '../db.js';
import { loadConfig, saveConfig } from '../../config/manager.js';

const DEFAULT_GRACE_MINUTES = 5;
const TICK_MS = 60_000;

let _timer = null;
let _running = false;

function _graceMs() {
    try {
        const cfg = loadConfig();
        const m = Number(cfg?.cluster?.failover_grace_minutes);
        if (Number.isFinite(m) && m > 0) return Math.floor(m * 60_000);
    } catch {
        /* nothing */
    }
    return DEFAULT_GRACE_MINUTES * 60_000;
}

function _ownerIsStale(ownerPeerId, graceMs) {
    const peer = getPeer(ownerPeerId);
    if (!peer) return false; // unknown peer — leave it alone
    const last = Math.max(peer.wsLastSeen || 0, peer.lastSeenAt || 0);
    if (!last) return false;
    return Date.now() - last > graceMs;
}

function _maybeFailover(group, selfId, graceMs) {
    const ownerId = group.ownerPeerId;
    const backupId = group.backupPeerId;
    if (!ownerId || ownerId === selfId) return null;
    if (!backupId || backupId !== selfId) return null;
    if (!_ownerIsStale(ownerId, graceMs)) return null;
    return {
        groupId: String(group.id ?? group.groupId ?? ''),
        fromPeerId: ownerId,
        toPeerId: selfId,
    };
}

/**
 * Single sweep over the local config.groups list. Returns the list of
 * failovers it applied (for tests + logs).
 */
export function runFailoverPass({ now = Date.now() } = {}) {
    const cfg = (() => {
        try {
            return loadConfig();
        } catch {
            return null;
        }
    })();
    if (!cfg || !Array.isArray(cfg.groups)) return [];
    const selfId = getSelfPeerId();
    const grace = _graceMs();
    const applied = [];
    let dirty = false;
    for (const g of cfg.groups) {
        const fo = _maybeFailover(g, selfId, grace);
        if (!fo) continue;
        g.ownerPeerId = selfId;
        g.failoverAt = now;
        applied.push(fo);
        dirty = true;
        recordFailover({
            groupId: fo.groupId,
            fromPeerId: fo.fromPeerId,
            toPeerId: fo.toPeerId,
            reason: 'owner_offline',
        });
        recordClusterAudit({
            kind: 'failover',
            ok: true,
            peerId: fo.fromPeerId,
            detail: `group ${fo.groupId} owner reassigned to self`,
        });
        try {
            broadcastClusterEvent('failover_completed', {
                group_id: fo.groupId,
                from_peer_id: fo.fromPeerId,
                to_peer_id: fo.toPeerId,
                ts: now,
            });
        } catch {
            /* nothing */
        }
    }
    if (dirty) {
        try {
            saveConfig(cfg);
        } catch (e) {
            recordClusterAudit({
                kind: 'failover',
                ok: false,
                detail: `saveConfig: ${e?.message || e}`,
            });
        }
    }
    return applied;
}

export function startFailoverWatcher() {
    if (_running) return;
    _running = true;
    const tick = () => {
        try {
            runFailoverPass();
        } catch {
            /* never let a bad failover pass kill the timer */
        }
    };
    _timer = setInterval(tick, TICK_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
}

export function stopFailoverWatcher() {
    _running = false;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}
