// End-to-end: saving web.csp through POST /api/config changes the CSP header
// on the very next request; injection characters are rejected with 400.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-csp-e2e-'));
const PORT = 3241;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
let admin = '';

async function api(method, url, body, cookie) {
    const r = await fetch(BASE + url, {
        method,
        headers: { 'content-type': 'application/json', cookie: cookie || '' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return {
        status: r.status,
        headers: r.headers,
        cookie: (r.headers.get('set-cookie') || '').split(';')[0],
        json: await r.json().catch(() => null),
    };
}

beforeAll(async () => {
    if (SKIP) return;
    child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(PORT),
            TGDL_DATA_DIR: DATA,
            NODE_ENV: 'test',
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
    await api('POST', '/api/auth/setup', { password: 'e2e-password-123' });
    admin = (await api('POST', '/api/login', { password: 'e2e-password-123' })).cookie;
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

describe.skipIf(SKIP)('web.csp settings (e2e)', () => {
    it('applies saved directives on the next request, and resets', async () => {
        const before = await api('GET', '/api/auth_check');
        expect(before.headers.get('content-security-policy')).toContain("frame-ancestors 'self';");
        expect(before.headers.get('x-frame-options')).toBe('SAMEORIGIN');

        const info = await api('GET', '/api/csp', null, admin);
        const csp = info.json.defaults;
        csp.directives['img-src'].push('https://img.example.com');
        csp.directives['frame-ancestors'].push('https://portal.example.com');
        expect((await api('POST', '/api/config', { web: { csp } }, admin)).status).toBe(200);

        const after = await api('GET', '/api/auth_check');
        const h = after.headers.get('content-security-policy');
        expect(h).toContain("img-src 'self' data: blob: https://img.example.com;");
        expect(h).toContain("frame-ancestors 'self' https://portal.example.com;");
        expect(after.headers.get('x-frame-options')).toBeNull();

        csp.reportOnly = true;
        await api('POST', '/api/config', { web: { csp } }, admin);
        const ro = await api('GET', '/api/auth_check');
        expect(ro.headers.get('content-security-policy')).toBeNull();
        expect(ro.headers.get('content-security-policy-report-only')).toContain('img.example.com');

        expect((await api('POST', '/api/config', { web: { csp: null } }, admin)).status).toBe(200);
        const reset = await api('GET', '/api/auth_check');
        expect(reset.headers.get('content-security-policy')).not.toContain('img.example.com');
        expect(reset.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });

    it('rejects header-injection characters with 400', async () => {
        const bad = { directives: { 'img-src': ["'self'; script-src *"] } };
        const r = await api('POST', '/api/config', { web: { csp: bad } }, admin);
        expect(r.status).toBe(400);
        expect(r.json.error).toMatch(/forbidden character/);
        const nl = { directives: { 'img-src': ['a\nb'] } };
        expect((await api('POST', '/api/config', { web: { csp: nl } }, admin)).status).toBe(400);
    });
});
