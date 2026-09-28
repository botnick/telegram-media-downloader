// Integration test for the DB layer. We isolate the test by pointing
// `TGDL_DATA_DIR` at an `os.tmpdir` mkdtemp before the dynamic import of
// src/core/db.js, so the singleton picks up the throwaway path and the
// user's real data/db.sqlite is never touched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-db-test-'));

let db;
let downloadsApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    downloadsApi = await import('../src/core/db.js');
    db = downloadsApi.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('downloads schema', () => {
    it('has the expected columns after migrations', () => {
        const cols = db
            .prepare(`PRAGMA table_info(downloads)`)
            .all()
            .map((r) => r.name);
        expect(cols).toEqual(
            expect.arrayContaining([
                'group_id',
                'group_name',
                'message_id',
                'file_name',
                'file_size',
                'file_type',
                'file_path',
                'ttl_seconds',
                'file_hash',
            ]),
        );
    });

    const indexNames = () =>
        db
            .prepare(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'downloads'`,
            )
            .all()
            .map((r) => r.name);

    it('builds the deferred indexes inline on a small library and keeps the old ones', () => {
        const names = indexNames();
        expect(names).toEqual(
            expect.arrayContaining([
                ...downloadsApi.DEFERRED_INDEXES.map((i) => i.name),
                // Still created by older releases — never dropped, so a
                // rollback doesn't have to rebuild them at boot.
                'idx_group_id',
                'idx_group_message',
            ]),
        );
        expect(downloadsApi.listMissingDeferredIndexes()).toEqual([]);
    });

    it('reports and builds a missing deferred index (big-library path)', () => {
        db.exec('DROP INDEX idx_gallery_type_pinned_date');
        expect(downloadsApi.listMissingDeferredIndexes().map((i) => i.name)).toEqual([
            'idx_gallery_type_pinned_date',
        ]);
        expect(typeof downloadsApi.buildDeferredIndex('idx_gallery_type_pinned_date')).toBe(
            'number',
        );
        expect(indexNames()).toContain('idx_gallery_type_pinned_date');
        // Idempotent.
        downloadsApi.buildDeferredIndex('idx_gallery_type_pinned_date');
        expect(() => downloadsApi.buildDeferredIndex('nope')).toThrow();
        // A finished build leaves no "attempting" marker behind.
        expect(downloadsApi.kvGet('index_build_attempt:idx_gallery_type_pinned_date')).toBeNull();
    });

    it('does not retry a build that was interrupted by a killed process', () => {
        // Simulate: marker written, process killed mid-CREATE INDEX (rolled
        // back → index missing, marker still there).
        db.exec('DROP INDEX idx_gallery_group_pinned_date');
        downloadsApi.kvSet('index_build_attempt:idx_gallery_group_pinned_date', {
            startedAt: 123,
        });
        let plan = downloadsApi.planDeferredIndexBuilds();
        expect(plan.build.map((i) => i.name)).toEqual([]);
        expect(plan.interrupted.map((i) => [i.name, i.attemptedAt])).toEqual([
            ['idx_gallery_group_pinned_date', 123],
        ]);
        // The manual path (scripts/build-indexes.js) builds it and clears the marker.
        downloadsApi.buildDeferredIndex('idx_gallery_group_pinned_date');
        plan = downloadsApi.planDeferredIndexBuilds();
        expect(plan).toEqual({ build: [], interrupted: [] });
        expect(downloadsApi.kvGet('index_build_attempt:idx_gallery_group_pinned_date')).toBeNull();
    });

    it('plans missing indexes without a marker and drops stale markers', () => {
        db.exec('DROP INDEX idx_file_path');
        // Killed after CREATE INDEX committed but before the marker was cleared.
        downloadsApi.kvSet('index_build_attempt:idx_group_name_size', { startedAt: 1 });
        const plan = downloadsApi.planDeferredIndexBuilds();
        expect(plan.build.map((i) => i.name)).toEqual(['idx_file_path']);
        expect(plan.interrupted).toEqual([]);
        expect(downloadsApi.kvGet('index_build_attempt:idx_group_name_size')).toBeNull();
        downloadsApi.buildDeferredIndex('idx_file_path');
    });

    it('clears the marker when a build throws (process survived)', () => {
        db.exec('DROP INDEX idx_file_path');
        const realExec = db.exec.bind(db);
        db.exec = (sql) => {
            if (/idx_file_path/.test(sql)) throw new Error('database is locked');
            return realExec(sql);
        };
        try {
            expect(() => downloadsApi.buildDeferredIndex('idx_file_path')).toThrow(/locked/);
        } finally {
            db.exec = realExec;
        }
        expect(downloadsApi.kvGet('index_build_attempt:idx_file_path')).toBeNull();
        expect(downloadsApi.planDeferredIndexBuilds().build.map((i) => i.name)).toEqual([
            'idx_file_path',
        ]);
        downloadsApi.buildDeferredIndex('idx_file_path');
    });

    it('serves the sidebar aggregate from the covering index', () => {
        const plan = db
            .prepare(
                `EXPLAIN QUERY PLAN SELECT group_id, MAX(group_name), COUNT(*), SUM(file_size) FROM downloads GROUP BY group_id`,
            )
            .all()
            .map((r) => r.detail)
            .join(' | ');
        expect(plan).toContain('COVERING INDEX idx_group_name_size');
    });
});

describe('insertDownload + isDownloaded', () => {
    it('inserts a row and detects a duplicate by (group_id, message_id)', () => {
        const r1 = downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'Test Group',
            messageId: 1,
            fileName: 'a.jpg',
            fileSize: 100,
            fileType: 'photo',
            filePath: 'Test_Group/images/a.jpg',
        });
        expect(r1.changes).toBe(1);
        expect(downloadsApi.isDownloaded('-100123', 1)).toBe(true);

        // Same (group, message) is a no-op
        const r2 = downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'Test Group',
            messageId: 1,
            fileName: 'a.jpg',
            fileSize: 100,
            fileType: 'photo',
            filePath: 'Test_Group/images/a.jpg',
        });
        expect(r2.changes).toBe(0);
    });

    it('persists ttl_seconds for self-destructing media', () => {
        downloadsApi.insertDownload({
            groupId: '-100123',
            groupName: 'Test Group',
            messageId: 2,
            fileName: 'b.mp4',
            fileSize: 200,
            fileType: 'video',
            filePath: 'Test_Group/videos/b.mp4',
            ttlSeconds: 30,
        });
        const row = db.prepare('SELECT ttl_seconds FROM downloads WHERE message_id = 2').get();
        expect(row.ttl_seconds).toBe(30);
    });
});

describe('fileAlreadyStored', () => {
    it('matches by (group_id, file_name, file_size)', () => {
        downloadsApi.insertDownload({
            groupId: '-100999',
            groupName: 'g',
            messageId: 7,
            fileName: 'cat.jpg',
            fileSize: 4242,
            fileType: 'photo',
            filePath: 'g/images/cat.jpg',
        });
        expect(downloadsApi.fileAlreadyStored('-100999', 'cat.jpg', 4242)).toBe(true);
        expect(downloadsApi.fileAlreadyStored('-100999', 'cat.jpg', 9999)).toBe(false);
        expect(downloadsApi.fileAlreadyStored('-100888', 'cat.jpg', 4242)).toBe(false);
    });
});

describe('searchDownloads', () => {
    it('finds by file_name and group_name', () => {
        const result = downloadsApi.searchDownloads('cat');
        expect(result.total).toBeGreaterThan(0);
        expect(result.files.some((f) => f.file_name.includes('cat'))).toBe(true);
    });
});

describe('getStats', () => {
    it('returns totalFiles and totalSize in a single query', () => {
        const stats = downloadsApi.getStats();
        expect(stats).toHaveProperty('totalFiles');
        expect(stats).toHaveProperty('totalSize');
        expect(stats.totalFiles).toBeGreaterThan(0);
        expect(typeof stats.totalSize).toBe('number');
    });
});

describe('pinned queries', () => {
    let pinnedId;

    it('pinned column is never NULL after backfill', () => {
        const nullCount = db
            .prepare('SELECT COUNT(*) AS n FROM downloads WHERE pinned IS NULL')
            .get().n;
        expect(nullCount).toBe(0);
    });

    it('getAllDownloads pinnedOnly returns only pinned rows', () => {
        downloadsApi.insertDownload({
            groupId: '-100555',
            groupName: 'Pinned Group',
            messageId: 900,
            fileName: 'pinned.jpg',
            fileSize: 500,
            fileType: 'photo',
            filePath: 'pg/images/pinned.jpg',
        });
        pinnedId = db.prepare('SELECT id FROM downloads WHERE message_id = 900').get().id;
        db.prepare('UPDATE downloads SET pinned = 1 WHERE id = ?').run(pinnedId);

        const result = downloadsApi.getAllDownloads(50, 0, 'all', { pinnedOnly: true });
        expect(result.files.length).toBeGreaterThan(0);
        expect(result.files.every((f) => f.pinned === 1)).toBe(true);
    });

    it('getAllDownloads pinnedFirst puts pinned rows first', () => {
        const result = downloadsApi.getAllDownloads(50, 0, 'all', { pinnedFirst: true });
        expect(result.files.length).toBeGreaterThan(1);
        const firstPinned = result.files.findIndex((f) => f.pinned === 1);
        const firstUnpinned = result.files.findIndex((f) => f.pinned === 0);
        if (firstPinned >= 0 && firstUnpinned >= 0) {
            expect(firstPinned).toBeLessThan(firstUnpinned);
        }
    });

    it('getOldestDownloads excludes pinned rows', () => {
        const oldest = downloadsApi.getOldestDownloads(100);
        expect(oldest.every((f) => f.pinned === 0)).toBe(true);
    });
});

describe('findDownloadsByPaths', () => {
    it('matches both separator forms through idx_file_path', () => {
        downloadsApi.insertDownload({
            groupId: '-100777',
            groupName: 'Paths',
            messageId: 1,
            fileName: 'win.jpg',
            fileSize: 1,
            fileType: 'photo',
            filePath: String.raw`Paths\images\win.jpg`,
        });
        downloadsApi.insertDownload({
            groupId: '-100777',
            groupName: 'Paths',
            messageId: 2,
            fileName: 'posix.jpg',
            fileSize: 1,
            fileType: 'photo',
            filePath: 'Paths/images/posix.jpg',
        });
        // Same basename in another folder must never be picked up.
        downloadsApi.insertDownload({
            groupId: '-100778',
            groupName: 'Other',
            messageId: 1,
            fileName: 'win.jpg',
            fileSize: 1,
            fileType: 'photo',
            filePath: 'Other/images/win.jpg',
        });
        const rows = downloadsApi.findDownloadsByPaths([
            'Paths/images/win.jpg',
            String.raw`Paths\images\posix.jpg`,
            'missing/x.jpg',
            '',
            null,
        ]);
        expect(rows.map((r) => r.file_path).sort()).toEqual([
            'Paths/images/posix.jpg',
            String.raw`Paths\images\win.jpg`,
        ]);
        const plan = db
            .prepare('EXPLAIN QUERY PLAN SELECT id FROM downloads WHERE file_path IN (?, ?)')
            .all('a', 'b')
            .map((r) => r.detail)
            .join(' | ');
        expect(plan).toContain('idx_file_path');
    });

    it('chunks large inputs under the bound-parameter cap', () => {
        const paths = Array.from({ length: 1500 }, (_, i) => `bulk/images/f${i}.jpg`);
        paths.push('Paths/images/posix.jpg');
        const rows = downloadsApi.findDownloadsByPaths(paths);
        expect(rows.map((r) => r.file_path)).toEqual(['Paths/images/posix.jpg']);
    });

    it('still finds rows stored with mixed separators (old REPLACE semantics)', () => {
        downloadsApi.insertDownload({
            groupId: '-100779',
            groupName: 'Mixed',
            messageId: 1,
            fileName: 'm.jpg',
            fileSize: 1,
            fileType: 'photo',
            filePath: String.raw`Mixed/images\m.jpg`,
        });
        const rows = downloadsApi.findDownloadsByPaths(['Mixed/images/m.jpg']);
        expect(rows.map((r) => r.file_path)).toEqual([String.raw`Mixed/images\m.jpg`]);
    });
});
