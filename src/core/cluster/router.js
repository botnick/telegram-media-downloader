/**
 * Owner-peer routing — Phase 5 dedup layer 1.
 *
 * Each `groups[i]` in `kv['config']` may carry an `ownerPeerId` field. If
 * set, only the peer whose `peer_id` matches owns the group's downloads;
 * other peers see the group's catalog via cluster sync but do NOT spawn
 * Telegram clients for it.
 *
 * The realtime monitor + history backfill consult `isLocalGroup(group)`
 * before doing any Telegram work. The downloader consults
 * `getOwnerPeerForGroup(groupId)` only as a sanity check.
 */

import { getSelfPeerId } from './identity.js';
import { getPeer } from './peers.js';
import { loadConfig } from '../../config/manager.js';

/**
 * Returns the peer record (or null) that should own a given group.
 *   - explicit per-group `ownerPeerId` matches a paired peer  → that peer
 *   - explicit `ownerPeerId === selfPeerId`                     → null (self-owns)
 *   - no override                                               → null (caller treats as self-owned)
 *
 * Returning `null` is the legacy default: the local peer downloads.
 */
export function getOwnerPeerForGroup(groupOrId) {
    const cfg = (() => {
        try {
            return loadConfig();
        } catch {
            return {};
        }
    })();
    const groups = Array.isArray(cfg?.groups) ? cfg.groups : [];
    let g;
    if (typeof groupOrId === 'object' && groupOrId !== null) {
        g = groupOrId;
    } else {
        const id = String(groupOrId);
        g = groups.find((x) => String(x.id ?? x.groupId) === id) || null;
    }
    if (!g) return null;
    const owner = String(g.ownerPeerId || '').trim();
    if (!owner || owner === getSelfPeerId()) return null;
    return getPeer(owner);
}

/**
 * True when this peer should be doing Telegram work for the group.
 * Convenient guard for `monitor.start()` / `forwarder.process()`.
 */
export function isLocalGroup(groupOrId) {
    const owner = getOwnerPeerForGroup(groupOrId);
    return owner == null; // null = self-owned (no remote owner set)
}
