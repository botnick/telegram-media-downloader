// Catalog sync engine — pulls deltas from a peer with a fake fetcher,
// persists rows into peer_downloads, advances the per-peer cursor.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-sync-'));

let db;
let peers;
let sync;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    peers = await import('../src/core/cluster/peers.js');
    sync = await import('../src/core/cluster/sync.js');
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
    db.getDb().exec(
        "DELETE FROM peers; DELETE FROM peer_downloads; DELETE FROM kv WHERE key='cluster_sync_state';",
    );
});

const PEER = {
    peerId: '11111111-2222-3333-4444-555555555555',
    name: 'Bee',
    url: 'http://b.example.com',
};

describe('syncPeerOnce', () => {
    it('persists rows into peer_downloads + advances cursor', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        const fetcher = async (url) => {
            expect(url).toContain('/api/cluster/downloads/since');
            expect(url).toContain('sinceId=0');
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    rows: [
                        { id: 1, file_path: 'g/a.jpg', file_size: 1024, file_hash: 'h1' },
                        { id: 5, file_path: 'g/b.jpg', file_size: 2048, file_hash: 'h2' },
                    ],
                }),
            };
        };
        const r = await sync.syncPeerOnce(peers.getPeer(PEER.peerId), { fetcher });
        expect(r.ok).toBe(true);
        expect(r.count).toBe(2);
        expect(r.nextSinceId).toBe(5);

        const rows = db
            .getDb()
            .prepare(
                'SELECT remote_id, file_path FROM peer_downloads WHERE peer_id = ? ORDER BY remote_id',
            )
            .all(PEER.peerId);
        expect(rows).toEqual([
            { remote_id: 1, file_path: 'g/a.jpg' },
            { remote_id: 5, file_path: 'g/b.jpg' },
        ]);
    });

    it('a second pass uses the advanced cursor', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        // First pass.
        await sync.syncPeerOnce(peers.getPeer(PEER.peerId), {
            fetcher: async () => ({
                ok: true,
                status: 200,
                json: async () => ({ rows: [{ id: 5, file_path: 'g/b.jpg' }] }),
            }),
        });
        // Second pass — sinceId should be 5.
        let captured;
        await sync.syncPeerOnce(peers.getPeer(PEER.peerId), {
            fetcher: async (url) => {
                captured = url;
                return { ok: true, status: 200, json: async () => ({ rows: [] }) };
            },
        });
        expect(captured).toContain('sinceId=5');
    });

    it('marks peer offline on fetch error', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        await sync.syncPeerOnce(peers.getPeer(PEER.peerId), {
            fetcher: async () => {
                throw new Error('ECONNREFUSED');
            },
        });
        expect(peers.getPeer(PEER.peerId).status).toBe('offline');
    });

    it('handles 401 without throwing', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        const r = await sync.syncPeerOnce(peers.getPeer(PEER.peerId), {
            fetcher: async () => ({ ok: false, status: 401, json: async () => ({}) }),
        });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('token_invalid');
    });
});

describe('syncAllOnce', () => {
    it('iterates every paired peer and skips revoked ones', async () => {
        peers.upsertPeer({ ...PEER, status: 'online' });
        peers.upsertPeer({
            peerId: '22222222-3333-4444-5555-666666666666',
            name: 'Cee',
            url: 'http://c.example.com',
            status: 'online',
        });
        peers.upsertPeer({
            peerId: '33333333-4444-5555-6666-777777777777',
            name: 'Dee',
            url: 'http://d.example.com',
            status: 'revoked',
        });
        const seen = [];
        const fetcher = async (url) => {
            const u = new URL(url);
            seen.push(u.hostname);
            return { ok: true, status: 200, json: async () => ({ rows: [] }) };
        };
        await sync.syncAllOnce({ fetcher });
        expect(seen.sort()).toEqual(['b.example.com', 'c.example.com']);
    });
});
