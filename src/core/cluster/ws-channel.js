/**
 * Cluster WebSocket channel — Phase B (v2.10).
 *
 * Each peer maintains TWO things:
 *   - One WS server endpoint at `/ws/cluster` (mounted on the existing
 *     `wss = WebSocketServer({noServer:true})` upgrade handler in
 *     server.js). Accepts authenticated peer connections; routes
 *     incoming events into local DB updates + WS rebroadcast.
 *   - One outbound WS client per paired peer. Reconnect with backoff.
 *
 * Wire format (every message after the handshake):
 *   {
 *     type:    'download_added' | 'download_deleted' | 'group_changed'
 *              | 'config_changed' | 'failover_requested' | 'peer_status'
 *              | 'ping' | 'pong',
 *     payload: <object>,
 *     ts:      <unix-ms>,
 *     sig:     hex(hmac_sha256(per-pair-secret, type|ts|sha256(payload-json)))
 *   }
 *
 * The handshake on connect is the same HMAC scheme as HTTP: the
 * inbound handler verifies a signed `?ts=<>&peer=<>&sig=<>` query
 * string against the per-pair secret. Pre-handshake, the connection
 * stays in "pending" state for 5s then auto-closes if no auth lands.
 */

import crypto from 'crypto';
import { listPeers, getPeer, markOnline, markOffline } from './peers.js';
import { getSelfPeerId } from './identity.js';
import {
    getPeerSharedSecret,
    setPeerWsLastSeen,
    upsertPeerDownloadsBatch,
    deletePeerDownloadsByRemoteIds,
    setPeerCatalogBlob,
    recordClusterAudit,
} from '../db.js';

const HEARTBEAT_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SEEN_SIG_TTL_MS = 5 * 60 * 1000;

const _outbound = new Map(); // peerId → { ws, status, reconnectAttempt, timers }
const _seenSigs = new Map(); // sig → expireAt

let _broadcastFn = () => {};
let _wsCtor = null; // injected at start (ws library)

/**
 * Initialise the cluster WS subsystem. Server.js calls this once with
 *   - broadcast: the local UI WS broadcaster
 *   - WebSocket: the `ws` package's client class
 * Idempotent.
 */
export function initClusterWs({ broadcast, WebSocket } = {}) {
    if (typeof broadcast === 'function') _broadcastFn = broadcast;
    if (WebSocket) _wsCtor = WebSocket;
    _connectAll();
}

function _broadcastLocal(msg) {
    try {
        _broadcastFn(msg);
    } catch {
        /* nothing */
    }
}

function _payloadHash(payload) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(payload || {}), 'utf8')
        .digest('hex');
}
function _sigBase(type, ts, payload) {
    return `${type}|${ts}|${_payloadHash(payload)}`;
}
function _sign(secret, type, ts, payload) {
    return crypto
        .createHmac('sha256', secret)
        .update(_sigBase(type, ts, payload))
        .digest('hex');
}
function _verify(secret, type, ts, payload, sig) {
    try {
        const expected = _sign(secret, type, ts, payload);
        const a = Buffer.from(sig, 'hex');
        const b = Buffer.from(expected, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function _gcSeen(now = Date.now()) {
    if (_seenSigs.size < 5000) return;
    for (const [k, exp] of _seenSigs) if (exp <= now) _seenSigs.delete(k);
}

/**
 * Build the connect-time auth query string for an outbound link.
 * Format: ?peer=<self-id>&ts=<ms>&sig=<hmac(secret, 'connect|<ts>')>
 */
function _connectAuthQuery(peerId) {
    const secret = _peerSecret(peerId);
    if (!secret) return null;
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', secret).update(`connect|${ts}`).digest('hex');
    return `peer=${encodeURIComponent(getSelfPeerId())}&ts=${ts}&sig=${sig}`;
}

function _peerSecret(peerId) {
    const buf = getPeerSharedSecret(peerId);
    if (!buf) return null;
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
}

/**
 * Verify a connect-time query string at the inbound side. Returns the
 * authenticated peer_id or null.
 */
export function verifyConnectAuth(query, { now = Date.now() } = {}) {
    const peerId = query?.peer;
    const ts = Number(query?.ts);
    const sig = query?.sig;
    if (!peerId || !Number.isFinite(ts) || !sig) return null;
    if (Math.abs(now - ts) > 60_000) return null; // 60s replay window
    const secret = _peerSecret(peerId);
    if (!secret) return null;
    const expected = crypto.createHmac('sha256', secret).update(`connect|${ts}`).digest('hex');
    try {
        const a = Buffer.from(sig, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    } catch {
        return null;
    }
    return String(peerId);
}

/**
 * Register an inbound WebSocket connection — called by the server's
 * upgrade handler AFTER verifyConnectAuth.
 */
export function registerInboundWs(peerId, ws) {
    if (!peerId || !ws) return;
    markOnline(peerId);
    setPeerWsLastSeen(peerId);
    _broadcastLocal({ type: 'peer_status', peerId, status: 'online' });
    let pingTimer = setInterval(() => {
        try {
            ws.ping();
        } catch {
            /* nothing */
        }
    }, HEARTBEAT_MS);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        _handleInbound(peerId, msg);
    });
    const onClose = () => {
        clearInterval(pingTimer);
        markOffline(peerId);
        _broadcastLocal({ type: 'peer_status', peerId, status: 'offline' });
    };
    ws.on('close', onClose);
    ws.on('error', onClose);
}

function _handleInbound(senderId, msg) {
    if (!msg || typeof msg !== 'object') return;
    const { type, payload, ts, sig } = msg;
    if (!type || !ts || !sig) return;
    const secret = _peerSecret(senderId);
    if (!secret) return;
    if (!_verify(secret, type, ts, payload, sig)) {
        recordClusterAudit({
            kind: 'ws_event',
            ok: false,
            peerId: senderId,
            detail: `bad sig for ${type}`,
        });
        return;
    }
    const now = Date.now();
    _gcSeen(now);
    if (_seenSigs.has(sig)) return; // replay
    _seenSigs.set(sig, now + SEEN_SIG_TTL_MS);
    setPeerWsLastSeen(senderId);

    switch (type) {
        case 'ping':
            return; // we just bumped ws_last_seen; nothing to respond
        case 'download_added':
        case 'download_updated':
            try {
                upsertPeerDownloadsBatch(senderId, [payload]);
                _broadcastLocal({
                    type: 'peer_catalog_update',
                    peerId: senderId,
                    op: type === 'download_added' ? 'add' : 'update',
                    row: payload,
                });
            } catch {
                /* nothing */
            }
            return;
        case 'download_deleted':
            try {
                if (payload?.remote_id != null) {
                    deletePeerDownloadsByRemoteIds(senderId, [Number(payload.remote_id)]);
                    _broadcastLocal({
                        type: 'peer_catalog_update',
                        peerId: senderId,
                        op: 'delete',
                        remoteId: Number(payload.remote_id),
                    });
                }
            } catch {
                /* nothing */
            }
            return;
        case 'group_changed':
        case 'group_added':
        case 'group_removed':
            try {
                setPeerCatalogBlob('peer_groups', senderId, payload?.groups || []);
            } catch {
                /* nothing */
            }
            _broadcastLocal({ type: 'peer_groups_update', peerId: senderId });
            return;
        case 'config_changed':
            // Phase F applies the change locally (last-writer-wins by ts +
            // peer_id tiebreak), then mirrors to the local UI WS so any
            // open Settings tab can refresh.
            (async () => {
                try {
                    const m = await import('./config-sync.js');
                    const action = m.applyRemoteConfigChange(payload);
                    _broadcastLocal({
                        type: 'cluster_config_changed',
                        peerId: senderId,
                        payload,
                        action,
                    });
                } catch {
                    _broadcastLocal({
                        type: 'cluster_config_changed',
                        peerId: senderId,
                        payload,
                    });
                }
            })();
            return;
        case 'failover_requested':
        case 'failover_completed':
            _broadcastLocal({
                type: 'cluster_failover',
                peerId: senderId,
                stage: type,
                payload,
            });
            return;
        case 'peer_status':
            // Mirror to local UI.
            _broadcastLocal({
                type: 'peer_status',
                peerId: senderId,
                status: payload?.status,
            });
            return;
        default:
            // Forward unknown types as a generic cluster event for
            // forward-compat with newer peers.
            _broadcastLocal({ type: 'cluster_event', peerId: senderId, payload, kind: type });
            return;
    }
}

/**
 * Open / refresh outbound connections to every paired peer.
 */
function _connectAll() {
    if (!_wsCtor) return;
    const peers = listPeers();
    for (const p of peers) {
        if (p.status === 'revoked') continue;
        if (!_outbound.has(p.peerId)) {
            _outbound.set(p.peerId, {
                ws: null,
                status: 'connecting',
                reconnectAttempt: 0,
            });
            _connectOne(p);
        }
    }
}

function _connectOne(peer) {
    if (!_wsCtor) return;
    const state = _outbound.get(peer.peerId) || { reconnectAttempt: 0 };
    const auth = _connectAuthQuery(peer.peerId);
    if (!auth) {
        // Pair has no shared secret yet (mid-migration). Defer; another
        // peer.added event will retry when secret lands.
        return;
    }
    const wsUrl = peer.url.replace(/^http/i, 'ws') + '/ws/cluster?' + auth;
    let ws;
    try {
        ws = new _wsCtor(wsUrl);
    } catch (e) {
        recordClusterAudit({
            kind: 'ws_connect',
            ok: false,
            peerId: peer.peerId,
            detail: `${e?.message || e}`,
        });
        _scheduleReconnect(peer);
        return;
    }
    state.ws = ws;
    state.status = 'connecting';
    _outbound.set(peer.peerId, state);

    let pingTimer = null;
    let pongDeadline = null;
    const armPongDeadline = () => {
        clearTimeout(pongDeadline);
        pongDeadline = setTimeout(() => {
            try {
                ws.terminate();
            } catch {
                /* nothing */
            }
        }, HEARTBEAT_TIMEOUT_MS);
        if (typeof pongDeadline.unref === 'function') pongDeadline.unref();
    };

    ws.on('open', () => {
        state.status = 'open';
        state.reconnectAttempt = 0;
        markOnline(peer.peerId);
        _broadcastLocal({ type: 'peer_status', peerId: peer.peerId, status: 'online' });
        recordClusterAudit({ kind: 'ws_connect', ok: true, peerId: peer.peerId });
        pingTimer = setInterval(() => {
            try {
                ws.ping();
                armPongDeadline();
            } catch {
                /* nothing */
            }
        }, HEARTBEAT_MS);
        if (typeof pingTimer.unref === 'function') pingTimer.unref();
    });
    ws.on('pong', () => clearTimeout(pongDeadline));
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        _handleInbound(peer.peerId, msg);
    });
    const onClose = () => {
        if (pingTimer) clearInterval(pingTimer);
        clearTimeout(pongDeadline);
        if (state.status !== 'closing') {
            markOffline(peer.peerId);
            _broadcastLocal({ type: 'peer_status', peerId: peer.peerId, status: 'offline' });
        }
        state.status = 'closed';
        _scheduleReconnect(peer);
    };
    ws.on('close', onClose);
    ws.on('error', onClose);
}

function _scheduleReconnect(peer) {
    const state = _outbound.get(peer.peerId);
    if (!state) return;
    state.reconnectAttempt = (state.reconnectAttempt || 0) + 1;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** state.reconnectAttempt);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(500, Math.floor(base + jitter));
    const t = setTimeout(() => _connectOne(peer), delay);
    if (typeof t.unref === 'function') t.unref();
}

/**
 * Broadcast a signed event to every paired peer over the outbound WS
 * channel. Falls back to no-op when no peers are paired (or libs not
 * inited yet).
 */
export function broadcastClusterEvent(type, payload) {
    if (!_wsCtor) return;
    const ts = Date.now();
    for (const [peerId, state] of _outbound) {
        if (!state?.ws || state.status !== 'open') continue;
        const secret = _peerSecret(peerId);
        if (!secret) continue;
        const sig = _sign(secret, type, ts, payload);
        try {
            state.ws.send(JSON.stringify({ type, payload, ts, sig }));
        } catch {
            /* nothing — reconnect will pick it up */
        }
    }
}

/**
 * Tear down all outbound connections (used on graceful shutdown / test
 * teardown).
 */
export function shutdownClusterWs() {
    for (const [, state] of _outbound) {
        try {
            state.status = 'closing';
            state.ws?.close();
        } catch {
            /* nothing */
        }
    }
    _outbound.clear();
    _seenSigs.clear();
}

/**
 * Refresh outbound connections — call after a peer is added or after
 * a per-pair secret is installed.
 */
export function reconnectPeers() {
    _connectAll();
}

/**
 * Test seam: peek the current outbound connection map. Returns an
 * array of `{peerId, status, reconnectAttempt}`.
 */
export function _outboundSnapshot() {
    return Array.from(_outbound.entries()).map(([peerId, s]) => ({
        peerId,
        status: s.status,
        reconnectAttempt: s.reconnectAttempt || 0,
    }));
}
