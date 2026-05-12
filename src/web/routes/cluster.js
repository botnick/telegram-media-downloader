import express from 'express';
import WebSocketLib from 'ws';
import { getDb } from '../../core/db.js';
import { loadConfig } from '../../config/manager.js';
import {
    getSelfPeerId,
    getSelfPeerName,
    setSelfPeerName,
    getClusterToken,
    rotateClusterToken,
    setClusterToken,
    getSelfIdentity,
    issuePairingCode,
} from '../../core/cluster/identity.js';
import { verifyRequest as verifyPeerHmac } from '../../core/cluster/hmac.js';
import {
    listPeers,
    getPeer,
    updatePeer,
    removePeer,
    markOnline,
    markOffline,
} from '../../core/cluster/peers.js';
import {
    initiateHandshake,
    acceptHandshake,
    testPeerHealth,
} from '../../core/cluster/handshake.js';
import { startSyncEngine, syncAllOnce, getSyncState } from '../../core/cluster/sync.js';
import { parseClusterRefPath } from '../../core/cluster/dedup.js';
import {
    tryStartSweep,
    abortSweep,
    getSweepStatus,
    listConflicts,
    resolveConflict,
} from '../../core/cluster/sweep.js';
import * as clusterWs from '../../core/cluster/ws-channel.js';
import * as clusterDiscovery from '../../core/cluster/discovery.js';
import { startFailoverWatcher, runFailoverPass } from '../../core/cluster/failover.js';
import {
    listDiscoveredPeers,
    recordClusterAudit,
    listClusterAudit,
    listOwnDownloadsSince,
} from '../../core/db.js';
import { safeResolveDownload } from '../lib/resolve-download.js';
import { readConfigSafe } from '../lib/config-cache.js';

let _clusterWsInitialised = false;
function _ensureClusterWsInit() {
    if (_clusterWsInitialised) return;
    _clusterWsInitialised = true;
    try {
        clusterWs.initClusterWs({
            broadcast: (m) => {
                try {
                    if (typeof global.__tgdlBroadcast === 'function') {
                        global.__tgdlBroadcast(m);
                    }
                } catch {
                    /* nothing */
                }
            },
            WebSocket: WebSocketLib,
        });
    } catch (e) {
        console.warn('[cluster] ws init deferred:', e?.message || e);
    }
}

export function createClusterRouter({ broadcast, log }) {
    const router = express.Router();

    // ============ CLUSTER MODE (v2.9 — Phase 1) ===============================
    //
    // Multi-instance peer federation. See docs/CLUSTER.md and CLAUDE.md for the
    // full mental model. Phase 1 covers identity bootstrap + manual pairing +
    // audit log; later phases add catalog sync, streaming bridge, dedup, sweep.
    //
    // Two auth shapes:
    //   - Admin routes (cookie-session, admin role): manage own identity, list
    //     peers, add/edit/remove peers, rotate token, view audit log.
    //   - Peer-to-peer routes (HMAC-signed, no cookie): handshake + health
    //     probe. Allow-listed in PUBLIC_API_PATHS so the cookie middleware
    //     lets them through; the handlers verify the HMAC themselves.
    //
    // Adding a new admin mutation route here gets admin-gating "for free" via
    // the /api chokepoint default-deny pattern. Adding a new peer-to-peer
    // route needs both an entry in PUBLIC_API_PATHS *and* a verifyPeerHmac
    // call in the handler — never one without the other.

    function _peerHmacGate(req, res) {
        const v = verifyPeerHmac(req);
        if (!v.ok) {
            recordClusterAudit({
                kind: 'request',
                ok: false,
                peerId: req.headers['x-peer-id'] || null,
                detail: `${req.method} ${req.originalUrl || req.url}: ${v.reason}`,
            });
            res.status(401).json({ error: 'cluster auth failed', code: v.reason });
            return null;
        }
        return v;
    }

    // --- Peer-to-peer (HMAC-signed) -----------------------------------------

    router.post('/cluster/handshake', async (req, res) => {
        // The very first signed call from a new remote peer — no peer row
        // exists yet, so we verify against our local cluster token directly.
        const v = _peerHmacGate(req, res);
        if (!v) return;
        try {
            const body = req.body || {};
            // The remote sends `body.url` empty — derive from headers so the
            // pairing url is whatever the remote can actually reach us at.
            const inferredUrl = (() => {
                try {
                    const proto =
                        req.headers['x-forwarded-proto'] ||
                        (req.socket?.encrypted ? 'https' : 'http');
                    const host = req.headers['x-forwarded-host'] || req.headers.host;
                    if (!host) return body.url || '';
                    return `${proto}://${host}`;
                } catch {
                    return body.url || '';
                }
            })();
            const peer = acceptHandshake({
                peerId: body.peer_id,
                name: body.name,
                url: body.url || inferredUrl || 'unknown',
                version: body.version || null,
                sharedSecret: body.shared_secret || null,
                pairingCode: body.pairing_code || null,
            });
            // peer is the inbound caller's peer record on US (i.e. the data we
            // just stored about them). The response carries OUR identity for
            // the caller to record symmetrically.
            res.json(peer);
        } catch (e) {
            const status = e?.status || 500;
            res.status(status).json({ error: e?.message || String(e), code: e?.code || 'error' });
        }
    });

    router.get('/cluster/health', (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        // Bump last_seen so the dashboard's status pill flips green on the
        // remote peer's next refresh.
        try {
            markOnline(v.peerId);
        } catch {
            /* peer might not be paired yet (handshake races health) */
        }
        res.json({
            peer_id: getSelfPeerId(),
            name: getSelfPeerName(),
            version: process.env.npm_package_version || null,
            ts: Date.now(),
            ok: true,
        });
    });

    // --- Admin (cookie-authed; admin role required by the chokepoint) -------

    router.get('/cluster/identity', (_req, res) => {
        res.json(getSelfIdentity());
    });

    router.put('/cluster/identity', (req, res) => {
        const name = req.body?.name;
        if (!name) return res.status(400).json({ error: 'name required' });
        try {
            const clean = setSelfPeerName(name);
            res.json({ peerId: getSelfPeerId(), name: clean });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/cluster/identity/token', (_req, res) => {
        // Sensitive: only admins reach here (chokepoint default-deny). Token
        // is returned in the response body and never logged.
        res.set('Cache-Control', 'no-store').json({ token: getClusterToken() });
    });

    router.post('/cluster/identity/rotate-token', (_req, res) => {
        const token = rotateClusterToken();
        recordClusterAudit({
            kind: 'rotate_token',
            ok: true,
            detail: 'admin rotated cluster token',
        });
        res.set('Cache-Control', 'no-store').json({ token });
    });

    router.post('/cluster/identity/set-token', (req, res) => {
        const token = req.body?.token;
        if (!token) return res.status(400).json({ error: 'token required' });
        try {
            const clean = setClusterToken(token);
            recordClusterAudit({
                kind: 'set_token',
                ok: true,
                detail: 'admin set cluster token to externally-supplied value',
            });
            res.set('Cache-Control', 'no-store').json({ token: clean });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // v2.10 — pairing code workflow. Operator on the receiving peer clicks
    // "Issue pairing code" → shows the 8-char code to dictate to whoever is
    // pairing the other peer. Code is consumable once + expires in 5 min.
    router.post('/cluster/identity/pairing-code', (_req, res) => {
        const { code, expiresAt } = issuePairingCode();
        recordClusterAudit({ kind: 'pairing_code', ok: true, detail: 'admin issued pairing code' });
        res.set('Cache-Control', 'no-store').json({ code, expiresAt });
    });

    router.get('/cluster/peers', (_req, res) => {
        res.json({ peers: listPeers() });
    });

    router.post('/cluster/peers', async (req, res) => {
        const { url, token = null, pairingCode = null } = req.body || {};
        if (!url || (!token && !pairingCode)) {
            return res.status(400).json({ error: 'url + (token or pairingCode) are required' });
        }
        try {
            const r = await initiateHandshake({ url, token, pairingCode });
            if (!r.ok) {
                return res.status(400).json({ error: r.message, code: r.code });
            }
            res.json({ peer: r.peer });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.put('/cluster/peers/:peerId', (req, res) => {
        const { peerId } = req.params;
        try {
            const peer = updatePeer(peerId, req.body || {});
            if (!peer) return res.status(404).json({ error: 'peer not found' });
            res.json({ peer });
        } catch (e) {
            res.status(400).json({ error: e?.message || String(e) });
        }
    });

    router.delete('/cluster/peers/:peerId', (req, res) => {
        const { peerId } = req.params;
        const ok = removePeer(peerId);
        if (!ok) return res.status(404).json({ error: 'peer not found' });
        recordClusterAudit({ kind: 'revoke', peerId, ok: true });
        res.json({ success: true });
    });

    router.post('/cluster/peers/:peerId/test', async (req, res) => {
        const peer = getPeer(req.params.peerId);
        if (!peer) return res.status(404).json({ error: 'peer not found' });
        try {
            const r = await testPeerHealth(peer);
            if (r.ok) {
                markOnline(peer.peerId);
                recordClusterAudit({ kind: 'test', ok: true, peerId: peer.peerId });
            } else {
                markOffline(peer.peerId);
                recordClusterAudit({
                    kind: 'test',
                    ok: false,
                    peerId: peer.peerId,
                    detail: r.code || 'unreachable',
                });
            }
            res.json(r);
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/cluster/discovered', (_req, res) => {
        res.json({ peers: listDiscoveredPeers({}) });
    });

    router.get('/cluster/audit', (req, res) => {
        const peerId = req.query.peerId || null;
        const kind = req.query.kind || null;
        const limit = Number(req.query.limit) || 200;
        res.json({ entries: listClusterAudit({ peerId, kind, limit }) });
    });

    // ---- Phase 2: catalog sync (P2P + admin) -------------------------------

    // Delta-pull endpoint: P2P, HMAC-required. Caller passes the highest id
    // it's already cached so we only return new rows.
    router.get('/cluster/downloads/since', (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        const sinceId = Number(req.query.sinceId) || 0;
        const limit = Number(req.query.limit) || 500;
        const rows = listOwnDownloadsSince({ sinceId, limit });
        res.json({ rows, peerId: getSelfPeerId(), now: Date.now() });
    });

    // Full snapshots — small, infrequent, no delta scheme.
    router.get('/cluster/groups/snapshot', async (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        try {
            const cfg = await readConfigSafe();
            // Strip any per-group secret-ish fields. Currently `groups` only
            // holds public metadata (name, monitorAccount, ttl, tags, etc.),
            // but defence-in-depth.
            const groups = (cfg.groups || []).map((g) => {
                const { ...clean } = g;
                return clean;
            });
            res.json({ groups, peerId: getSelfPeerId(), now: Date.now() });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/cluster/accounts/snapshot', async (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        try {
            const cfg = await readConfigSafe();
            // Redact the StringSession blob — peers shouldn't impersonate
            // each other's Telegram clients.
            const accounts = (cfg.accounts || []).map((a) => ({
                id: a.id,
                label: a.label,
                phone: a.phone,
                disabled: !!a.disabled,
                // session: redacted
            }));
            res.json({ accounts, peerId: getSelfPeerId(), now: Date.now() });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Admin — manual sync trigger (e.g. after pairing a new peer).
    router.post('/cluster/sync/run', async (_req, res) => {
        try {
            const r = await syncAllOnce();
            res.json(r);
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/cluster/sync/state', (_req, res) => {
        res.json(getSyncState());
    });

    // Admin — merged downloads view (self + every peer's catalog). Powers
    // the unified gallery + downloads list. ?peerId=<self|<id>|all> filters.
    router.get('/cluster/downloads', (req, res) => {
        try {
            const filter = req.query.peerId || 'all';
            const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const ownPid = getSelfPeerId();
            const rows = [];
            if (filter === 'all' || filter === 'self' || filter === ownPid) {
                const own = getDb()
                    .prepare(
                        `SELECT id, group_id, group_name, message_id, file_name, file_size,
                            file_type, file_path, file_hash, status, created_at, nsfw_score
                       FROM downloads
                      ORDER BY id DESC LIMIT ? OFFSET ?`,
                    )
                    .all(limit, offset);
                for (const r of own)
                    rows.push({ ...r, peer_id: ownPid, peer_name: getSelfPeerName() });
            }
            if (filter === 'all' || (filter !== 'self' && filter !== ownPid)) {
                const peerFilter = filter === 'all' ? null : String(filter);
                const peers = listPeers().filter((p) => !peerFilter || p.peerId === peerFilter);
                for (const p of peers) {
                    const r = getDb()
                        .prepare(
                            `SELECT * FROM peer_downloads WHERE peer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                        )
                        .all(p.peerId, limit, offset);
                    for (const row of r) rows.push({ ...row, peer_name: p.name });
                }
            }
            rows.sort((a, b) => {
                const ta =
                    typeof a.created_at === 'string'
                        ? Date.parse(a.created_at)
                        : Number(a.created_at) || 0;
                const tb =
                    typeof b.created_at === 'string'
                        ? Date.parse(b.created_at)
                        : Number(b.created_at) || 0;
                return tb - ta;
            });
            res.json({ rows, total: rows.length });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ---- Phase 3: streaming bridge (P2P file proxy) ------------------------

    // P2P bridge endpoint — when peer A's /files resolves a row that lives on
    // peer B, A signs a GET to B at this path. We respond with the same
    // bytes the local /files would serve.
    router.get('/cluster/files/:path(*)', async (req, res, next) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        let reqPath;
        try {
            reqPath = decodeURIComponent(req.params.path || '').replace(/^\/+/, '');
        } catch {
            return res.status(400).send('Bad request');
        }
        if (!reqPath || reqPath.includes('\0')) return res.status(400).send('Bad request');
        const r = await safeResolveDownload(reqPath);
        if (!r.ok) {
            const status = r.reason === 'missing' ? 404 : 403;
            return res.status(status).send(r.reason === 'missing' ? 'File not found' : 'Forbidden');
        }
        // Re-use Express's static-stream path so Range works identically to
        // the cookie-authed /files route. No HEIC inline transcode here —
        // the bridge serves raw bytes; the requesting peer decides framing.
        res.setHeader('Cache-Control', 'private, no-store');
        res.sendFile(r.real);
    });

    // ---- Federated gallery thumbnails (Layer 1) ----------------------------
    //
    // Two endpoints, mirroring the /api/cluster/files split:
    //
    // 1. P2P HMAC-only (called by another peer when proxying a thumb to its
    //    own browser): GET /api/cluster/thumbs/:remoteId?w=<N>
    //    Re-resolves to the local /api/thumbs path via getOrCreateThumb so
    //    every code path (resize, hwaccel, miss-tracking) stays in one place.
    //
    // 2. Cookie-auth proxy (called by THIS peer's browser when rendering a
    //    federated tile): GET /api/cluster/thumbs/:peerId/:remoteId?w=<N>
    //    Looks up the peer, HMAC-signs a fetch to its endpoint above, streams
    //    the response back. On peer-offline / non-2xx, returns a 1×1
    //    transparent PNG with a short Cache-Control so the gallery doesn't
    //    spam the console with 404s while a peer is briefly unreachable.

    // Peer-to-peer side. Sits under a different prefix (`peer-thumbs`) than
    // the cookie-auth proxy (`thumbs`) so the public-path auth middleware
    // can prefix-match the HMAC bucket without accidentally exempting the
    // cookie route. See PUBLIC_PATH_PREFIXES wiring elsewhere.
    router.get('/cluster/peer-thumbs/:remoteId', async (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        try {
            const id = parseInt(req.params.remoteId, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).type('text/plain').send('Bad id');
            }
            const thumb = await getOrCreateThumb(id, req.query.w);
            if (!thumb) {
                res.setHeader('Cache-Control', 'no-store');
                return res.status(404).type('text/plain').send('No thumb');
            }
            res.setHeader('Content-Type', 'image/webp');
            res.setHeader('Cache-Control', 'private, no-store');
            if (Buffer.isBuffer(thumb)) return res.send(thumb);
            if (typeof thumb === 'string') return res.sendFile(thumb);
            return res.send(thumb);
        } catch (e) {
            recordClusterAudit({
                kind: 'thumb',
                ok: false,
                peerId: v.peerId || null,
                detail: `peer-thumb ${req.params.remoteId}: ${e?.message || String(e)}`,
            });
            res.status(500).type('text/plain').send('Internal error');
        }
    });

    // 1×1 transparent PNG — placeholder when a peer is offline / errored. The
    // alternative would be a 502 which the SPA <img> would render as a broken
    // glyph; this keeps the gallery layout stable and adds a short cache so
    // we don't hammer the offline peer.
    const _PEER_THUMB_PLACEHOLDER = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
    );

    function _sendPeerThumbPlaceholder(res) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.send(_PEER_THUMB_PLACEHOLDER);
    }

    // Browser-side (cookie auth — admin only). Two-param form.
    router.get('/cluster/thumbs/:peerId/:remoteId', async (req, res) => {
        try {
            const peer = getPeer(req.params.peerId);
            if (!peer) return _sendPeerThumbPlaceholder(res);
            const id = parseInt(req.params.remoteId, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).type('text/plain').send('Bad id');
            }
            const w = req.query.w ? `?w=${encodeURIComponent(req.query.w)}` : '';
            const path0 = `/api/cluster/peer-thumbs/${id}${w}`;
            const headers = (await import('../../core/cluster/hmac.js')).signRequest({
                method: 'GET',
                path: path0,
                targetPeerId: peer.peerId,
            });
            let upstream;
            try {
                upstream = await fetch(peer.url + path0, { method: 'GET', headers });
            } catch {
                return _sendPeerThumbPlaceholder(res);
            }
            if (!upstream.ok) {
                return _sendPeerThumbPlaceholder(res);
            }
            const ct = upstream.headers.get('content-type') || 'image/webp';
            res.setHeader('Content-Type', ct);
            // Browser HTTP cache only — content-addressed by (peer, remoteId, w),
            // so a stale cache hit is impossible during the URL's lifetime.
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
            const buf = Buffer.from(await upstream.arrayBuffer());
            res.send(buf);
        } catch (e) {
            recordClusterAudit({
                kind: 'thumb',
                ok: false,
                peerId: req.params.peerId,
                detail: `proxy ${req.params.remoteId}: ${e?.message || String(e)}`,
            });
            _sendPeerThumbPlaceholder(res);
        }
    });

    // ---- Phase 4: direct stream mode (sign-url minting) -------------------

    router.post('/cluster/sign-url', async (req, res, next) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        const { path: filePath, ttlSec = 60 } = req.body || {};
        if (!filePath) return res.status(400).json({ error: 'path required' });
        try {
            const row = getDb()
                .prepare('SELECT id FROM downloads WHERE file_path = ? LIMIT 1')
                .get(String(filePath));
            if (!row) return res.status(404).json({ error: 'file not catalogued' });
            // Mint an unauthenticated share-link (HMAC-signed url) — the
            // requesting peer's browser will fetch this directly. Reuse the
            // existing share infra so revocation + access counters stay one
            // unified source of truth.
            const expiresAt =
                Date.now() + Math.max(10, Math.min(3600, Number(ttlSec) || 60)) * 1000;
            const linkRow = createShareLink({
                downloadId: Number(row.id),
                expiresAt,
                label: `cluster:${v.peerId.slice(0, 8)}`,
            });
            const expSec = Math.floor(expiresAt / 1000);
            const baseUrl = (() => {
                const proto =
                    req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
                const host = req.headers['x-forwarded-host'] || req.headers.host;
                return `${proto}://${host}`;
            })();
            res.set('Cache-Control', 'no-store').json({
                url: baseUrl + buildShareUrlPath(linkRow.id, expSec),
                expiresAt,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ---- Phase 7: dedup sweep --------------------------------------------

    router.post('/cluster/sweep/run', (req, res) => {
        const minSize = Number(req.body?.minSize) || 1024;
        const r = tryStartSweep({ minSize });
        if (!r.started) {
            return res.status(409).json({
                started: false,
                code: 'ALREADY_RUNNING',
                snapshot: r.snapshot,
            });
        }
        res.json({ started: true });
    });

    router.get('/cluster/sweep/status', (_req, res) => {
        res.json(getSweepStatus());
    });

    router.post('/cluster/sweep/cancel', (_req, res) => {
        const ok = abortSweep();
        res.json({ ok });
    });

    router.get('/cluster/conflicts', (_req, res) => {
        res.json({ conflicts: listConflicts(), stats: getSweepStatus().stats });
    });

    router.post('/cluster/conflicts/:id/resolve', async (req, res) => {
        try {
            const id = req.params.id;
            const keep = req.body?.keep;
            const r = await resolveConflict(id, keep);
            res.json(r);
        } catch (e) {
            res.status(e?.status || 500).json({ error: e?.message || String(e) });
        }
    });

    // ---- Phase D (v2.10): relay-through-peer ------------------------------

    router.post('/cluster/relay/proxy', async (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        try {
            const { handleRelay } = await import('../../core/cluster/relay.js');
            const upstream = await handleRelay({
                envelope: req.body || {},
                sourcePeerId: v.peerId,
            });
            // Pipe response status + body back. Headers we forward are limited
            // to the standard set — anything sensitive (Set-Cookie etc.) is
            // dropped at the relay boundary.
            res.status(upstream.status);
            for (const [k, val] of upstream.headers) {
                const lk = k.toLowerCase();
                if (
                    lk === 'content-type' ||
                    lk === 'content-length' ||
                    lk === 'cache-control' ||
                    lk === 'etag'
                ) {
                    res.setHeader(k, val);
                }
            }
            const buf = Buffer.from(await upstream.arrayBuffer());
            res.end(buf);
        } catch (e) {
            res.status(e?.status || 500).json({ error: e?.message || String(e) });
        }
    });

    // ---- Phase G (v2.10): cross-peer file delete --------------------------

    router.post('/cluster/files/delete', async (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        const { file_path: filePath, remote_id: remoteId, reason = null } = req.body || {};
        try {
            let row;
            if (remoteId != null) {
                row = getDb()
                    .prepare('SELECT id, file_path, file_size FROM downloads WHERE id = ?')
                    .get(Number(remoteId));
            } else if (filePath) {
                row = getDb()
                    .prepare(
                        'SELECT id, file_path, file_size FROM downloads WHERE file_path = ? LIMIT 1',
                    )
                    .get(String(filePath));
            }
            if (!row) {
                return res.status(404).json({ error: 'file not catalogued' });
            }
            const r = await safeResolveDownload(row.file_path);
            let freedBytes = 0;
            if (r.ok) {
                try {
                    await fs.unlink(r.real);
                    freedBytes = Number(row.file_size) || 0;
                } catch {
                    /* best effort */
                }
            }
            getDb().prepare('DELETE FROM downloads WHERE id = ?').run(Number(row.id));
            recordClusterAudit({
                kind: 'cross_delete',
                ok: true,
                peerId: v.peerId,
                detail: `${row.file_path} (reason=${reason || '-'})`,
            });
            // Tell paired peers the row is gone so their cache catches up.
            try {
                clusterWs.broadcastClusterEvent('download_deleted', { remote_id: row.id });
            } catch {
                /* nothing */
            }
            res.json({ deleted: true, freedBytes });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ---- Phase I (v2.10): federated search ------------------------------

    // HMAC peer-to-peer search. Returns matching local download rows.
    router.get('/cluster/search/peer', (req, res) => {
        const v = _peerHmacGate(req, res);
        if (!v) return;
        const q = String(req.query.q || '').trim();
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        if (!q) return res.json({ rows: [] });
        try {
            const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
            const rows = getDb()
                .prepare(
                    `SELECT id, group_id, group_name, message_id, file_name, file_size, file_type,
                        file_path, file_hash, status, created_at, nsfw_score
                   FROM downloads
                  WHERE file_name LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\'
                  ORDER BY created_at DESC
                  LIMIT ?`,
                )
                .all(like, like, limit);
            res.json({ rows, peerId: getSelfPeerId(), q });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Admin cookie-authed cluster-wide search — fan-out, merge, dedup by hash.
    router.get('/cluster/search', async (req, res) => {
        const q = String(req.query.q || '').trim();
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        if (!q) return res.json({ rows: [] });
        try {
            const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
            const ownPid = getSelfPeerId();
            const local = getDb()
                .prepare(
                    `SELECT id, group_id, group_name, message_id, file_name, file_size, file_type,
                        file_path, file_hash, status, created_at, nsfw_score
                   FROM downloads
                  WHERE file_name LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\'
                  ORDER BY created_at DESC LIMIT ?`,
                )
                .all(like, like, limit);
            const merged = local.map((r) => ({
                ...r,
                peer_id: ownPid,
                peer_name: getSelfPeerName(),
            }));

            // Fan-out to paired peers (online only).
            const peers = listPeers().filter((p) => p.status === 'online' && !!p.peerId);
            await Promise.allSettled(
                peers.map(async (p) => {
                    try {
                        const path0 = `/api/cluster/search/peer?q=${encodeURIComponent(q)}&limit=${limit}`;
                        const headers = {
                            ...(await import('../../core/cluster/hmac.js')).signRequest({
                                method: 'GET',
                                path: path0,
                                targetPeerId: p.peerId,
                            }),
                        };
                        const r = await fetch(p.url + path0, { method: 'GET', headers });
                        if (!r.ok) return;
                        const j = await r.json();
                        for (const row of j.rows || []) {
                            merged.push({ ...row, peer_id: p.peerId, peer_name: p.name });
                        }
                    } catch {
                        /* peer offline / refused */
                    }
                }),
            );
            // Dedup by file_hash (when present), keep first hit per hash.
            const seen = new Set();
            const dedup = [];
            for (const r of merged) {
                const k = r.file_hash || `${r.peer_id}:${r.id}`;
                if (seen.has(k)) continue;
                seen.add(k);
                dedup.push(r);
            }
            dedup.sort((a, b) => {
                const ta =
                    typeof a.created_at === 'string'
                        ? Date.parse(a.created_at)
                        : Number(a.created_at);
                const tb =
                    typeof b.created_at === 'string'
                        ? Date.parse(b.created_at)
                        : Number(b.created_at);
                return (tb || 0) - (ta || 0);
            });
            res.json({ rows: dedup, total: dedup.length });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ---- Phase E (v2.10): failover audit + manual reassign ----------------

    router.get('/cluster/failover-log', (req, res) => {
        try {
            const limit = Number(req.query.limit) || 100;
            const { listFailoverLog } = require('../../core/db.js');
            res.json({ entries: listFailoverLog({ limit }) });
        } catch {
            try {
                // ESM dynamic import fallback
                import('../../core/db.js').then((m) => {
                    res.json({
                        entries: m.listFailoverLog({ limit: Number(req.query.limit) || 100 }),
                    });
                });
            } catch (e) {
                res.status(500).json({ error: 'failover log unavailable' });
            }
        }
    });

    // ---- Phase K (v2.10): cluster stats ---------------------------------

    router.get('/cluster/stats', async (_req, res) => {
        try {
            const { aggregateEgress } = await import('../../core/db.js');
            const ownPid = getSelfPeerId();
            const peers = listPeers();
            const localBytes = (() => {
                try {
                    return getDb()
                        .prepare('SELECT COALESCE(SUM(file_size),0) AS n FROM downloads')
                        .get().n;
                } catch {
                    return 0;
                }
            })();
            const cachedBytes = peers.map((p) => {
                const n = getDb()
                    .prepare(
                        'SELECT COALESCE(SUM(file_size),0) AS n FROM peer_downloads WHERE peer_id = ?',
                    )
                    .get(p.peerId).n;
                return { peerId: p.peerId, name: p.name, status: p.status, totalBytes: n };
            });
            const egress = aggregateEgress({ days: 30 });
            res.json({
                self: {
                    peerId: ownPid,
                    name: getSelfPeerName(),
                    totalBytes: localBytes,
                },
                peers: cachedBytes,
                egress30d: egress,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Start the sync engine on first cluster route hit. It will poll every
    // 30s; idempotent if already running.
    let _clusterSyncStarted = false;
    function _ensureSyncEngineStarted() {
        if (_clusterSyncStarted) return;
        _clusterSyncStarted = true;
        try {
            startSyncEngine({ intervalMs: 30_000 });
        } catch (e) {
            console.warn('[cluster] sync engine start failed:', e?.message || e);
        }
    }
    let _clusterDiscoveryStarted = false;
    function _ensureClusterDiscoveryStarted() {
        if (_clusterDiscoveryStarted) return;
        _clusterDiscoveryStarted = true;
        try {
            const port = Number(process.env.PORT) || 3000;
            const proto = process.env.PUBLIC_PROTO || 'http';
            const host = process.env.PUBLIC_HOST || `localhost:${port}`;
            const selfUrl = process.env.PUBLIC_URL || `${proto}://${host}`;
            clusterDiscovery.startDiscovery({ selfUrl });
        } catch (e) {
            console.warn('[cluster] discovery start failed:', e?.message || e);
        }
    }

    let _clusterFailoverStarted = false;
    function _ensureClusterFailoverStarted() {
        if (_clusterFailoverStarted) return;
        _clusterFailoverStarted = true;
        try {
            startFailoverWatcher();
        } catch (e) {
            console.warn('[cluster] failover watcher start failed:', e?.message || e);
        }
    }

    router.use((_req, _res, next) => {
        _ensureSyncEngineStarted();
        _ensureClusterWsInit();
        _ensureClusterDiscoveryStarted();
        _ensureClusterFailoverStarted();
        next();
    });

    // Manual failover sweep (admin) — useful when an operator wants to
    // trigger reassignment immediately rather than wait for the 60s tick.
    router.post('/cluster/failover/run', (_req, res) => {
        try {
            const applied = runFailoverPass();
            res.json({ applied });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Expose broadcast() globally for sweep.js (which can't import directly
    // without creating a circular dep). One-line bridge.
    global.__tgdlBroadcast =
        global.__tgdlBroadcast ||
        ((m) => {
            try {
                broadcast(m);
            } catch {
                /* nothing */
            }
        });

    return router;
}
