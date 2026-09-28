// Download-time dedup makes several downloads rows point at ONE physical
// file (the later download is dropped and its row re-uses the existing
// path). Deleting a row must never delete a file another row still uses,
// and the duplicate finder must treat rows sharing a file as one copy.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-dedup-shared-'));
const DL = path.join(DATA_DIR, 'downloads');

let db;
let dbApi;
let dedup;
let msg = 1;

function writeFile(rel, content) {
    const abs = path.join(DL, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

function addRow(groupId, rel, content, createdAt) {
    const buf = Buffer.from(content);
    dbApi.insertDownload({
        groupId,
        groupName: `G${groupId}`,
        messageId: msg++,
        fileName: path.basename(rel),
        fileSize: buf.length,
        fileType: 'photo',
        filePath: rel,
        fileHash: crypto.createHash('sha256').update(buf).digest('hex'),
    });
    const id = db.prepare('SELECT MAX(id) AS id FROM downloads').get().id;
    db.prepare('UPDATE downloads SET created_at = ? WHERE id = ?').run(createdAt, id);
    return id;
}

const exists = (rel) => fs.existsSync(path.join(DL, rel));
const rowIds = () =>
    db
        .prepare('SELECT id FROM downloads ORDER BY id')
        .all()
        .map((r) => r.id);

beforeEach(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    if (!db) {
        vi.resetModules();
        dbApi = await import('../src/core/db.js');
        dedup = await import('../src/core/dedup.js');
        db = dbApi.getDb();
    }
    db.prepare('DELETE FROM downloads').run();
    fs.rmSync(DL, { recursive: true, force: true });
});

afterAll(() => {
    db?.close();
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('shared physical files', () => {
    it('does not report rows that already share one file as duplicates', async () => {
        writeFile('g1/x.jpg', 'same bytes');
        addRow('1', 'g1/x.jpg', 'same bytes', 1);
        addRow('2', 'g1/x.jpg', 'same bytes', 2); // download-time dedup ref
        const r = await dedup.findDuplicates();
        expect(r.duplicateSets).toEqual([]);
    });

    it('lists one entry per physical copy', async () => {
        writeFile('g1/x.jpg', 'same bytes');
        writeFile('g3/y.jpg', 'same bytes');
        const a = addRow('1', 'g1/x.jpg', 'same bytes', 1);
        addRow('2', 'g1/x.jpg', 'same bytes', 2);
        const c = addRow('3', 'g3/y.jpg', 'same bytes', 3);
        const r = await dedup.findDuplicates();
        expect(r.duplicateSets).toHaveLength(1);
        const set = r.duplicateSets[0];
        expect(set.count).toBe(2);
        expect(set.files.map((f) => f.id)).toEqual([a, c]);
    });

    it('deleting a row keeps a file that another row still uses', () => {
        writeFile('g1/x.jpg', 'same bytes');
        const a = addRow('1', 'g1/x.jpg', 'same bytes', 1);
        const b = addRow('2', 'g1/x.jpg', 'same bytes', 2);
        const res = dedup.deleteByIds([b]);
        expect(exists('g1/x.jpg')).toBe(true);
        expect(rowIds()).toEqual([a]);
        expect(res.removed).toBe(1);
        expect(res.freedBytes).toBe(0);
    });

    it('deletes the file once every row using it is deleted', () => {
        writeFile('g1/x.jpg', 'same bytes');
        const a = addRow('1', 'g1/x.jpg', 'same bytes', 1);
        const b = addRow('2', 'g1/x.jpg', 'same bytes', 2);
        const res = dedup.deleteByIds([a, b]);
        expect(exists('g1/x.jpg')).toBe(false);
        expect(rowIds()).toEqual([]);
        expect(res.freedBytes).toBe(Buffer.byteLength('same bytes'));
    });

    it('removing a duplicate copy frees it and drops every row using it, keeping the other copy', async () => {
        writeFile('g1/x.jpg', 'same bytes');
        writeFile('g3/y.jpg', 'same bytes');
        const a = addRow('1', 'g1/x.jpg', 'same bytes', 1);
        const b = addRow('2', 'g1/x.jpg', 'same bytes', 2);
        const c = addRow('3', 'g3/y.jpg', 'same bytes', 3);
        addRow('4', 'g3/y.jpg', 'same bytes', 4); // shares y with c

        // Duplicates page default: keep the oldest copy (x), delete the rest.
        const set = (await dedup.findDuplicates()).duplicateSets[0];
        const toDelete = set.files.filter((f) => f.id !== a).map((f) => f.id);
        expect(toDelete).toEqual([c]);

        const res = dedup.deleteByIds(dedup.expandToSharedRefs(toDelete));
        expect(exists('g1/x.jpg')).toBe(true);
        expect(exists('g3/y.jpg')).toBe(false);
        expect(rowIds()).toEqual([a, b]);
        expect(res.freedBytes).toBe(Buffer.byteLength('same bytes'));
    });

    it('deleting a group folder keeps files other groups still use', async () => {
        writeFile('G1/images/x.jpg', 'shared');
        writeFile('G1/images/z.jpg', 'only g1');
        addRow('1', 'G1/images/x.jpg', 'shared', 1);
        addRow('1', 'G1/images/z.jpg', 'only g1', 2);
        addRow('2', 'G1/images/x.jpg', 'shared', 3); // group 2 reuses x

        const kept = await dedup.removeGroupFolder('1', path.join(DL, 'G1'));
        expect(kept).toBe(1);
        expect(exists('G1/images/x.jpg')).toBe(true);
        expect(exists('G1/images/z.jpg')).toBe(false);
    });

    it('deleting a group folder nobody else uses removes it entirely', async () => {
        writeFile('G1/images/z.jpg', 'only g1');
        addRow('1', 'G1/images/z.jpg', 'only g1', 1);
        expect(await dedup.removeGroupFolder('1', path.join(DL, 'G1'))).toBe(0);
        expect(fs.existsSync(path.join(DL, 'G1'))).toBe(false);
    });
});
