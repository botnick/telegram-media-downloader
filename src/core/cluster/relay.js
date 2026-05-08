/**
 * Relay-through-peer — Phase D (v2.10).
 *
 * Source `A` wants to call target `C` but can't reach `C` directly. If
 * `A` is paired with both `B` and `C`, and `B` is paired with `C`, `A`
 * can ask `B` to forward an end-to-end signed request:
 *
 *     A  ──signs(B-secret)──>  B  ──signs(B↔C secret + forwards inner_sig)──>  C
 *                                        ▲ B re-signs the outer wrapping
 *                                          but cannot tamper the inner
 *                                          (which is signed by A's pair
 *                                          secret with C).
 *
 * Wire format for `POST /api/cluster/relay/proxy`:
 *
 *     {
 *       "to_peer_id": "<C-uuid>",
 *       "method":     "GET",
 *       "path":       "/api/cluster/health",
 *       "headers":    { ... } (optional, allow-listed),
 *       "body_b64":   "" (raw body or empty),
 *       "ts":         <unix-ms>,
 *       "inner_sig":  "<hmac(A↔C-secret, base)>"
 *     }
 *
 *   B verifies the OUTER signature (HMAC headers) against B↔A pair
 *   secret. If `to_peer_id === self`, B unwraps + verifies inner_sig
 *   against B↔A secret (degenerate case). Otherwise, B forwards to
 *   `<C.url>/<path>` with method/body and the inner_sig as
 *   `X-Peer-Signature`. C verifies against its own A↔C pair secret.
 *   B has no access to C's pair secret with A, so it cannot fake or
 *   tamper.
 *
 * Quotas: each source peer is limited to 100 MB / 24h relayed bytes
 * (configurable). Quota state is in-memory; resets on restart (cheap;
 * abuse is rare).
 */

import crypto from 'crypto';
import { getSharedSecret, getPeer, listPeers } from './peers.js';
import { getSelfPeerId } from './identity.js';
import { signRequest } from './hmac.js';
import { recordClusterAudit } from '../db.js';

const RELAY_DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB
const RELAY_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const RELAY_TIMEOUT_MS = 30_000;
const RELAY_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB single-shot

const _quota = new Map(); // sourcePeerId → { bytes, since }

function _quotaCheck(sourcePeerId, bytes, limit = RELAY_DEFAULT_QUOTA_BYTES) {
    const now = Date.now();
    let entry = _quota.get(sourcePeerId);
    if (!entry || now - entry.since > RELAY_QUOTA_WINDOW_MS) {
        entry = { bytes: 0, since: now };
        _quota.set(sourcePeerId, entry);
    }
    if (entry.bytes + bytes > limit) return false;
    entry.bytes += bytes;
    return true;
}

/**
 * Pick a paired peer that's likely to reach `targetPeerId`. Heuristic:
 * the most-recently-online paired peer that is NOT the target itself.
 * If none qualifies, returns null.
 */
export function pickRelayPeer(targetPeerId) {
    const peers = listPeers();
    return (
        peers
            .filter(
                (p) =>
                    p.peerId !== targetPeerId &&
                    p.status !== 'revoked' &&
                    !!getSharedSecret(p.peerId),
            )
            .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))[0] || null
    );
}

/**
 * Source-side: relay a signed call to `targetPeerId` through any paired
 * peer that can reach it. Returns the fetch Response from the final
 * target, or throws on relay failure.
 */
export async function relayTo({
    targetPeerId,
    method = 'GET',
    path,
    body = null,
    relayPeerId = null,
    fetcher = globalThis.fetch,
}) {
    const target = getPeer(targetPeerId);
    if (!target) throw new Error('target peer not paired');
    const relay = relayPeerId ? getPeer(relayPeerId) : pickRelayPeer(targetPeerId);
    if (!relay) throw new Error('no paired peer available to relay through');
    if (!getSharedSecret(target.peerId)) {
        throw new Error('no per-pair secret for target — cannot sign inner');
    }

    // Inner signature — what the target verifies against its A↔C secret.
    const ts = Date.now();
    const innerHeaders = signRequest({
        method,
        path,
        body,
        peerId: getSelfPeerId(),
        targetPeerId: target.peerId,
        ts,
    });

    // Wrap in the relay envelope.
    const bodyBuf =
        body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const envelope = {
        to_peer_id: target.peerId,
        method: String(method).toUpperCase(),
        path: String(path),
        body_b64: bodyBuf.toString('base64'),
        ts,
        inner_sig: innerHeaders['X-Peer-Signature'],
        inner_ts: innerHeaders['X-Peer-Ts'],
    };
    const envBody = JSON.stringify(envelope);
    const outerHeaders = signRequest({
        method: 'POST',
        path: '/api/cluster/relay/proxy',
        body: envBody,
        peerId: getSelfPeerId(),
        targetPeerId: relay.peerId,
    });
    outerHeaders['Content-Type'] = 'application/json';

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
    let res;
    try {
        res = await fetcher(`${relay.url}/api/cluster/relay/proxy`, {
            method: 'POST',
            headers: outerHeaders,
            body: envBody,
            signal: ac.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    return res;
}

/**
 * Transit-side: invoked by the express handler at
 * `POST /api/cluster/relay/proxy` AFTER the outer HMAC has been
 * verified. Forwards the inner request to the target peer.
 *
 * Throws on quota exceeded, bad target, or unreachable target.
 */
export async function handleRelay({ envelope, sourcePeerId, fetcher = globalThis.fetch }) {
    if (!envelope?.to_peer_id || !envelope?.method || !envelope?.path) {
        const err = new Error('bad envelope');
        err.status = 400;
        throw err;
    }
    if (envelope.to_peer_id === getSelfPeerId()) {
        // Degenerate case — source asked to relay to us. Tell them to call
        // directly.
        const err = new Error('relay target is self — call direct');
        err.status = 400;
        throw err;
    }
    const target = getPeer(envelope.to_peer_id);
    if (!target) {
        const err = new Error('relay target not paired with this peer');
        err.status = 404;
        throw err;
    }

    const bodyBuf = envelope.body_b64
        ? Buffer.from(String(envelope.body_b64), 'base64')
        : Buffer.alloc(0);
    if (bodyBuf.length > RELAY_MAX_BODY_BYTES) {
        const err = new Error('relay body too large');
        err.status = 413;
        throw err;
    }
    if (!_quotaCheck(sourcePeerId, bodyBuf.length)) {
        const err = new Error('relay quota exceeded for source peer');
        err.status = 429;
        throw err;
    }

    // Forward — RE-SIGN the OUTER HMAC headers between us and the target,
    // BUT pass the inner_sig back as `X-Peer-Signature` value? No: the
    // target validates against the A↔C secret (which we don't have).
    // Crucial detail: the target uses `X-Peer-Id = sourcePeerId` (NOT us)
    // and `X-Peer-Signature = envelope.inner_sig`. The target then
    // verifies against the A↔C secret it has stored.
    const headers = {
        'X-Peer-Id': sourcePeerId,
        'X-Peer-Ts': String(envelope.inner_ts || envelope.ts),
        'X-Peer-Signature': envelope.inner_sig,
    };
    const fetchInit = {
        method: envelope.method,
        headers,
        signal: AbortSignal.timeout ? AbortSignal.timeout(RELAY_TIMEOUT_MS) : undefined,
    };
    if (envelope.method !== 'GET' && envelope.method !== 'HEAD' && bodyBuf.length) {
        fetchInit.body = bodyBuf;
        // Best-effort content-type — most cluster JSON requests are app/json.
        headers['Content-Type'] = envelope.contentType || 'application/json';
    }
    const url = target.url + envelope.path;
    let res;
    try {
        res = await fetcher(url, fetchInit);
    } catch (e) {
        recordClusterAudit({
            kind: 'relay',
            ok: false,
            peerId: sourcePeerId,
            detail: `→ ${target.peerId}: ${e?.message || e}`,
        });
        const err = new Error(`relay fetch failed: ${e?.message || e}`);
        err.status = 502;
        throw err;
    }
    recordClusterAudit({
        kind: 'relay',
        ok: res.ok,
        peerId: sourcePeerId,
        detail: `→ ${target.peerId} ${envelope.method} ${envelope.path} → ${res.status}`,
    });
    return res;
}

/**
 * Test seam — clear quota state.
 */
export function _resetQuotaForTests() {
    _quota.clear();
}
