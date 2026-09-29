// Supervision of the tgdl-core front server by the Node process.
//
//   - tgdl-core killed: Node restarts it; the dashboard is back within a
//     second and /api/auth_check (the Docker healthcheck) answers.
//   - tgdl-core dying over and over (5 times in a minute): Node stops
//     restarting it, binds PORT itself, logs why and the dashboard banner
//     says so.
//   - PORT already taken: the process exits with the same fatal message
//     as before (no silent fallback).
//
// Uses the tree's tgdl-core build (tests/setup/gocore.global.js).

import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testCoreBin } from './helpers/gocore-bin.js';
import {
    freePort,
    makeDataDir,
    REPO,
    rawRequest,
    seedParity,
    startServer,
    stopServer,
} from './helpers/front-server.js';

const SKIP = process.env.TGDL_SKIP_E2E === '1';
const ADMIN = { Cookie: `tg_dl_session=${'a'.repeat(64)}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bin = null;
let resolved = false;

async function health(port) {
    const r = await rawRequest(port, { path: '/api/system/health?front=1', headers: ADMIN });
    return JSON.parse(r.body).goCoreFront;
}

async function waitFor(fn, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await fn();
            if (last) return last;
        } catch (e) {
            last = e;
        }
        await sleep(50);
    }
    throw new Error(`timed out (${last?.message || last})`);
}

beforeAll(async () => {
    if (SKIP) return;
    bin = testCoreBin(); // the tree's build (tests/setup/gocore.global.js)
    resolved = true;
}, 300_000);

describe.skipIf(SKIP)('tgdl-core front server supervision', () => {
    let srv;
    let dataDir;

    afterAll(async () => {
        await stopServer(srv);
    });

    it('restarts a killed front server; auth_check keeps answering', async () => {
        if (!resolved || !bin) return;
        dataDir = makeDataDir('tgdl-front-sup-');
        seedParity(dataDir);
        const port = await freePort();
        // The second case needs the fallback that TGDL_FRONT_REQUIRED (CI) disables.
        srv = await startServer({
            dataDir,
            port,
            env: { TGDL_CORE_BIN: bin, TGDL_FRONT_REQUIRED: '' },
        });
        const h0 = await health(port);
        expect(h0.state).toBe('running');

        const killedAt = Date.now();
        process.kill(h0.pid);
        const h1 = await waitFor(async () => {
            const h = await health(port);
            return h.state === 'running' && h.pid !== h0.pid ? h : null;
        });
        const gapMs = Date.now() - killedAt;
        // h1.since: when Node saw the new process bound to PORT. (gapMs also
        // includes how long this client's refused connects took to fail.)
        console.log(
            `front server back on PORT ${h1.since - killedAt} ms after the kill (restarts: ${h1.restarts}; client saw it after ${gapMs} ms)`,
        );
        expect(h1.restarts).toBeGreaterThanOrEqual(1);
        expect(gapMs).toBeLessThan(5_000);
        expect((await rawRequest(port, { path: '/api/auth_check' })).status).toBe(200);
        const f = await rawRequest(port, { path: '/files/G1/videos/clip.mp4', headers: ADMIN });
        expect(f.status).toBe(200);
    }, 60_000);

    it('gives up after repeated exits and serves PORT from Node, with a banner', async () => {
        if (!resolved || !bin || !srv) return;
        const port = srv.port;
        for (let i = 0; i < 6; i++) {
            const h = await waitFor(async () => {
                const x = await health(port);
                return x.state === 'running' || x.state === 'gave_up' ? x : null;
            });
            if (h.state === 'gave_up') break;
            process.kill(h.pid);
            await waitFor(async () => (await health(port)).pid !== h.pid);
        }
        const h = await waitFor(async () => {
            const x = await health(port);
            return x.state === 'gave_up' && x.servedByNode ? x : null;
        });
        expect(h.servedByNode).toMatch(/failed \d+ times/);
        expect((await rawRequest(port, { path: '/api/auth_check' })).status).toBe(200);
        const page = await rawRequest(port, { path: '/', headers: ADMIN });
        expect(page.status).toBe(200);
        // The dashboard banner says why.
        const mon = JSON.parse(
            (await rawRequest(port, { path: '/api/monitor/status', headers: ADMIN })).body,
        );
        expect(mon.core?.state).toBe('front_down');
        // Media still works — Node streams it itself now.
        const f = await rawRequest(port, {
            path: '/files/G1/videos/clip.mp4',
            headers: { ...ADMIN, Range: 'bytes=0-9' },
        });
        expect(f.status).toBe(206);
        expect(f.headers['content-range']).toBe('bytes 0-9/262144');
        expect(srv.log()).toMatch(/giving up on tgdl-core front/);
    }, 90_000);

    it('PORT already in use: exits with the same fatal message as before', async () => {
        if (!resolved || !bin) return;
        const blocker = net.createServer();
        const port = await freePort();
        await new Promise((r) => blocker.listen(port, r));
        try {
            const dir = makeDataDir('tgdl-front-busy-');
            seedParity(dir);
            const child = spawn(process.execPath, [path.join(REPO, 'src', 'web', 'server.js')], {
                cwd: REPO,
                env: {
                    ...process.env,
                    PORT: String(port),
                    TGDL_DATA_DIR: dir,
                    TGDL_CORE_BIN: bin,
                    TGDL_GO_CORE: 'off',
                    NODE_ENV: 'test',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            child.stdout.on('data', (d) => {
                out += d;
            });
            child.stderr.on('data', (d) => {
                out += d;
            });
            const code = await new Promise((r) => child.on('exit', r));
            expect(code).toBe(1);
            expect(out).toContain(`[fatal] Port ${port} is already in use.`);
        } finally {
            blocker.close();
        }
    }, 60_000);
});
