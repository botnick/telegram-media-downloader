// Persistent backup-job queue.
//
// Jobs are SQLite rows in `backup_jobs`. The manager calls into this
// module from two sides:
//
//   - producer side (download_complete hook, snapshot creator,
//                    POST /run handlers) → enqueue()
//   - consumer side (per-destination worker)              → claim() /
//                                                            markDone() /
//                                                            markFailed() /
//                                                            markRetry()
//
// The DB is the single source of truth. Restarting the server picks
// every pending / uploading row back up because the worker startup
// sweep resets `uploading` rows that were claimed by a previous boot to
// `pending`. No in-memory queue, no lost jobs.

import { getDb } from '../db.js';

/**
 * Insert a new pending job.
 *
 * @param {object} args
 * @param {number} args.destinationId
 * @param {number|null} [args.downloadId]
 * @param {string|null} [args.snapshotPath]   absolute path of an archive
 *                                            to upload (snapshot mode)
 * @param {string|null} [args.remotePath]     pre-computed remote target
 * @param {number}      [args.maxAttempts=5]
 * @returns {number} new job id
 */
export function enqueue(args) {
    const r = getDb().prepare(`
        INSERT INTO backup_jobs (
            destination_id, download_id, snapshot_path,
            status, attempts, max_attempts, next_retry_at, remote_path
        )
        VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?)
    `).run(
        Number(args.destinationId),
        args.downloadId == null ? null : Number(args.downloadId),
        args.snapshotPath || null,
        Number(args.maxAttempts) || 5,
        args.remotePath || null,
    );
    return r.lastInsertRowid;
}

/**
 * Atomically pick the next runnable job for a destination and flip its
 * status to `uploading`. Returns the row, or null when no work is ready.
 *
 * "Runnable" = `status='pending'` AND (`next_retry_at IS NULL` OR
 * `next_retry_at <= now`). Oldest first.
 *
 * @param {number} destinationId
 * @param {number} [now=Date.now()]
 */
export function claim(destinationId, now = Date.now()) {
    const db = getDb();
    const tx = db.transaction((destId, t) => {
        const row = db.prepare(`
            SELECT * FROM backup_jobs
             WHERE destination_id = ?
               AND status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= ?)
             ORDER BY id ASC
             LIMIT 1
        `).get(destId, t);
        if (!row) return null;
        db.prepare(`
            UPDATE backup_jobs
               SET status = 'uploading',
                   started_at = ?,
                   attempts = attempts + 1
             WHERE id = ?
        `).run(t, row.id);
        return { ...row, status: 'uploading', started_at: t, attempts: (row.attempts || 0) + 1 };
    });
    return tx(Number(destinationId), Number(now));
}

/**
 * Mark a job complete.
 *
 * @param {number} jobId
 * @param {object} [meta]
 * @param {number} [meta.bytes]      bytes uploaded
 * @param {string} [meta.remotePath] final remote path (overrides claim-time value)
 */
export function markDone(jobId, meta = {}) {
    const r = getDb().prepare(`
        UPDATE backup_jobs
           SET status = 'done',
               finished_at = ?,
               bytes_uploaded = COALESCE(?, bytes_uploaded),
               remote_path = COALESCE(?, remote_path),
               error = NULL,
               next_retry_at = NULL
         WHERE id = ?
    `).run(
        Date.now(),
        meta.bytes == null ? null : Number(meta.bytes),
        meta.remotePath || null,
        Number(jobId),
    );
    return r.changes;
}

/**
 * Mark a job permanently failed. Use after `attempts >= max_attempts`
 * — `markRetry` should be preferred for transient errors that should
 * trigger another attempt.
 */
export function markFailed(jobId, error) {
    return getDb().prepare(`
        UPDATE backup_jobs
           SET status = 'failed',
               finished_at = ?,
               error = ?,
               next_retry_at = NULL
         WHERE id = ?
    `).run(Date.now(), String(error || '').slice(0, 4000), Number(jobId)).changes;
}

/**
 * Mark a job to retry later. Computes the next backoff window from
 * `attempts` (already incremented by claim()).
 *
 * Backoff: `2 ** attempts` seconds, capped at 30 minutes. So a job
 * that's hit 1 failure retries in 2 s, 2 failures → 4 s, 5 → 32 s,
 * 10 → 17 min, 11+ → 30 min.
 */
export function markRetry(jobId, error, now = Date.now()) {
    const row = getDb().prepare(
        'SELECT attempts, max_attempts FROM backup_jobs WHERE id = ?',
    ).get(Number(jobId));
    if (!row) return { changes: 0, willRetry: false, nextRetryAt: 0 };
    if ((row.attempts || 0) >= (row.max_attempts || 5)) {
        markFailed(jobId, error);
        return { changes: 1, willRetry: false, nextRetryAt: 0 };
    }
    const backoffMs = Math.min(30 * 60 * 1000, (2 ** (row.attempts || 1)) * 1000);
    const nextRetryAt = now + backoffMs;
    const r = getDb().prepare(`
        UPDATE backup_jobs
           SET status = 'pending',
               error = ?,
               next_retry_at = ?,
               started_at = NULL
         WHERE id = ?
    `).run(
        String(error || '').slice(0, 4000),
        nextRetryAt,
        Number(jobId),
    );
    return { changes: r.changes, willRetry: true, nextRetryAt };
}

/**
 * Reset a `failed` (or stuck `uploading`) job back to pending so the
 * worker picks it up on the next tick. Manual retry path.
 */
export function requeue(jobId) {
    return getDb().prepare(`
        UPDATE backup_jobs
           SET status = 'pending',
               attempts = 0,
               next_retry_at = NULL,
               error = NULL,
               started_at = NULL,
               finished_at = NULL
         WHERE id = ?
    `).run(Number(jobId)).changes;
}

/**
 * Delete every `done` / `failed` / `skipped` job older than `olderThanMs`
 * for a destination. Used by the manager's per-destination GC pass to
 * keep the table small.
 */
export function gcFinished(destinationId, olderThanMs = 30 * 86400 * 1000) {
    return getDb().prepare(`
        DELETE FROM backup_jobs
         WHERE destination_id = ?
           AND status IN ('done', 'failed', 'skipped')
           AND finished_at IS NOT NULL
           AND finished_at < ?
    `).run(Number(destinationId), Date.now() - olderThanMs).changes;
}

/**
 * Boot-time recovery: any row left in `uploading` after a crash gets
 * flipped back to `pending` so the worker picks it up. The retry
 * counter stays — three crashes in a row will eventually surface as
 * "failed" rather than spinning forever.
 */
export function recoverInflight(destinationId) {
    return getDb().prepare(`
        UPDATE backup_jobs
           SET status = 'pending',
               started_at = NULL
         WHERE destination_id = ?
           AND status = 'uploading'
    `).run(Number(destinationId)).changes;
}

/** Counters for the destination-status endpoint. */
export function statusCounts(destinationId, now = Date.now()) {
    const db = getDb();
    const dayAgo = now - 86400 * 1000;
    const queued = db.prepare(
        `SELECT COUNT(*) AS n FROM backup_jobs WHERE destination_id = ? AND status = 'pending'`,
    ).get(Number(destinationId)).n;
    const processing = db.prepare(
        `SELECT COUNT(*) AS n FROM backup_jobs WHERE destination_id = ? AND status = 'uploading'`,
    ).get(Number(destinationId)).n;
    const completed24h = db.prepare(
        `SELECT COUNT(*) AS n FROM backup_jobs
         WHERE destination_id = ? AND status = 'done'
           AND finished_at IS NOT NULL AND finished_at > ?`,
    ).get(Number(destinationId), dayAgo).n;
    const failed24h = db.prepare(
        `SELECT COUNT(*) AS n FROM backup_jobs
         WHERE destination_id = ? AND status = 'failed'
           AND finished_at IS NOT NULL AND finished_at > ?`,
    ).get(Number(destinationId), dayAgo).n;
    return { queued, processing, completed24h, failed24h };
}

/** List jobs for the dashboard. */
export function listJobs({ destinationId = null, status = null, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (destinationId != null) { where.push('destination_id = ?'); params.push(Number(destinationId)); }
    if (status) { where.push('status = ?'); params.push(String(status)); }
    const sql = `
        SELECT * FROM backup_jobs
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
    `;
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    return getDb().prepare(sql).all(...params, lim, off);
}

/** Recent activity strip across every destination for the UI footer. */
export function listRecent(limit = 20) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 20));
    return getDb().prepare(`
        SELECT j.*, d.name AS destination_name, d.provider
          FROM backup_jobs j
          JOIN backup_destinations d ON d.id = j.destination_id
         ORDER BY COALESCE(j.finished_at, j.started_at, j.id) DESC
         LIMIT ?
    `).all(lim);
}

/** Single row by id — used by the retry endpoint. */
export function getJob(jobId) {
    return getDb().prepare('SELECT * FROM backup_jobs WHERE id = ?').get(Number(jobId));
}

/**
 * True if a job already exists for (destination, download). Used by
 * the download_complete hook to keep mirror jobs idempotent — running
 * a Re-index from disk shouldn't enqueue a backup job for every row
 * a second time.
 */
export function hasJobForDownload(destinationId, downloadId) {
    if (downloadId == null) return false;
    const r = getDb().prepare(`
        SELECT 1 FROM backup_jobs
         WHERE destination_id = ? AND download_id = ?
         LIMIT 1
    `).get(Number(destinationId), Number(downloadId));
    return !!r;
}
