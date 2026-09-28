// The disk rotator and the rescue sweeper delete rows on their own. When
// download-time dedup made another row share the file, only the row may go —
// the file has to stay for the other row.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-shared-sweepers-'));
const DL = path.join(DATA_DIR, 'downloads');

let db;
let dbApi;
let DiskRotator;
let RescueSweeper;
let msg = 1;

function put(rel, content) {
    const abs = path.join(DL, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}
function row(groupId, rel, size, extra = {}) {
    dbApi.insertDownload({
        groupId,
        groupName: `G${groupId}`,
        messageId: msg++,
        fileName: path.basename(rel),
        fileSize: size,
        fileType: 'photo',
        filePath: rel,
        ...extra,
    });
    return db.prepare('SELECT MAX(id) AS id FROM downloads').get().id;
}
const exists = (rel) => fs.existsSync(path.join(DL, rel));
const ids = () =>
    db
        .prepare('SELECT id FROM downloads ORDER BY id')
        .all()
        .map((r) => r.id);

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    vi.resetModules();
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    ({ DiskRotator } = await import('../src/core/disk-rotator.js'));
    ({ RescueSweeper } = await import('../src/core/rescue.js'));
});

afterAll(() => {
    db?.close();
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    db.prepare('DELETE FROM downloads').run();
    fs.rmSync(DL, { recursive: true, force: true });
});

describe('sweepers keep shared files', () => {
    it('disk rotator deletes the oldest row but keeps a file a newer row shares', async () => {
        put('G1/images/x.jpg', 'x'.repeat(100));
        put('G1/images/solo.jpg', 's'.repeat(100));
        const old = row('1', 'G1/images/x.jpg', 100);
        const solo = row('1', 'G1/images/solo.jpg', 100);
        const ref = row('2', 'G1/images/x.jpg', 100); // download-time dedup ref
        db.prepare('UPDATE downloads SET created_at = ? WHERE id = ?').run(1, old);
        db.prepare('UPDATE downloads SET created_at = ? WHERE id = ?').run(2, solo);
        db.prepare('UPDATE downloads SET created_at = ? WHERE id = ?').run(3, ref);

        const rotator = new DiskRotator({
            loadConfig: () => ({ diskManagement: { enabled: true, maxTotalSize: '150B' } }),
        });
        const r = await rotator.sweep();
        expect(r.deleted).toBeGreaterThan(0);
        expect(ids()).not.toContain(old);
        expect(ids()).toContain(ref);
        expect(exists('G1/images/x.jpg')).toBe(true);
    });

    it('rescue sweep drops an expired pending row without deleting a shared file', async () => {
        put('G1/images/x.jpg', 'shared');
        const keep = row('1', 'G1/images/x.jpg', 6);
        const pending = row('2', 'G1/images/x.jpg', 6, { pendingUntil: Date.now() - 1000 });
        const rescue = new RescueSweeper({ loadConfig: () => ({ rescue: { enabled: true } }) });
        await rescue.sweep();
        expect(ids()).toEqual([keep]);
        expect(ids()).not.toContain(pending);
        expect(exists('G1/images/x.jpg')).toBe(true);
    });

    it('rescue sweep still deletes the file of an expired row nobody else uses', async () => {
        put('G3/images/y.jpg', 'alone');
        row('3', 'G3/images/y.jpg', 5, { pendingUntil: Date.now() - 1000 });
        const rescue = new RescueSweeper({ loadConfig: () => ({ rescue: { enabled: true } }) });
        await rescue.sweep();
        expect(ids()).toEqual([]);
        expect(exists('G3/images/y.jpg')).toBe(false);
    });
});
