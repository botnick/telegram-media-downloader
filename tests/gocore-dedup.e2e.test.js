// End to end with the real server and the real tgdl-core in `on` mode:
// the duplicate scan hashes rows that have no file_hash yet; every
// digest it stores must equal Node's, and /metrics must show that Go
// did the work. Skips without a binary / Go (TGDL_GOCORE_REQUIRE=1 in CI).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { findOrBuildGoCore, REQUIRE_GOCORE } from './helpers/gocore-bin.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-e2e-'));
const DL = path.join(DATA, 'downloads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bin = null;
let child;
let base;
let cookie = '';
const expected = new Map(); // row id → sha256

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function api(method, url, body) {
    const r = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
}

async function seed() {
    process.env.TGDL_DATA_DIR = DATA;
    vi.resetModules();
    const db = await import('../src/core/db.js');
    const names = ['a.jpg', 'ภาพถ่าย.jpg', '🎬 video.mp4', 'b.bin', 'dup-of-a.jpg'];
    let msg = 1;
    for (let i = 0; i < 30; i++) {
        const name = names[i % names.length];
        const rel = `G${i % 3}/files/${i}-${name}`;
        const buf =
            name === 'dup-of-a.jpg'
                ? Buffer.from('same content for duplicates')
                : crypto.randomBytes(1024 * (1 + ((i * 97) % 700)));
        fs.mkdirSync(path.dirname(path.join(DL, rel)), { recursive: true });
        fs.writeFileSync(path.join(DL, rel), buf);
        db.insertDownload({
            groupId: String(i % 3),
            groupName: `G${i % 3}`,
            messageId: msg++,
            fileName: path.basename(rel),
            fileSize: buf.length,
            fileType: 'photo',
            filePath: rel,
            fileHash: null,
        });
        const id = db.getDb().prepare('SELECT MAX(id) AS id FROM downloads').get().id;
        expected.set(id, crypto.createHash('sha256').update(buf).digest('hex'));
    }
    db.getDb().close();
    delete process.env.TGDL_DATA_DIR;
}

beforeAll(async () => {
    if (SKIP) return;
    bin = await findOrBuildGoCore();
    if (!bin) {
        if (REQUIRE_GOCORE) throw new Error('TGDL_GOCORE_REQUIRE=1 but no tgdl-core');
        return;
    }
    await seed();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(port),
            TGDL_DATA_DIR: DATA,
            NODE_ENV: 'test',
            TGDL_DISABLE_AUTOSTART: '1',
            TGDL_GO_CORE: 'on',
            TGDL_CORE_BIN: bin,
        },
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    for (let i = 0; i < 240; i++) {
        try {
            await fetch(`${base}/api/auth_check`);
            break;
        } catch {
            await sleep(100);
        }
    }
    expect((await api('POST', '/api/auth/setup', { password: 'e2e-password-123' })).status).toBe(
        200,
    );
    expect((await api('POST', '/api/login', { password: 'e2e-password-123' })).status).toBe(200);
    for (let i = 0; i < 100; i++) {
        const h = (await api('GET', '/api/system/health')).json;
        if (h?.goCore?.state === 'running') break;
        await sleep(100);
    }
}, 300_000);

afterAll(async () => {
    try {
        child?.kill('SIGTERM');
    } catch {}
    await sleep(800);
    try {
        fs.rmSync(DATA, { recursive: true, force: true });
    } catch {}
}, 30_000);

describe.skipIf(SKIP)('dedup scan hashes through tgdl-core', () => {
    it('stores Node-identical digests and Go did the hashing', {
        timeout: 60_000,
    }, async ({ skip }) => {
        if (!bin) skip();
        const h = (await api('GET', '/api/system/health')).json;
        expect(h.goCore.state).toBe('running');
        expect(h.goCore.features.hash.mode).toBe('on');

        await api('POST', '/api/maintenance/dedup/scan');
        let st;
        for (let i = 0; i < 300; i++) {
            st = (await api('GET', '/api/maintenance/dedup/status')).json;
            if (st && !st.running) break;
            await sleep(100);
        }
        expect(st.running).toBe(false);
        expect(st.result.hashed).toBe(expected.size);

        const { default: Database } = await import('better-sqlite3');
        const d = new Database(path.join(DATA, 'db.sqlite'), { readonly: true });
        const rows = d.prepare('SELECT id, file_hash FROM downloads').all();
        d.close();
        expect(rows.length).toBe(expected.size);
        for (const r of rows) expect(r.file_hash, `row ${r.id}`).toBe(expected.get(r.id));

        // The 6 identical files form one duplicate set.
        expect(st.result.duplicateSets.length).toBe(1);
        expect(st.result.duplicateSets[0].count).toBe(6);

        const text = await (await fetch(`${base}/metrics`)).text();
        const ok = /tgdl_gocore_calls_total\{feature="hash",result="ok"\} (\d+)/.exec(text);
        expect(Number(ok?.[1])).toBeGreaterThanOrEqual(expected.size);
        const after = (await api('GET', '/api/system/health')).json.goCore.features.hash;
        expect(after.go).toBeGreaterThanOrEqual(expected.size);
        expect(after.fallbacks).toBe(0);
    });
});
