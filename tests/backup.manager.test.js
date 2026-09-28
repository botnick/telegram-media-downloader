// Backup manager — mirror catch-up, worker failure handling, snapshot
// retention and destination edits, against a throwaway TGDL_DATA_DIR and
// the local-filesystem provider.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backup-mgr-'));
const REMOTE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backup-remote-'));
const SECRET = crypto.randomBytes(32).toString('hex');
// Feb 31st — the snapshot cron timer never fires during the test.
const NEVER = '0 0 31 2 *';

let db;
let manager;
let queue;
const events = [];

function waitForEvent(pred, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
            const hit = events.find(pred);
            if (hit) return resolve(hit);
            if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
            setTimeout(poll, 20);
        };
        poll();
    });
}

let _msgId = 0;
function insertDownloads(n, filePathFn) {
    const ins = db.prepare(`
        INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path)
        VALUES ('-100777', ?, ?, 10, 'photo', ?)
    `);
    const ids = [];
    db.transaction(() => {
        for (let i = 0; i < n; i++) {
            _msgId += 1;
            const name = `f${_msgId}.jpg`;
            ids.push(Number(ins.run(_msgId, name, filePathFn(name)).lastInsertRowid));
        }
    })();
    return ids;
}

function destRow(id) {
    return db.prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id);
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    queue = await import('../src/core/backup/queue.js');
    manager = await import('../src/core/backup/manager.js');
    manager.init({
        getShareSecret: () => SECRET,
        broadcast: (m) => events.push(m),
        log: () => {},
    });
});

afterAll(() => {
    try {
        for (const d of manager.listDestinations()) manager.removeDestination(d.id);
    } catch {}
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(REMOTE_ROOT, { recursive: true, force: true });
});

describe('mirror Run now', () => {
    it('walks more rows than one batch without "connection is busy"', async () => {
        const destId = manager.addDestination({
            name: 'mirror-walk',
            provider: 'local',
            config: { rootPath: path.join(REMOTE_ROOT, 'walk') },
            mode: 'mirror',
        });
        // Keep the worker idle so the assertion only sees the walk.
        manager.pause(destId);
        insertDownloads(1200, (name) => `g/images/${name}`);

        const r = await manager.runBackup(destId);
        expect(r.enqueued).toBe(1200);
        expect(queue.statusCounts(destId).queued).toBe(1200);

        // Idempotent — a second run finds every row already queued.
        const again = await manager.runBackup(destId);
        expect(again.enqueued).toBe(0);
        manager.removeDestination(destId);
    });
});
