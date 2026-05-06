// Integration test for the web_sessions table accessors in src/core/db.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-sessions-test-'));

let db;
let api;

beforeAll(async () => {
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

describe('web_sessions table', () => {
    it('insertSession + findSession round-trip', () => {
        const tok = 'tok-1';
        const exp = Date.now() + 60_000;
        api.insertSession({ token: tok, role: 'admin', expiresAt: exp });
        const row = api.findSession(tok);
        expect(row).toBeTruthy();
        expect(row.role).toBe('admin');
        expect(row.expiresAt).toBe(exp);
    });

    it('findSession returns null for unknown token', () => {
        expect(api.findSession('does-not-exist')).toBeNull();
    });

    it('findSession self-cleans expired rows', () => {
        api.insertSession({ token: 'tok-expired', role: 'guest', expiresAt: Date.now() - 1 });
        expect(api.findSession('tok-expired')).toBeNull();
        // Confirm row was also deleted, not just hidden.
        const row = db.prepare('SELECT 1 FROM web_sessions WHERE token = ?').get('tok-expired');
        expect(row).toBeUndefined();
    });

    it('rejects roles other than admin / guest', () => {
        expect(() =>
            api.insertSession({ token: 'tok-bad', role: 'root', expiresAt: Date.now() + 1000 }),
        ).toThrow(/invalid role/);
    });

    it('deleteSession removes a single row', () => {
        api.insertSession({ token: 'tok-del', role: 'admin', expiresAt: Date.now() + 1000 });
        expect(api.deleteSession('tok-del')).toBe(1);
        expect(api.findSession('tok-del')).toBeNull();
    });

    it('deleteAllSessions wipes the table', () => {
        api.insertSession({ token: 'a', role: 'admin', expiresAt: Date.now() + 1000 });
        api.insertSession({ token: 'b', role: 'guest', expiresAt: Date.now() + 1000 });
        const cleared = api.deleteAllSessions();
        expect(cleared).toBeGreaterThanOrEqual(2);
        expect(api.listSessions()).toHaveLength(0);
    });

    it('deleteSessionsByRole only kills the matching role', () => {
        api.insertSession({ token: 'admin-1', role: 'admin', expiresAt: Date.now() + 1000 });
        api.insertSession({ token: 'guest-1', role: 'guest', expiresAt: Date.now() + 1000 });
        api.insertSession({ token: 'guest-2', role: 'guest', expiresAt: Date.now() + 1000 });
        const n = api.deleteSessionsByRole('guest');
        expect(n).toBe(2);
        expect(api.findSession('admin-1')).toBeTruthy();
        expect(api.findSession('guest-1')).toBeNull();
        expect(api.findSession('guest-2')).toBeNull();
    });

    it('deleteExpiredSessions removes only expired tokens', () => {
        api.deleteAllSessions();
        const now = Date.now();
        api.insertSession({ token: 'past', role: 'admin', expiresAt: now - 10 });
        api.insertSession({ token: 'future', role: 'admin', expiresAt: now + 10_000 });
        const removed = api.deleteExpiredSessions(now);
        expect(removed).toBe(1);
        expect(api.findSession('future')).toBeTruthy();
        // 'past' was already cleaned by the GC; double-check via raw query.
        const row = db.prepare('SELECT 1 FROM web_sessions WHERE token = ?').get('past');
        expect(row).toBeUndefined();
    });
});
