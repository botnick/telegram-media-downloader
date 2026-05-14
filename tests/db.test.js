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
