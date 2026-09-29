// End-to-end: POST /api/downloads/pin — the gallery's bulk Pin in one
// request (it used to send one POST per selected file). Admin only, capped
// id count, skips ids that don't exist, keeps the per-file route working.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-pin-e2e-'));
const PORT = 3232;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
const ids = [];

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

function pinnedOf(list) {
    const db = new Database(path.join(DATA, 'db.sqlite'), { readonly: true });
    try {
        const marks = list.map(() => '?').join(',');
        return db
            .prepare(`SELECT id, pinned FROM downloads WHERE id IN (${marks}) ORDER BY id`)
            .all(...list)
            .map((r) => r.pinned);
    } finally {
        db.close();
    }
}

let admin = '';
let guest = '';

beforeAll(async () => {
    if (SKIP) return;
    process.env.TGDL_DATA_DIR = DATA;
    vi.resetModules();
    const db = await import('../src/core/db.js');
    for (let i = 1; i <= 4; i++) {
        db.insertDownload({
            groupId: '1',
            groupName: 'G1',
            messageId: i,
            fileName: `f${i}.jpg`,
            fileSize: 4,
            fileType: 'photo',
            filePath: `G1/images/f${i}.jpg`,
        });
    }
    for (const r of db.getDb().prepare('SELECT id FROM downloads ORDER BY id').all()) {
        ids.push(r.id);
    }
    db.getDb().close();
    delete process.env.TGDL_DATA_DIR;

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

describe.skipIf(SKIP)('POST /api/downloads/pin (e2e)', () => {
    it('pins and unpins several rows in one request, skipping unknown ids', async () => {
        const r = await api(
            'POST',
            '/api/downloads/pin',
            { ids: [ids[0], ids[1], ids[2], 999999, ids[0]], pinned: true },
            admin,
        );
        expect(r.status).toBe(200);
        expect(r.json.ids.sort((a, b) => a - b)).toEqual([ids[0], ids[1], ids[2]]);
        expect(r.json.updated).toBe(3);
        expect(pinnedOf(ids)).toEqual([1, 1, 1, 0]);

        const u = await api('POST', '/api/downloads/pin', { ids: [ids[1]], pinned: false }, admin);
        expect(u.status).toBe(200);
        expect(pinnedOf(ids)).toEqual([1, 0, 1, 0]);
    });

    it('rejects a bad body and more ids than the cap', async () => {
        expect((await api('POST', '/api/downloads/pin', { ids: [ids[0]] }, admin)).status).toBe(
            400,
        );
        expect(
            (await api('POST', '/api/downloads/pin', { ids: [], pinned: true }, admin)).status,
        ).toBe(400);
        const many = Array.from({ length: 5001 }, (_, i) => i + 1);
        expect(
            (await api('POST', '/api/downloads/pin', { ids: many, pinned: true }, admin)).status,
        ).toBe(413);
    });

    it('is admin-only', async () => {
        const r = await api('POST', '/api/downloads/pin', { ids: [ids[3]], pinned: true }, guest);
        expect(r.status).toBe(403);
        expect(pinnedOf([ids[3]])).toEqual([0]);
    });

    it('keeps the per-file route', async () => {
        const r = await api('POST', `/api/downloads/${ids[3]}/pin`, { pinned: true }, admin);
        expect(r.status).toBe(200);
        expect(pinnedOf([ids[3]])).toEqual([1]);
    });
});
