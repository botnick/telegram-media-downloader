// Cluster bugs the API contract suite recorded as-is:
//   - a pairing-code handshake could never verify (the initiator signed with
//     a key derived from ITS cluster token, the receiver only checked its
//     own token / per-pair secret);
//   - a direct-stream URL minted by an older peer never verifies, so the
//     requester must not redirect a browser to it;
//   - the /ws/cluster channel handled one failed dial twice ('error' then
//     'close'), doubling the reconnect attempts every round, and marked a
//     peer offline (re-stamping last_seen_at) on every failed dial.
// The HTTP side (sign-url, peer-thumbs, pairing between two servers, engine
// start) is in cluster-pairing.e2e.test.js.

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-fixes-'));
const PEER = '11111111-2222-4333-8444-555555555555';

let db;
let identity;
let peers;
let hmac;
let handshake;
let proxy;
let wsChannel;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    identity = await import('../src/core/cluster/identity.js');
    peers = await import('../src/core/cluster/peers.js');
    hmac = await import('../src/core/cluster/hmac.js');
    handshake = await import('../src/core/cluster/handshake.js');
    proxy = await import('../src/core/cluster/proxy.js');
    wsChannel = await import('../src/core/cluster/ws-channel.js');
});

afterAll(() => {
    try {
        wsChannel.shutdownClusterWs();
        db.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
});

beforeEach(() => {
    db.getDb().exec(
        "DELETE FROM peers; DELETE FROM cluster_audit; DELETE FROM kv WHERE key='pairing_codes';",
    );
    hmac._resetReplayCacheForTests();
});

// The request an initiator sends, captured by a fake fetcher, replayed into
// verifyRequest() the way the express handler sees it.
function captureFetcher(reply = { status: 401, body: { error: 'cluster auth failed' } }) {
    const sent = [];
    const fetcher = async (url, init) => {
        sent.push({ url, ...init });
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            json: async () => reply.body,
        };
    };
    return { sent, fetcher };
}
const asExpressReq = (s) => ({
    method: s.method,
    originalUrl: new URL(s.url).pathname,
    headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawBody: s.body,
});

describe('pairing-code handshake', () => {
    it('verifies at a receiver holding a different cluster token', async () => {
        // Receiver: issues the code under its own token.
        const receiverToken = identity.getClusterToken();
        const { code } = identity.issuePairingCode();
        // Initiator: another install, another token.
        identity.setClusterToken('ab'.repeat(32));
        const { sent, fetcher } = captureFetcher();
        await handshake.initiateHandshake({
            url: 'http://receiver.test',
            pairingCode: code,
            fetcher,
        });
        identity.setClusterToken(receiverToken);

        const req = asExpressReq(sent[0]);
        expect(JSON.parse(req.rawBody).pairing_code).toBe(code);
        // What the receiver checked before the fix: token / per-pair secret.
        expect(hmac.verifyRequest(req)).toEqual({ ok: false, reason: 'bad_signature' });
        // What the handshake route checks now.
        const v = hmac.verifyRequest(req, { expectedToken: identity.pairingKeysFor(code) });
        expect(v.ok).toBe(true);
    });

    it('accepts the token-derived key older initiators sign with', () => {
        const { code, secret } = identity.issuePairingCode();
        expect(identity.deriveSecretFromPairingCode(code)).toBe(secret);
        expect(identity.pairingKeysFor(code)).toEqual([identity.pairingCodeKey(code), secret]);
        expect(identity.pairingKeysFor(code.toLowerCase())).toHaveLength(2);
    });

    it('offers no key for an unknown, expired or consumed code', () => {
        expect(identity.pairingKeysFor('NOTISSUED')).toEqual([]);
        expect(identity.pairingKeysFor(null)).toEqual([]);
        const { code } = identity.issuePairingCode();
        const map = db.getDb().prepare("SELECT value FROM kv WHERE key='pairing_codes'").get();
        const codes = JSON.parse(map.value);
        codes[code].expiresAt = Date.now() - 1;
        db.getDb()
            .prepare("UPDATE kv SET value = ? WHERE key='pairing_codes'")
            .run(JSON.stringify(codes));
        expect(identity.pairingKeysFor(code)).toEqual([]);
        const fresh = identity.issuePairingCode().code;
        identity.consumePairingCode(fresh);
        expect(identity.pairingKeysFor(fresh)).toEqual([]);
    });

    it('the code key does not depend on the cluster token', () => {
        const before = identity.pairingCodeKey('ABCD2345');
        identity.rotateClusterToken();
        expect(identity.pairingCodeKey('abcd2345')).toBe(before);
    });

    it('a refused pairing code says so instead of blaming the cluster token', async () => {
        const { fetcher } = captureFetcher();
        const r = await handshake.initiateHandshake({
            url: 'http://receiver.test',
            pairingCode: 'ABCD2345',
            fetcher,
        });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('pairing_code_rejected');
        expect(r.message).toMatch(/pairing code/);
        // The token path keeps its code.
        const t = await handshake.initiateHandshake({
            url: 'http://receiver.test',
            token: 'cd'.repeat(32),
            fetcher,
        });
        expect(t.code).toBe('token_invalid');
    });
});

describe('direct-stream URL from a peer', () => {
    beforeEach(() => {
        peers.upsertPeer({ peerId: PEER, name: 'Bee', url: 'http://bee.test' });
    });
    const fetcherReturning = (body) => async () => ({
        ok: true,
        status: 200,
        json: async () => body,
    });

    it('is used when the peer marks it verifiable (exp)', async () => {
        const url = await proxy.requestSignedShareUrl(PEER, 'a/b.jpg', {
            fetcher: fetcherReturning({
                url: 'http://bee.test/share/1?s=x',
                expiresAt: 1_900_000_000_000,
                exp: 1_900_000_000,
            }),
        });
        expect(url).toBe('http://bee.test/share/1?s=x');
    });

    it('is refused from an older peer, whose URLs never verify', async () => {
        await expect(
            proxy.requestSignedShareUrl(PEER, 'a/b.jpg', {
                fetcher: fetcherReturning({
                    url: 'http://bee.test/share/1?s=x',
                    expiresAt: 1_900_000_000_000,
                }),
            }),
        ).rejects.toMatchObject({ code: 'LEGACY_SIGN_URL' });
    });
});

describe('/ws/cluster outbound dials', () => {
    class FakeWs extends EventEmitter {
        static made = [];
        constructor(url) {
            super();
            this.url = url;
            FakeWs.made.push(this);
        }
        ping() {}
        terminate() {}
        close() {}
        send() {}
    }

    it('one failed dial schedules one reconnect and changes nothing about the peer', async () => {
        vi.useFakeTimers();
        try {
            peers.upsertPeer({
                peerId: PEER,
                name: 'Bee',
                url: 'http://bee.test',
                status: 'offline',
            });
            peers.setSharedSecret(PEER, 'ef'.repeat(32));
            db.getDb().prepare('UPDATE peers SET last_seen_at = 1000 WHERE peer_id = ?').run(PEER);
            const events = [];
            wsChannel.initClusterWs({ broadcast: (m) => events.push(m), WebSocket: FakeWs });
            expect(FakeWs.made).toHaveLength(1);
            for (let round = 0; round < 3; round++) {
                const ws = FakeWs.made.at(-1);
                ws.emit('error', new Error('getaddrinfo ENOTFOUND bee.test'));
                ws.emit('close');
                await vi.advanceTimersByTimeAsync(40_000);
            }
            // 1 dial + 1 reconnect per failure (it was 1, 2, 4, …).
            expect(FakeWs.made).toHaveLength(4);
            const row = peers.getPeer(PEER);
            expect(row.status).toBe('offline');
            expect(row.lastSeenAt).toBe(1000);
            expect(events).toEqual([]);

            // A link that was up going down is a status change.
            const live = FakeWs.made.at(-1);
            live.emit('open');
            expect(peers.getPeer(PEER).status).toBe('online');
            live.emit('close');
            expect(peers.getPeer(PEER).status).toBe('offline');
            expect(events.map((e) => e.status)).toEqual(['online', 'offline']);
        } finally {
            wsChannel.shutdownClusterWs();
            vi.useRealTimers();
        }
    });
});
