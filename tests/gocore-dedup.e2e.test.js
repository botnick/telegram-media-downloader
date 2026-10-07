// End to end with the real server and the real tgdl-core: the duplicate
// scan hashes rows that have no file_hash yet; every digest it stores must
// equal crypto.createHash's, and /metrics must show that tgdl-core did the
// work. Then Verify files and Re-index from disk run through it as well.

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-e2e-'));
const DL = path.join(DATA, 'downloads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(url, done) {
    let st;
    for (let i = 0; i < 300; i++) {
        st = (await api('GET', url)).json;
        if (st && done(st)) return st;
        await sleep(100);
    }
    return st;
}

beforeAll(async () => {
    if (SKIP) return;
    const bin = requireCoreBin();
    await seed();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(port),
            TGDL_DATA_DIR: DATA,
            NODE_ENV: 'test',
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

describe.skipIf(SKIP)('maintenance jobs run through tgdl-core', () => {
    it('dedup scan stores identical digests and tgdl-core did the hashing', {
        timeout: 60_000,
    }, async () => {
        const h = (await api('GET', '/api/system/health')).json;
        expect(h.goCore.state).toBe('running');
        expect(h.goCore.problem).toBe(null);
        for (const f of ['hash', 'stat', 'walk', 'dbscan']) {
            expect(h.goCore.features[f].available, f).toBe(true);
        }

        expect((await api('POST', '/api/maintenance/dedup/scan')).status).toBe(200);
        const st = await waitFor('/api/maintenance/dedup/status', (s) => !s.running);
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
        const single = /tgdl_gocore_calls_total\{feature="hash",result="ok"\} (\d+)/.exec(text);
        const batch = /tgdl_gocore_calls_total\{feature="hash-batch",result="ok"\} (\d+)/.exec(
            text,
        );
        // New cores hash the maintenance page in one bounded request. Older
        // cores remain valid through the single-file fallback.
        expect(Number(batch?.[1] || 0) + Number(single?.[1] || 0)).toBeGreaterThan(0);
        expect(Number(batch?.[1] || 0)).toBeGreaterThanOrEqual(1);
    });

    it('Verify files prunes exactly the missing row; Re-index walks the tree', {
        timeout: 60_000,
    }, async () => {
        const victim = [...expected.keys()][0];
        const { default: Database } = await import('better-sqlite3');
        let d = new Database(path.join(DATA, 'db.sqlite'), { readonly: true });
        const rel = d.prepare('SELECT file_path FROM downloads WHERE id = ?').get(victim).file_path;
        d.close();
        fs.rmSync(path.join(DL, rel));

        expect((await api('POST', '/api/maintenance/files/verify')).status).toBe(200);
        const v = await waitFor(
            '/api/maintenance/files/verify/status',
            (s) => !s.running && s.result,
        );
        expect(v.result.pruned).toBe(1);
        d = new Database(path.join(DATA, 'db.sqlite'), { readonly: true });
        expect(d.prepare('SELECT COUNT(*) AS n FROM downloads').get().n).toBe(expected.size - 1);
        d.close();

        expect((await api('POST', '/api/maintenance/reindex')).status).toBe(200);
        const r = await waitFor('/api/maintenance/reindex/status', (s) => !s.running);
        expect(r.running).toBe(false);

        const text = await (await fetch(`${base}/metrics`)).text();
        expect(text).toMatch(/tgdl_gocore_calls_total\{feature="stat",result="ok"\} [1-9]/);
        expect(text).toMatch(/tgdl_gocore_calls_total\{feature="walk",result="ok"\} [1-9]/);
    });
});
