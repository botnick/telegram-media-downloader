// Backup manager — mirror catch-up, worker failure handling, snapshot
// retention and destination edits, against a throwaway TGDL_DATA_DIR and
// the local-filesystem provider.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

    it('fails a job whose local file is missing without erroring the destination', async () => {
        const destId = manager.addDestination({
            name: 'mirror-missing',
            provider: 'local',
            config: { rootPath: path.join(REMOTE_ROOT, 'missing') },
            mode: 'mirror',
        });
        manager.pause(destId);
        // Start from an empty library so the walk queues exactly one job.
        db.prepare('DELETE FROM downloads').run();
        const [dlId] = insertDownloads(1, (name) => `g/images/${name}`);
        await manager.runBackup(destId);
        const job = queue.listJobs({ destinationId: destId })[0];
        expect(job.download_id).toBe(dlId);

        manager.resume(destId);
        const err = await waitForEvent((m) => m.type === 'backup_error' && m.jobId === job.id);
        expect(err.willRetry).toBe(false);
        const after = queue.getJob(job.id);
        expect(after.status).toBe('failed');
        expect(after.attempts).toBe(1);
        expect(after.error).toMatch(/local file missing/);
        expect(destRow(destId).last_error).toBeNull();
        manager.removeDestination(destId);
    });

    it('a successful Run now clears a stale error badge', async () => {
        const destId = manager.addDestination({
            name: 'mirror-badge',
            provider: 'local',
            config: { rootPath: path.join(REMOTE_ROOT, 'badge') },
            mode: 'mirror',
        });
        manager.pause(destId);
        db.prepare(
            'UPDATE backup_destinations SET last_error = ?, last_failure_at = ? WHERE id = ?',
        ).run('old failure', Date.now(), destId);
        await manager.runBackup(destId);
        expect(destRow(destId).last_error).toBeNull();
        expect(manager.getDestinationStatus(destId).lastError).toBeNull();
        manager.removeDestination(destId);
    });
});

describe('snapshot retention', () => {
    const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

    function seedRemote(root, rels) {
        for (const [rel, size] of rels) {
            const abs = path.join(root, ...rel.split('/'));
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, Buffer.alloc(size, 1));
        }
    }
    function stageArchive(name, size) {
        fs.mkdirSync(BACKUPS_DIR, { recursive: true });
        const abs = path.join(BACKUPS_DIR, name);
        fs.writeFileSync(abs, Buffer.alloc(size, 2));
        return abs;
    }
    async function upload(destId, localPath) {
        const jobId = queue.enqueue({
            destinationId: destId,
            snapshotPath: localPath,
            remotePath: `snapshots/${path.basename(localPath)}`,
        });
        manager._wake(destId);
        await waitForEvent((m) => m.type === 'backup_done' && m.jobId === jobId);
        return jobId;
    }
    const listRemote = (root) =>
        fs
            .readdirSync(path.join(root, 'snapshots'), { recursive: true })
            .map((p) => p.split(path.sep).join('/'));

    it('prunes old remote snapshots, deletes the staging archive, reconciles counters', async () => {
        const root = path.join(REMOTE_ROOT, 'snap');
        seedRemote(root, [
            ['snapshots/snapshot-20260101-000000.tar.gz', 10],
            ['snapshots/snapshot-20260102-000000.tar.gz', 10],
            ['snapshots/snapshot-20260103-000000.tar.gz', 10],
            ['snapshots/snapshot-20260104-000000.tar.gz', 40],
            ['snapshots/notes.txt', 5],
            ['snapshots/snapshot-manual.tar.gz', 5],
            ['snapshots/old/snapshot-20250101-000000.tar.gz', 5],
        ]);
        const destId = manager.addDestination({
            name: 'snap',
            provider: 'local',
            config: { rootPath: root },
            mode: 'snapshot',
            cron: NEVER,
            retainCount: 2,
        });
        db.prepare(
            'UPDATE backup_destinations SET total_files = 99, total_bytes = 9999 WHERE id = ?',
        ).run(destId);
        const local = stageArchive('snapshot-20260928-120000.tar.gz', 100);
        await upload(destId, local);

        expect(listRemote(root).sort()).toEqual(
            [
                'notes.txt',
                'old',
                'old/snapshot-20250101-000000.tar.gz',
                'snapshot-20260104-000000.tar.gz',
                'snapshot-20260928-120000.tar.gz',
                'snapshot-manual.tar.gz',
            ].sort(),
        );
        expect(fs.existsSync(local)).toBe(false);
        const row = destRow(destId);
        expect(row.total_files).toBe(2);
        expect(row.total_bytes).toBe(140);
        manager.removeDestination(destId);
    });

    it('keeps a staging archive another destination still has queued', async () => {
        const root = path.join(REMOTE_ROOT, 'shared');
        const destId = manager.addDestination({
            name: 'snap-a',
            provider: 'local',
            config: { rootPath: root },
            mode: 'snapshot',
            cron: NEVER,
            retainCount: 2,
        });
        const otherId = manager.addDestination({
            name: 'snap-b',
            provider: 'local',
            config: { rootPath: path.join(REMOTE_ROOT, 'shared-b') },
            mode: 'snapshot',
            cron: NEVER,
        });
        manager.pause(otherId);
        const local = stageArchive('snapshot-20260928-130000.tar.gz', 50);
        queue.enqueue({ destinationId: otherId, snapshotPath: local, remotePath: 'snapshots/x' });
        await upload(destId, local);

        expect(fs.existsSync(path.join(root, 'snapshots', path.basename(local)))).toBe(true);
        expect(fs.existsSync(local)).toBe(true);
        manager.removeDestination(destId);
        manager.removeDestination(otherId);
    });

    it('leaves manual destinations alone', async () => {
        const root = path.join(REMOTE_ROOT, 'manual');
        seedRemote(root, [
            ['snapshots/snapshot-20260101-000000.tar.gz', 10],
            ['snapshots/snapshot-20260102-000000.tar.gz', 10],
        ]);
        const destId = manager.addDestination({
            name: 'manual',
            provider: 'local',
            config: { rootPath: root },
            mode: 'manual',
            retainCount: 1,
        });
        const local = stageArchive('snapshot-20260928-140000.tar.gz', 30);
        await upload(destId, local);

        expect(listRemote(root)).toHaveLength(3);
        expect(fs.existsSync(local)).toBe(true);
        expect(destRow(destId).total_files).toBe(1);
        manager.removeDestination(destId);
    });
});

describe('snapshot schedule', () => {
    it('builds one snapshot per matching cron minute', async () => {
        // Only the 30 s interval + the clock are faked; archive building
        // and the polling below use real timers.
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        try {
            vi.setSystemTime(new Date(2026, 8, 28, 2, 59, 50));
            const destId = manager.addDestination({
                name: 'cron',
                provider: 'local',
                config: { rootPath: path.join(REMOTE_ROOT, 'cron') },
                mode: 'snapshot',
                cron: '0 3 * * *',
            });
            manager.pause(destId);
            const jobs = () => queue.listJobs({ destinationId: destId }).length;
            // Resolves once cond() holds, or after timeoutMs either way.
            const settle = async (cond, timeoutMs) => {
                const end = performance.now() + timeoutMs;
                while (!cond() && performance.now() < end) {
                    await new Promise((r) => setTimeout(r, 25));
                }
            };

            vi.advanceTimersByTime(30_000); // 03:00:20 — due
            await settle(() => jobs() > 0, 5000);
            expect(jobs()).toBe(1);
            vi.advanceTimersByTime(30_000); // 03:00:50 — same minute
            await settle(() => jobs() > 1, 1500);
            expect(jobs()).toBe(1);
            vi.advanceTimersByTime(60_000); // 03:01:50 — not due
            await settle(() => jobs() > 1, 500);
            expect(jobs()).toBe(1);
            manager.removeDestination(destId);
        } finally {
            vi.useRealTimers();
        }
    });
});
