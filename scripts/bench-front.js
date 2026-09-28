#!/usr/bin/env node
/**
 * Benchmark the tgdl-core front server against Node answering PORT itself.
 *
 *   node scripts/bench-front.js [--size-mb 1024] [--requests 300] [--json out.json]
 *
 * For each mode — `front` (tgdl-core on PORT, the default) and `node`
 * (no tgdl-core: Node on PORT, the pre-front behaviour) — on the parity
 * seed plus one large video:
 *
 *   1. video Range throughput: the whole file in 4 MiB ranges, 1 client
 *      and 4 clients in parallel (what a player + prefetch does);
 *   2. time to first byte of /files (64 KiB range) and /api/thumbs/:id
 *      cache hits, idle and while Node's event loop is blocked 90 % of the
 *      time (a CPU burn preloaded into the server, scripts/bench/burn-hook.mjs);
 *   3. resident memory of the Node and tgdl-core processes, idle and at
 *      the end of the throughput run.
 *
 * Needs a tgdl-core binary for the `front` mode (npm run build:core, or
 * TGDL_CORE_BIN).
 */

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import {
    NO_CORE_BIN,
    REPO,
    freePort,
    makeDataDir,
    seedParity,
} from '../tests/helpers/front-server.js';

const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
};
const SIZE_MB = Number(arg('--size-mb', 1024));
const REQUESTS = Number(arg('--requests', 300));
const JSON_OUT = arg('--json', null);
const CHUNK = 4 * 1024 * 1024;
const ADMIN = `tg_dl_session=${'a'.repeat(64)}`;
const BURN = { busyMs: 450, everyMs: 500 };
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });

function bigVideo(dataDir) {
    const p = path.join(dataDir, 'downloads', 'G1', 'videos', 'big.mp4');
    const block = Buffer.alloc(1 << 20);
    for (let i = 0; i < block.length; i++) block[i] = (i * 7 + (i >> 9)) & 255;
    const fd = fs.openSync(p, 'w');
    for (let i = 0; i < SIZE_MB; i++) fs.writeSync(fd, block);
    fs.closeSync(fd);
    return '/files/G1/videos/big.mp4';
}

function get(port, p, headers = {}) {
    return new Promise((resolve, reject) => {
        const t0 = process.hrtime.bigint();
        const req = http.get(
            { host: '127.0.0.1', port, path: p, headers: { Cookie: ADMIN, ...headers }, agent },
            (res) => {
                const ttfb = Number(process.hrtime.bigint() - t0) / 1e6;
                let bytes = 0;
                res.on('data', (c) => {
                    bytes += c.length;
                });
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        bytes,
                        ttfb,
                        total: Number(process.hrtime.bigint() - t0) / 1e6,
                    }),
                );
                res.on('error', reject);
            },
        );
        req.on('error', reject);
    });
}

function rssKb(pid) {
    try {
        if (process.platform === 'win32') {
            const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
                encoding: 'utf8',
            });
            const m = /"([\d,.\s]+) K"/.exec(out);
            return m ? Number(m[1].replace(/[^\d]/g, '')) : null;
        }
        const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const m = /VmRSS:\s+(\d+) kB/.exec(s);
        if (m) return Number(m[1]);
        return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }));
    } catch {
        return null;
    }
}

async function start(mode, dataDir) {
    const port = await freePort();
    const env = {
        ...process.env,
        PORT: String(port),
        TGDL_DATA_DIR: dataDir,
        NODE_ENV: 'test',
        TGDL_DISABLE_AUTOSTART: '1',
        TGDL_GO_CORE: 'off',
    };
    if (mode === 'node') env.TGDL_CORE_BIN = NO_CORE_BIN;
    const hook = pathToFileURL(path.join(REPO, 'scripts', 'bench', 'burn-hook.mjs')).href;
    const child = spawn(
        process.execPath,
        ['--import', hook, path.join(REPO, 'src', 'web', 'server.js')],
        { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let log = '';
    child.stdout.on('data', (d) => {
        log += d;
    });
    child.stderr.on('data', (d) => {
        log += d;
    });
    for (let i = 0; i < 300; i++) {
        try {
            const r = await get(port, '/api/auth_check');
            if (r.status === 200) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
    }
    const h = await new Promise((resolve) => {
        http.get(
            { host: '127.0.0.1', port, path: '/api/system/health', headers: { Cookie: ADMIN } },
            (res) => {
                let b = '';
                res.on('data', (c) => {
                    b += c;
                });
                res.on('end', () => resolve(JSON.parse(b)));
            },
        );
    });
    const front = h.goCoreFront;
    if (mode === 'front' && front?.state !== 'running') {
        throw new Error(`front server not running: ${JSON.stringify(front)}\n${log}`);
    }
    return {
        port,
        child,
        nodePid: child.pid,
        goPid: mode === 'front' ? front.pid : null,
        burn: (on) =>
            new Promise((resolve) => {
                child.once('message', resolve);
                child.send({ burn: on ? BURN : null });
            }),
        log: () => log,
    };
}

function stats(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return {
        p50: +q(0.5).toFixed(2),
        p95: +q(0.95).toFixed(2),
        p99: +q(0.99).toFixed(2),
        max: +s[s.length - 1].toFixed(2),
    };
}

async function throughput(port, url, size, clients) {
    const ranges = [];
    for (let off = 0; off < size; off += CHUNK) {
        ranges.push(`bytes=${off}-${Math.min(size, off + CHUNK) - 1}`);
    }
    let next = 0;
    let bytes = 0;
    const t0 = process.hrtime.bigint();
    await Promise.all(
        Array.from({ length: clients }, async () => {
            while (next < ranges.length) {
                const r = await get(port, url, { Range: ranges[next++] });
                if (r.status !== 206) throw new Error(`range status ${r.status}`);
                bytes += r.bytes;
            }
        }),
    );
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    return +(bytes / sec / 1e6).toFixed(0); // MB/s
}

// Closed loop (one request after another) when idle. Busy: open loop — a
// request starts every OPEN_LOOP_MS whether or not the previous one has
// answered, like a player's chunk requests, so the samples cover the whole
// burn cycle instead of bunching up in its gaps.
const OPEN_LOOP_MS = 25;
async function ttfb(port, url, headers = {}, { openLoop = false } = {}) {
    const one = async () => {
        const r = await get(port, url, headers);
        if (r.status >= 400) throw new Error(`${url}: ${r.status}`);
        return r.ttfb;
    };
    if (!openLoop) {
        const xs = [];
        for (let i = 0; i < REQUESTS; i++) xs.push(await one());
        return stats(xs);
    }
    const jobs = [];
    for (let i = 0; i < REQUESTS; i++) {
        jobs.push(one());
        await new Promise((r) => setTimeout(r, OPEN_LOOP_MS));
    }
    return stats(await Promise.all(jobs));
}

async function runMode(mode) {
    const dataDir = makeDataDir(`tgdl-bench-${mode}-`);
    seedParity(dataDir);
    const video = bigVideo(dataDir);
    const size = SIZE_MB * 1024 * 1024;
    const s = await start(mode, dataDir);
    const out = { mode };
    try {
        // Node blocks its loop for ~2.7 s a moment after boot (on main too);
        // let that pass before measuring.
        await new Promise((r) => setTimeout(r, 6000));
        out.memIdleKb = { node: rssKb(s.nodePid), go: s.goPid ? rssKb(s.goPid) : null };

        // warm the page cache
        await throughput(s.port, video, size, 4);
        out.throughputMBs = {
            oneClient: await throughput(s.port, video, size, 1),
            fourClients: await throughput(s.port, video, size, 4),
        };
        out.memAfterStreamKb = { node: rssKb(s.nodePid), go: s.goPid ? rssKb(s.goPid) : null };

        const r64 = { Range: 'bytes=0-65535' };
        out.ttfbIdleMs = {
            files: await ttfb(s.port, video, r64),
            thumbs: await ttfb(s.port, '/api/thumbs/1'),
            authCheck: await ttfb(s.port, '/api/auth_check'),
        };

        await s.burn(true);
        await new Promise((r) => setTimeout(r, BURN.everyMs + 100));
        out.ttfbBusyMs = {
            files: await ttfb(s.port, video, r64, { openLoop: true }),
            thumbs: await ttfb(s.port, '/api/thumbs/1', {}, { openLoop: true }),
        };
        out.throughputBusyMBs = { oneClient: await throughput(s.port, video, size, 1) };
        await s.burn(false);
    } finally {
        s.child.kill();
        await new Promise((r) => setTimeout(r, 1000));
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    }
    return out;
}

const env = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    sizeMB: SIZE_MB,
    requests: REQUESTS,
    burn: BURN,
};
const results = [];
for (const mode of ['node', 'front']) {
    console.error(`[bench] ${mode}…`);
    results.push(await runMode(mode));
}
agent.destroy();
const doc = { env, results };
console.log(JSON.stringify(doc, null, 2));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(doc, null, 2)}\n`);
