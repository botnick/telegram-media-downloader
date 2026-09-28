// End-to-end regression tests for auth gaps found while recording
// the API contract suite:
//   1. POST /api/update (DB snapshot + watchtower container recreate) sits
//      before the global auth middleware and answered anyone.
//   2. Saving a group broadcast `config_updated` with the whole config —
//      password hashes, the share secret — to every socket, guests too.
//   3. The re-auth guard of session export / sign-out-everywhere accepted
//      the guest password.
//   4. GET /api/update/status, /api/auto-update/status and
//      /api/update/history (same registration spot as 1.) answered
//      anonymous callers.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gates-e2e-'));
const ADMIN_PW = 'gates-admin-pass';
const GUEST_PW = 'gates-guest-pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
let port = 0;
let base = '';
let admin = '';
let guest = '';

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

async function api(method, url, { body, cookie } = {}) {
    const r = await fetch(base + url, {
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

beforeAll(async () => {
    if (SKIP) return;
    process.env.TGDL_DATA_DIR = DATA;
    vi.resetModules();
    const { loadConfig, saveConfig } = await import('../src/config/manager.js');
    const { hashPassword } = await import('../src/core/web-auth.js');
    const { getDb } = await import('../src/core/db.js');
    const cfg = loadConfig();
    cfg.web = {
        ...(cfg.web || {}),
        enabled: true,
        passwordHash: hashPassword(ADMIN_PW),
        guestPasswordHash: hashPassword(GUEST_PW),
        guestEnabled: true,
    };
    cfg.groups = [{ id: '-1001', name: 'G', enabled: false, filters: { photos: true } }];
    saveConfig(cfg);
    getDb().close();
    delete process.env.TGDL_DATA_DIR;

    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(port),
            TGDL_DATA_DIR: DATA,
            NODE_ENV: 'test',
            TGDL_GO_CORE: 'off',
        },
        cwd: REPO_ROOT,
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    for (let i = 0; i < 120; i++) {
        try {
            if ((await fetch(`${base}/api/auth_check`)).ok) break;
        } catch {
            /* not listening yet */
        }
        await sleep(250);
    }
    admin = (await api('POST', '/api/login', { body: { password: ADMIN_PW } })).cookie;
    guest = (await api('POST', '/api/login', { body: { password: GUEST_PW } })).cookie;
}, 60_000);

afterAll(async () => {
    try {
        child?.kill('SIGTERM');
    } catch {}
    await sleep(500);
    try {
        fs.rmSync(DATA, { recursive: true, force: true });
    } catch {
        /* file lock — non-fatal */
    }
}, 30_000);

describe.skipIf(SKIP)('auth gates (e2e)', () => {
    it('POST /api/update needs an admin session', async () => {
        expect((await api('POST', '/api/update')).status).toBe(401);
        const g = await api('POST', '/api/update', { cookie: guest });
        expect(g.status).toBe(403);
        expect(g.json).toMatchObject({ adminRequired: true });
    });

    it('the update probe, job status and history need a session', async () => {
        // Anonymous callers used to get all three (registered before checkAuth).
        for (const url of [
            '/api/update/status',
            '/api/auto-update/status',
            '/api/update/history',
        ]) {
            const anon = await api('GET', url);
            expect(anon.status, url).toBe(401);
            expect(anon.json).toEqual({ error: 'Unauthorized' });
            expect((await api('GET', url, { cookie: admin })).status, url).toBe(200);
        }
        // Guests keep the capability probe the status-bar update chooser
        // reads; the Maintenance-only job status and audit log are admin's.
        const probe = await api('GET', '/api/update/status', { cookie: guest });
        expect(probe.status).toBe(200);
        expect(probe.json).toMatchObject({ available: false });
        for (const url of ['/api/auto-update/status', '/api/update/history']) {
            const g = await api('GET', url, { cookie: guest });
            expect(g.status, url).toBe(403);
            expect(g.json).toMatchObject({ adminRequired: true });
        }
    });

    it('group saves reach guest sockets without the config', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie: guest } });
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        const got = new Promise((resolve) => {
            ws.on('message', (d) => {
                const m = JSON.parse(d.toString());
                if (m.type === 'config_updated') resolve(m);
            });
        });
        const r = await api('PUT', '/api/groups/-1001', {
            cookie: admin,
            body: { name: 'G renamed', enabled: false },
        });
        expect(r.status).toBe(200);
        const msg = await got;
        ws.close();
        expect(msg).toEqual({ type: 'config_updated' });
    });

    it('the re-auth guard takes the admin password only', async () => {
        const withGuestPw = await api('POST', '/api/maintenance/sessions/revoke-all', {
            cookie: admin,
            body: { confirm: true, password: GUEST_PW },
        });
        expect(withGuestPw.status).toBe(403);
        expect(withGuestPw.json).toEqual({ error: 'Invalid password' });
        const auth = await api('GET', '/api/auth_check', { cookie: admin });
        expect(auth.json.authenticated).toBe(true);
    });
});
