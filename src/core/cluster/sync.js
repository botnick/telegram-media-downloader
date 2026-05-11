/**
 * Cluster catalog sync engine.
 *
 * For each online peer, periodically pull deltas from
 *   GET /api/cluster/downloads/since?sinceId=<n>&limit=<n>
 * and persist into peer_downloads. Groups + accounts are full-snapshot
 * pulls — they're small and rarely change.
 *
 * Sync state lives in kv['cluster_sync_state']:
 *   { '<peer_id>': { sinceId: <number>, lastSuccessAt: <ms>, lastError: <str> } }
 *
 * The engine is a singleton per process: startSyncEngine() / stopSyncEngine().
 * Every getDb() boot calls startSyncEngine() once via runtime.js wiring.
 *
 * Errors are non-fatal — a failing peer just falls behind on cache freshness;
 * the dashboard still serves what it has, with a "stale" timestamp pill.
 */

import {
    kvGet,
    kvSet,
    upsertPeerDownloadsBatch,
    setPeerCatalogBlob,
    recordClusterAudit,
} from '../db.js';
import { listPeers, markOnline, markOffline } from './peers.js';
import { signRequest } from './hmac.js';

const SYNC_KEY = 'cluster_sync_state';
const DEFAULT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

let _timer = null;
let _running = false;
let _fetcher = globalThis.fetch;

function _state() {
    return kvGet(SYNC_KEY) || {};
}
function _saveState(s) {
    kvSet(SYNC_KEY, s || {});
}

async function _signedFetch(
    url,
    { method = 'GET', body = null, signal, targetPeerId = null } = {},
) {
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    // Use per-pair shared_secret when caller knows the target peer.
    // Same reasoning as testPeerHealth / proxy.js: the legacy global
    // cluster_token gets rotated after pairing so signing with it
    // produces a 401 even on a healthy paired link.
    const headers = signRequest({ method, path, body, targetPeerId });
    if (body && typeof body !== 'string') {
        body = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    try {
        return await _fetcher(url, { method, headers, body: body || undefined, signal: ac.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Pull one page of deltas from a peer. Returns
 *   { ok, count, nextSinceId, code? }
 */
export async function syncPeerOnce(peer, { fetcher = _fetcher, limit = 500 } = {}) {
    if (!peer?.url || !peer?.peerId) return { ok: false, code: 'bad_peer' };
    _fetcher = fetcher; // honour test injection
    const state = _state();
    const ps = state[peer.peerId] || {};
    const sinceId = Number(ps.sinceId) || 0;
    const url = `${peer.url}/api/cluster/downloads/since?sinceId=${sinceId}&limit=${limit}`;
    let res;
    try {
        res = await _signedFetch(url, { method: 'GET', targetPeerId: peer.peerId });
    } catch (e) {
        markOffline(peer.peerId);
        const detail = `sync ${peer.peerId}: ${e?.message || String(e)}`;
        recordClusterAudit({ kind: 'sync', ok: false, peerId: peer.peerId, detail });
        ps.lastError = detail;
        state[peer.peerId] = ps;
        _saveState(state);
        return { ok: false, code: 'unreachable' };
    }
    if (!res.ok) {
        markOffline(peer.peerId);
        const detail = `sync ${peer.peerId}: HTTP ${res.status}`;
        recordClusterAudit({ kind: 'sync', ok: false, peerId: peer.peerId, detail });
        ps.lastError = detail;
        state[peer.peerId] = ps;
        _saveState(state);
        return { ok: false, code: res.status === 401 ? 'token_invalid' : 'remote_error' };
    }
    let payload;
    try {
        payload = await res.json();
    } catch {
        payload = null;
    }
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (rows.length) {
        upsertPeerDownloadsBatch(peer.peerId, rows);
        // Bounded loop instead of `Math.max(sinceId, ...rows.map(…))` —
        // V8 caps function-arg count at ~65 535, so a spread over a
        // future larger sync page (or a malicious peer payload) would
        // throw RangeError mid-tick. See CLAUDE.md → Big-data patterns.
        let maxId = sinceId;
        for (const r of rows) {
            const id = Number(r.id || r.remoteId) || 0;
            if (id > maxId) maxId = id;
        }
        ps.sinceId = maxId;
    }
    ps.lastSuccessAt = Date.now();
    ps.lastError = null;
    state[peer.peerId] = ps;
    _saveState(state);
    markOnline(peer.peerId);
    if (rows.length) {
        recordClusterAudit({
            kind: 'sync',
            ok: true,
            peerId: peer.peerId,
            detail: `${rows.length} rows, sinceId=${sinceId}→${ps.sinceId}`,
        });
    }
    return { ok: true, count: rows.length, nextSinceId: ps.sinceId };
}

/**
 * One pass over every paired peer. Sequential (one at a time) to keep
 * memory + connection pressure predictable.
 */
export async function syncAllOnce({ fetcher = _fetcher } = {}) {
    const peers = listPeers();
    let totalRows = 0;
    for (const p of peers) {
        if (p.status === 'revoked') continue;
        const r = await syncPeerOnce(p, { fetcher });
        if (r.ok) totalRows += r.count || 0;
    }
    return { peers: peers.length, rows: totalRows };
}

export function startSyncEngine({
    intervalMs = DEFAULT_INTERVAL_MS,
    fetcher = globalThis.fetch,
} = {}) {
    if (_timer || _running) return;
    _running = true;
    _fetcher = fetcher;
    const tick = async () => {
        if (!_running) return;
        try {
            await syncAllOnce({ fetcher: _fetcher });
        } catch (e) {
            // never let a sync exception kill the timer
            recordClusterAudit({ kind: 'sync', ok: false, detail: e?.message || String(e) });
        }
    };
    // Don't fire immediately on boot — let the rest of the system settle.
    _timer = setInterval(tick, Math.max(5_000, intervalMs));
    if (typeof _timer.unref === 'function') _timer.unref();
}

export function stopSyncEngine() {
    _running = false;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

export function getSyncState() {
    return _state();
}
