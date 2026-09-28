// End-to-end: the delete paths through the real HTTP server must never
// delete a file another downloads row still uses. Download-time dedup makes
// a later download (possibly from another group) a reference to the file
// already on disk, so rows and files are not 1:1.
//
// Also pins GET /api/maintenance/dedup/status: it must return the found
// duplicate sets and running:false once the scan is done — the duplicates
// page renders from it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-dedup-e2e-'));
const DL = path.join(DATA, 'downloads');
const PORT = 3230;
const BASE = `http://127.0.0.1:${PORT}`;
const exists = (rel) => fs.existsSync(path.join(DL, rel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
let cookie = '';
const ids = {};

async function api(method, url, body) {
    const r = await fetch(BASE + url, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
}

async function waitIdle(statusUrl) {
    for (let i = 0; i < 150; i++) {
        const s = (await api('GET', statusUrl)).json;
        if (s && !s.running) return s;
        await sleep(100);
    }
    throw new Error(`${statusUrl} still running`);
}

async function seed() {
    process.env.TGDL_DATA_DIR = DATA;
    vi.resetModules();
    const db = await import('../src/core/db.js');
    let msg = 1;
    const put = (rel, content) => {
        const abs = path.join(DL, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    };
    const row = (groupId, rel, content) => {
        const buf = Buffer.from(content);
        db.insertDownload({
            groupId,
            groupName: `G${groupId}`,
            messageId: msg++,
            fileName: path.basename(rel),
            fileSize: buf.length,
            fileType: 'photo',
            filePath: rel,
            fileHash: crypto.createHash('sha256').update(buf).digest('hex'),
        });
        return db.getDb().prepare('SELECT MAX(id) AS id FROM downloads').get().id;
    };
    // x: g1 + a dedup'd reference from g2; y: a separate copy in g3.
    put('G1/images/x.jpg', 'dup content');
    put('G3/images/y.jpg', 'dup content');
    ids.a = row('1', 'G1/images/x.jpg', 'dup content');
    ids.b = row('2', 'G1/images/x.jpg', 'dup content');
    ids.c = row('3', 'G3/images/y.jpg', 'dup content');
    // p: owned by g4, referenced by g5.
    put('G4/images/p.jpg', 'gallery content');
    ids.p4 = row('4', 'G4/images/p.jpg', 'gallery content');
    ids.p5 = row('5', 'G4/images/p.jpg', 'gallery content');
    // q: in g6's folder, also used by g7; r: only g6.
    put('G6/images/q.jpg', 'group shared');
    put('G6/images/r.jpg', 'group only');
    row('6', 'G6/images/q.jpg', 'group shared');
    row('6', 'G6/images/r.jpg', 'group only');
    ids.q7 = row('7', 'G6/images/q.jpg', 'group shared');
    db.getDb().close();
    delete process.env.TGDL_DATA_DIR;
}

beforeAll(async () => {
    if (SKIP) return;
    await seed();
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
    expect((await api('POST', '/api/login', { password: 'e2e-password-123' })).status).toBe(200);
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

describe.skipIf(SKIP)('delete paths keep shared files (e2e)', () => {
    it('duplicate scan reports one entry per physical copy and finishes', async () => {
        await api('POST', '/api/maintenance/dedup/scan');
        const st = await waitIdle('/api/maintenance/dedup/status');
        expect(st.running).toBe(false);
        const sets = st.result?.duplicateSets || [];
        expect(sets.map((s) => s.files.map((f) => f.id))).toEqual([[ids.a, ids.c]]);
    });

    it('removing the duplicate copy keeps the kept copy', async () => {
        await api('POST', '/api/maintenance/dedup/delete', { ids: [ids.c] });
        await waitIdle('/api/maintenance/dedup/delete/status');
        expect(exists('G1/images/x.jpg')).toBe(true);
        expect(exists('G3/images/y.jpg')).toBe(false);
    });

    it('gallery delete keeps a file until its last row is deleted', async () => {
        await api('POST', '/api/downloads/bulk-delete', { ids: [ids.p5] });
        await waitIdle('/api/maintenance/dedup/delete/status');
        expect(exists('G4/images/p.jpg')).toBe(true);
        await api('POST', '/api/downloads/bulk-delete', { ids: [ids.p4] });
        await waitIdle('/api/maintenance/dedup/delete/status');
        expect(exists('G4/images/p.jpg')).toBe(false);
    });

    it("deleting a group's files keeps files another group uses", async () => {
        await api('POST', '/api/groups/6/delete-files');
        for (let i = 0; i < 100 && exists('G6/images/r.jpg'); i++) await sleep(100);
        await sleep(300);
        expect(exists('G6/images/q.jpg')).toBe(true);
        expect(exists('G6/images/r.jpg')).toBe(false);
    });
});
