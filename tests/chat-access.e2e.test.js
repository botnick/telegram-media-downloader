// End-to-end: the chat access state over HTTP — `access` on /api/groups
// (guests get no account ids), GET /api/chats/access, the backfill refusal
// (CHAT_UNREACHABLE, before any Telegram call), "Check again" with no
// account (inconclusive, nothing changes), follow-migration, stop and
// remove (config only — downloaded rows stay), and the Recovery list.
// No Telegram account is loaded; the states are seeded in the DB.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-access-e2e-'));
const PORT = 3233;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
let admin = '';
let guest = '';

async function api(method, url, body, cookie) {
    const r = await fetch(BASE + url, {
        method,
        headers: { 'content-type': 'application/json', cookie: cookie || '' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return {
        status: r.status,
        cookie: (r.headers.get('set-cookie') || '').split(';')[0],
        json: await r.json().catch(() => null),
    };
}

const FILTERS = { photos: true, videos: false, files: false };

beforeAll(async () => {
    if (SKIP) return;
    process.env.TGDL_DATA_DIR = DATA;
    vi.resetModules();
    const db = await import('../src/core/db.js');
    const manager = await import('../src/config/manager.js');
    const access = await import('../src/core/chat-access.js');
    const cfg = manager.loadConfig();
    cfg.groups = [
        { id: -1001, name: 'Fine', enabled: true, filters: FILTERS },
        { id: -1002, name: 'Private one', enabled: true, filters: FILTERS },
        { id: -3003, name: 'Old basic', enabled: true, filters: FILTERS, monitorAccount: 'A' },
        { id: -1004, name: 'Gone', enabled: true, filters: FILTERS },
        {
            id: -1005,
            name: 'Legacy',
            enabled: false,
            filters: FILTERS,
            suspended: true,
            _resolveFailedAt: 1,
            _resolveFailedReason: 'banned:CHANNEL_PRIVATE',
        },
    ];
    manager.saveConfig(cfg);
    access._resetForTests();
    access.recordCheck('-1002', [
        { accountId: 'A', cls: { state: 'private', code: 'CHANNEL_PRIVATE', definite: true } },
    ]);
    access.recordCheck('-3003', [
        {
            accountId: 'A',
            cls: { state: 'migrated', code: 'CHAT_MIGRATED', definite: true, migratedTo: '-1009' },
        },
    ]);
    access.recordCheck('-1004', [
        { accountId: 'A', cls: { state: 'deleted', code: 'CHANNEL_INVALID', definite: true } },
    ]);
    db.insertDownload({
        groupId: '-1004',
        groupName: 'Gone',
        messageId: 1,
        fileName: 'a.jpg',
        fileSize: 4,
        fileType: 'photo',
        filePath: 'Gone/images/a.jpg',
    });
    db.getDb().close();
    delete process.env.TGDL_DATA_DIR;

    child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(PORT),
            TGDL_DATA_DIR: DATA,
            NODE_ENV: 'test',
            TGDL_DISABLE_AUTOSTART: '1',
        },
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    for (let i = 0; i < 120; i++) {
        try {
            await fetch(`${BASE}/api/auth_check`);
            break;
        } catch {
            await sleep(250);
        }
    }
    expect((await api('POST', '/api/auth/setup', { password: 'e2e-password-123' })).status).toBe(
        200,
    );
    admin = (await api('POST', '/api/login', { password: 'e2e-password-123' })).cookie;
    expect(
        (await api('POST', '/api/auth/guest-password', { password: 'guest-pass-123' }, admin))
            .status,
    ).toBe(200);
    guest = (await api('POST', '/api/login', { password: 'guest-pass-123' })).cookie;
}, 60_000);

afterAll(async () => {
    try {
        child?.kill('SIGTERM');
    } catch {}
    await sleep(800);
    try {
        fs.rmSync(DATA, { recursive: true, force: true });
    } catch {
        /* file lock — non-fatal */
    }
}, 30_000);

const byId = (list, id) => list.find((g) => String(g.id) === String(id));

describe.skipIf(SKIP)('chat access state (e2e)', () => {
    it('/api/groups carries `access` on every own row; guests see no account ids', async () => {
        const r = await api('GET', '/api/groups', null, admin);
        expect(r.status).toBe(200);
        expect(byId(r.json, -1001).access).toEqual({ state: 'ok' });
        const priv = byId(r.json, -1002).access;
        expect(priv).toMatchObject({ state: 'private', code: 'CHANNEL_PRIVATE' });
        expect(priv.accounts).toEqual([expect.objectContaining({ id: 'A', state: 'private' })]);
        expect(byId(r.json, -3003).access).toMatchObject({
            state: 'migrated',
            migratedTo: '-1009',
        });
        // an older version's auto-disabled entry maps to the same badge
        expect(byId(r.json, -1005).access).toMatchObject({ state: 'private', legacy: true });
        const g = await api('GET', '/api/groups', null, guest);
        expect(g.status).toBe(200);
        expect(byId(g.json, -1002).access.state).toBe('private');
        expect(byId(g.json, -1002).access.accounts).toEqual([]);
    });

    it('GET /api/chats/access lists the configured chats that can’t be reached (admin only)', async () => {
        const r = await api('GET', '/api/chats/access', null, admin);
        expect(r.status).toBe(200);
        expect(r.json.total).toBe(4);
        expect(r.json.byState).toEqual({ private: 2, migrated: 1, deleted: 1 });
        expect(r.json.items.map((x) => x.id).sort()).toEqual(['-1002', '-1004', '-1005', '-3003']);
        const c = await api('GET', '/api/chats/access?countOnly=1', null, admin);
        expect(c.json).toMatchObject({ total: 4 });
        expect(c.json.items).toBeUndefined();
        expect((await api('GET', '/api/chats/access', null, guest)).status).toBe(403);
        expect(
            (await api('POST', '/api/chats/access/recheck', { id: '-1002' }, guest)).status,
        ).toBe(403);
    });

    it('a backfill of a chat that can’t be reached is refused up front', async () => {
        const r = await api('POST', '/api/history', { groupId: '-1002', limit: 10 }, admin);
        expect(r.status).toBe(409);
        expect(r.json).toMatchObject({
            code: 'CHAT_UNREACHABLE',
            access: { state: 'private' },
        });
    });

    it('"Check again" with no account connected learns nothing and changes nothing', async () => {
        const r = await api('POST', '/api/chats/access/recheck', { id: '-1002' }, admin);
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ id: '-1002', inconclusive: true, state: 'private' });
        const after = await api('GET', '/api/groups', null, admin);
        expect(byId(after.json, -1002).access.state).toBe('private');
    });

    it('a blocked chat’s avatar is never looked up', async () => {
        const t0 = Date.now();
        const r = await fetch(`${BASE}/api/groups/-1002/photo`, { headers: { cookie: admin } });
        expect(r.status).toBe(404);
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('Recovery cleanup lists the same chats with an access: reason', async () => {
        const r = await api('GET', '/api/maintenance/recovery/list', null, admin);
        const it1 = r.json.items.find((x) => x.id === '-1002');
        expect(it1.resolveFailedReason).toBe('access:private:CHANNEL_PRIVATE');
        expect(it1.access.state).toBe('private');
    });

    it('follow-migration adds the new group with the old settings and switches the old one off', async () => {
        const bad = await api('POST', '/api/chats/-1001/follow-migration', {}, admin);
        expect(bad.status).toBe(409);
        expect(bad.json.code).toBe('NOT_MIGRATED');
        const r = await api('POST', '/api/chats/-3003/follow-migration', {}, admin);
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({
            added: true,
            group: { id: -1009, name: 'Old basic', enabled: true, monitorAccount: 'A' },
        });
        // (the config manager fills in the other media-type keys)
        expect(r.json.group.filters).toMatchObject(FILTERS);
        const groups = (await api('GET', '/api/groups', null, admin)).json;
        expect(byId(groups, -3003).enabled).toBe(false);
        expect(byId(groups, -1009)).toBeTruthy();
    });

    it('stop monitoring and remove from list touch the config only', async () => {
        const s = await api('POST', '/api/chats/access/stop', { ids: ['-1002'] }, admin);
        expect(s.json).toMatchObject({ success: true, stopped: 1 });
        let groups = (await api('GET', '/api/groups', null, admin)).json;
        expect(byId(groups, -1002).enabled).toBe(false);

        const rm = await api('POST', '/api/chats/access/remove', { ids: ['-1004'] }, admin);
        expect(rm.json).toMatchObject({ success: true, removed: 1 });
        groups = (await api('GET', '/api/groups', null, admin)).json;
        expect(byId(groups, -1004)).toBeUndefined();
        // its downloaded row (and so its gallery) is still there
        const db = new Database(path.join(DATA, 'db.sqlite'), { readonly: true });
        try {
            expect(
                db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE group_id = '-1004'").get().n,
            ).toBe(1);
            expect(
                db.prepare("SELECT COUNT(*) AS n FROM chat_access WHERE chat_id = '-1004'").get().n,
            ).toBe(0);
        } finally {
            db.close();
        }
    });
});
