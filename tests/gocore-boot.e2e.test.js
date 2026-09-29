// Boot with tgdl-core unavailable: the dashboard must come up exactly as
// before, and /api/auth_check must answer right away.
//
//   1. TGDL_GO_CORE unset (default shadow) and no binary
//      (TGDL_CORE_BIN points nowhere).
//   2. TGDL_GO_CORE unset, TGDL_CORE_BIN unset, and the release download
//      hangs forever (TGDL_CORE_RELEASE_URL → a server that never
//      answers). In a tree with `npm run build:core` output the dev binary
//      is found first instead; either way boot must not wait.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'web', 'server.js');
const SKIP = process.env.TGDL_SKIP_E2E === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let hangServer;
let hangUrl;
const children = [];
const dirs = [];

beforeAll(async () => {
    if (SKIP) return;
    hangServer = http.createServer(() => {
        /* never answers */
    });
    await new Promise((r) => hangServer.listen(0, '127.0.0.1', r));
    hangUrl = `http://127.0.0.1:${hangServer.address().port}`;
});

afterAll(async () => {
    for (const c of children) {
        try {
            c.kill('SIGTERM');
        } catch {}
    }
    hangServer?.closeAllConnections?.();
    await new Promise((r) => (hangServer ? hangServer.close(r) : r()));
    await sleep(800);
    for (const d of dirs) {
        try {
            fs.rmSync(d, { recursive: true, force: true });
        } catch {}
    }
}, 30_000);

async function bootServer(extraEnv) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-boot-'));
    dirs.push(dataDir);
    const port = await freePort();
    const env = { ...process.env, ...extraEnv, PORT: String(port), TGDL_DATA_DIR: dataDir };
    delete env.TGDL_GO_CORE;
    delete env.TGDL_GO_FEATURES;
    for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
    env.NODE_ENV = 'test';
    const t0 = Date.now();
    const child = spawn(process.execPath, [SERVER_PATH], {
        env,
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let log = '';
    child.stdout.on('data', (c) => {
        log += c;
    });
    child.stderr.on('data', (c) => {
        log += c;
    });
    const base = `http://127.0.0.1:${port}`;
    let upAt = null;
    for (let i = 0; i < 240 && upAt === null; i++) {
        try {
            const r = await fetch(`${base}/api/auth_check`);
            if (r.status === 200) upAt = Date.now();
        } catch {
            await sleep(100);
        }
    }
    if (upAt === null) throw new Error(`server did not boot:\n${log}`);
    return { child, base, bootMs: upAt - t0, log: () => log };
}

async function login(base) {
    const post = (url, body, cookie = '') =>
        fetch(base + url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify(body),
        });
    expect((await post('/api/auth/setup', { password: 'boot-test-password-1' })).status).toBe(200);
    const r = await post('/api/login', { password: 'boot-test-password-1' });
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie').split(';')[0];
}

async function authCheckLatencies(base, n = 10) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const t = performance.now();
        const r = await fetch(`${base}/api/auth_check`);
        await r.arrayBuffer();
        expect(r.status).toBe(200);
        out.push(performance.now() - t);
    }
    return out;
}

describe.skipIf(SKIP)('boot without a usable tgdl-core', () => {
    it('no binary: boots normally, auth_check answers at once, Node hashes', {
        timeout: 90_000,
    }, async () => {
        const s = await bootServer({
            TGDL_CORE_BIN: path.join(os.tmpdir(), 'tgdl-no-such-dir', 'tgdl-core'),
        });
        expect(s.bootMs).toBeLessThan(30_000);
        const lat = await authCheckLatencies(s.base);
        expect(Math.max(...lat)).toBeLessThan(500);

        const cookie = await login(s.base);
        const h = await (
            await fetch(`${s.base}/api/system/health`, { headers: { cookie } })
        ).json();
        // Existing fields untouched, goCore added.
        for (const k of ['process', 'system', 'disk', 'database', 'connections']) {
            expect(h).toHaveProperty(k);
        }
        expect(h.goCore.mode).toBe('shadow');
        expect(h.goCore.modeSource).toBe('default');
        expect(h.goCore.state).toBe('binary_missing');
        expect(h.goCore.features.hash.active).toBe('node');
    });

    it('download hanging (or dev binary present): boot and auth_check unaffected', {
        timeout: 90_000,
    }, async () => {
        const s = await bootServer({
            TGDL_CORE_BIN: undefined,
            TGDL_CORE_RELEASE_URL: hangUrl,
        });
        expect(s.bootMs).toBeLessThan(30_000);
        const lat = await authCheckLatencies(s.base);
        expect(Math.max(...lat)).toBeLessThan(500);

        const cookie = await login(s.base);
        const h = await (
            await fetch(`${s.base}/api/system/health`, { headers: { cookie } })
        ).json();
        expect(['downloading', 'starting', 'running']).toContain(h.goCore.state);
    });
});
