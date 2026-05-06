// Backup queue — enqueue / claim / retry / max-attempts giveup against a
// throwaway TGDL_DATA_DIR.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-backup-q-'));

let db;
let queue;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbMod = await import('../src/core/db.js');
    db = dbMod.getDb();
    queue = await import('../src/core/backup/queue.js');
    // Seed a destination row so the FK is satisfied.
    db.prepare(`
        INSERT INTO backup_destinations (
            name, provider, config_blob, enabled, encryption, mode, created_at
        )
        VALUES ('test', 'local', ?, 1, 0, 'mirror', ?)
    `).run(Buffer.from([1, 2, 3]), Date.now());
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('backup/queue', () => {
    it('enqueue → claim → markDone is a clean cycle', () => {
        const id = queue.enqueue({
            destinationId: 1,
            snapshotPath: '/tmp/a.tar.gz',
            remotePath: 'snapshots/a.tar.gz',
        });
        expect(typeof id).toBe('number');
        const job = queue.claim(1);
        expect(job).not.toBeNull();
        expect(job.id).toBe(id);
        expect(job.status).toBe('uploading');
        expect(job.attempts).toBe(1);
        const changed = queue.markDone(job.id, { bytes: 1024 });
        expect(changed).toBe(1);
        // Nothing left to claim.
        expect(queue.claim(1)).toBeNull();
    });

    it('markRetry sets next_retry_at into the future, claim() respects the window', () => {
        const id = queue.enqueue({ destinationId: 1, snapshotPath: '/tmp/b.tar.gz' });
        const job = queue.claim(1);
        expect(job.id).toBe(id);
        const r = queue.markRetry(job.id, 'connection refused');
        expect(r.willRetry).toBe(true);
        expect(r.nextRetryAt).toBeGreaterThan(Date.now());
        // Immediate claim should NOT find the job — it's pending but the
        // backoff hasn't elapsed.
        expect(queue.claim(1)).toBeNull();
        // Pretending time has passed reveals it again.
        const job2 = queue.claim(1, r.nextRetryAt + 1);
        expect(job2).not.toBeNull();
        expect(job2.id).toBe(id);
        expect(job2.attempts).toBe(2);
    });

    it('gives up after max_attempts is hit', () => {
        const id = queue.enqueue({
            destinationId: 1,
            snapshotPath: '/tmp/c.tar.gz',
            maxAttempts: 2,
        });
        // Attempt 1
        let job = queue.claim(1);
        let r = queue.markRetry(job.id, 'fail #1');
        expect(r.willRetry).toBe(true);
        // Attempt 2 — at this point attempts=2 == max_attempts, so the
        // *next* failure should give up.
        job = queue.claim(1, r.nextRetryAt + 1);
        r = queue.markRetry(job.id, 'fail #2');
        expect(r.willRetry).toBe(false);
        // Row is now `failed`.
        const row = queue.getJob(id);
        expect(row.status).toBe('failed');
        expect(row.error).toBe('fail #2');
    });

    it('recoverInflight resets stuck uploading rows on boot', () => {
        const id = queue.enqueue({ destinationId: 1, snapshotPath: '/tmp/d.tar.gz' });
        queue.claim(1);
        // Simulate a crash mid-upload — the row stays `uploading`.
        let row = queue.getJob(id);
        expect(row.status).toBe('uploading');
        const fixed = queue.recoverInflight(1);
        expect(fixed).toBeGreaterThanOrEqual(1);
        row = queue.getJob(id);
        expect(row.status).toBe('pending');
    });

    it('hasJobForDownload reports presence of a per-download mirror row', () => {
        // Insert a download to FK against, then enqueue a mirror job for it.
        db.prepare(`INSERT INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path)
                    VALUES ('-100123', 999, 'x.jpg', 100, 'photo', 'path/x.jpg')`).run();
        const dlRow = db.prepare('SELECT id FROM downloads WHERE message_id = 999').get();
        expect(queue.hasJobForDownload(1, dlRow.id)).toBe(false);
        queue.enqueue({ destinationId: 1, downloadId: dlRow.id });
        expect(queue.hasJobForDownload(1, dlRow.id)).toBe(true);
    });
});
