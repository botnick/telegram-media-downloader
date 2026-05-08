// Unit tests for src/core/updater.js — the auto-update pipeline.
//
// We isolate the test by pointing TGDL_DATA_DIR at an os.tmpdir mkdtemp
// before the dynamic import so getDb() picks up the throwaway path and
// the user's real db.sqlite is never touched. global.fetch is replaced
// with vi.fn() per-test so we never make a real network call.
//
// Mocks fs.existsSync ONLY for the `/.dockerenv` heuristic — every
// other fs path falls through to the real implementation so the DB
// init + snapshot writes still work end-to-end.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-updater-test-'));

// Toggleable inDocker heuristic — flipped per-test inside individual
// it() blocks. Default off so the AUTO_UPDATE_UNAVAILABLE path is the
// natural failure mode.
let _fakeDockerEnv = false;

vi.mock('fs', async (importOriginal) => {
    const real = await importOriginal();
    const wrapped = {
        ...real,
        existsSync: (p) => (p === '/.dockerenv' ? _fakeDockerEnv : real.existsSync(p)),
    };
    // Both `import { existsSync } from 'fs'` and `import fs from 'fs'`
    // resolve through this map; expose `default` so the latter works.
    return { default: wrapped, ...wrapped };
});

let updater;
let db;
let dbApi;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    process.env.WATCHTOWER_URL = 'http://watchtower-test:8080';
    process.env.WATCHTOWER_HTTP_API_TOKEN = 'test-token';
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    updater = await import('../src/core/updater.js');
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    delete process.env.WATCHTOWER_URL;
    delete process.env.WATCHTOWER_HTTP_API_TOKEN;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let _origFetch;
beforeEach(() => {
    _origFetch = globalThis.fetch;
    _fakeDockerEnv = false;
});
afterEach(() => {
    globalThis.fetch = _origFetch;
});

// ---- autoUpdateStatus -----------------------------------------------------

describe('autoUpdateStatus', () => {
    it('reports unavailable when /.dockerenv is missing', () => {
        _fakeDockerEnv = false;
        const s = updater.autoUpdateStatus();
        expect(s.available).toBe(false);
        expect(s.inDocker).toBe(false);
        expect(s.watchtowerConfigured).toBe(true);
    });

    it('reports unavailable when env vars are unset even inside docker', () => {
        _fakeDockerEnv = true;
        const url = process.env.WATCHTOWER_URL;
        delete process.env.WATCHTOWER_URL;
        try {
            const s = updater.autoUpdateStatus();
            expect(s.available).toBe(false);
            expect(s.watchtowerConfigured).toBe(false);
        } finally {
            process.env.WATCHTOWER_URL = url;
        }
    });

    it('reports available + surfaces overlayStallMs when both checks pass', () => {
        _fakeDockerEnv = true;
        const s = updater.autoUpdateStatus();
        expect(s.available).toBe(true);
        expect(s.inDocker).toBe(true);
        expect(s.watchtowerConfigured).toBe(true);
        expect(typeof s.overlayStallMs).toBe('number');
        expect(s.overlayStallMs).toBeGreaterThan(0);
    });
});

// ---- _pingWatchtower ------------------------------------------------------

describe('_pingWatchtower', () => {
    const ping = () => updater._internals._pingWatchtower();

    it('returns ok=true on a 200', async () => {
        globalThis.fetch = vi.fn(async () => ({ status: 200, ok: true }));
        const r = await ping();
        expect(r.ok).toBe(true);
        expect(r.status).toBe(200);
    });

    it('returns ok=true on a 405 (HEAD on POST-only route)', async () => {
        globalThis.fetch = vi.fn(async () => ({ status: 405, ok: false }));
        const r = await ping();
        expect(r.ok).toBe(true);
    });

    it('classifies 401 as WATCHTOWER_UNAUTHENTICATED', async () => {
        globalThis.fetch = vi.fn(async () => ({ status: 401, ok: false }));
        const r = await ping();
        expect(r.ok).toBe(false);
        expect(r.code).toBe('WATCHTOWER_UNAUTHENTICATED');
        expect(r.msg).toMatch(/401/);
    });

    it('classifies 403 as WATCHTOWER_UNAUTHENTICATED', async () => {
        globalThis.fetch = vi.fn(async () => ({ status: 403, ok: false }));
        const r = await ping();
        expect(r.ok).toBe(false);
        expect(r.code).toBe('WATCHTOWER_UNAUTHENTICATED');
    });

    it('classifies 5xx as WATCHTOWER_UNREACHABLE', async () => {
        globalThis.fetch = vi.fn(async () => ({ status: 502, ok: false }));
        const r = await ping();
        expect(r.ok).toBe(false);
        expect(r.code).toBe('WATCHTOWER_UNREACHABLE');
    });

    it('classifies AbortError as WATCHTOWER_UNREACHABLE', async () => {
        globalThis.fetch = vi.fn(async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        });
        const r = await ping();
        expect(r.ok).toBe(false);
        expect(r.code).toBe('WATCHTOWER_UNREACHABLE');
        expect(r.msg).toMatch(/timed out/);
    });

    it('classifies generic network errors as WATCHTOWER_UNREACHABLE', async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new Error('ENOTFOUND watchtower');
        });
        const r = await ping();
        expect(r.ok).toBe(false);
        expect(r.code).toBe('WATCHTOWER_UNREACHABLE');
        expect(r.msg).toMatch(/ENOTFOUND/);
    });

    it('returns code=WATCHTOWER_UNREACHABLE when endpoint is not configured', async () => {
        const url = process.env.WATCHTOWER_URL;
        delete process.env.WATCHTOWER_URL;
        try {
            const r = await ping();
            expect(r.ok).toBe(false);
            expect(r.code).toBe('WATCHTOWER_UNREACHABLE');
        } finally {
            process.env.WATCHTOWER_URL = url;
        }
    });
});

// ---- _verifyDbIntegrity ---------------------------------------------------

describe('_verifyDbIntegrity', () => {
    it('returns ok=true on a healthy DB', () => {
        const r = updater._internals._verifyDbIntegrity();
        expect(r.ok).toBe(true);
    });
});

// ---- _snapshotDb + _verifySnapshot ----------------------------------------

describe('_snapshotDb', () => {
    it('writes a snapshot file under data/backups/ and prunes by slug', async () => {
        // Seed enough fake old snapshots to exceed KEEP_BACKUPS.
        const backupsDir = path.join(DATA_DIR, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        const fakeNames = [
            'db-pre-update-20200101-000000.sqlite',
            'db-pre-update-20200102-000000.sqlite',
            'db-pre-update-20200103-000000.sqlite',
            'db-pre-update-20200104-000000.sqlite',
            'db-pre-update-20200105-000000.sqlite',
            'db-pre-update-20200106-000000.sqlite',
        ];
        for (const n of fakeNames) {
            fs.writeFileSync(path.join(backupsDir, n), 'placeholder');
        }
        const r = await updater._internals._snapshotDb();
        expect(r.path).toBeTruthy();
        expect(r.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(r.path)).toBe(true);
        // The oldest fake snapshot should have been pruned (KEEP_BACKUPS = 5).
        const remaining = fs
            .readdirSync(backupsDir)
            .filter((n) => /^db-pre-update-.*\.sqlite$/.test(n))
            .sort();
        expect(remaining).not.toContain('db-pre-update-20200101-000000.sqlite');
        expect(remaining.length).toBe(5);
        // Cleanup
        for (const n of fs.readdirSync(backupsDir)) {
            try {
                fs.unlinkSync(path.join(backupsDir, n));
            } catch {}
        }
    });
});

describe('_verifySnapshot', () => {
    it('returns ok=true for a freshly-written, clean snapshot', async () => {
        const snap = await updater._internals._snapshotDb();
        expect(snap.path).toBeTruthy();
        try {
            const v = await updater._internals._verifySnapshot(snap.path);
            expect(v.ok).toBe(true);
        } finally {
            try {
                fs.unlinkSync(snap.path);
            } catch {}
        }
    });

    it('returns ok=false when the file is missing', async () => {
        const v = await updater._internals._verifySnapshot('/no/such/file.sqlite');
        expect(v.ok).toBe(false);
        expect(v.msg).toMatch(/missing/);
    });

    it('returns ok=false when the file is not a SQLite DB', async () => {
        const garbage = path.join(DATA_DIR, 'backups', 'garbage.sqlite');
        fs.mkdirSync(path.dirname(garbage), { recursive: true });
        fs.writeFileSync(garbage, 'not a real sqlite file');
        try {
            const v = await updater._internals._verifySnapshot(garbage);
            expect(v.ok).toBe(false);
        } finally {
            try {
                fs.unlinkSync(garbage);
            } catch {}
        }
    });
});

// ---- _withTimeout ---------------------------------------------------------

describe('_withTimeout', () => {
    it('resolves when the inner promise settles in time', async () => {
        const r = await updater._internals._withTimeout(Promise.resolve(42), 1000, 'x');
        expect(r).toBe(42);
    });

    it('rejects with a timeout message when the inner stalls', async () => {
        const stalled = new Promise(() => {}); // never settles
        await expect(updater._internals._withTimeout(stalled, 50, 'stall')).rejects.toThrow(
            /timed out after 50ms/,
        );
    });
});

// ---- _parseBackupSlug -----------------------------------------------------

describe('_parseBackupSlug', () => {
    it('extracts the slug from a well-formed name', () => {
        expect(updater._internals._parseBackupSlug('db-pre-update-20260101-120000.sqlite')).toBe(
            '20260101-120000',
        );
    });
    it('returns null on a malformed name', () => {
        expect(updater._internals._parseBackupSlug('something-else.sqlite')).toBeNull();
        expect(updater._internals._parseBackupSlug('db-pre-update-bad.sqlite')).toBeNull();
    });
});

// ---- runAutoUpdate end-to-end --------------------------------------------

describe('runAutoUpdate', () => {
    it('throws AUTO_UPDATE_UNAVAILABLE when not in Docker', async () => {
        _fakeDockerEnv = false;
        await expect(updater.runAutoUpdate()).rejects.toMatchObject({
            code: 'AUTO_UPDATE_UNAVAILABLE',
        });
    });

    it('threads WATCHTOWER_UNAUTHENTICATED through the error', async () => {
        _fakeDockerEnv = true;
        globalThis.fetch = vi.fn(async () => ({ status: 401, ok: false }));
        await expect(updater.runAutoUpdate()).rejects.toMatchObject({
            code: 'WATCHTOWER_UNAUTHENTICATED',
        });
    });

    it('threads WATCHTOWER_UNREACHABLE on 5xx', async () => {
        _fakeDockerEnv = true;
        globalThis.fetch = vi.fn(async () => ({ status: 503, ok: false }));
        await expect(updater.runAutoUpdate()).rejects.toMatchObject({
            code: 'WATCHTOWER_UNREACHABLE',
        });
    });

    it('threads TRIGGER_FAILED when ping passes but POST fails', async () => {
        _fakeDockerEnv = true;
        // First call (HEAD) succeeds, second call (POST) returns 5xx.
        let n = 0;
        globalThis.fetch = vi.fn(async () => {
            n += 1;
            if (n === 1) return { status: 200, ok: true };
            return {
                status: 502,
                ok: false,
                text: async () => 'gateway error',
            };
        });
        const err = await updater.runAutoUpdate().catch((e) => e);
        expect(err.code).toBe('TRIGGER_FAILED');
        // Backup metadata should be threaded through on the error so the
        // route handler can stamp it onto the failed audit row.
        expect(err.backup).toBeTruthy();
        expect(err.backup.path).toBeTruthy();
        expect(fs.existsSync(err.backup.path)).toBe(true);
        // Cleanup the snapshot it took.
        try {
            fs.unlinkSync(err.backup.path);
        } catch {}
    });

    it('completes the full pipeline on the happy path', async () => {
        _fakeDockerEnv = true;
        globalThis.fetch = vi.fn(async () => ({
            status: 200,
            ok: true,
            text: async () => '',
        }));
        const r = await updater.runAutoUpdate();
        expect(r.success).toBe(true);
        expect(r.backup.path).toBeTruthy();
        expect(r.backup.sizeBytes).toBeGreaterThan(0);
        // Cleanup the snapshot.
        try {
            fs.unlinkSync(r.backup.path);
        } catch {}
    });
});
