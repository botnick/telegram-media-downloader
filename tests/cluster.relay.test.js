// Relay-through-peer — source signs end-to-end, transit forwards.
// Three peers simulated in-process: A (source), B (transit), C (target).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-relay-'));

let db;
let peers;
let relay;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    peers = await import('../src/core/cluster/peers.js');
    relay = await import('../src/core/cluster/relay.js');
});

afterAll(() => {
    try {
        db.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
});

beforeEach(() => {
    db.getDb().exec('DELETE FROM peers;');
    relay._resetQuotaForTests();
});

const PEER_B = '22222222-3333-4444-5555-666666666666'; // transit
const PEER_C = '33333333-4444-5555-6666-777777777777'; // target

describe('pickRelayPeer', () => {
    it('picks the most-recently-online peer that is not the target', () => {
        peers.upsertPeer({ peerId: PEER_B, name: 'B', url: 'http://b' });
        peers.setSharedSecret(PEER_B, peers.generateSharedSecret());
        peers.upsertPeer({ peerId: PEER_C, name: 'C', url: 'http://c' });
        peers.setSharedSecret(PEER_C, peers.generateSharedSecret());
        const r = relay.pickRelayPeer(PEER_C);
        expect(r?.peerId).toBe(PEER_B);
    });

    it('returns null when no candidates', () => {
        expect(relay.pickRelayPeer(PEER_C)).toBeNull();
    });
});

describe('handleRelay (transit-side)', () => {
    it('forwards inner_sig as X-Peer-Signature on the outbound call', async () => {
        peers.upsertPeer({ peerId: PEER_C, name: 'C', url: 'http://c' });
        peers.setSharedSecret(PEER_C, peers.generateSharedSecret());

        let captured;
        const fakeFetcher = async (url, init) => {
            captured = { url, init };
            return {
                ok: true,
                status: 200,
                headers: new Map(),
                arrayBuffer: async () => new ArrayBuffer(0),
            };
        };

        const innerSig = 'aabb' + 'cc'.repeat(30);
        const ts = Date.now();
        const envelope = {
            to_peer_id: PEER_C,
            method: 'GET',
            path: '/api/cluster/health',
            body_b64: '',
            ts,
            inner_sig: innerSig,
            inner_ts: ts,
        };
        const sourceId = '11111111-2222-3333-4444-555555555555';
        const res = await relay.handleRelay({
            envelope,
            sourcePeerId: sourceId,
            fetcher: fakeFetcher,
        });
        expect(res.ok).toBe(true);
        expect(captured.url).toBe('http://c/api/cluster/health');
        // Crucially the inner sig is preserved verbatim — transit cannot tamper.
        expect(captured.init.headers['X-Peer-Signature']).toBe(innerSig);
        expect(captured.init.headers['X-Peer-Id']).toBe(sourceId);
    });

    it('refuses if target not paired', async () => {
        await expect(
            relay.handleRelay({
                envelope: { to_peer_id: PEER_C, method: 'GET', path: '/x', ts: Date.now() },
                sourcePeerId: 'A',
                fetcher: async () => ({}),
            }),
        ).rejects.toThrow(/not paired/);
    });

    it('refuses to relay to self', async () => {
        const { getSelfPeerId } = await import('../src/core/cluster/identity.js');
        await expect(
            relay.handleRelay({
                envelope: {
                    to_peer_id: getSelfPeerId(),
                    method: 'GET',
                    path: '/x',
                    ts: Date.now(),
                },
                sourcePeerId: 'A',
                fetcher: async () => ({}),
            }),
        ).rejects.toThrow(/self/);
    });
});
