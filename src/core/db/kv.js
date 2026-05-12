import { randomUUID } from 'crypto';
import { getDb } from '../db.js';

const _stmtCache = new Map();
function _prep(sql) {
    let s = _stmtCache.get(sql);
    if (!s) {
        s = getDb().prepare(sql);
        _stmtCache.set(sql, s);
    }
    return s;
}

// ---- KV blob store --------------------------------------------------------
//
// Generic key/value persistence that replaces the old data/*.json files.
// Values are arbitrary JSON; everything is round-tripped through
// JSON.stringify / JSON.parse so callers see real objects, not strings.
// kvSet wraps the upsert in a transaction so a partial write can never
// land — same atomicity guarantee the previous tmp+rename pattern gave us.

export function kvGet(key) {
    const row = _prep('SELECT value FROM kv WHERE key = ?').get(String(key));
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch {
        // Corrupt row — surface as null so the caller falls back to defaults
        // rather than crashing the whole boot path.
        return null;
    }
}

export function kvSet(key, value) {
    const json = JSON.stringify(value);
    const now = Date.now();
    const stmt = _prep(`
        INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    // better-sqlite3 throws `This database connection is busy executing
    // a query` when a long-running `.iterate()` holds the connection
    // while `kvSet` writes. The root cause is upstream — see
    // `iterateAllFaces` (now using `.all()` instead). Keep a defensive
    // 4-attempt retry with a sync sleep here for the remaining iter
    // call-sites (integrity sweep, dedup sweep) that legitimately stream
    // through high-cardinality tables; without it those sweeps could
    // race a UI save and surface a confusing toast to the operator.
    const RETRIES = 4;
    const BACKOFF_MS = 50;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
            getDb().transaction(() => {
                stmt.run(String(key), json, now);
            })();
            return;
        } catch (e) {
            const msg = String(e?.message || e);
            const busy =
                msg.includes('database connection is busy') ||
                msg.includes('SQLITE_BUSY') ||
                e?.code === 'SQLITE_BUSY';
            if (!busy || attempt === RETRIES - 1) throw e;
            const buf = new SharedArrayBuffer(4);
            Atomics.wait(new Int32Array(buf), 0, 0, BACKOFF_MS);
        }
    }
}

export function kvDelete(key) {
    return _prep('DELETE FROM kv WHERE key = ?').run(String(key)).changes;
}

export function kvList() {
    // KV is small in practice (config + a handful of progress / cache rows)
    // but explicit LIMIT is defence-in-depth — see CLAUDE.md "Big-data
    // patterns". Iterator drains row-by-row so a future runaway writer
    // can't blow the JS heap in a single `.all()`.
    const out = {};
    const iter = _prep('SELECT key, value FROM kv LIMIT 10000').iterate();
    for (const r of iter) {
        try {
            out[r.key] = JSON.parse(r.value);
        } catch {
            /* skip corrupt row */
        }
    }
    return out;
}

// ---- Spilled-queue backlog ------------------------------------------------
//
// Replaces data/logs/queue_backlog.jsonl. The downloader spills queued jobs
// here when the in-memory lane size crosses `advanced.downloader.spilloverThreshold`,
// and rehydrates from here when worker capacity frees up. SQLite gives us
// atomic appends, indexed FIFO reads, and a clean DELETE-after-pop tx so a
// crash mid-rehydrate can't lose or double-deliver a job.

export function pushQueueBacklog(job) {
    const stmt = _prep(`
        INSERT INTO queue_backlog (job, created_at) VALUES (?, ?)
    `);
    stmt.run(JSON.stringify(job), Date.now());
}

/**
 * Pop up to `limit` jobs FIFO. Returns the parsed job objects in insertion
 * order. The SELECT + DELETE happen in one transaction so a concurrent
 * worker (rare; we only have one downloader) couldn't take the same row
 * twice.
 */
export function popQueueBacklog(limit = 1000) {
    const lim = Math.max(1, Math.min(10000, Number(limit) || 1000));
    const select = _prep('SELECT id, job FROM queue_backlog ORDER BY id ASC LIMIT ?');
    const del = _prep('DELETE FROM queue_backlog WHERE id = ?');
    const out = [];
    getDb().transaction(() => {
        const rows = select.all(lim);
        for (const r of rows) {
            try {
                out.push(JSON.parse(r.job));
            } catch {
                /* corrupt row — drop it */
            }
            del.run(r.id);
        }
    })();
    return out;
}

export function queueBacklogSize() {
    const r = _prep('SELECT COUNT(1) AS n FROM queue_backlog').get();
    return Number(r?.n) || 0;
}

export function clearQueueBacklog() {
    return _prep('DELETE FROM queue_backlog').run().changes;
}

// ---- Auto-update audit ---------------------------------------------------
//
// Every /api/update click writes one row. The audit row is INSERTed up
// front in status='triggered' BEFORE any work; pre-flight failures
// UPDATE it to 'failed' in place. The new container's boot path
// promotes 'triggered' rows to 'success' when it observes either a
// version change OR an instance_id change.

const UPDATE_STATUS_PENDING = 'pending'; // reserved — not used by the active flow
const UPDATE_STATUS_TRIGGERED = 'triggered';
const UPDATE_STATUS_SUCCESS = 'success';
const UPDATE_STATUS_FAILED = 'failed';
const UPDATE_STATUS_STALLED = 'stalled';

// `triggered` rows older than this without a matching version/instance_id
// change are considered stalled. Default 10 min covers every healthy
// watchtower pull + recreate cycle; tunable via UPDATE_STALL_AFTER_MS for
// operators on slow disks / thin links.
const UPDATE_STALL_AFTER_MS = (() => {
    const raw = Number(process.env.UPDATE_STALL_AFTER_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();

const BOOT_INSTANCE_ID_KEY = 'boot_instance_id';
let _bootInstanceId = null;

/**
 * Generate a fresh UUIDv4, persist it to kv['boot_instance_id'], and
 * cache it for in-process reads. Called exactly once per process during
 * getDb() bootstrap; subsequent reads come from the cached value.
 */
export function _rotateBootInstanceId() {
    const id = randomUUID();
    kvSet(BOOT_INSTANCE_ID_KEY, id);
    _bootInstanceId = id;
    return id;
}

/**
 * Read the current process's boot instance ID. Lazy-loaded from kv on
 * the first call after bootstrap; should normally just return the
 * cached value populated by _rotateBootInstanceId().
 */
export function getBootInstanceId() {
    if (_bootInstanceId) return _bootInstanceId;
    try {
        const v = kvGet(BOOT_INSTANCE_ID_KEY);
        if (typeof v === 'string' && v.length > 0) {
            _bootInstanceId = v;
            return v;
        }
    } catch {
        /* db not ready yet — caller should retry post-getDb() */
    }
    return null;
}

/**
 * Record a fresh update attempt up front. INSERTs a 'triggered' row
 * with the click-time metadata and returns the row id; the caller
 * either finalises it via finaliseSuccessfulTrigger() (after watchtower
 * acks) or recordUpdateFailure() (on any pre-flight failure).
 */
export function recordUpdateAttempt({
    fromVersion,
    fromInstanceId = null,
    backupPath = null,
    backupBytes = null,
} = {}) {
    const r = _prep(`
        INSERT INTO update_history
          (from_version, from_instance_id, started_at, status, backup_path, backup_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        fromVersion ? String(fromVersion) : null,
        fromInstanceId ? String(fromInstanceId) : null,
        Date.now(),
        UPDATE_STATUS_TRIGGERED,
        backupPath,
        backupBytes,
    );
    return Number(r.lastInsertRowid);
}

/**
 * Stamp the snapshot metadata onto a previously-recorded 'triggered'
 * row once the watchtower handoff succeeds. Leaves status='triggered';
 * the boot finaliser will promote to 'success' on the next container
 * recreation.
 */
export function finaliseSuccessfulTrigger({ id, backupPath = null, backupBytes = null } = {}) {
    if (!id) return 0;
    return _prep(`
        UPDATE update_history
           SET backup_path = COALESCE(?, backup_path),
               backup_bytes = COALESCE(?, backup_bytes)
         WHERE id = ?
    `).run(backupPath, backupBytes, id).changes;
}

/**
 * Mark an attempt as failed. Used both for pre-flight failures
 * (watchtower unreachable, DB corrupt, snapshot torn) and post-snapshot
 * trigger failures. UPDATEs in place when an id is supplied; falls back
 * to inserting a fresh failed row when called without one (defensive
 * — should not happen with the up-front recordUpdateAttempt flow).
 *
 * Optional backupPath/backupBytes capture a snapshot that was taken
 * before the failure (e.g. snapshot succeeded but trigger 5xx'd) so
 * the operator can still find the recovery file.
 */
export function recordUpdateFailure({
    id,
    fromVersion,
    fromInstanceId = null,
    errorCode,
    errorMsg,
    backupPath = null,
    backupBytes = null,
} = {}) {
    if (id) {
        _prep(`
            UPDATE update_history
               SET status = ?, finished_at = ?, error_code = ?, error_msg = ?,
                   backup_path = COALESCE(?, backup_path),
                   backup_bytes = COALESCE(?, backup_bytes)
             WHERE id = ?
        `).run(
            UPDATE_STATUS_FAILED,
            Date.now(),
            errorCode || null,
            errorMsg || null,
            backupPath,
            backupBytes,
            id,
        );
        return id;
    }
    const now = Date.now();
    const r = _prep(`
        INSERT INTO update_history
          (from_version, from_instance_id, started_at, finished_at, status,
           error_code, error_msg, backup_path, backup_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        fromVersion ? String(fromVersion) : null,
        fromInstanceId ? String(fromInstanceId) : null,
        now,
        now,
        UPDATE_STATUS_FAILED,
        errorCode || null,
        errorMsg || null,
        backupPath,
        backupBytes,
    );
    return Number(r.lastInsertRowid);
}

/**
 * Walks every `triggered` row and:
 *
 *   - Stamps it `success` with `to_version = currentVersion` if EITHER
 *     the current package version differs from the row's from_version
 *     OR the current boot_instance_id differs from the row's
 *     from_instance_id (= watchtower recreated us as expected, even on
 *     same-semver `:latest` rebuilds).
 *   - Stamps it `stalled` if neither has changed AND the row is older
 *     than UPDATE_STALL_AFTER_MS (= watchtower acked but never recreated
 *     us, OR we crash-restarted with the same image).
 *   - Leaves it alone otherwise (recently triggered, may still complete).
 *
 * Idempotent — safe to call repeatedly. Invoked once at boot and lazily
 * on every status/history GET so stalled rows surface even when the
 * container hasn't restarted.
 *
 * Returns `{ promoted, stalled }` for logging.
 */
export function finalisePendingUpdates(currentVersion, currentInstanceId = null) {
    const now = Date.now();
    const rows = _prep(
        `SELECT id, from_version, from_instance_id, started_at FROM update_history WHERE status = ?`,
    ).all(UPDATE_STATUS_TRIGGERED);
    let promoted = 0;
    let stalled = 0;
    const promoteStmt = _prep(`
        UPDATE update_history
           SET status = ?, finished_at = ?, to_version = ?
         WHERE id = ?
    `);
    const stallStmt = _prep(`
        UPDATE update_history
           SET status = ?, finished_at = ?, error_code = ?, error_msg = ?
         WHERE id = ?
    `);
    for (const r of rows) {
        const movedVersion =
            currentVersion && r.from_version && String(currentVersion) !== String(r.from_version);
        const movedInstance =
            currentInstanceId &&
            r.from_instance_id &&
            String(currentInstanceId) !== String(r.from_instance_id);
        if (movedVersion || movedInstance) {
            promoteStmt.run(
                UPDATE_STATUS_SUCCESS,
                now,
                currentVersion ? String(currentVersion) : null,
                r.id,
            );
            promoted += 1;
            continue;
        }
        if (now - Number(r.started_at) > UPDATE_STALL_AFTER_MS) {
            stallStmt.run(
                UPDATE_STATUS_STALLED,
                now,
                'STALL_TIMEOUT',
                `Container did not recreate within ${Math.round(UPDATE_STALL_AFTER_MS / 60000)} min; watchtower swap likely never completed.`,
                r.id,
            );
            stalled += 1;
        }
    }
    return { promoted, stalled };
}

/**
 * Read the most recent N update-history rows (newest first). Used by
 * /api/update/history.
 */
export function listUpdateHistory({ limit = 25 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 25));
    return _prep(`
        SELECT id, from_version, to_version, from_instance_id, started_at, finished_at,
               status, error_code, error_msg, backup_path, backup_bytes
          FROM update_history
         ORDER BY id DESC
         LIMIT ?
    `).all(lim);
}

// ---- Dashboard sessions ---------------------------------------------------
//
// Replaces the in-memory map + data/web-sessions.json file in core/web-auth.
// Each accessor maps 1:1 to the previous public method on web-auth so the
// caller surface stays unchanged.

export function insertSession({ token, role, expiresAt, issuedAt = Date.now() }) {
    if (role !== 'admin' && role !== 'guest') {
        throw new Error(`insertSession: invalid role ${role}`);
    }
    _prep(`
        INSERT INTO web_sessions (token, role, issued_at, expires_at, last_seen)
        VALUES (?, ?, ?, ?, ?)
    `).run(String(token), role, Number(issuedAt), Number(expiresAt), Number(issuedAt));
}

export function findSession(token) {
    const row = _prep(
        'SELECT token, role, issued_at, expires_at, last_seen FROM web_sessions WHERE token = ?',
    ).get(String(token));
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
        // Self-clean expired tokens at lookup time so a stale row never
        // satisfies a request even if the GC hasn't run yet.
        deleteSession(token);
        return null;
    }
    return {
        token: row.token,
        role: row.role,
        issuedAt: Number(row.issued_at),
        expiresAt: Number(row.expires_at),
        lastSeen: Number(row.last_seen),
    };
}

export function touchSession(token) {
    _prep('UPDATE web_sessions SET last_seen = ? WHERE token = ?').run(Date.now(), String(token));
}

export function deleteSession(token) {
    return _prep('DELETE FROM web_sessions WHERE token = ?').run(String(token)).changes;
}

export function deleteAllSessions() {
    return _prep('DELETE FROM web_sessions').run().changes;
}

export function deleteSessionsByRole(role) {
    if (role !== 'admin' && role !== 'guest') {
        throw new Error(`deleteSessionsByRole: invalid role ${role}`);
    }
    return _prep('DELETE FROM web_sessions WHERE role = ?').run(role).changes;
}

export function deleteExpiredSessions(nowMs = Date.now()) {
    return _prep('DELETE FROM web_sessions WHERE expires_at <= ?').run(Number(nowMs)).changes;
}

export function listSessions() {
    return _prep(
        'SELECT token, role, issued_at, expires_at, last_seen FROM web_sessions ORDER BY issued_at DESC LIMIT 10000',
    ).all();
}
