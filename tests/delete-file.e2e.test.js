// End-to-end: single-file delete (DELETE /api/file) and gallery bulk delete
// by path, through the real HTTP server.
//
//   - `?id=` removes only that row, and keeps the file while another row
//     (download-time dedup, usually another group) still uses it.
//   - Without an id (older SPA tabs) every row for the exact path goes,
//     together with the file.
//   - Two groups holding different files with the same basename are never
//     confused (the old handler deleted by file_name across all groups).
//   - Bulk delete by path resolves every row for the path, in either
//     separator form.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-delfile-e2e-'));
const DL = path.join(DATA, 'downloads');
const PORT = 3231;
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

function rowIds(where, ...args) {
    const db = new Database(path.join(DATA, 'db.sqlite'), { readonly: true });
    try {
        return db
            .prepare(`SELECT id FROM downloads WHERE ${where} ORDER BY id`)
            .all(...args)
            .map((r) => r.id);
    } finally {
        db.close();
    }
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
    const row = (groupId, rel) => {
        db.insertDownload({
            groupId,
            groupName: `G${groupId}`,
            messageId: msg++,
            fileName: path.basename(rel.replace(/\\/g, '/')),
            fileSize: 4,
            fileType: 'photo',
            filePath: rel,
        });
        return db.getDb().prepare('SELECT MAX(id) AS id FROM downloads').get().id;
    };
    // s: owned by g1, dedup'd reference from g2.
    put('G1/images/s.jpg', 'ssss');
    ids.s1 = row('1', 'G1/images/s.jpg');
    ids.s2 = row('2', 'G1/images/s.jpg');
    // t: shared by g3 + g4, deleted by path only (old tab).
    put('G3/images/t.jpg', 'tttt');
    ids.t3 = row('3', 'G3/images/t.jpg');
    ids.t4 = row('4', 'G3/images/t.jpg');
    // same basename, different files, different groups.
    put('G5/images/same.jpg', 'five');
    put('G6/images/same.jpg', 'six!');
    ids.same5 = row('5', 'G5/images/same.jpg');
    ids.same6 = row('6', 'G6/images/same.jpg');
    // bulk by path; one row stored with Windows separators.
    put('G7/images/u.jpg', 'uuuu');
    ids.u7 = row('7', 'G7/images/u.jpg');
    ids.u8 = row('8', String.raw`G7\images\u.jpg`);
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

const del = (p, id) =>
    api('DELETE', `/api/file?path=${encodeURIComponent(p)}${id ? `&id=${id}` : ''}`);

describe.skipIf(SKIP)('DELETE /api/file (e2e)', () => {
    it('with ?id= removes only that row and keeps a file another row uses', async () => {
        expect((await del('G1/images/s.jpg', ids.s2)).status).toBe(200);
        expect(rowIds("file_path = 'G1/images/s.jpg'")).toEqual([ids.s1]);
        expect(exists('G1/images/s.jpg')).toBe(true);
        // Last reference → the file goes too.
        expect((await del('G1/images/s.jpg', ids.s1)).status).toBe(200);
        expect(rowIds("file_path = 'G1/images/s.jpg'")).toEqual([]);
        expect(exists('G1/images/s.jpg')).toBe(false);
    });

    it('without an id removes every row for the path and the file', async () => {
        expect((await del('G3/images/t.jpg')).status).toBe(200);
        expect(rowIds('id IN (?, ?)', ids.t3, ids.t4)).toEqual([]);
        expect(exists('G3/images/t.jpg')).toBe(false);
    });

    it("never touches another group's file with the same basename", async () => {
        expect((await del('G5/images/same.jpg')).status).toBe(200);
        expect(rowIds("file_name = 'same.jpg'")).toEqual([ids.same6]);
        expect(exists('G6/images/same.jpg')).toBe(true);
    });

    it('ignores an ?id= that belongs to a different file', async () => {
        // id of G6's row, path of a file that has no row → only the file goes.
        fs.writeFileSync(path.join(DL, 'G5/images/orphan.jpg'), 'orph');
        expect((await del('G5/images/orphan.jpg', ids.same6)).status).toBe(200);
        expect(rowIds('id = ?', ids.same6)).toEqual([ids.same6]);
    });
});

describe.skipIf(SKIP)('bulk delete by path (e2e)', () => {
    it('resolves every row for the path in both separator forms', async () => {
        await api('POST', '/api/downloads/bulk-delete', { paths: ['G7/images/u.jpg'] });
        await waitIdle('/api/maintenance/dedup/delete/status');
        expect(rowIds('id IN (?, ?)', ids.u7, ids.u8)).toEqual([]);
        expect(exists('G7/images/u.jpg')).toBe(false);
    });
});
