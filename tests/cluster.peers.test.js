// Peers CRUD — upsert, list, update, remove, mark online/offline.
// Self-pairing is rejected. Bad URLs / peer_ids throw.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-peers-'));

let peers;
let identity;
let db;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    identity = await import('../src/core/cluster/identity.js');
    peers = await import('../src/core/cluster/peers.js');
});

afterAll(() => {
    try {
        db.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
        /* Windows occasionally retains a brief file lock — non-fatal */
    }
});

beforeEach(() => {
    db.getDb().exec('DELETE FROM peers; DELETE FROM peer_downloads;');
});

describe('upsertPeer', () => {
    it('creates a peer row and returns the public shape', () => {
        const p = peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com:3001/',
        });
        expect(p.peerId).toBe('11111111-2222-3333-4444-555555555555');
        expect(p.name).toBe('Bee');
        expect(p.url).toBe('http://b.example.com:3001'); // trailing slash stripped
        expect(p.streamMode).toBe('proxy');
        expect(p.status).toBe('online');
        expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(p.pairedAt).toBeGreaterThan(0);
    });

    it('updates an existing peer on second upsert (no duplicate row)', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee renamed',
            url: 'http://b.example.com',
        });
        const list = peers.listPeers();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('Bee renamed');
    });

    it('refuses to pair with self', () => {
        const selfId = identity.getSelfPeerId();
        expect(() =>
            peers.upsertPeer({ peerId: selfId, name: 'Me', url: 'http://localhost:3000' }),
        ).toThrow(/self/);
    });

    it('rejects non-http URLs', () => {
        expect(() =>
            peers.upsertPeer({
                peerId: '11111111-2222-3333-4444-555555555555',
                name: 'Bad',
                url: 'ftp://example.com',
            }),
        ).toThrow();
    });

    it('rejects malformed peer_id', () => {
        expect(() =>
            peers.upsertPeer({ peerId: 'not-a-uuid', name: 'X', url: 'http://x' }),
        ).toThrow();
    });
});

describe('updatePeer', () => {
    it('patches name + streamMode + notes', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        const r = peers.updatePeer('11111111-2222-3333-4444-555555555555', {
            name: 'Renamed',
            streamMode: 'direct',
            notes: 'home NAS',
        });
        expect(r.name).toBe('Renamed');
        expect(r.streamMode).toBe('direct');
        expect(r.notes).toBe('home NAS');
    });

    it('returns null for unknown peer', () => {
        expect(peers.updatePeer('99999999-9999-9999-9999-999999999999', { name: 'X' })).toBeNull();
    });

    it('rejects an invalid streamMode', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        expect(() =>
            peers.updatePeer('11111111-2222-3333-4444-555555555555', { streamMode: 'rocket' }),
        ).toThrow();
    });
});

describe('removePeer', () => {
    it('returns true when a row was deleted, false otherwise', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        expect(peers.removePeer('11111111-2222-3333-4444-555555555555')).toBe(true);
        expect(peers.removePeer('11111111-2222-3333-4444-555555555555')).toBe(false);
    });

    it('cascade-purges cached catalog rows', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
        });
        db.getDb()
            .prepare(
                "INSERT INTO peer_downloads (peer_id, remote_id, file_path, cached_at) VALUES (?, 1, 'x', ?)",
            )
            .run('11111111-2222-3333-4444-555555555555', Date.now());
        peers.removePeer('11111111-2222-3333-4444-555555555555');
        const left = db
            .getDb()
            .prepare('SELECT COUNT(*) AS n FROM peer_downloads WHERE peer_id = ?')
            .get('11111111-2222-3333-4444-555555555555').n;
        expect(left).toBe(0);
    });
});

describe('mark online / offline', () => {
    it('flips status + bumps last_seen_at', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
            status: 'offline',
        });
        peers.markOnline('11111111-2222-3333-4444-555555555555');
        const live = peers.getPeer('11111111-2222-3333-4444-555555555555');
        expect(live.status).toBe('online');
        expect(live.lastSeenAt).toBeGreaterThan(0);
        peers.markOffline('11111111-2222-3333-4444-555555555555');
        expect(peers.getPeer('11111111-2222-3333-4444-555555555555').status).toBe('offline');
    });
});
