// Cluster peer-to-peer API contract (HMAC-signed, no cookie): handshake,
// health, delta/snapshot sync reads, sign-url, relay, cross-peer delete,
// federated search, file bridge (+ Range) and peer thumbnails — plus every
// way the signature gate refuses a request (missing headers, bad ts, clock
// skew, bad signature, replay) and what it writes to the audit log.
//
// Requests are signed here exactly like src/core/cluster/hmac.js does:
//   X-Peer-Signature = hex(HMAC-SHA256(key, METHOD\nPATH?QUERY\nTS\nsha256(rawBody)))
// with key = the per-pair secret (seeded for peer alpha) or the legacy
// global cluster token (accepted for ANY X-Peer-Id).
//
// Peer beta's URL is pointed at a fake peer in this process so a relayed
// call has somewhere to land; alpha stays on peer-alpha.invalid.

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const ALPHA = SEED.peers.alpha;
const BETA = SEED.peers.beta;
const DELTA_ID = '00000000-0000-4000-8000-0000000000d4';
const STRANGER = '00000000-0000-4000-8000-00000000beef';

// ---- fake relay target (peer beta) ----------------------------------------

const relayed = [];
const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        relayed.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            raw: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'application/json', 'x-not-forwarded': 'dropped' });
        res.end(JSON.stringify({ relayedTo: 'beta', ok: true }));
    });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE_URL = `http://127.0.0.1:${fake.address().port}`;

const h = useContract(import.meta.url, {
    afterDb: (db) => {
        // Per-pair secrets are stored as the UTF-8 bytes of the hex string
        // (db.setPeerSharedSecret); the shared seed writes raw bytes.
        db.prepare('UPDATE peers SET shared_secret = ? WHERE peer_id = ?').run(
            Buffer.from(ALPHA.sharedSecret, 'utf8'),
            ALPHA.peerId,
        );
        db.prepare('UPDATE peers SET url = ? WHERE peer_id = ?').run(FAKE_URL, BETA.peerId);
    },
});

// ---- signing ---------------------------------------------------------------

let lastTs = 0;
function nextTs() {
    // Strictly increasing so two requests never share a signature (the
    // replay cache is keyed by signature).
    lastTs = Math.max(Date.now(), lastTs + 1);
    return lastTs;
}

function sign({ method, urlPath, raw = '', key, peerId = ALPHA.peerId, ts = nextTs() }) {
    const bodyHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    const sig = crypto
        .createHmac('sha256', key)
        .update(`${method}\n${urlPath}\n${Number(ts)}\n${bodyHash}`)
        .digest('hex');
    return { 'x-peer-id': peerId, 'x-peer-ts': String(ts), 'x-peer-signature': sig };
}

// Beta's URL is the fake peer's ephemeral port — rewrite it before
// recording admin views that list peers.
function swapFake(v) {
    if (typeof v === 'string') return v.split(FAKE_URL).join('http://<FAKE_PEER>');
    if (Array.isArray(v)) return v.map(swapFake);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapFake(x)]));
    return v;
}

async function peersView(label) {
    const t = h.t;
    const res = await t.request('GET', '/api/cluster/peers');
    await t.record(
        label,
        { method: 'GET', path: '/api/cluster/peers', as: 'admin' },
        { ...res, json: swapFake(res.json) },
    );
}

const KEYS = {
    alpha: ALPHA.sharedSecret,
    token: SEED.clusterToken,
};

/**
 * Signed peer request + record. `as` in the snapshot names who signed:
 * `peer:<id>/<key>`, `peer:unsigned`, …  Signature headers themselves are
 * not recorded (clock-derived).
 */
async function peer(label, method, urlPath, o = {}) {
    const t = h.t;
    const raw =
        o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    let headers = {};
    let as = 'peer:unsigned';
    if (o.headers) {
        headers = o.headers;
        as = o.as ?? 'peer:custom-headers';
    } else if (o.key !== null) {
        const keyName = o.key ?? 'alpha';
        const key = KEYS[keyName] ?? keyName;
        const pid = o.peerId ?? ALPHA.peerId;
        headers = sign({ method, urlPath, raw, key, peerId: pid });
        as = `peer:${pid === ALPHA.peerId ? 'alpha' : pid}/${KEYS[keyName] ? keyName : 'other-key'}`;
    }
    if (raw) headers['content-type'] = 'application/json';
    Object.assign(headers, o.extraHeaders || {});
    const res = await t.request(method, urlPath, { as: 'anon', headers, body: raw || undefined });
    await t.record(
        label,
        {
            method,
            path: urlPath,
            as,
            ...(o.body !== undefined ? { body: o.recordBody ?? o.body } : {}),
        },
        res,
        { bodyMode: o.bodyMode, mask: o.mask, unordered: o.unordered, note: o.note },
    );
    return res;
}

describe('signature gate', () => {
    it('refuses unsigned, malformed, stale, forged and replayed requests', async () => {
        await peer('health unsigned → 401 missing_headers', 'GET', '/api/cluster/health', {
            key: null,
        });
        await peer('health bad ts → 401 bad_ts', 'GET', '/api/cluster/health', {
            headers: { 'x-peer-id': ALPHA.peerId, 'x-peer-ts': 'abc', 'x-peer-signature': '00' },
            as: 'peer:alpha/bad-ts',
        });
        const old = Date.now() - 120_000;
        await peer('health clock skew → 401 clock_skew', 'GET', '/api/cluster/health', {
            headers: sign({
                method: 'GET',
                urlPath: '/api/cluster/health',
                key: KEYS.alpha,
                ts: old,
            }),
            as: 'peer:alpha/ts-120s-old',
        });
        await peer('health wrong key → 401 bad_signature', 'GET', '/api/cluster/health', {
            key: 'e1'.repeat(32),
        });
        await peer('health non-hex signature → 401 bad_signature', 'GET', '/api/cluster/health', {
            headers: {
                'x-peer-id': ALPHA.peerId,
                'x-peer-ts': String(nextTs()),
                'x-peer-signature': 'zz',
            },
            as: 'peer:alpha/non-hex-sig',
        });
        const replay = sign({ method: 'GET', urlPath: '/api/cluster/health', key: KEYS.alpha });
        await peer('health signed (first use)', 'GET', '/api/cluster/health', {
            headers: { ...replay },
            as: 'peer:alpha/alpha',
        });
        await peer('health same signature again → 401 replay', 'GET', '/api/cluster/health', {
            headers: { ...replay },
            as: 'peer:alpha/alpha (replayed)',
        });
        await peer('health signature for another path → 401', 'GET', '/api/cluster/health', {
            headers: sign({ method: 'GET', urlPath: '/api/cluster/health?x=1', key: KEYS.alpha }),
            as: 'peer:alpha/signed-other-path',
        });
    });

    it('accepts the per-pair secret and the legacy cluster token (for any peer id)', async () => {
        await peer('health signed with alpha secret', 'GET', '/api/cluster/health', {
            key: 'alpha',
        });
        await peer('health signed with cluster token as alpha', 'GET', '/api/cluster/health', {
            key: 'token',
        });
        await peer(
            'health signed with cluster token as unknown peer',
            'GET',
            '/api/cluster/health',
            {
                key: 'token',
                peerId: STRANGER,
            },
        );
        await peer(
            'health signed with alpha secret but beta id → 401',
            'GET',
            '/api/cluster/health',
            {
                key: 'alpha',
                peerId: BETA.peerId,
            },
        );
    });

    it('every peer route is behind the gate', async () => {
        for (const [m, p] of [
            ['POST', '/api/cluster/handshake'],
            ['GET', '/api/cluster/downloads/since'],
            ['GET', '/api/cluster/groups/snapshot'],
            ['GET', '/api/cluster/accounts/snapshot'],
            ['POST', '/api/cluster/sign-url'],
            ['POST', '/api/cluster/relay/proxy'],
            ['POST', '/api/cluster/files/delete'],
            ['GET', '/api/cluster/search/peer?q=x'],
            ['GET', '/api/cluster/files/Alpha%20Photos/images/IMG_0001.jpg'],
            ['GET', '/api/cluster/peer-thumbs/1'],
        ]) {
            await peer(`${m} ${p} unsigned → 401`, m, p, {
                key: null,
                body: m === 'POST' ? {} : undefined,
            });
        }
    });

    it('failed attempts land in the audit log', async () => {
        const t = h.t;
        const res = await t.exchange(
            'audit kind=request (admin)',
            'GET',
            '/api/cluster/audit?kind=request&limit=100',
            {
                unordered: ['entries'],
                note: 'ORDER BY ts DESC with same-millisecond ties; compared as a set',
            },
        );
        expect(res.json.entries.length).toBeGreaterThan(5);
        await peersView('peers after signed health (alpha online)');
    });
});

describe('handshake', () => {
    it('validation', async () => {
        await peer('handshake missing name → 400', 'POST', '/api/cluster/handshake', {
            key: 'token',
            peerId: DELTA_ID,
            body: { peer_id: DELTA_ID, url: 'http://peer-delta.invalid:3000' },
        });
        await peer('handshake as self → 400', 'POST', '/api/cluster/handshake', {
            key: 'token',
            peerId: SEED.selfPeerId,
            body: { peer_id: SEED.selfPeerId, name: 'me', url: 'http://me.invalid' },
        });
        await peer(
            'handshake without url → 500 (stored as "unknown", rejected by the URL check)',
            'POST',
            '/api/cluster/handshake',
            {
                key: 'token',
                peerId: DELTA_ID,
                body: { peer_id: DELTA_ID, name: 'peer-delta' },
            },
        );
        await peer('handshake bad pairing code → 400', 'POST', '/api/cluster/handshake', {
            key: 'token',
            peerId: DELTA_ID,
            body: {
                peer_id: DELTA_ID,
                name: 'peer-delta',
                url: 'http://peer-delta.invalid:3000',
                pairing_code: 'NOPE1234',
            },
        });
    });

    it('pairs a new peer with the cluster token and installs its secret', async () => {
        const t = h.t;
        const secret = '5a17'.repeat(16);
        const res = await peer('handshake new peer delta', 'POST', '/api/cluster/handshake', {
            key: 'token',
            peerId: DELTA_ID,
            body: {
                peer_id: DELTA_ID,
                name: 'peer-delta',
                url: 'http://peer-delta.invalid:3000/',
                version: '1.2.3',
                shared_secret: secret,
                ts: 1717200000000,
            },
        });
        t.store.record('handshake fingerprint (derived)', {
            derived: {
                fingerprintIsSha256OfTokenAndPeerId:
                    res.json.fingerprint ===
                    crypto
                        .createHash('sha256')
                        .update(`${SEED.clusterToken}:${DELTA_ID}`)
                        .digest('hex'),
                ackEchoesSecret: res.json.shared_secret_ack === secret,
            },
        });
        KEYS.delta = secret;
        await peer('health signed with delta per-pair secret', 'GET', '/api/cluster/health', {
            key: 'delta',
            peerId: DELTA_ID,
        });
        await peer('re-handshake is idempotent', 'POST', '/api/cluster/handshake', {
            key: 'token',
            peerId: DELTA_ID,
            body: {
                peer_id: DELTA_ID,
                name: 'peer-delta renamed',
                url: 'http://peer-delta.invalid:3000',
            },
        });
        await peersView('peers after handshake');
    });

    it('pairing codes', async () => {
        const t = h.t;
        const EPS = '00000000-0000-4000-8000-0000000000e5';
        const code = (await t.request('POST', '/api/cluster/identity/pairing-code')).json.code;
        const derived = crypto
            .createHmac('sha256', SEED.clusterToken)
            .update(`pairing:${code}`)
            .digest('hex');
        const body = {
            peer_id: EPS,
            name: 'peer-epsilon',
            url: 'http://peer-epsilon.invalid:3000',
            pairing_code: code,
        };
        // What initiateHandshake() does for a pairing code: sign with the
        // code-derived secret. The receiver only checks the cluster token /
        // per-pair secret, so this is refused today.
        // The code is random: recorded as <pairing-code>.
        const recordBody = { ...body, pairing_code: '<pairing-code>' };
        await peer(
            'handshake signed with pairing-code secret → 401',
            'POST',
            '/api/cluster/handshake',
            {
                key: derived,
                peerId: EPS,
                body,
                recordBody,
            },
        );
        await peer(
            'handshake with pairing code, signed with token',
            'POST',
            '/api/cluster/handshake',
            {
                key: 'token',
                peerId: EPS,
                body,
                recordBody,
            },
        );
        await peer('pairing code is single-use → 400', 'POST', '/api/cluster/handshake', {
            key: 'token',
            peerId: EPS,
            body,
            recordBody,
        });
    });
});

describe('sync reads', () => {
    it('downloads/since, groups and accounts snapshots', async () => {
        await peer(
            'downloads since 0 limit 3',
            'GET',
            '/api/cluster/downloads/since?sinceId=0&limit=3',
        );
        await peer('downloads since 18', 'GET', '/api/cluster/downloads/since?sinceId=18');
        await peer('downloads since (defaults)', 'GET', '/api/cluster/downloads/since');
        await peer(
            'downloads since garbage params',
            'GET',
            '/api/cluster/downloads/since?sinceId=x&limit=y',
        );
        await peer('groups snapshot', 'GET', '/api/cluster/groups/snapshot');
        await peer('accounts snapshot', 'GET', '/api/cluster/accounts/snapshot');
    });

    it('federated search (peer side)', async () => {
        await peer('search/peer no q', 'GET', '/api/cluster/search/peer');
        await peer(
            'search/peer q=IMG_001 limit=2',
            'GET',
            '/api/cluster/search/peer?q=IMG_001&limit=2',
        );
        await peer('search/peer by group name', 'GET', '/api/cluster/search/peer?q=gamma');
        await peer('search/peer LIKE wildcard is literal', 'GET', '/api/cluster/search/peer?q=%25');
    });
});

describe('file bridge and thumbnails', () => {
    it('files', async () => {
        const p = '/api/cluster/files/Alpha%20Photos/images/IMG_0002.jpg';
        await peer('file bridge', 'GET', p);
        await peer('file bridge Range 0-99', 'GET', p, { extraHeaders: { range: 'bytes=0-99' } });
        await peer('file bridge HEAD', 'HEAD', p);
        await peer(
            'file bridge unicode name',
            'GET',
            `/api/cluster/files/${encodeURI('Delta Mixed/images/ภาพทดสอบ รูป.jpg')}`,
        );
        await peer(
            'file bridge missing → 404',
            'GET',
            '/api/cluster/files/Alpha%20Photos/images/nope.jpg',
        );
        await peer('file bridge traversal → refused', 'GET', '/api/cluster/files/..%2Fdb.sqlite');
        await peer(
            'file bridge undecodable path → 500 (Express decode error)',
            'GET',
            '/api/cluster/files/%E0%A4%A',
        );
    });

    it('peer thumbs', async () => {
        // Today the route res.send()s the {path, width, mtime} object that
        // getOrCreateThumb() returns — a JSON body labelled image/webp —
        // instead of the WebP bytes. Recorded as-is (see report).
        const thumbJson = {
            bodyMode: 'json',
            mask: { mtime: 'mtime of the thumbnail file generated during this run' },
        };
        await peer('peer thumb photo', 'GET', '/api/cluster/peer-thumbs/1', thumbJson);
        await peer('peer thumb w=320', 'GET', '/api/cluster/peer-thumbs/2?w=320', thumbJson);
        await peer('peer thumb document → 404', 'GET', '/api/cluster/peer-thumbs/10');
        await peer('peer thumb unknown id → 404', 'GET', '/api/cluster/peer-thumbs/999');
        await peer('peer thumb bad id → 400', 'GET', '/api/cluster/peer-thumbs/abc');
    });
});

describe('sign-url', () => {
    it('mints a share link the direct-stream mode hands to the browser', async () => {
        const t = h.t;
        await peer('sign-url without path → 400', 'POST', '/api/cluster/sign-url', { body: {} });
        await peer('sign-url unknown path → 404', 'POST', '/api/cluster/sign-url', {
            body: { path: 'Nope/images/x.jpg' },
        });
        const res = await peer('sign-url', 'POST', '/api/cluster/sign-url', {
            body: { path: 'Alpha Photos/images/IMG_0001.jpg', ttlSec: 120 },
        });
        await peer('sign-url behind a proxy', 'POST', '/api/cluster/sign-url', {
            body: { path: 'Alpha Photos/images/IMG_0001.jpg' },
            extraHeaders: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'dl.example.test' },
        });
        const minted = new URL(res.json.url);
        await t.exchange('fetch the minted share url', 'GET', minted.pathname + minted.search, {
            as: 'anon',
        });
        const links = await t.request('GET', '/api/share/links?downloadId=1');
        const row = links.json.links.find((l) => l.label === 'cluster:00000000');
        t.store.record('minted share link row (derived)', {
            derived: {
                label: row.label,
                ttlWindow:
                    res.json.expiresAt - Date.now() <= 120_000 &&
                    res.json.expiresAt - Date.now() > 100_000,
                storedExpiresAtIsMilliseconds: row.expiresAt > 1e12,
            },
        });
    });
});

describe('relay', () => {
    it('forwards to a paired peer, refuses bad envelopes', async () => {
        const t = h.t;
        await peer('relay empty envelope → 400', 'POST', '/api/cluster/relay/proxy', { body: {} });
        await peer('relay to self → 400', 'POST', '/api/cluster/relay/proxy', {
            body: { to_peer_id: SEED.selfPeerId, method: 'GET', path: '/api/cluster/health' },
        });
        await peer('relay to unknown peer → 404', 'POST', '/api/cluster/relay/proxy', {
            body: { to_peer_id: STRANGER, method: 'GET', path: '/api/cluster/health' },
        });
        await peer('relay to unreachable peer → 502', 'POST', '/api/cluster/relay/proxy', {
            key: 'delta',
            peerId: DELTA_ID,
            body: {
                to_peer_id: ALPHA.peerId,
                method: 'GET',
                path: '/api/cluster/health',
                inner_sig: 'aa',
                inner_ts: 1,
            },
        });
        relayed.length = 0;
        const body = JSON.stringify({ hello: 'beta' });
        await peer('relay POST to beta (fake peer)', 'POST', '/api/cluster/relay/proxy', {
            body: {
                to_peer_id: BETA.peerId,
                method: 'POST',
                path: '/api/cluster/files/delete',
                body_b64: Buffer.from(body).toString('base64'),
                inner_sig: 'c0ffee',
                inner_ts: 1717200000000,
            },
        });
        await peer('relay GET to beta (fake peer)', 'POST', '/api/cluster/relay/proxy', {
            body: {
                to_peer_id: BETA.peerId,
                method: 'GET',
                path: '/api/cluster/health',
                body_b64: '',
                ts: 1717200000001,
                inner_sig: 'beef',
            },
        });
        t.store.record('what beta received through the relay (derived)', {
            received: relayed.map((r) => ({
                method: r.method,
                path: r.url,
                xPeerId: r.headers['x-peer-id'] === ALPHA.peerId ? 'alpha' : r.headers['x-peer-id'],
                xPeerTs: r.headers['x-peer-ts'],
                xPeerSignature: r.headers['x-peer-signature'],
                contentType: r.headers['content-type'] ?? null,
                body: r.raw,
            })),
        });
    });
});

describe('cross-peer delete', () => {
    it('deletes a catalogued file, keeps one still used by another row', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await peer('delete: no selector → 404', 'POST', '/api/cluster/files/delete', { body: {} });
        await peer('delete: unknown remote_id → 404', 'POST', '/api/cluster/files/delete', {
            body: { remote_id: 999 },
        });
        await peer('delete by remote_id (notes.txt)', 'POST', '/api/cluster/files/delete', {
            body: { remote_id: 11, reason: 'contract' },
        });
        await peer(
            'delete by file_path shared with another row',
            'POST',
            '/api/cluster/files/delete',
            {
                body: { file_path: 'Delta Mixed/images/IMG_0014.jpg' },
            },
        );
        await peer(
            'delete by file_path, last user of the file',
            'POST',
            '/api/cluster/files/delete',
            {
                body: { file_path: 'Delta Mixed/images/IMG_0014.jpg' },
            },
        );
        await peer('delete already gone → 404', 'POST', '/api/cluster/files/delete', {
            body: { remote_id: 11 },
        });
        const dl = path.join(t.dataDir, 'downloads');
        t.store.record('files after cross-peer delete (derived)', {
            derived: {
                notesTxt: fs.existsSync(path.join(dl, 'Gamma Docs', 'documents', 'notes.txt')),
                deltaShared: fs.existsSync(path.join(dl, 'Delta Mixed', 'images', 'IMG_0014.jpg')),
            },
        });
        await t.exchange('audit kind=cross_delete', 'GET', '/api/cluster/audit?kind=cross_delete', {
            unordered: ['entries'],
        });
        // The route pushes download_deleted to peers over /ws/cluster; the
        // dashboard socket gets nothing.
        await new Promise((r) => setTimeout(r, 300));
        t.recordWs('ws: dashboard during cross-peer delete', ws.drain());
        ws.close();
    });
});
