/**
 * Streaming bridge — Phase 3 (proxy mode).
 *
 * `streamFromPeer(req, res, peerId, remotePath)` is the only path the
 * dashboard takes when serving a file that physically lives on another
 * peer. It:
 *   1. Looks up the peer + its cluster_token (we hold a single shared
 *      token; see identity.js setClusterToken).
 *   2. Issues a signed `GET /api/cluster/files/<encoded>` against the
 *      peer with the client's `Range` header forwarded.
 *   3. Pipes the response back to the browser, mirroring status + key
 *      headers (Content-Length, Content-Range, Content-Type, ETag,
 *      Accept-Ranges) so video seek + resume-download keep working.
 *
 * Direct mode (Phase 4) takes a different branch in the route — it calls
 * `requestSignedShareUrl()` and 302-redirects the browser.
 */

import { signRequest } from './hmac.js';
import { getPeer } from './peers.js';
import { recordClusterAudit } from '../db.js';

const STREAM_TIMEOUT_MS = 30_000;

const _refCounts = new Map(); // download key → count

export function acquireStreamLock(key) {
    _refCounts.set(key, (_refCounts.get(key) || 0) + 1);
}
export function releaseStreamLock(key) {
    const n = (_refCounts.get(key) || 1) - 1;
    if (n <= 0) _refCounts.delete(key);
    else _refCounts.set(key, n);
}
export function isStreamLocked(key) {
    return (_refCounts.get(key) || 0) > 0;
}

function _proxyHeaders({ peerId, peerName }, res, sourceHeaders) {
    res.setHeader('X-Bridge-Peer', peerName || peerId);
    res.setHeader('Cache-Control', 'private, no-store');
    const passThrough = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
        'content-disposition',
    ];
    for (const h of passThrough) {
        const v = sourceHeaders.get(h);
        if (v != null) res.setHeader(h, v);
    }
}

/**
 * Open a stream against a peer and return the fetch Response. Used both
 * by streamFromPeer (for /files) and by the bulk-zip cluster branch
 * (which needs the body as a Readable for ZipStream consumption).
 */
export async function openPeerStream(
    peerOrId,
    remotePath,
    { range = null, fetcher = globalThis.fetch, signal = null } = {},
) {
    const peer = typeof peerOrId === 'string' ? getPeer(peerOrId) : peerOrId;
    if (!peer) throw new Error('peer not paired');
    if (peer.status === 'revoked') throw new Error('peer revoked');
    const url = `${peer.url}/api/cluster/files/${encodeURIComponent(remotePath)}`;
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    // Pass `targetPeerId` so signRequest uses the per-pair shared_secret
    // instead of falling back to the legacy global cluster_token. The
    // remote peer rotated to the per-pair key on handshake; without this
    // hint the file fetch would 401 even though `Test` and `Handshake`
    // both succeeded earlier in the same pair lifecycle.
    const headers = signRequest({ method: 'GET', path, targetPeerId: peer.peerId });
    if (range) headers.Range = range;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), STREAM_TIMEOUT_MS);
    if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    let res;
    try {
        res = await fetcher(url, { method: 'GET', headers, signal: ac.signal });
    } catch (e) {
        clearTimeout(timer);
        recordClusterAudit({
            kind: 'stream',
            ok: false,
            peerId: peer.peerId,
            detail: `open ${remotePath}: ${e?.message || String(e)}`,
        });
        throw e;
    }
    // We must NOT clearTimeout(timer) on success here — abort still needs
    // to fire if the body read stalls. Caller is responsible for cancelling.
    if (!res.ok && res.status !== 206) {
        clearTimeout(timer);
        recordClusterAudit({
            kind: 'stream',
            ok: false,
            peerId: peer.peerId,
            detail: `open ${remotePath}: HTTP ${res.status}`,
        });
        const err = new Error(`peer returned HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return { peer, res, _abortTimer: timer };
}

/**
 * Stream a remote peer's file through the local response. Sets the
 * passthrough headers + status; pipes body. Releases the timer when the
 * response finishes.
 */
export async function streamFromPeer(
    req,
    res,
    peerId,
    remotePath,
    { fetcher = globalThis.fetch } = {},
) {
    let opened;
    try {
        opened = await openPeerStream(peerId, remotePath, {
            range: req.headers.range,
            fetcher,
            signal: null,
        });
    } catch (e) {
        const status = e?.status === 401 ? 502 : 502;
        return res.status(status).json({
            error: 'storage_offline',
            message: e?.message || 'peer unreachable',
        });
    }
    const { peer, res: upstream, _abortTimer } = opened;
    _proxyHeaders(peer, res, upstream.headers);
    res.status(upstream.status);
    const lockKey = `${peer.peerId}:${remotePath}`;
    acquireStreamLock(lockKey);
    res.on('close', () => {
        releaseStreamLock(lockKey);
        clearTimeout(_abortTimer);
    });
    if (!upstream.body) {
        res.end();
        return;
    }
    try {
        // Web ReadableStream → Node by manual pump (Node 18+ has a
        // helper but pumping is portable).
        const reader = upstream.body.getReader();
        const pump = async () => {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!res.write(Buffer.from(value))) {
                    await new Promise((r) => res.once('drain', r));
                }
            }
            res.end();
        };
        await pump();
    } catch (e) {
        recordClusterAudit({
            kind: 'stream',
            ok: false,
            peerId: peer.peerId,
            detail: `pipe ${remotePath}: ${e?.message || String(e)}`,
        });
        try {
            res.destroy(e);
        } catch {
            /* nothing to do */
        }
    }
}

/**
 * Mint a short-lived signed URL on a peer for direct-mode streaming.
 * Calls `POST /api/cluster/sign-url` over HMAC; the peer responds with
 * a /share/<hash>/<sig> URL the browser can fetch directly.
 */
export async function requestSignedShareUrl(
    peerId,
    remotePath,
    { ttlSec = 60, fetcher = globalThis.fetch } = {},
) {
    const peer = getPeer(peerId);
    if (!peer) throw new Error('peer not paired');
    const body = JSON.stringify({ path: remotePath, ttlSec });
    const u = `${peer.url}/api/cluster/sign-url`;
    const path = '/api/cluster/sign-url';
    const headers = signRequest({ method: 'POST', path, body, targetPeerId: peerId });
    headers['Content-Type'] = 'application/json';
    const res = await fetcher(u, { method: 'POST', headers, body });
    if (!res.ok) {
        const err = new Error(`peer returned HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    const payload = await res.json();
    if (!payload?.url) throw new Error('peer did not return a signed url');
    return payload.url;
}
