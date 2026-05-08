// Tests for the update_history audit functions in src/core/db.js.
//
// Covers:
//   - recordUpdateAttempt INSERTs a 'triggered' row and returns the id
//   - finaliseSuccessfulTrigger UPDATEs the row's backup metadata in place
//   - recordUpdateFailure UPDATEs by id (in-place) and INSERTs when no id
//   - finalisePendingUpdates promotes on version OR instance_id change,
//     stalls past the timeout, leaves recent rows alone, idempotent
//   - getBootInstanceId returns a stable per-process value

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-update-hist-test-'));

let db;
let dbApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    // Tighten the stall window so the timeout test doesn't have to wait
    // 10 minutes. Read once at module load — set BEFORE the dynamic import.
    process.env.UPDATE_STALL_AFTER_MS = '5000';
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    delete process.env.UPDATE_STALL_AFTER_MS;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    db.exec('DELETE FROM update_history');
});

// ---- schema sanity --------------------------------------------------------

describe('update_history schema', () => {
    it('has the from_instance_id column', () => {
        const cols = db
            .prepare('PRAGMA table_info(update_history)')
            .all()
            .map((r) => r.name);
        expect(cols).toEqual(
            expect.arrayContaining([
                'from_version',
                'to_version',
                'from_instance_id',
                'started_at',
                'finished_at',
                'status',
                'error_code',
                'error_msg',
                'backup_path',
                'backup_bytes',
            ]),
        );
    });
});

// ---- getBootInstanceId ----------------------------------------------------

describe('getBootInstanceId', () => {
    it('returns a non-empty UUIDv4 stamped at boot', () => {
        const id = dbApi.getBootInstanceId();
        expect(id).toBeTruthy();
        // UUIDv4 shape: 8-4-4-4-12 hex
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('is stable across calls inside the same process', () => {
        expect(dbApi.getBootInstanceId()).toBe(dbApi.getBootInstanceId());
    });
});

// ---- recordUpdateAttempt --------------------------------------------------

describe('recordUpdateAttempt', () => {
    it('INSERTs a triggered row with the click-time metadata and returns the id', () => {
        const id = dbApi.recordUpdateAttempt({
            fromVersion: '2.8.1',
            fromInstanceId: 'old-inst',
        });
        expect(id).toBeGreaterThan(0);
        const row = db.prepare('SELECT * FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('triggered');
        expect(row.from_version).toBe('2.8.1');
        expect(row.from_instance_id).toBe('old-inst');
        expect(row.started_at).toBeGreaterThan(0);
        expect(row.finished_at).toBeNull();
        expect(row.backup_path).toBeNull();
    });
});

// ---- finaliseSuccessfulTrigger --------------------------------------------

describe('finaliseSuccessfulTrigger', () => {
    it('UPDATEs the backup metadata in place without changing status', () => {
        const id = dbApi.recordUpdateAttempt({ fromVersion: '2.8.1', fromInstanceId: 'i' });
        const changes = dbApi.finaliseSuccessfulTrigger({
            id,
            backupPath: '/tmp/snap.sqlite',
            backupBytes: 4096,
        });
        expect(changes).toBe(1);
        const row = db.prepare('SELECT * FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('triggered');
        expect(row.backup_path).toBe('/tmp/snap.sqlite');
        expect(row.backup_bytes).toBe(4096);
    });

    it('returns 0 when no id is supplied (defensive)', () => {
        expect(dbApi.finaliseSuccessfulTrigger({})).toBe(0);
    });
});

// ---- recordUpdateFailure --------------------------------------------------

describe('recordUpdateFailure', () => {
    it('UPDATEs an existing row in place when an id is supplied', () => {
        const id = dbApi.recordUpdateAttempt({ fromVersion: '2.8.1', fromInstanceId: 'i' });
        dbApi.recordUpdateFailure({
            id,
            errorCode: 'WATCHTOWER_UNREACHABLE',
            errorMsg: 'connect ECONNREFUSED',
            backupPath: '/tmp/snap.sqlite',
            backupBytes: 1024,
        });
        const row = db.prepare('SELECT * FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('failed');
        expect(row.error_code).toBe('WATCHTOWER_UNREACHABLE');
        expect(row.error_msg).toMatch(/ECONNREFUSED/);
        expect(row.backup_path).toBe('/tmp/snap.sqlite');
        expect(row.backup_bytes).toBe(1024);
        expect(row.finished_at).toBeGreaterThan(0);
        // No second row inserted.
        const count = db.prepare('SELECT COUNT(*) AS n FROM update_history').get().n;
        expect(count).toBe(1);
    });

    it('INSERTs a fresh failed row when called without an id', () => {
        const id = dbApi.recordUpdateFailure({
            fromVersion: '2.8.1',
            fromInstanceId: 'i',
            errorCode: 'AUTO_UPDATE_UNAVAILABLE',
            errorMsg: 'not in docker',
        });
        expect(id).toBeGreaterThan(0);
        const row = db.prepare('SELECT * FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('failed');
        expect(row.error_code).toBe('AUTO_UPDATE_UNAVAILABLE');
        expect(row.from_instance_id).toBe('i');
    });
});

// ---- finalisePendingUpdates ----------------------------------------------

describe('finalisePendingUpdates', () => {
    it('promotes a triggered row when the version changed', () => {
        const id = dbApi.recordUpdateAttempt({
            fromVersion: '2.8.1',
            fromInstanceId: 'inst-A',
        });
        const r = dbApi.finalisePendingUpdates('2.9.0', 'inst-A');
        expect(r.promoted).toBe(1);
        expect(r.stalled).toBe(0);
        const row = db.prepare('SELECT * FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('success');
        expect(row.to_version).toBe('2.9.0');
        expect(row.finished_at).toBeGreaterThan(0);
    });

    it('promotes when the instance_id changed even on the same version', () => {
        const id = dbApi.recordUpdateAttempt({
            fromVersion: '2.8.1',
            fromInstanceId: 'inst-A',
        });
        const r = dbApi.finalisePendingUpdates('2.8.1', 'inst-B');
        expect(r.promoted).toBe(1);
        const row = db.prepare('SELECT * FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('success');
        expect(row.to_version).toBe('2.8.1');
    });

    it('leaves recent triggered rows alone when nothing changed', () => {
        const id = dbApi.recordUpdateAttempt({
            fromVersion: '2.8.1',
            fromInstanceId: 'inst-A',
        });
        const r = dbApi.finalisePendingUpdates('2.8.1', 'inst-A');
        expect(r.promoted).toBe(0);
        expect(r.stalled).toBe(0);
        const row = db.prepare('SELECT status FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('triggered');
    });

    it('stalls a triggered row whose age exceeds UPDATE_STALL_AFTER_MS', () => {
        const id = dbApi.recordUpdateAttempt({
            fromVersion: '2.8.1',
            fromInstanceId: 'inst-A',
        });
        // Backdate started_at by 10 s — env var sets the stall window to 5 s.
        db.prepare('UPDATE update_history SET started_at = ? WHERE id = ?').run(
            Date.now() - 10_000,
            id,
        );
        const r = dbApi.finalisePendingUpdates('2.8.1', 'inst-A');
        expect(r.stalled).toBe(1);
        expect(r.promoted).toBe(0);
        const row = db.prepare('SELECT * FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('stalled');
        expect(row.error_code).toBe('STALL_TIMEOUT');
    });

    it('is idempotent — re-runs are no-ops', () => {
        dbApi.recordUpdateAttempt({ fromVersion: '2.8.1', fromInstanceId: 'inst-A' });
        dbApi.finalisePendingUpdates('2.9.0', 'inst-A');
        const r = dbApi.finalisePendingUpdates('2.9.0', 'inst-A');
        expect(r.promoted).toBe(0);
        expect(r.stalled).toBe(0);
    });

    it('handles a row missing from_instance_id (legacy pre-v2.9 row)', () => {
        // Insert a row directly with from_instance_id = NULL to simulate
        // a row written by the v2.8 code path before the schema migration.
        const now = Date.now();
        const r = db
            .prepare(
                `INSERT INTO update_history (from_version, started_at, status) VALUES (?, ?, 'triggered')`,
            )
            .run('2.8.1', now);
        const id = Number(r.lastInsertRowid);
        // Even with NULL from_instance_id, a version change should still
        // promote it.
        const sweep = dbApi.finalisePendingUpdates('2.9.0', 'inst-A');
        expect(sweep.promoted).toBe(1);
        const row = db.prepare('SELECT status FROM update_history WHERE id = ?').get(id);
        expect(row.status).toBe('success');
    });
});

// ---- listUpdateHistory ---------------------------------------------------

describe('listUpdateHistory', () => {
    it('returns rows newest first and clamps the limit', () => {
        for (let i = 0; i < 5; i += 1) {
            dbApi.recordUpdateAttempt({ fromVersion: `2.${i}.0`, fromInstanceId: `i-${i}` });
        }
        const all = dbApi.listUpdateHistory({ limit: 100 });
        expect(all.length).toBe(5);
        // Newest (largest id) first.
        for (let i = 0; i < all.length - 1; i += 1) {
            expect(all[i].id).toBeGreaterThan(all[i + 1].id);
        }
        // Limit capped at 200, floored at 1.
        expect(dbApi.listUpdateHistory({ limit: 0 }).length).toBeGreaterThan(0);
        expect(dbApi.listUpdateHistory({ limit: 9999 }).length).toBe(5);
    });
});
