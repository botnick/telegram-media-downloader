// Federated gallery helpers — UNION ALL of `downloads` + `peer_downloads`,
// shared by /api/downloads/all, /api/downloads/:groupId, and
// /api/downloads/search when the caller passes ?include=peers|all.
// Locks down the SQL contract so future refactors can't drift the
// column shape, sort order, or pagination semantics.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-fed-gallery-'));

let db;
let api;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    // Wipe both tables between tests so each case starts clean.
    db.prepare('DELETE FROM downloads').run();
    db.prepare('DELETE FROM peer_downloads').run();
});

// ---- Helpers ---------------------------------------------------------------

function seedLocal({ id, groupId, groupName, fileName, fileType, fileSize, createdAt, hash }) {
    const stmt = db.prepare(`
        INSERT INTO downloads
            (id, group_id, group_name, message_id, file_name, file_size, file_type,
             file_path, file_hash, status, created_at, pinned)
        VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, 0)
    `);
    stmt.run(
        id,
        groupId,
        groupName,
        id,
        fileName,
        fileSize,
        fileType,
        `${groupName}/${fileType === 'photo' ? 'images' : 'videos'}/${fileName}`,
        hash || null,
        createdAt,
    );
}

function seedPeer({
    peerId,
    remoteId,
    groupId,
    groupName,
    fileName,
    fileType,
    fileSize,
    createdAtMs,
    hash,
}) {
    const stmt = db.prepare(`
        INSERT INTO peer_downloads
            (peer_id, remote_id, group_id, group_name, message_id, file_name, file_size,
             file_type, file_path, file_hash, status, created_at, cached_at)
        VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
    `);
    stmt.run(
        peerId,
        remoteId,
        groupId,
        groupName,
        remoteId,
        fileName,
        fileSize,
        fileType,
        `${groupName}/${fileType === 'photo' ? 'images' : 'videos'}/${fileName}`,
        hash || null,
        createdAtMs,
        Date.now(),
    );
}

// ---- Tests -----------------------------------------------------------------

describe('getAllDownloadsFederated', () => {
    it('returns local-only when include=local (default; backward-compat)', () => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-01 12:00:00',
        });
        seedPeer({
            peerId: 'peer-B',
            remoteId: 99,
            groupId: '-100',
            groupName: 'A',
            fileName: 'peer.jpg',
            fileType: 'photo',
            fileSize: 200,
            createdAtMs: Date.parse('2026-04-02T12:00:00Z'),
        });

        const r = api.getAllDownloadsFederated(50, 0, 'all', { include: 'local' });
        expect(r.total).toBe(1);
        expect(r.files.map((f) => f.file_name)).toEqual(['own.jpg']);
    });

    it('UNIONs local + peer rows when include=peers, sorted by created_at DESC across both', () => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own-old.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-01 12:00:00',
        });
        seedLocal({
            id: 2,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own-new.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-03 12:00:00',
        });
        seedPeer({
            peerId: 'peer-B',
            remoteId: 99,
            groupId: '-100',
            groupName: 'A',
            fileName: 'peer-mid.jpg',
            fileType: 'photo',
            fileSize: 200,
            createdAtMs: Date.parse('2026-04-02T12:00:00Z'),
        });

        const r = api.getAllDownloadsFederated(50, 0, 'all', { include: 'peers' });
        expect(r.total).toBe(3);
        // Newest first across both sides
        expect(r.files.map((f) => f.file_name)).toEqual([
            'own-new.jpg',
            'peer-mid.jpg',
            'own-old.jpg',
        ]);
        // peer_id is 'self' for local rows, the peer's id for federated
        expect(r.files.map((f) => f.peer_id)).toEqual(['self', 'peer-B', 'self']);
        // sort_ts column is dropped from the response
        expect(r.files[0].sort_ts).toBeUndefined();
    });

    it('respects the type filter on both sides of the UNION', () => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-01 12:00:00',
        });
        seedLocal({
            id: 2,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own.mp4',
            fileType: 'video',
            fileSize: 100,
            createdAt: '2026-04-02 12:00:00',
        });
        seedPeer({
            peerId: 'peer-B',
            remoteId: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'peer.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAtMs: Date.parse('2026-04-03T12:00:00Z'),
        });
        seedPeer({
            peerId: 'peer-B',
            remoteId: 2,
            groupId: '-100',
            groupName: 'A',
            fileName: 'peer.mp4',
            fileType: 'video',
            fileSize: 100,
            createdAtMs: Date.parse('2026-04-04T12:00:00Z'),
        });

        const r = api.getAllDownloadsFederated(50, 0, 'images', { include: 'peers' });
        expect(r.total).toBe(2);
        expect(r.files.every((f) => f.file_type === 'photo')).toBe(true);
        expect(new Set(r.files.map((f) => f.file_name))).toEqual(new Set(['own.jpg', 'peer.jpg']));
    });

    it('paginates the merged result correctly', () => {
        for (let i = 0; i < 5; i++) {
            seedLocal({
                id: i + 1,
                groupId: '-100',
                groupName: 'A',
                fileName: `own-${i}.jpg`,
                fileType: 'photo',
                fileSize: 100,
                createdAt: `2026-04-0${i + 1} 12:00:00`,
            });
        }
        for (let i = 0; i < 5; i++) {
            seedPeer({
                peerId: 'peer-B',
                remoteId: i + 100,
                groupId: '-100',
                groupName: 'A',
                fileName: `peer-${i}.jpg`,
                fileType: 'photo',
                fileSize: 100,
                createdAtMs: Date.parse(`2026-04-1${i}T12:00:00Z`),
            });
        }

        const page1 = api.getAllDownloadsFederated(3, 0, 'all', { include: 'peers' });
        expect(page1.files.length).toBe(3);
        expect(page1.total).toBe(10);

        const page2 = api.getAllDownloadsFederated(3, 3, 'all', { include: 'peers' });
        expect(page2.files.length).toBe(3);
        // No id duplication across pages
        const seen = new Set();
        for (const f of [...page1.files, ...page2.files]) {
            const key = `${f.peer_id}:${f.id}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
        }
    });

    it('pinnedOnly excludes peer rows entirely (peer files cant be pinned locally)', () => {
        db.prepare(`UPDATE downloads SET pinned = 1 WHERE id = ?`); // no-op (no rows yet)
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own-pinned.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-01 12:00:00',
        });
        db.prepare(`UPDATE downloads SET pinned = 1 WHERE id = 1`).run();
        seedPeer({
            peerId: 'peer-B',
            remoteId: 99,
            groupId: '-100',
            groupName: 'A',
            fileName: 'peer.jpg',
            fileType: 'photo',
            fileSize: 200,
            createdAtMs: Date.parse('2026-04-02T12:00:00Z'),
        });

        const r = api.getAllDownloadsFederated(50, 0, 'all', {
            include: 'peers',
            pinnedOnly: true,
        });
        expect(r.total).toBe(1);
        expect(r.files.map((f) => f.file_name)).toEqual(['own-pinned.jpg']);
    });

    it('falls back to local-only when no peer rows exist (zero-cluster install)', () => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-01 12:00:00',
        });
        const r = api.getAllDownloadsFederated(50, 0, 'all', { include: 'peers' });
        expect(r.total).toBe(1);
        expect(r.files[0].peer_id).toBe('self');
    });
});

describe('getDownloadsForGroupFederated', () => {
    beforeEach(() => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'own-A.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-01 12:00:00',
        });
        seedLocal({
            id: 2,
            groupId: '-200',
            groupName: 'B',
            fileName: 'own-B.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-02 12:00:00',
        });
        seedPeer({
            peerId: 'peer-X',
            remoteId: 99,
            groupId: '-100',
            groupName: 'A',
            fileName: 'peer-A.jpg',
            fileType: 'photo',
            fileSize: 200,
            createdAtMs: Date.parse('2026-04-03T12:00:00Z'),
        });
        seedPeer({
            peerId: 'peer-Y',
            remoteId: 100,
            groupId: '-100',
            groupName: 'A',
            fileName: 'peerY-A.jpg',
            fileType: 'photo',
            fileSize: 200,
            createdAtMs: Date.parse('2026-04-04T12:00:00Z'),
        });
    });

    it('filters to one group across both sides', () => {
        const r = api.getDownloadsForGroupFederated('-100', 50, 0, 'all', { include: 'peers' });
        expect(r.total).toBe(3);
        expect(r.files.map((f) => f.file_name).sort()).toEqual([
            'own-A.jpg',
            'peer-A.jpg',
            'peerY-A.jpg',
        ]);
    });

    it('opts.peerId narrows to a single peer (sidebar foreign-group click)', () => {
        const r = api.getDownloadsForGroupFederated('-100', 50, 0, 'all', {
            include: 'peers',
            peerId: 'peer-X',
        });
        expect(r.total).toBe(1);
        expect(r.files[0].file_name).toBe('peer-A.jpg');
        expect(r.files[0].peer_id).toBe('peer-X');
    });
});

describe('searchDownloadsFederated', () => {
    beforeEach(() => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'CoolGroup',
            fileName: 'sunset.jpg',
            fileType: 'photo',
            fileSize: 100,
            createdAt: '2026-04-01 12:00:00',
        });
        seedPeer({
            peerId: 'peer-X',
            remoteId: 99,
            groupId: '-100',
            groupName: 'CoolGroup',
            fileName: 'sunrise.jpg',
            fileType: 'photo',
            fileSize: 200,
            createdAtMs: Date.parse('2026-04-02T12:00:00Z'),
        });
        seedPeer({
            peerId: 'peer-X',
            remoteId: 100,
            groupId: '-200',
            groupName: 'OtherGroup',
            fileName: 'sunset.png',
            fileType: 'photo',
            fileSize: 200,
            createdAtMs: Date.parse('2026-04-03T12:00:00Z'),
        });
    });

    it('matches filenames LIKE on both sides of the UNION', () => {
        const r = api.searchDownloadsFederated('sun', { include: 'peers' });
        expect(r.total).toBe(3);
    });

    it('local-only search matches only the local row', () => {
        const r = api.searchDownloadsFederated('sun', { include: 'local' });
        expect(r.total).toBe(1);
        expect(r.files[0].file_name).toBe('sunset.jpg');
    });

    it('groupId filter scopes both sides', () => {
        const r = api.searchDownloadsFederated('sun', { include: 'peers', groupId: '-100' });
        expect(r.total).toBe(2);
        expect(r.files.every((f) => String(f.group_id) === '-100')).toBe(true);
    });
});

describe('getStatsFederated', () => {
    it('returns local totals with empty peerStats array on a single-instance install', () => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'a.jpg',
            fileType: 'photo',
            fileSize: 1000,
            createdAt: '2026-04-01 12:00:00',
        });
        const r = api.getStatsFederated();
        expect(r.totalFiles).toBe(1);
        expect(r.totalSize).toBe(1000);
        expect(r.peerStats).toEqual([]);
    });

    it('aggregates per-peer file count + size when peer rows exist', () => {
        seedLocal({
            id: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'a.jpg',
            fileType: 'photo',
            fileSize: 1000,
            createdAt: '2026-04-01 12:00:00',
        });
        seedPeer({
            peerId: 'peer-X',
            remoteId: 1,
            groupId: '-100',
            groupName: 'A',
            fileName: 'p1.jpg',
            fileType: 'photo',
            fileSize: 500,
            createdAtMs: Date.now(),
        });
        seedPeer({
            peerId: 'peer-X',
            remoteId: 2,
            groupId: '-100',
            groupName: 'A',
            fileName: 'p2.jpg',
            fileType: 'photo',
            fileSize: 700,
            createdAtMs: Date.now(),
        });
        seedPeer({
            peerId: 'peer-Y',
            remoteId: 1,
            groupId: '-200',
            groupName: 'B',
            fileName: 'q.jpg',
            fileType: 'photo',
            fileSize: 900,
            createdAtMs: Date.now(),
        });

        const r = api.getStatsFederated();
        expect(r.totalFiles).toBe(1);
        expect(r.totalSize).toBe(1000);
        expect(r.peerStats.length).toBe(2);
        const byPeer = Object.fromEntries(r.peerStats.map((p) => [p.peerId, p]));
        expect(byPeer['peer-X'].totalFiles).toBe(2);
        expect(byPeer['peer-X'].totalSize).toBe(1200);
        expect(byPeer['peer-Y'].totalFiles).toBe(1);
        expect(byPeer['peer-Y'].totalSize).toBe(900);
    });
});
