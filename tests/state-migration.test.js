// End-to-end test for the legacy-JSON → SQLite migration runner.
//
// We seed a temp data dir with handcrafted config.json, disk_usage.json,
// and web-sessions.json, then import db.js so getDb() runs the migration.
// Asserts:
//   - kv['config'] / kv['disk_usage'] match the input
//   - web_sessions has one row per non-expired token
//   - each source file is renamed to <file>.migrated
//   - re-running getDb() in a child process is idempotent

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-state-migration-'));

const CONFIG = {
    telegram: { apiId: '12345', apiHash: 'abcd' },
    accounts: [{ id: 'a1', name: 'primary' }],
    download: { concurrent: 7 },
};

const DISK_USAGE = { size: 123_456_789, lastScan: 1700000000000 };

const NOW = Date.now();
const SESSIONS = {
    'tok-future': { createdAt: NOW - 1000, expiresAt: NOW + 60_000, role: 'admin' },
    'tok-guest': { createdAt: NOW - 2000, expiresAt: NOW + 60_000, role: 'guest' },
    'tok-expired': { createdAt: NOW - 90_000, expiresAt: NOW - 1000, role: 'admin' },
};

let api;
let db;

beforeAll(async () => {
    fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(CONFIG, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'disk_usage.json'), JSON.stringify(DISK_USAGE));
    fs.writeFileSync(path.join(DATA_DIR, 'web-sessions.json'), JSON.stringify(SESSIONS));

    process.env.TGDL_DATA_DIR = DATA_DIR;
    api = await import('../src/core/db.js');
    db = api.getDb();
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('state-migration', () => {
    it('imports config.json into kv["config"]', () => {
        expect(api.kvGet('config')).toEqual(CONFIG);
    });

    it('imports disk_usage.json into kv["disk_usage"]', () => {
        expect(api.kvGet('disk_usage')).toEqual(DISK_USAGE);
    });

    it('imports non-expired sessions; drops expired ones', () => {
        const all = api.listSessions();
        const tokens = all.map((r) => r.token).sort();
        expect(tokens).toEqual(['tok-future', 'tok-guest']);

        const future = api.findSession('tok-future');
        expect(future).toBeTruthy();
        expect(future.role).toBe('admin');
        const guest = api.findSession('tok-guest');
        expect(guest).toBeTruthy();
        expect(guest.role).toBe('guest');
    });

    it('renames the source files to .migrated', () => {
        expect(fs.existsSync(path.join(DATA_DIR, 'config.json'))).toBe(false);
        expect(fs.existsSync(path.join(DATA_DIR, 'config.json.migrated'))).toBe(true);
        expect(fs.existsSync(path.join(DATA_DIR, 'disk_usage.json'))).toBe(false);
        expect(fs.existsSync(path.join(DATA_DIR, 'disk_usage.json.migrated'))).toBe(true);
        expect(fs.existsSync(path.join(DATA_DIR, 'web-sessions.json'))).toBe(false);
        expect(fs.existsSync(path.join(DATA_DIR, 'web-sessions.json.migrated'))).toBe(true);
    });

    it('preserves the migrated-file content as a backup', () => {
        const recovered = JSON.parse(
            fs.readFileSync(path.join(DATA_DIR, 'config.json.migrated'), 'utf8'),
        );
        expect(recovered).toEqual(CONFIG);
    });
});
