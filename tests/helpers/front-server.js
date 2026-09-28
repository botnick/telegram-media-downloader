// Start / stop src/web/server.js on a seeded data dir for the front-server
// suites and scripts/front-parity.js.

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
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

/** Seed `dir` with the parity data set (files, rows, sessions, config). */
export function seedParity(dir) {
    const r = spawnSync(process.execPath, [SEED, dir], { encoding: 'utf8', cwd: REPO });
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
            TGDL_DISABLE_AUTOSTART: '1',
            TGDL_GO_CORE: 'off',
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
