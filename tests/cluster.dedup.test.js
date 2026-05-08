// Pre-download cluster dedup — find a hash across peer_downloads,
// synthesize/parse _clusterref/<peerId>/<remoteId> paths.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-dedup-'));

let db;
let peers;
let dedup;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    peers = await import('../src/core/cluster/peers.js');
    dedup = await import('../src/core/cluster/dedup.js');
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
    db.getDb().exec('DELETE FROM peers; DELETE FROM peer_downloads;');
});

describe('clusterRefPath / parseClusterRefPath', () => {
    it('round-trips a peerId + remoteId', () => {
        const ref = dedup.clusterRefPath('abc-123', 42);
        expect(ref).toBe('_clusterref/abc-123/42');
        expect(dedup.parseClusterRefPath(ref)).toEqual({ peerId: 'abc-123', remoteId: 42 });
    });

    it('returns null on a non-ref path', () => {
        expect(dedup.parseClusterRefPath('group/photos/x.jpg')).toBeNull();
        expect(dedup.parseClusterRefPath('')).toBeNull();
        expect(dedup.parseClusterRefPath(null)).toBeNull();
    });

    it('decodes URL-encoded peerIds', () => {
        const ref = dedup.clusterRefPath('peer/with/slashes', 7);
        const parsed = dedup.parseClusterRefPath(ref);
        expect(parsed.peerId).toBe('peer/with/slashes');
        expect(parsed.remoteId).toBe(7);
    });
});

describe('findHashAcrossCluster', () => {
    it('returns matching peer rows by hash + size', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
            status: 'online',
        });
        db.getDb()
            .prepare(
                `INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_hash, file_size, cached_at)
                 VALUES (?, 7, 'x.jpg', 'deadbeef', 1024, ?)`,
            )
            .run('11111111-2222-3333-4444-555555555555', Date.now());
        const hits = dedup.findHashAcrossCluster('deadbeef', 1024);
        expect(hits).toHaveLength(1);
        expect(hits[0].peerId).toBe('11111111-2222-3333-4444-555555555555');
        expect(hits[0].remoteId).toBe(7);
        expect(hits[0].peerName).toBe('Bee');
    });

    it('skips revoked peers', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
            status: 'online',
        });
        peers.updatePeer('11111111-2222-3333-4444-555555555555', { status: 'revoked' });
        db.getDb()
            .prepare(
                `INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_hash, file_size, cached_at)
                 VALUES (?, 7, 'x.jpg', 'deadbeef', 1024, ?)`,
            )
            .run('11111111-2222-3333-4444-555555555555', Date.now());
        const hits = dedup.findHashAcrossCluster('deadbeef', 1024);
        expect(hits).toHaveLength(0);
    });

    it('size mismatch → no hit', () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
            status: 'online',
        });
        db.getDb()
            .prepare(
                `INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_hash, file_size, cached_at)
                 VALUES (?, 7, 'x.jpg', 'deadbeef', 1024, ?)`,
            )
            .run('11111111-2222-3333-4444-555555555555', Date.now());
        expect(dedup.findHashAcrossCluster('deadbeef', 999)).toHaveLength(0);
    });

    it('empty hash returns empty array', () => {
        expect(dedup.findHashAcrossCluster(null)).toHaveLength(0);
        expect(dedup.findHashAcrossCluster('')).toHaveLength(0);
    });
});
