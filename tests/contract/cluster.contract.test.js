// Cluster admin API contract (cookie-authed): identity + token + pairing
// code, peers CRUD / pairing / test, discovery, audit, catalog sync, merged
// downloads, stats, federated search, thumbnail proxy, dedup sweep +
// conflicts, failover log / manual failover.
//
// A fake peer ("gamma") runs in this test process on 127.0.0.1 (the network
// sandbox lets loopback through): it answers the handshake, health, delta
// sync, federated search and peer-thumb calls with fixed payloads and
// records what the node sent it. Seeded peers alpha / beta point at
// *.invalid hosts, so every call to them fails at once (ENOTFOUND).
//
// The fake peer listens on an ephemeral port; its URL is rewritten to
// `http://<FAKE_PEER>` in recorded bodies (see swapFake).
//
// POST /api/cluster/failover/run is the ONLY cluster route that reaches the
// lazy `app.use('/api/cluster', …)` engine starter (sync / WS / discovery /
// failover watcher) — so it runs last here.

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DOWNLOAD_IDS, SEED, until, useContract } from './harness.js';

const ALPHA = SEED.peers.alpha;
const BETA = SEED.peers.beta;
const GAMMA_ID = '00000000-0000-4000-8000-0000000000c3';
const UNKNOWN_PEER = '00000000-0000-4000-8000-00000000dead';

// ---- fake peer --------------------------------------------------------------

const fakeReceived = [];
let gammaSecret = null;
const SPRITE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'media', 'sprite.webp'));
const GAMMA_ROWS = [
    {
        id: 7001,
        group_id: '-1009000000003',
        group_name: 'Gamma Remote',
        message_id: 1,
        file_name: 'G_7001.jpg',
        file_size: 2222,
        file_type: 'photo',
        file_path: 'Gamma Remote/images/G_7001.jpg',
        file_hash: 'f'.repeat(64),
        status: 'completed',
        created_at: '2024-07-01 10:00:00',
        nsfw_score: null,
    },
    {
        id: 7002,
        group_id: '-1009000000003',
        group_name: 'Gamma Remote',
        message_id: 2,
        file_name: 'IMG_0001.jpg',
        file_size: 3365,
        file_type: 'photo',
        file_path: 'Gamma Remote/images/IMG_0001.jpg',
        file_hash: null,
        status: 'completed',
        created_at: '2024-07-02 10:00:00',
        nsfw_score: 0.1,
    },
];

const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
        fakeReceived.push({ method: req.method, url: req.url, headers: req.headers, raw, body });
        // The per-pair secret the node generates travels in the handshake
        // body; keep it to verify the node's later signatures.
        if (req.url === '/api/cluster/handshake' && body?.shared_secret)
            gammaSecret = body.shared_secret;
        const json = (status, obj) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        const u = new URL(req.url, 'http://x');
        if (req.method === 'POST' && u.pathname === '/api/cluster/handshake') {
            return json(200, {
                peer_id: GAMMA_ID,
                name: 'peer-gamma',
                version: '9.9.9',
                fingerprint: 'unused',
                paired_at: 1717200000000,
                shared_secret_ack: body?.shared_secret ?? null,
            });
        }
        if (u.pathname === '/api/cluster/health') {
            return json(200, {
                peer_id: GAMMA_ID,
                name: 'peer-gamma',
                version: '9.9.9',
                ts: 1717200000000,
                ok: true,
            });
        }
        if (u.pathname === '/api/cluster/downloads/since') {
            const since = Number(u.searchParams.get('sinceId')) || 0;
            return json(200, {
                rows: GAMMA_ROWS.filter((r) => r.id > since),
                peerId: GAMMA_ID,
                now: 1717200000000,
            });
        }
        if (u.pathname === '/api/cluster/search/peer') {
            const q = String(u.searchParams.get('q') || '').toLowerCase();
            return json(200, {
                rows: GAMMA_ROWS.filter((r) => r.file_name.toLowerCase().includes(q)),
                peerId: GAMMA_ID,
                q,
            });
        }
        if (u.pathname.startsWith('/api/cluster/peer-thumbs/')) {
            res.writeHead(200, { 'content-type': 'image/webp' });
            return res.end(SPRITE);
        }
        return json(404, { error: 'fake peer: no such route' });
    });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE_URL = `http://127.0.0.1:${fake.address().port}`;

// The fake peer's ephemeral port is not the target's, so the normaliser
// can't know it — rewrite it before recording.
function swapFake(v) {
    if (typeof v === 'string') return v.split(FAKE_URL).join('http://<FAKE_PEER>');
    if (Array.isArray(v)) return v.map(swapFake);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapFake(x)]));
    return v;
}

function verifyNodeSignature(recv, secret) {
    const ts = recv.headers['x-peer-ts'];
    const bodyHash = crypto
        .createHash('sha256')
        .update(recv.raw || '', 'utf8')
        .digest('hex');
    const base = `${recv.method}\n${recv.url}\n${Number(ts)}\n${bodyHash}`;
    const want = crypto.createHmac('sha256', secret).update(base).digest('hex');
    return (
        recv.headers['x-peer-signature'] === want && recv.headers['x-peer-id'] === SEED.selfPeerId
    );
}

// What the node sent to the fake peer, normalised: signature headers are
// replaced by "is it a valid signature under <secret>" facts.
function describeReceived(t, recv, secret) {
    return {
        method: recv.method,
        path: recv.url,
        signedBy:
            recv.headers['x-peer-id'] === SEED.selfPeerId ? 'self' : recv.headers['x-peer-id'],
        signatureValid: verifyNodeSignature(recv, secret),
        contentType: recv.headers['content-type'] ?? null,
        body: recv.body ? t.norm.value(swapFake(recv.body)) : null,
    };
}

// ---- target -----------------------------------------------------------------

const h = useContract(import.meta.url, {
    // The app stores a per-pair secret as the UTF-8 bytes of its hex
    // string (db.setPeerSharedSecret); the shared seed writes raw bytes.
    // Store alpha's secret the way the app would.
    afterDb: (db) => {
        db.prepare('UPDATE peers SET shared_secret = ? WHERE peer_id = ?').run(
            Buffer.from(ALPHA.sharedSecret, 'utf8'),
            ALPHA.peerId,
        );
    },
});

/** request + record, with the fake peer URL masked in the response. */
async function ex(label, method, urlPath, o = {}) {
    const t = h.t;
    const res = await t.request(method, urlPath, o);
    const shown = res.json !== undefined ? { ...res, json: swapFake(res.json) } : res;
    const req = {
        method,
        path: urlPath,
        as: o.as ?? 'admin',
        ...(o.body !== undefined ? { body: swapFake(o.body) } : {}),
    };
    const { body: _b, ...recOpts } = o;
    await t.record(label, req, shown, recOpts);
    return res;
}

describe('identity, token, pairing code', () => {
    it('identity read / auth gates', async () => {
        await ex('identity', 'GET', '/api/cluster/identity');
        await ex('identity as guest → 403', 'GET', '/api/cluster/identity', { as: 'guest' });
        await ex('identity as anon → 401', 'GET', '/api/cluster/identity', { as: 'anon' });
        await ex('token', 'GET', '/api/cluster/identity/token');
        await ex('token as guest → 403', 'GET', '/api/cluster/identity/token', { as: 'guest' });
    });

    it('rename', async () => {
        await ex('rename without name → 400', 'PUT', '/api/cluster/identity', { body: {} });
        await ex('rename trims', 'PUT', '/api/cluster/identity', {
            body: { name: '  Contract Node  ' },
        });
        await ex('rename clips to 64 chars', 'PUT', '/api/cluster/identity', {
            body: { name: 'n'.repeat(100) },
        });
        await ex('rename whitespace-only → 400', 'PUT', '/api/cluster/identity', {
            body: { name: '   ' },
        });
        await ex('rename back', 'PUT', '/api/cluster/identity', {
            body: { name: SEED.selfPeerName },
        });
        await ex('identity after rename', 'GET', '/api/cluster/identity');
    });

    it('set / rotate token', async () => {
        await ex('set-token missing → 400', 'POST', '/api/cluster/identity/set-token', {
            body: {},
        });
        await ex('set-token not hex → 400', 'POST', '/api/cluster/identity/set-token', {
            body: { token: 'xyz' },
        });
        await ex('set-token uppercase is lowered', 'POST', '/api/cluster/identity/set-token', {
            body: { token: `  ${'AB'.repeat(20)}  ` },
        });
        await ex('rotate-token', 'POST', '/api/cluster/identity/rotate-token');
        await ex('set-token back to seed', 'POST', '/api/cluster/identity/set-token', {
            body: { token: SEED.clusterToken },
        });
        await ex('token after restore', 'GET', '/api/cluster/identity/token');
    });

    it('pairing code', async () => {
        const res = await ex('pairing-code', 'POST', '/api/cluster/identity/pairing-code', {
            mask: { code: 'random 8-char pairing code (crypto.randomBytes)' },
        });
        // `expiresAt` is the server's clock + 5 min; the test reads its own
        // clock afterwards. Two processes can disagree by a few ms (seen on
        // Windows), so the upper bound allows 1 s of skew.
        const left = res.json.expiresAt - Date.now();
        h.t.store.record('pairing-code shape (derived)', {
            derived: {
                code: /^[0-9A-HJ-NP-Z]{8}$/.test(res.json.code),
                ttlMs: left > 4 * 60_000 && left <= 5 * 60_000 + 1_000,
            },
        });
    });
});

describe('peers', () => {
    it('list', async () => {
        await ex('peers (seeded)', 'GET', '/api/cluster/peers');
    });

    it('pairing validation and unreachable peer', async () => {
        await ex('add peer without token → 400', 'POST', '/api/cluster/peers', {
            body: { url: 'http://x' },
        });
        await ex('add peer bad url → 400', 'POST', '/api/cluster/peers', {
            body: { url: 'ftp://peer', token: SEED.clusterToken },
        });
        await ex('add peer bad token → 400', 'POST', '/api/cluster/peers', {
            body: { url: 'http://peer', token: 'short' },
        });
        await ex('add peer bad pairing code → 400', 'POST', '/api/cluster/peers', {
            body: { url: 'http://peer', pairingCode: '!!' },
        });
        await ex('add peer unreachable → 400', 'POST', '/api/cluster/peers', {
            body: { url: 'http://peer-gamma.invalid:3000/', token: SEED.clusterToken },
        });
        await ex('add peer as guest → 403', 'POST', '/api/cluster/peers', {
            as: 'guest',
            body: { url: FAKE_URL, token: SEED.clusterToken },
        });
    });

    it('pair with the fake peer (token)', async () => {
        const t = h.t;
        fakeReceived.length = 0;
        const res = await ex('add peer gamma → paired', 'POST', '/api/cluster/peers', {
            body: { url: `${FAKE_URL}/`, token: SEED.clusterToken },
        });
        const hs = fakeReceived.find((r) => r.url === '/api/cluster/handshake');
        t.store.record('handshake request the node sent (derived)', {
            received: describeReceived(t, hs, SEED.clusterToken),
            fingerprintIsSha256OfTokenAndPeerId:
                res.json.peer.fingerprint ===
                crypto
                    .createHash('sha256')
                    .update(`${SEED.clusterToken}:${GAMMA_ID}`)
                    .digest('hex'),
        });
        await ex('peers after pairing', 'GET', '/api/cluster/peers');
    });

    it('edit', async () => {
        await ex('edit bad peer id → 400', 'PUT', '/api/cluster/peers/not-a-peer', {
            body: { name: 'x' },
        });
        await ex('edit unknown peer → 404', 'PUT', `/api/cluster/peers/${UNKNOWN_PEER}`, {
            body: { name: 'x' },
        });
        await ex('edit bad url → 400', 'PUT', `/api/cluster/peers/${ALPHA.peerId}`, {
            body: { url: 'nope' },
        });
        await ex('edit bad streamMode → 400', 'PUT', `/api/cluster/peers/${ALPHA.peerId}`, {
            body: { streamMode: 'weird' },
        });
        await ex('edit empty name → 400', 'PUT', `/api/cluster/peers/${ALPHA.peerId}`, {
            body: { name: '  ' },
        });
        await ex('edit alpha', 'PUT', `/api/cluster/peers/${ALPHA.peerId}`, {
            body: {
                name: '  peer-alpha (edited)  ',
                streamMode: 'direct',
                notes: 'edited note',
                url: `${ALPHA.url}///`,
            },
        });
        await ex('edit alpha back to proxy', 'PUT', `/api/cluster/peers/${ALPHA.peerId}`, {
            body: { streamMode: 'proxy' },
        });
    });

    it('test', async () => {
        const t = h.t;
        await ex('test alpha → unreachable', 'POST', `/api/cluster/peers/${ALPHA.peerId}/test`);
        await ex('test unknown peer → 404', 'POST', `/api/cluster/peers/${UNKNOWN_PEER}/test`);
        fakeReceived.length = 0;
        await ex('test gamma → ok', 'POST', `/api/cluster/peers/${GAMMA_ID}/test`);
        const gamma = (await t.request('GET', '/api/cluster/peers')).json.peers.find(
            (p) => p.peerId === GAMMA_ID,
        );
        expect(gamma.migrationRequired).toBe(false);
        t.store.record('health probe the node sent to gamma (derived)', {
            received: describeReceived(t, fakeReceived[0], gammaSecret),
        });
    });

    it('discovered, audit', async () => {
        await ex('discovered (sandbox: nothing on the LAN)', 'GET', '/api/cluster/discovered');
        const res = await ex('audit', 'GET', '/api/cluster/audit', {
            unordered: ['entries'],
            note: 'rows are ORDER BY ts DESC; rows written in the same millisecond tie-break by rowid, so the array is compared as a set and the order checked separately',
        });
        const ts = res.json.entries.map((e) => e.ts);
        h.t.store.record('audit is newest first (derived)', {
            derived: {
                newestFirst: ts.every((v, i) => i === 0 || ts[i - 1] >= v),
                count: ts.length,
            },
        });
        await ex('audit kind=handshake', 'GET', '/api/cluster/audit?kind=handshake', {
            unordered: ['entries'],
        });
        await ex('audit peerId=alpha', 'GET', `/api/cluster/audit?peerId=${ALPHA.peerId}`, {
            unordered: ['entries'],
        });
        await ex(
            'audit limit=1',
            'GET',
            '/api/cluster/audit?limit=1&kind=handshake&peerId=' + ALPHA.peerId,
        );
    });
});

describe('catalog sync, merged downloads, stats, search, thumbs', () => {
    it('sync', async () => {
        await ex('sync state before', 'GET', '/api/cluster/sync/state');
        fakeReceived.length = 0;
        await ex('sync run', 'POST', '/api/cluster/sync/run');
        const t = h.t;
        t.store.record('delta pull the node sent to gamma (derived)', {
            received: fakeReceived.map((r) => describeReceived(t, r, gammaSecret)),
        });
        await ex('sync state after', 'GET', '/api/cluster/sync/state');
        await ex('sync run again (sinceId advanced)', 'POST', '/api/cluster/sync/run');
        await ex('peers after sync', 'GET', '/api/cluster/peers');
    });

    it('merged downloads', async () => {
        await ex('cluster downloads all', 'GET', '/api/cluster/downloads');
        await ex('cluster downloads self', 'GET', '/api/cluster/downloads?peerId=self');
        await ex(
            'cluster downloads self by id',
            'GET',
            `/api/cluster/downloads?peerId=${SEED.selfPeerId}&limit=3`,
        );
        await ex('cluster downloads alpha', 'GET', `/api/cluster/downloads?peerId=${ALPHA.peerId}`);
        await ex(
            'cluster downloads gamma limit=1 offset=1',
            'GET',
            `/api/cluster/downloads?peerId=${GAMMA_ID}&limit=1&offset=1`,
        );
        await ex(
            'cluster downloads unknown peer',
            'GET',
            `/api/cluster/downloads?peerId=${UNKNOWN_PEER}`,
        );
    });

    it('stats', async () => {
        await ex('cluster stats', 'GET', '/api/cluster/stats');
    });

    it('federated search', async () => {
        fakeReceived.length = 0;
        await ex('search without q', 'GET', '/api/cluster/search');
        await ex(
            'search q=IMG_0001 (local + gamma fan-out)',
            'GET',
            '/api/cluster/search?q=IMG_0001',
        );
        await ex('search q=gamma limit=5', 'GET', '/api/cluster/search?q=G_7001&limit=5');
        await ex('search escapes LIKE wildcards', 'GET', '/api/cluster/search?q=%25');
        h.t.store.record('search fan-out the node sent to gamma (derived)', {
            received: fakeReceived.map((r) => describeReceived(h.t, r, gammaSecret)),
        });
    });

    it('thumbnail proxy', async () => {
        fakeReceived.length = 0;
        await ex(
            'peer thumb unknown peer → placeholder',
            'GET',
            `/api/cluster/thumbs/${UNKNOWN_PEER}/501`,
        );
        await ex(
            'peer thumb alpha unreachable → placeholder',
            'GET',
            `/api/cluster/thumbs/${ALPHA.peerId}/501?w=320`,
        );
        await ex('peer thumb bad id → 400', 'GET', `/api/cluster/thumbs/${ALPHA.peerId}/abc`);
        await ex('peer thumb gamma → proxied', 'GET', `/api/cluster/thumbs/${GAMMA_ID}/7001?w=320`);
        h.t.store.record('thumb fetch the node sent to gamma (derived)', {
            received: fakeReceived.map((r) => describeReceived(h.t, r, gammaSecret)),
        });
    });
});

describe('dedup sweep and conflicts', () => {
    it('sweep lifecycle with WS events', async () => {
        const t = h.t;
        await ex('conflicts before sweep', 'GET', '/api/cluster/conflicts');
        await ex('sweep status idle', 'GET', '/api/cluster/sweep/status');
        await ex('sweep cancel when idle', 'POST', '/api/cluster/sweep/cancel');
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await ex('sweep run', 'POST', '/api/cluster/sweep/run', { body: { minSize: 1024 } });
        await ws.waitFor((m) => m.type === 'cluster_sweep_done' && m.kind === 'cluster_sweep');
        t.recordWs('ws: sweep', ws.drain());
        ws.close();
        await until(
            async () => !(await t.request('GET', '/api/cluster/sweep/status')).json.running,
            {
                what: 'sweep idle',
            },
        );
        await ex('sweep status done', 'GET', '/api/cluster/sweep/status');
        await ex('conflicts after sweep', 'GET', '/api/cluster/conflicts');
    });

    it('resolve', async () => {
        const t = h.t;
        const photoA = crypto
            .createHash('sha256')
            .update(
                fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'media', 'photo-a.jpg')),
            )
            .digest('hex');
        const id = `${photoA}|3365`;
        await ex(
            'resolve without keep → 400',
            'POST',
            `/api/cluster/conflicts/${encodeURIComponent(id)}/resolve`,
            {
                body: {},
            },
        );
        await ex('resolve unknown conflict → 404', 'POST', '/api/cluster/conflicts/nope/resolve', {
            body: { keep: { peerId: 'self', remoteId: 1 } },
        });
        fakeReceived.length = 0;
        await ex(
            'resolve photo-a keeping self:1',
            'POST',
            `/api/cluster/conflicts/${encodeURIComponent(id)}/resolve`,
            {
                body: { keep: { peerId: 'self', remoteId: DOWNLOAD_IDS.alphaPinned } },
            },
        );
        await ex('conflicts after resolve', 'GET', '/api/cluster/conflicts');
        const dl = await t.request('GET', '/api/cluster/downloads?peerId=self&limit=100');
        t.store.record('rows left after resolve (derived)', {
            derived: {
                ids: dl.json.rows.map((r) => r.id).sort((a, b) => a - b),
                deltaFileOnDisk: fs.existsSync(
                    path.join(t.dataDir, 'downloads', 'Delta Mixed', 'images', 'IMG_0014.jpg'),
                ),
                alphaFileOnDisk: fs.existsSync(
                    path.join(t.dataDir, 'downloads', 'Alpha Photos', 'images', 'IMG_0001.jpg'),
                ),
            },
        });
    });
});

describe('peer removal and failover', () => {
    it('delete', async () => {
        await ex('delete unknown peer → 404', 'DELETE', `/api/cluster/peers/${UNKNOWN_PEER}`);
        await ex('delete bad peer id → 500', 'DELETE', '/api/cluster/peers/not-a-peer');
        await ex('delete beta', 'DELETE', `/api/cluster/peers/${BETA.peerId}`);
        await ex('peers after delete', 'GET', '/api/cluster/peers');
    });

    it('failover log and manual run (starts the cluster engines)', async () => {
        await ex('failover log', 'GET', '/api/cluster/failover-log');
        await ex('failover log limit=1', 'GET', '/api/cluster/failover-log?limit=1');
        await ex('failover run (nothing to take over)', 'POST', '/api/cluster/failover/run');
        await ex('failover run as guest → 403', 'POST', '/api/cluster/failover/run', {
            as: 'guest',
        });
        await ex('unknown cluster route → 404', 'GET', '/api/cluster/does-not-exist');
    });
});
