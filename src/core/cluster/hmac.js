/**
 * HMAC signing + verification for cross-peer requests.
 *
 * Every cross-peer HTTP request carries three headers:
 *
 *   X-Peer-Id        — sender's peer_id (UUID).
 *   X-Peer-Ts        — unix-ms timestamp at request build time.
 *   X-Peer-Signature — hex(hmac_sha256(token, METHOD + '\n' + PATH + '\n' + Ts + '\n' + sha256(body))).
 *
 * Verification rejects:
 *   - Missing headers.
 *   - Timestamp drift > REPLAY_WINDOW_MS in either direction.
 *   - Signature mismatch (constant-time compare).
 *   - Replay (same {peer_id, ts, sig} tuple seen within RECENT_TUPLE_TTL_MS).
 *
 * The replay cache is in-memory only — it would need to be a shared store
 * if peers ever ran more than one Node process per identity, but the
 * downloader's "single writer" invariant makes this safe today.
 */

import crypto from 'crypto';
import { getClusterToken, getSelfPeerId } from './identity.js';
import { getSharedSecret } from './peers.js';

export const REPLAY_WINDOW_MS = 60 * 1000; // ±60s clock-skew tolerance
const RECENT_TUPLE_TTL_MS = 5 * 60 * 1000; // forget seen-sigs after 5 min

const _seen = new Map(); // sigHex → expireAt

function sweepSeen(now = Date.now()) {
    if (_seen.size < 5000) return;
    for (const [k, exp] of _seen) {
        if (exp <= now) _seen.delete(k);
    }
}

function bodyHash(body) {
    if (body == null) return crypto.createHash('sha256').update('').digest('hex');
    if (Buffer.isBuffer(body)) {
        return crypto.createHash('sha256').update(body).digest('hex');
    }
    if (typeof body === 'string') {
        return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    }
    // object → canonical JSON
    return crypto.createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

function buildBaseString({ method, path, ts, body }) {
    const m = String(method || 'GET').toUpperCase();
    // Path includes query string. Strip origin if caller passed a full URL.
    let p;
    try {
        const u = new URL(String(path));
        p = u.pathname + (u.search || '');
    } catch {
        p = String(path || '/');
    }
    return `${m}\n${p}\n${Number(ts)}\n${bodyHash(body)}`;
}

/**
 * Sign an outbound request to a specific target peer. v2.10 priority is
 * to use the per-pair `shared_secret` (looked up by `targetPeerId`); if
 * not yet set (mid-migration from v2.9), fall back to the legacy global
 * `cluster_token` so existing pairings keep working until they re-pair.
 *
 * Callers that DON'T have a target peer id (e.g. the very first
 * handshake call, where the peer row doesn't exist yet) pass `token`
 * explicitly — that's the receiver's pairing-code-derived secret or
 * legacy cluster_token, depending on flow.
 */
export function signRequest({
    method,
    path,
    body = null,
    peerId = null, // sender peer_id (this instance)
    targetPeerId = null, // receiver peer_id — resolves the pair secret
    token = null, // explicit override (handshake / pairing-code path)
    ts = null,
}) {
    let tok = token;
    if (!tok && targetPeerId) {
        tok = getSharedSecret(targetPeerId);
    }
    if (!tok) tok = getClusterToken(); // legacy fallback
    const id = peerId || getSelfPeerId();
    const stamp = Number(ts) || Date.now();
    const base = buildBaseString({ method, path, ts: stamp, body });
    const sig = crypto.createHmac('sha256', tok).update(base).digest('hex');
    return {
        'X-Peer-Id': id,
        'X-Peer-Ts': String(stamp),
        'X-Peer-Signature': sig,
    };
}

/**
 * Verify an inbound express request. Returns either
 *   { ok: true, peerId }
 *   { ok: false, reason }
 *
 * `reason` is a stable code (`missing_headers`, `bad_ts`, `clock_skew`,
 * `bad_signature`, `replay`) so the audit log + UI can group failures.
 *
 * `expectedToken` lets the handshake path verify against the locally
 * configured cluster token before any peer row exists. After pairing,
 * routes can pass null and we fall back to getClusterToken().
 *
 * Body must be the RAW bytes the client sent (string or Buffer) — re-
 * stringifying a parsed JSON object would change whitespace and break
 * the hash. The express integration captures `req.rawBody` upstream.
 */
export function verifyRequest(req, { expectedToken = null, now = null } = {}) {
    const headers = req?.headers || {};
    const peerId = headers['x-peer-id'];
    const tsRaw = headers['x-peer-ts'];
    const sig = headers['x-peer-signature'];
    if (!peerId || !tsRaw || !sig) {
        return { ok: false, reason: 'missing_headers' };
    }
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || ts <= 0) {
        return { ok: false, reason: 'bad_ts' };
    }
    const t = now || Date.now();
    if (Math.abs(t - ts) > REPLAY_WINDOW_MS) {
        return { ok: false, reason: 'clock_skew' };
    }

    // v2.10: try the per-pair secret first (looked up by the caller's
    // peer_id), fall back to the legacy global cluster_token for v2.9
    // peers that haven't re-paired yet, and finally accept an explicit
    // expectedToken from the handshake bootstrap path. A request matches
    // if it verifies under ANY of the three keys.
    const candidates = [];
    if (expectedToken) candidates.push(expectedToken);
    const pairSecret = getSharedSecret(peerId);
    if (pairSecret) candidates.push(pairSecret);
    const legacy = getClusterToken();
    if (legacy && !candidates.includes(legacy)) candidates.push(legacy);
    if (!candidates.length) return { ok: false, reason: 'no_secret' };

    const path = req.originalUrl || req.url || '/';
    const method = req.method || 'GET';
    const body = req.rawBody != null ? req.rawBody : '';
    const base = buildBaseString({ method, path, ts, body });

    let matched = false;
    for (const tok of candidates) {
        const expected = crypto.createHmac('sha256', tok).update(base).digest('hex');
        try {
            const a = Buffer.from(String(sig), 'hex');
            const b = Buffer.from(expected, 'hex');
            if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
                matched = true;
                break;
            }
        } catch {
            /* fall through */
        }
    }
    if (!matched) return { ok: false, reason: 'bad_signature' };

    // Replay guard.
    sweepSeen(t);
    if (_seen.has(sig)) {
        return { ok: false, reason: 'replay' };
    }
    _seen.set(sig, t + RECENT_TUPLE_TTL_MS);
    return { ok: true, peerId: String(peerId), ts };
}

/**
 * Test helper — clears the replay cache. Production code never needs
 * this; vitest uses it to avoid order-dependence between specs.
 */
export function _resetReplayCacheForTests() {
    _seen.clear();
}
