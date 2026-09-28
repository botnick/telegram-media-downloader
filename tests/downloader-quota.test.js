// Disk-quota usage (DownloadManager.getDiskUsage) against a throwaway
// TGDL_DATA_DIR: the persisted counter must come back down after deletes,
// without counting dedup-shared files twice.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-quota-'));

let db;
let dbApi;
let DownloadManager;
let _msg = 0;

function addRow(size, filePath) {
    _msg += 1;
    return dbApi.insertDownload({
        groupId: '-100900',
        groupName: 'Quota',
        messageId: _msg,
        fileName: path.basename(filePath),
        fileSize: size,
        fileType: 'video',
        filePath,
    });
}

function manager(counter) {
    dbApi.kvSet('disk_usage', { size: counter, lastScan: Date.now() });
    return new DownloadManager(null, { diskManagement: { maxTotalSize: '1KB' } });
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    ({ DownloadManager } = await import('../src/core/downloader.js'));
});

beforeEach(() => {
    db.prepare('DELETE FROM downloads').run();
});

afterAll(() => {
    vi.useRealTimers();
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('DownloadManager.getDiskUsage', () => {
    it('drops a lifetime counter to the catalogue total after deletes', async () => {
        addRow(300, 'Quota/videos/a.mp4');
        addRow(500, 'Quota/videos/b.mp4');
        // 5 000 bytes downloaded over the install's lifetime, most since deleted.
        const m = manager(5000);
        expect(await m.getDiskUsage()).toBe(800);
        expect(dbApi.kvGet('disk_usage').size).toBe(800);
    });

    it('does not count a dedup-shared file twice', async () => {
        // Two rows, one physical 400-byte file (download-time dedup).
        addRow(400, 'Quota/videos/shared.mp4');
        addRow(400, 'Quota/videos/shared.mp4');
        const m = manager(400);
        expect(await m.getDiskUsage()).toBe(400);
    });

    it('picks up deletes within a minute and counts new bytes immediately', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
        const { lastInsertRowid } = addRow(900, 'Quota/videos/big.mp4');
        addRow(100, 'Quota/videos/small.mp4');
        const m = manager(1000);
        expect(await m.getDiskUsage()).toBe(1000);

        db.prepare('DELETE FROM downloads WHERE id = ?').run(lastInsertRowid);
        // Cached catalogue total — no re-query inside the minute.
        expect(await m.getDiskUsage()).toBe(1000);
        vi.setSystemTime(new Date(2026, 0, 1, 12, 1, 1));
        expect(await m.getDiskUsage()).toBe(100);

        m.incrementDiskUsage(250);
        clearTimeout(m._saveTimeout);
        expect(await m.getDiskUsage()).toBe(350);
        vi.useRealTimers();
    });
});
