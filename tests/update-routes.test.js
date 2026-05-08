// Integration tests for /api/update/* endpoints. We mount the route
// handlers on a fresh Express app rather than importing
// src/web/server.js (which would bind the listen socket + boot the
// monitor) and exercise them via fetch.
//
// Mocks: fs.existsSync('/.dockerenv') is overridden so autoUpdateStatus()
// returns available=true, and globalThis.fetch is stubbed per-test so
// no real watchtower call is made.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-update-routes-test-'));

let _fakeDockerEnv = false;

vi.mock('fs', async (importOriginal) => {
    const real = await importOriginal();
    const wrapped = {
        ...real,
        existsSync: (p) => (p === '/.dockerenv' ? _fakeDockerEnv : real.existsSync(p)),
    };
    return { default: wrapped, ...wrapped };
});

let updater;
let dbApi;
let createJobTracker;
let app;
let server;
let port;
let db;
let jobTracker;

const broadcasts = [];

function _wireUpdateRoutes() {
    const a = express();
    a.use(express.json());
    jobTracker = createJobTracker({
        kind: 'autoUpdate',
        broadcast: (msg) => broadcasts.push(msg),
        log: () => {},
        eventPrefix: 'update',
    });

    const _readCurrentVersion = () => '2.8.1';

    const _sweepStalledUpdates = () => {
        try {
            return dbApi.finalisePendingUpdates(_readCurrentVersion(), dbApi.getBootInstanceId());
        } catch {
            return { promoted: 0, stalled: 0 };
        }
    };

    a.get('/api/update/status', (_req, res) => {
        _sweepStalledUpdates();
        res.json(updater.autoUpdateStatus());
    });

    a.post('/api/update', (req, res) => {
        const fromVersion = _readCurrentVersion();
        const fromInstanceId = dbApi.getBootInstanceId();
        const force = String(req.query.force || '') === '1';
        const r = jobTracker.tryStart(async () => {
            let auditId = 0;
            try {
                auditId = dbApi.recordUpdateAttempt({ fromVersion, fromInstanceId });
            } catch {}
            try {
                broadcasts.push({ type: 'update_started', auditId });
            } catch {}
            let result;
            try {
                result = await updater.runAutoUpdate({ force });
            } catch (e) {
                const partial = e?.backup || {};
                try {
                    dbApi.recordUpdateFailure({
                        id: auditId,
                        fromVersion,
                        fromInstanceId,
                        errorCode: e?.code || 'UNKNOWN',
                        errorMsg: e?.message || String(e),
                        backupPath: partial.path || null,
                        backupBytes: partial.sizeBytes ?? null,
                    });
                } catch {}
                throw e;
            }
            try {
                dbApi.finaliseSuccessfulTrigger({
                    id: auditId,
                    backupPath: result.backup?.path || null,
                    backupBytes: result.backup?.sizeBytes ?? null,
                });
            } catch {}
            return { backup: result.backup, auditId };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'An update is already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    a.get('/api/auto-update/status', (_req, res) => {
        res.json(jobTracker.getStatus());
    });

    a.get('/api/update/history', (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 25));
            _sweepStalledUpdates();
            res.json({ history: dbApi.listUpdateHistory({ limit }) });
        } catch (e) {
            res.status(500).json({ error: e?.message || 'Failed to read update history' });
        }
    });

    return { app: a, jobTracker };
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    process.env.WATCHTOWER_URL = 'http://watchtower-test:8080';
    process.env.WATCHTOWER_HTTP_API_TOKEN = 'test-token';
    process.env.UPDATE_STALL_AFTER_MS = '5000';
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    updater = await import('../src/core/updater.js');
    ({ createJobTracker } = await import('../src/core/job-tracker.js'));
    app = _wireUpdateRoutes().app;
    server = app.listen(0);
    port = server.address().port;
});

afterAll(async () => {
    await new Promise((r) => server.close(r));
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    delete process.env.WATCHTOWER_URL;
    delete process.env.WATCHTOWER_HTTP_API_TOKEN;
    delete process.env.UPDATE_STALL_AFTER_MS;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let _origFetch;
beforeEach(() => {
    _origFetch = globalThis.fetch;
    _fakeDockerEnv = false;
    broadcasts.length = 0;
    db.exec('DELETE FROM update_history');
});
afterEach(() => {
    globalThis.fetch = _origFetch;
});

// HACK: the test harness uses node's built-in fetch — but our route
// handler ALSO calls fetch (against watchtower) inside the same process.
// We stub globalThis.fetch only for the duration of a single test, so
// every harness-outbound fetch goes through `_testFetch`, which captures
// the real fetch up front and bypasses the stub.
const _realFetch = globalThis.fetch;
function _testFetch(url, init) {
    return _realFetch.call(globalThis, url, init);
}

// Wait until the JobTracker has settled (success or error). The
// /api/update endpoint returns 200 immediately, but the actual run
// finishes asynchronously inside the tracker. The route tests need to
// observe the post-completion DB state. Uses _testFetch so the mocked
// watchtower-fetch can't leak into the polling call.
async function _waitForJobIdle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await _testFetch(`http://127.0.0.1:${port}/api/auto-update/status`);
        const s = await r.json();
        if (!s.running) return s;
        await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('JobTracker still running after timeout');
}

// ---- /api/update/status ---------------------------------------------------

describe('GET /api/update/status', () => {
    it('returns the autoUpdateStatus shape', async () => {
        _fakeDockerEnv = true;
        const r = await _testFetch(`http://127.0.0.1:${port}/api/update/status`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body).toMatchObject({
            available: true,
            inDocker: true,
            watchtowerConfigured: true,
        });
        expect(typeof body.overlayStallMs).toBe('number');
    });

    it('runs the lazy stall sweep on each call', async () => {
        // Insert a stale triggered row directly.
        const id = dbApi.recordUpdateAttempt({ fromVersion: '2.8.0', fromInstanceId: 'old' });
        db.prepare('UPDATE update_history SET started_at = ? WHERE id = ?').run(
            Date.now() - 10_000,
            id,
        );
        // The current process is on '2.8.1' / current instance — but the
        // version is the same as fromVersion in some other tests, so we
        // rely on the stall window (5 s set in beforeAll).
        await _testFetch(`http://127.0.0.1:${port}/api/update/status`);
        const row = db.prepare('SELECT status FROM update_history WHERE id = ?').get(id);
        // Either promoted (if instance id differs) or stalled (timeout).
        expect(['success', 'stalled']).toContain(row.status);
    });
});

// ---- POST /api/update -----------------------------------------------------

describe('POST /api/update', () => {
    it('returns 200 + started:true and writes a single triggered row on success', async () => {
        _fakeDockerEnv = true;
        // First call (HEAD) → 200, second call (POST /v1/update) → 200.
        globalThis.fetch = vi.fn(async () => ({
            status: 200,
            ok: true,
            text: async () => '',
        }));
        const r = await _testFetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST' });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body).toEqual({ success: true, started: true });
        // Wait for the JobTracker to finish.
        await _waitForJobIdle();
        const rows = dbApi.listUpdateHistory({ limit: 10 });
        expect(rows.length).toBe(1);
        expect(rows[0].status).toBe('triggered');
        expect(rows[0].backup_path).toBeTruthy();
        expect(rows[0].backup_bytes).toBeGreaterThan(0);
        expect(rows[0].from_instance_id).toBeTruthy();
        // update_started fired before any work.
        expect(broadcasts.find((b) => b.type === 'update_started')).toBeTruthy();
        // Cleanup snapshot.
        try {
            fs.unlinkSync(rows[0].backup_path);
        } catch {}
    });

    it('writes a single failed row with the structured error code on pre-flight failure', async () => {
        _fakeDockerEnv = true;
        globalThis.fetch = vi.fn(async () => ({ status: 401, ok: false }));
        const r = await _testFetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST' });
        expect(r.status).toBe(200); // tracker started — failure surfaces async
        await _waitForJobIdle();
        const rows = dbApi.listUpdateHistory({ limit: 10 });
        expect(rows.length).toBe(1);
        expect(rows[0].status).toBe('failed');
        expect(rows[0].error_code).toBe('WATCHTOWER_UNAUTHENTICATED');
    });

    it('returns 409 ALREADY_RUNNING when a run is in flight', async () => {
        _fakeDockerEnv = true;
        // Slow watchtower POST so the run is still in flight when the
        // second request arrives. 200 ms is plenty for the second
        // request to hit tryStart while the first is still awaiting the
        // mocked POST, but short enough that the JobTracker drains
        // before this test ends.
        globalThis.fetch = vi.fn(async (_url, init) => {
            if (init?.method === 'HEAD') return { status: 200, ok: true };
            await new Promise((res) => setTimeout(res, 200));
            return { status: 200, ok: true, text: async () => '' };
        });
        const first = await _testFetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST' });
        expect(first.status).toBe(200);
        // Probe the tracker directly — sync, no fetch involved, so the
        // mocked watchtower-fetch can't interfere.
        expect(jobTracker.isRunning()).toBe(true);
        const second = await _testFetch(`http://127.0.0.1:${port}/api/update`, { method: 'POST' });
        expect(second.status).toBe(409);
        const body = await second.json();
        expect(body.code).toBe('ALREADY_RUNNING');
        // Wait for the slow POST to drain so the next test starts clean.
        const deadline = Date.now() + 3000;
        while (jobTracker.isRunning() && Date.now() < deadline) {
            await new Promise((res) => setTimeout(res, 25));
        }
        expect(jobTracker.isRunning()).toBe(false);
        // Tidy any snapshot the run wrote.
        try {
            const backupsDir = path.join(DATA_DIR, 'backups');
            for (const f of fs.readdirSync(backupsDir)) {
                if (/^db-pre-update-/.test(f)) {
                    fs.unlinkSync(path.join(backupsDir, f));
                }
            }
        } catch {}
    });
});

// ---- GET /api/update/history ---------------------------------------------

describe('GET /api/update/history', () => {
    it('returns rows newest first, capped by limit', async () => {
        for (let i = 0; i < 3; i += 1) {
            dbApi.recordUpdateAttempt({ fromVersion: `2.${i}.0`, fromInstanceId: `i-${i}` });
        }
        const r = await _testFetch(`http://127.0.0.1:${port}/api/update/history?limit=2`);
        const body = await r.json();
        expect(body.history.length).toBe(2);
        expect(body.history[0].id).toBeGreaterThan(body.history[1].id);
    });
});
