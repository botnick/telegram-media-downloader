// End-to-end regression tests for HTTP-level bugs the API contract suite
// recorded as-is (tests/contract/README.md, "Known bugs pinned by the
// goldens"), against a spawned server:
//   - an unsatisfiable or inverted Range on /files and /share answered 500
//     (under the file's Content-Type) instead of 416, and /share counted it
//     as an access;
//   - a malformed JSON body, a JSON null or a body over 2 MB answered 500
//     instead of 400 / 413.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-findings-e2e-'));
const ADMIN_PW = 'findings-admin-pass';
const FILE_REL = 'G1/images/a.jpg';
const FILE_BYTES = Buffer.alloc(100, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
let base = '';
let admin = '';
let downloadId = 0;

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function req(method, url, { body, raw, cookie = admin, headers = {} } = {}) {
    const r = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', cookie, ...headers },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try {
        json = JSON.parse(buf.toString('utf8'));
    } catch {
        /* not JSON */
    }
    return { status: r.status, headers: r.headers, buf, text: buf.toString('utf8'), json };
}

beforeAll(async () => {
    if (SKIP) return;
    process.env.TGDL_DATA_DIR = DATA;
    vi.resetModules();
    const { loadConfig, saveConfig } = await import('../src/config/manager.js');
    const { hashPassword } = await import('../src/core/web-auth.js');
    const db = await import('../src/core/db.js');
    const cfg = loadConfig();
    cfg.web = { ...(cfg.web || {}), enabled: true, passwordHash: hashPassword(ADMIN_PW) };
    saveConfig(cfg);
    const abs = path.join(DATA, 'downloads', FILE_REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, FILE_BYTES);
    db.insertDownload({
        groupId: '1',
        groupName: 'G1',
        messageId: 1,
        fileName: 'a.jpg',
        fileSize: FILE_BYTES.length,
        fileType: 'photo',
        filePath: FILE_REL,
    });
    downloadId = db.getDb().prepare('SELECT MAX(id) AS id FROM downloads').get().id;
    db.getDb().close();
    delete process.env.TGDL_DATA_DIR;

    const port = await freePort();
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
    const login = await req('POST', '/api/login', { body: { password: ADMIN_PW }, cookie: '' });
    admin = (login.headers.get('set-cookie') || '').split(';')[0];
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

function expect416(r) {
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe(`bytes */${FILE_BYTES.length}`);
    // Not the file's type, validators or disposition, and never cached.
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(r.headers.get('etag')).toBeNull();
    expect(r.headers.get('last-modified')).toBeNull();
    expect(r.headers.get('content-disposition')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.text).toBe('Range Not Satisfiable');
}

describe.skipIf(SKIP)('contract findings (e2e)', () => {
    it('/files answers 416 to a Range the file cannot satisfy', async () => {
        const url = `/files/${FILE_REL}?inline=1`;
        expect416(await req('GET', url, { headers: { range: 'bytes=500-600' } }));
        expect416(await req('GET', url, { headers: { range: 'bytes=50-10' } }));
        const ok = await req('GET', url, { headers: { range: 'bytes=0-9' } });
        expect(ok.status).toBe(206);
        expect(ok.headers.get('content-range')).toBe(`bytes 0-9/${FILE_BYTES.length}`);
        expect(ok.buf.length).toBe(10);
    });

    it('/share answers 416 without counting an access', async () => {
        const created = await req('POST', '/api/share/links', { body: { downloadId } });
        expect(created.status).toBe(200);
        const link = created.json.link;
        const sharePath = new URL(link.url).pathname + new URL(link.url).search;
        const count = async () =>
            (await req('GET', `/api/share/links?downloadId=${downloadId}`)).json.links.find(
                (l) => l.id === link.id,
            ).accessCount;

        const bad = await req('GET', sharePath, { cookie: '', headers: { range: 'bytes=500-' } });
        expect416(bad);
        expect(await count()).toBe(0);

        const ok = await req('GET', sharePath, { cookie: '' });
        expect(ok.status).toBe(200);
        expect(ok.buf.equals(FILE_BYTES)).toBe(true);
        expect(await count()).toBe(1);
    });

    it('a body express.json() refuses is a 400 / 413, and nothing is saved', async () => {
        const before = (await req('GET', '/api/config')).json.pollingInterval;
        const cases = [
            ['{"pollingInterval": 99,', 400, 'Malformed JSON body'],
            ['null', 400, 'Malformed JSON body'],
            [
                JSON.stringify({ pollingInterval: 99, pad: 'x'.repeat(2 * 1024 * 1024) }),
                413,
                'Request body too large',
            ],
        ];
        for (const [raw, status, error] of cases) {
            const r = await req('POST', '/api/config', { raw });
            expect(r.status).toBe(status);
            expect(r.json).toEqual({ error });
        }
        // Parsing runs before the auth check: a bad body is a 400 for anyone.
        const anon = await req('POST', '/api/config', { raw: '{', cookie: '' });
        expect(anon.status).toBe(400);
        expect((await req('GET', '/api/config')).json.pollingInterval).toBe(before);
    });
});
