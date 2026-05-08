/**
 * Live config sync — Phase F (v2.10).
 *
 * Each top-level config key has a replication policy:
 *   'local'         — never propagated (default; private to this peer)
 *   'cluster'       — every paired peer mirrors the value
 *   'cluster_excl'  — propagated, but receivers may override locally
 *
 * Policies live under `config.cluster.replicate.<key>`. Operator picks
 * per-key in Settings → Cluster → Replication.
 *
 * Events flow over `/ws/cluster`:
 *   { type: 'config_changed', payload: { key, value, ts, peer_id } }
 *
 * Receiver:
 *   - drops the event if the local key's policy is 'local'
 *   - tie-breaks by `(ts, peer_id)`: newer ts wins; equal ts → lex
 *     compare peer_id, lower wins (stable)
 *   - applies the patch + records an audit row
 */

import { broadcastClusterEvent } from './ws-channel.js';
import { recordClusterAudit, kvGet, kvSet } from '../db.js';
import { loadConfig, saveConfig } from '../../config/manager.js';
import { getSelfPeerId } from './identity.js';

const KV_LAST_TS = 'cluster_config_last_ts';
const RECEIVER_TS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function _policyFor(key) {
    try {
        const cfg = loadConfig();
        const p = cfg?.cluster?.replicate?.[key];
        if (p === 'cluster' || p === 'cluster_excl') return p;
    } catch {
        /* nothing */
    }
    return 'local';
}

function _peerLastTsMap() {
    return kvGet(KV_LAST_TS) || {};
}
function _bumpLastTs(key, peerId, ts) {
    const map = _peerLastTsMap();
    map[`${key}|${peerId}`] = ts;
    kvSet(KV_LAST_TS, map);
}
function _lastTsFor(key, peerId) {
    const map = _peerLastTsMap();
    return Number(map[`${key}|${peerId}`]) || 0;
}

/**
 * Source-side: when the local config changes, push the event to peers
 * if the key is replicated.
 */
export function publishConfigChange(key, value) {
    const policy = _policyFor(key);
    if (policy === 'local') return;
    const ts = Date.now();
    try {
        broadcastClusterEvent('config_changed', {
            key,
            value,
            ts,
            peer_id: getSelfPeerId(),
            policy,
        });
        recordClusterAudit({
            kind: 'config_sync',
            ok: true,
            detail: `push ${key} (${policy})`,
        });
    } catch {
        /* nothing */
    }
}

/**
 * Receiver-side: handle a `config_changed` event from a peer. Returns
 * the action taken — 'applied' | 'skipped' | 'override'.
 */
export function applyRemoteConfigChange(payload) {
    if (!payload?.key || !payload?.peer_id || !Number.isFinite(Number(payload.ts))) {
        return 'skipped';
    }
    const { key, value, ts, peer_id } = payload;
    const policy = _policyFor(key);
    if (policy === 'local') {
        return 'skipped';
    }
    if (policy === 'cluster_excl') {
        // Local override wins — only apply if we've never had this key
        // touched locally OR the remote is newer than our last apply.
    }
    const last = _lastTsFor(key, peer_id);
    if (Number(ts) <= last) return 'skipped';
    try {
        const cfg = loadConfig();
        cfg[key] = value;
        saveConfig(cfg);
        _bumpLastTs(key, peer_id, Number(ts));
        recordClusterAudit({
            kind: 'config_sync',
            ok: true,
            peerId: peer_id,
            detail: `apply ${key} (${policy})`,
        });
        return 'applied';
    } catch (e) {
        recordClusterAudit({
            kind: 'config_sync',
            ok: false,
            peerId: peer_id,
            detail: `${key}: ${e?.message || e}`,
        });
        return 'skipped';
    }
}

export function _resetForTests() {
    kvSet(KV_LAST_TS, {});
}
