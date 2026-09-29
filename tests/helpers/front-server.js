// Start / stop src/web/server.js on a seeded data dir for the front-server
// suites and scripts/front-parity.js.

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

import { PARITY_SHARE_SECRET, runAll } from './front-parity.js';

export const REPO = path.resolve(import.meta.dirname, '..', '..');
const SEED = path.join(REPO, 'tests', 'helpers', 'front-parity-seed.js');
const SERVER = path.join(REPO, 'src', 'web', 'server.js');

export function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

/**
 * Seed `dir` with the parity data set (files, rows, sessions, config).
 * `webPatch` is merged into config.web (a null value deletes the key).
 */
export function seedParity(dir, webPatch = {}) {
    const r = spawnSync(process.execPath, [SEED, dir, JSON.stringify(webPatch)], {
        encoding: 'utf8',
        cwd: REPO,
    });
    if (r.status !== 0) throw new Error(`seed failed: ${r.stderr || r.stdout}`);
}

export function makeDataDir(prefix = 'tgdl-front-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Spawn the server and wait until GET /api/auth_check answers 200 on PORT.
 * Resolves `{ child, port, log() }`.
 */
export async function startServer({ dataDir, port, env = {}, timeoutMs = 60_000 }) {
    const child = spawn(process.execPath, [SERVER], {
        cwd: REPO,
        env: {
            ...process.env,
            PORT: String(port),
            TGDL_DATA_DIR: dataDir,
            NODE_ENV: 'test',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => {
        log += d;
    });
    child.stderr.on('data', (d) => {
        log += d;
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
        try {
            const r = await fetch(`http://127.0.0.1:${port}/api/auth_check`);
            if (r.status === 200) return { child, port, log: () => log };
        } catch {}
        await new Promise((r) => setTimeout(r, 150));
    }
    child.kill();
    throw new Error(`server did not come up:\n${log}`);
}

export async function stopServer(s) {
    if (!s?.child || s.child.exitCode !== null) return;
    await new Promise((resolve) => {
        s.child.once('exit', resolve);
        s.child.kill();
        setTimeout(resolve, 5000).unref();
    });
}

/** Admin + guest file tokens signed with the parity share secret. */
export async function parityFileTokens() {
    const share = await import('../../src/core/share.js');
    share.ensureShareSecret({ web: { shareSecret: PARITY_SHARE_SECRET } });
    return {
        fileTokenAdmin: share.mintFileToken(3600, 'admin').token,
        fileTokenGuest: share.mintFileToken(3600, 'guest').token,
    };
}

/** Seed, start, run every parity case, stop. Returns `{ [name]: result }`. */
export async function runParityOnce(env = {}) {
    const dataDir = makeDataDir('tgdl-front-parity-');
    seedParity(dataDir);
    const port = await freePort();
    const srv = await startServer({ dataDir, port, env });
    try {
        return await runAll(port, await parityFileTokens());
    } finally {
        await stopServer(srv);
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    }
}

/** A non-loopback IPv4 address of this machine (a "remote" client), or null. */
export function lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
                return a.address;
            }
        }
    }
    return null;
}

/** Path to a tgdl-core that doesn't exist: the app serves PORT itself. */
export const NO_CORE_BIN = path.join(os.tmpdir(), 'tgdl-no-such-dir', 'tgdl-core');

/**
 * Two instances on identically seeded data dirs: `front` (tgdl-core on
 * PORT, `bin` if given) and `node` (no tgdl-core: Node on PORT itself, i.e.
 * the pre-front behaviour).
 */
export async function startPair({ webPatch = {}, env = {}, bin = null } = {}) {
    const boot = async (extra) => {
        const dataDir = makeDataDir('tgdl-front-pair-');
        seedParity(dataDir, webPatch);
        const port = await freePort();
        const s = await startServer({ dataDir, port, env: { ...env, ...extra } });
        return { ...s, dataDir };
    };
    const front = await boot(bin ? { TGDL_CORE_BIN: bin } : {});
    const node = await boot({ TGDL_CORE_BIN: NO_CORE_BIN, TGDL_FRONT_REQUIRED: '' });
    return {
        front,
        node,
        async close() {
            for (const s of [front, node]) {
                await stopServer(s);
                fs.rmSync(s.dataDir, { recursive: true, force: true, maxRetries: 5 });
            }
        },
    };
}

/**
 * One raw HTTP request. `host` / `localAddress` pick the connection's
 * endpoints (a LAN address makes the client non-local). Resolves
 * `{ status, headers, body }` with lower-case header names.
 */
export function rawRequest(
    port,
    { host = '127.0.0.1', localAddress, method = 'GET', path: p = '/', headers = {}, body } = {},
) {
    return new Promise((resolve, reject) => {
        const data =
            body === undefined
                ? null
                : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const h = { Host: `localhost:${port}`, ...headers };
        if (data) {
            h['Content-Length'] = String(data.length);
            if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
                h['Content-Type'] = 'application/json';
            }
        }
        const req = http.request(
            { host, port, localAddress, method, path: p, headers: h, agent: false },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    }),
                );
                res.on('error', reject);
            },
        );
        req.setTimeout(20_000, () => req.destroy(new Error(`timeout ${method} ${p}`)));
        req.on('error', reject);
        req.end(data || undefined);
    });
}

/** Node's loopback port behind a front server, from its startup log. */
export function upstreamPort(s) {
    const m = /upstream=127\.0\.0\.1:(\d+)/.exec(s.log());
    return m ? Number(m[1]) : null;
}
