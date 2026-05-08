// Cross-peer dedup sweep — populates conflicts, resolves them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-cluster-sweep-'));

let db;
let peers;
let sweep;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    db = await import('../src/core/db.js');
    db.getDb();
    peers = await import('../src/core/cluster/peers.js');
    sweep = await import('../src/core/cluster/sweep.js');
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
    db.getDb().exec(`
        DELETE FROM peers;
        DELETE FROM peer_downloads;
        DELETE FROM downloads;
        DELETE FROM kv WHERE key LIKE 'cluster_sweep_%';
    `);
});

describe('runClusterSweep', () => {
    it('finds duplicates spanning self + a peer', async () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
            status: 'online',
        });
        // Self row
        db.getDb()
            .prepare(
                `INSERT INTO downloads (group_id, message_id, file_path, file_name, file_size, file_hash)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run('g', 1, 'g/a.jpg', 'a.jpg', 4096, 'h-shared');
        // Peer row with the same hash + size
        db.getDb()
            .prepare(
                `INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_size, file_hash, cached_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
                '11111111-2222-3333-4444-555555555555',
                99,
                'g/a.jpg',
                4096,
                'h-shared',
                Date.now(),
            );

        await sweep.runClusterSweep({ minSize: 1024 });
        const conflicts = sweep.listConflicts();
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].fileHash).toBe('h-shared');
        expect(conflicts[0].count).toBe(2);
        expect(conflicts[0].owners).toHaveLength(2);
    });

    it('skips files below minSize', async () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
            status: 'online',
        });
        db.getDb()
            .prepare(
                `INSERT INTO downloads (group_id, message_id, file_path, file_size, file_hash)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run('g', 1, 'g/a.jpg', 100, 'h');
        db.getDb()
            .prepare(
                `INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_size, file_hash, cached_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run('11111111-2222-3333-4444-555555555555', 99, 'g/a.jpg', 100, 'h', Date.now());

        await sweep.runClusterSweep({ minSize: 1024 });
        expect(sweep.listConflicts()).toHaveLength(0);
    });
});

describe('resolveConflict', () => {
    it('rejects a missing keep clause', async () => {
        await expect(sweep.resolveConflict('x', null)).rejects.toThrow(/keep/);
    });

    it('removes the conflict from the list when resolved', async () => {
        peers.upsertPeer({
            peerId: '11111111-2222-3333-4444-555555555555',
            name: 'Bee',
            url: 'http://b.example.com',
            status: 'online',
        });
        const r = db
            .getDb()
            .prepare(
                `INSERT INTO downloads (group_id, message_id, file_path, file_size, file_hash)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run('g', 1, 'g/a.jpg', 4096, 'h-shared');
        db.getDb()
            .prepare(
                `INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_size, file_hash, cached_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
                '11111111-2222-3333-4444-555555555555',
                99,
                'g/a.jpg',
                4096,
                'h-shared',
                Date.now(),
            );

        await sweep.runClusterSweep({ minSize: 1024 });
        const before = sweep.listConflicts();
        expect(before).toHaveLength(1);

        // Keep the peer copy → local row gets unlinked + DB row deleted.
        await sweep.resolveConflict(before[0].id, {
            peerId: '11111111-2222-3333-4444-555555555555',
            remoteId: 99,
        });
        expect(sweep.listConflicts()).toHaveLength(0);
        // Local downloads row deleted.
        const left = db.getDb().prepare('SELECT COUNT(*) AS n FROM downloads').get().n;
        expect(left).toBe(0);
    });
});
