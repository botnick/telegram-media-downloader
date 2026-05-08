/**
 * Handshake — the only path that creates a peers row.
 *
 * Operator pastes the remote peer's URL + cluster token in the dashboard.
 * `initiateHandshake({url, token})` runs locally, opens a signed POST
 * `/api/cluster/handshake` against the remote, validates the reply, and
 * (on success) inserts the remote into our own peers table. The remote
 * mirrors the same logic in `acceptHandshake()` — both sides end up
 * holding a peer row referencing each other.
 *
 * Idempotent: a re-pair with the same token + URL returns a 200 "already
 * paired" rather than mutating the row twice. A re-pair after token
 * rotation refreshes the fingerprint and bumps last_seen_at.
 */

import crypto from 'crypto';
import {
    getSelfIdentity,
    getClusterToken,
    fingerprintFor,
    consumePairingCode,
    deriveSecretFromPairingCode,
} from './identity.js';
import { signRequest } from './hmac.js';
import { upsertPeer, getPeer, generateSharedSecret, setSharedSecret } from './peers.js';
import { recordClusterAudit } from '../db.js';

const HANDSHAKE_PATH = '/api/cluster/handshake';
const HANDSHAKE_TIMEOUT_MS = 10_000;

function _readPackageVersion() {
    try {
        // server.js sets this; doctor sets this; deno has its own. Plain
        // npm start exposes it.
        return process.env.npm_package_version || null;
    } catch {
        return null;
    }
}

/**
 * Outbound — used by the dashboard's "Add peer" wizard.
 *
 * Two pairing modes:
 *   1. **Pairing code** (v2.10 default) — operator pastes URL + an
 *      8-char pairing code from the receiving peer. Initiator derives
 *      the receiver's expected secret deterministically + signs.
 *   2. **Legacy token** — operator pastes URL + the receiver's full
 *      cluster_token. Backward-compatible with v2.9.
 *
 * Caller passes EITHER `pairingCode` OR `token`. Both are accepted; if
 * both supplied the pairing code wins.
 *
 * Returns `{ok:true, peer}` on success or `{ok:false, code, message}`
 * on every failure mode.
 */
export async function initiateHandshake({
    url,
    token = null,
    pairingCode = null,
    fetcher = globalThis.fetch,
}) {
    const cleanUrl = String(url || '')
        .trim()
        .replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cleanUrl)) {
        return { ok: false, code: 'bad_url', message: 'URL must start with http:// or https://' };
    }

    let tok;
    if (pairingCode) {
        const code = String(pairingCode).trim().toUpperCase();
        if (!/^[A-Z0-9]{6,16}$/.test(code)) {
            return {
                ok: false,
                code: 'bad_pairing_code',
                message: 'Pairing code must be 6-16 alphanumeric characters',
            };
        }
        tok = deriveSecretFromPairingCode(code);
    } else {
        tok = String(token || '').trim();
        if (!/^[0-9a-f]{32,}$/i.test(tok)) {
            return { ok: false, code: 'bad_token', message: 'Token must be 32+ hex chars' };
        }
    }
    const self = getSelfIdentity();
    // v2.10: initiator generates the per-pair shared_secret + ships it
    // INSIDE the signed handshake body. Both sides persist it after
    // handshake — every subsequent cross-peer call signs with this
    // value instead of the bootstrap token / pairing code.
    const sharedSecret = generateSharedSecret();
    const body = {
        peer_id: self.peerId,
        name: self.name,
        url: '', // filled in by the route from req origin
        version: _readPackageVersion(),
        shared_secret: sharedSecret,
        pairing_code: pairingCode ? String(pairingCode).toUpperCase() : null,
        ts: Date.now(),
    };
    const bodyJson = JSON.stringify(body);
    const headers = signRequest({
        method: 'POST',
        path: HANDSHAKE_PATH,
        body: bodyJson,
        peerId: self.peerId,
        token: tok,
        ts: body.ts,
    });
    headers['Content-Type'] = 'application/json';

    let res;
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), HANDSHAKE_TIMEOUT_MS);
        try {
            res = await fetcher(cleanUrl + HANDSHAKE_PATH, {
                method: 'POST',
                headers,
                body: bodyJson,
                signal: ac.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        recordClusterAudit({
            kind: 'handshake',
            ok: false,
            detail: `outbound to ${cleanUrl}: ${e?.message || e}`,
        });
        return {
            ok: false,
            code: 'unreachable',
            message: `Could not reach ${cleanUrl}: ${e?.message || e}`,
        };
    }

    let payload;
    try {
        payload = await res.json();
    } catch {
        payload = null;
    }
    if (!res.ok) {
        const code = res.status === 401 ? 'token_invalid' : 'remote_error';
        recordClusterAudit({
            kind: 'handshake',
            ok: false,
            peerId: payload?.peer_id || null,
            detail: `outbound to ${cleanUrl} → HTTP ${res.status}`,
        });
        return {
            ok: false,
            code,
            message: payload?.error || `Remote returned HTTP ${res.status}`,
        };
    }
    if (!payload?.peer_id || !payload?.name) {
        return { ok: false, code: 'bad_response', message: 'Remote did not return identity' };
    }
    if (payload.peer_id === self.peerId) {
        return {
            ok: false,
            code: 'self',
            message: 'Cannot pair with self — that URL points to this same instance',
        };
    }
    const fp = fingerprintFor(payload.peer_id, tok);
    const peer = upsertPeer({
        peerId: payload.peer_id,
        name: payload.name,
        url: cleanUrl,
        fingerprint: fp,
        version: payload.version || null,
        streamMode: 'proxy',
        status: 'online',
    });
    // Persist the per-pair shared secret. The receiver sent us back the
    // same value we shipped in the request body (echo) AS PROOF they
    // verified the handshake — both sides now hold the same key.
    try {
        if (payload.shared_secret_ack === sharedSecret) {
            setSharedSecret(payload.peer_id, sharedSecret);
        } else if (payload.shared_secret) {
            // Receiver-suggested secret (legacy v2.9 path or asymmetric
            // pairing). Adopt it.
            setSharedSecret(payload.peer_id, payload.shared_secret);
        }
    } catch (e) {
        recordClusterAudit({
            kind: 'handshake',
            ok: false,
            peerId: payload.peer_id,
            detail: `secret persist failed: ${e?.message || e}`,
        });
    }
    recordClusterAudit({
        kind: 'handshake',
        ok: true,
        peerId: payload.peer_id,
        detail: `outbound to ${cleanUrl}: paired`,
    });
    return { ok: true, peer };
}

/**
 * Inbound — invoked by the express handler at POST /api/cluster/handshake
 * AFTER the HMAC verifier confirms the request was signed by the same
 * token we hold locally. Returns the JSON body to send back.
 *
 * This is the only place that ever auto-creates a peer row from an
 * inbound request — every other route requires an existing pairing.
 *
 * v2.10:
 *   - If `pairingCode` is supplied, it's consumed (single-use) — extra
 *     check on top of HMAC verification.
 *   - If `sharedSecret` is supplied, it's stored as the per-pair secret
 *     and echoed back as `shared_secret_ack` so the initiator knows we
 *     verified.
 */
export function acceptHandshake({
    peerId,
    name,
    url,
    version = null,
    sharedSecret = null,
    pairingCode = null,
}) {
    if (!peerId || !name || !url) {
        const err = new Error('peer_id, name, url required');
        err.code = 'bad_request';
        err.status = 400;
        throw err;
    }
    const self = getSelfIdentity();
    if (peerId === self.peerId) {
        const err = new Error('peer_id matches self');
        err.code = 'self';
        err.status = 400;
        throw err;
    }
    if (pairingCode) {
        // Consume the code — single-use; expired/missing rejects.
        const consumed = consumePairingCode(pairingCode);
        if (!consumed) {
            const err = new Error('pairing code expired or invalid');
            err.code = 'bad_pairing_code';
            err.status = 400;
            throw err;
        }
    }
    const fp = fingerprintFor(peerId, getClusterToken());
    const peer = upsertPeer({
        peerId,
        name,
        url,
        fingerprint: fp,
        version,
        streamMode: 'proxy',
        status: 'online',
    });
    // Persist the per-pair shared secret if the initiator provided one.
    let ack = null;
    if (sharedSecret && /^[0-9a-f]{32,}$/i.test(sharedSecret)) {
        try {
            setSharedSecret(peerId, sharedSecret);
            ack = sharedSecret;
        } catch {
            /* never block handshake on secret persist failure */
        }
    }
    recordClusterAudit({
        kind: 'handshake',
        ok: true,
        peerId,
        detail: `inbound from ${url}: paired${ack ? ' (per-pair-secret installed)' : ''}`,
    });
    return {
        peer_id: self.peerId,
        name: self.name,
        version: _readPackageVersion(),
        fingerprint: fp,
        paired_at: peer.pairedAt,
        shared_secret_ack: ack,
    };
}

/**
 * Lightweight signed health probe — used by the "Test" button on each
 * peer row + by the catalog sync engine before each sweep.
 */
export async function testPeerHealth(peer, { fetcher = globalThis.fetch } = {}) {
    if (!peer?.url) return { ok: false, code: 'bad_peer' };
    const path = '/api/cluster/health';
    const ts = Date.now();
    const headers = signRequest({ method: 'GET', path, ts });
    let res;
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), HANDSHAKE_TIMEOUT_MS);
        try {
            res = await fetcher(peer.url + path, { method: 'GET', headers, signal: ac.signal });
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        return { ok: false, code: 'unreachable', message: e?.message || String(e) };
    }
    if (!res.ok) {
        return {
            ok: false,
            code: res.status === 401 ? 'token_invalid' : 'remote_error',
            status: res.status,
        };
    }
    let payload;
    try {
        payload = await res.json();
    } catch {
        payload = null;
    }
    return { ok: true, payload };
}

/**
 * Test helper — surfaces the constant we sign so tests can reproduce
 * the headers manually if they need to bypass the signRequest helper.
 */
export const _HANDSHAKE_PATH = HANDSHAKE_PATH;
