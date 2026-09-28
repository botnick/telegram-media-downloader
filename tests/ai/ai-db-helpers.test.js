// AI helpers in db.js that the face scan leans on every batch / status
// poll. Pins the semantics that survived their query rewrites:
//   - getUnindexedAiBatch: oldest-first (insertion order), skips .part
//   - getAiCounts: indexed + unindexed == totalEligible
//   - iterateAllFaces: every row once, in id order, across chunk borders
//   - insertFace: exif_oriented stored as 1 / NULL

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-ai-db-'));
let db;
let api;
let msg = 0;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../../src/core/db.js');
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
    db.prepare('DELETE FROM faces').run();
    db.prepare('DELETE FROM downloads').run();
});

function add(type, file) {
    api.insertDownload({
        groupId: '-1001',
        groupName: 'G',
        messageId: ++msg,
        fileName: file,
        fileSize: 1,
        fileType: type,
        filePath: `G/${file}`,
    });
    return db.prepare('SELECT MAX(id) AS id FROM downloads').get().id;
}

describe('getUnindexedAiBatch', () => {
    it('returns unindexed rows oldest-first, skipping stamped and .part rows', () => {
        const a = add('photo', 'a.jpg');
        const b = add('photo', 'b.jpg');
        add('photo', 'c.jpg.part');
        const d = add('video', 'd.mp4');
        const e = add('photo', 'e.jpg');
        // created_at out of insertion order must not reorder the scan.
        db.prepare("UPDATE downloads SET created_at = '2001-01-01 00:00:00' WHERE id = ?").run(e);
        api.setAiIndexedAt(b);
        expect(
            api.getUnindexedAiBatch({ fileTypes: ['photo'], limit: 10 }).map((r) => r.id),
        ).toEqual([a, e]);
        expect(
            api.getUnindexedAiBatch({ fileTypes: ['photo', 'video'], limit: 10 }).map((r) => r.id),
        ).toEqual([a, d, e]);
        expect(
            api.getUnindexedAiBatch({ fileTypes: ['photo'], limit: 1 }).map((r) => r.id),
        ).toEqual([a]);
    });
});

describe('getAiCounts', () => {
    it('indexed + unindexed adds up to the eligible total', () => {
        const ids = [add('photo', '1.jpg'), add('photo', '2.jpg'), add('photo', '3.jpg')];
        add('video', '4.mp4');
        api.setAiIndexedAt(ids[0]);
        api.setAiIndexedAt(ids[2]);
        const c = api.getAiCounts({ fileTypes: ['photo'] });
        expect(c.totalEligible).toBe(3);
        expect(c.indexed).toBe(2);
        expect(c.unindexed).toBe(1);
        const both = api.getAiCounts({ fileTypes: ['photo', 'video'] });
        expect(both.totalEligible).toBe(4);
        expect(both.indexed).toBe(2);
    });
});

describe('iterateAllFaces / insertFace', () => {
    it('walks every face once in id order across chunk boundaries', () => {
        const dl = add('photo', 'f.jpg');
        const blob = Buffer.from(new Float32Array([1, 0]).buffer);
        for (let i = 0; i < 7; i++) {
            api.insertFace({ downloadId: dl, x: i, y: 0, w: 1, h: 1, embeddingBlob: blob });
        }
        const seen = [...api.iterateAllFaces({ chunkSize: 3 })].map((r) => r.x);
        expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('stores exif_oriented as 1 or NULL', () => {
        const dl = add('photo', 'g.jpg');
        const blob = Buffer.from(new Float32Array([1, 0]).buffer);
        api.insertFace({
            downloadId: dl,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            embeddingBlob: blob,
            exifOriented: true,
        });
        api.insertFace({ downloadId: dl, x: 1, y: 0, w: 1, h: 1, embeddingBlob: blob });
        const rows = db.prepare('SELECT exif_oriented FROM faces ORDER BY id').all();
        expect(rows.map((r) => r.exif_oriented)).toEqual([1, null]);
    });
});
