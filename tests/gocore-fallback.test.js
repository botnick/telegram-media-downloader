// Every way tgdl-core can fail must end in the Node result, with nothing
// thrown that the Node path wouldn't throw itself.
//
// Most cases use a fake tgdl-core (a local HTTP server) so they run
// everywhere; the "killed mid-request", "wrong token", "outside the
// allowed roots" and "parent died" cases also run against the real
// binary with TGDL_GO_CORE_TEST=1 (CI's "node + tgdl-core" jobs).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import readline from 'readline';

import { findOrBuildGoCore } from './helpers/gocore-bin.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-fallback-'));
const ENV_KEYS = [
    'TGDL_CORE_BIN',
    'TGDL_GO_CORE',
    'TGDL_GO_FEATURES',
    'TGDL_DATA_DIR',
    'TGDL_DOWNLOADS_DIR',
    'TGDL_CORE_ALLOW_ROOTS',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TGDL_DATA_DIR/downloads is one of the roots the app lets tgdl-core read.
const DOWNLOADS = path.join(TMP, 'data', 'downloads');
const FILE = path.join(DOWNLOADS, 'sample ไทย 🎬.bin');
const PAYLOAD = crypto.randomBytes(3 * 1024 * 1024 + 11);
const EXPECTED = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const WRONG = 'f'.repeat(64);

let client, router, checksum, spawnMod, hashWorker, metrics;
const servers = [];

function counter(name, labels) {
    const want = Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .sort()
        .join(',');
    for (const line of metrics.render().split('\n')) {
        const m = /^([a-z_]+)\{([^}]*)\} (\S+)$/.exec(line);
        if (m && m[1] === name && m[2].split(',').sort().join(',') === want) return Number(m[3]);
    }
    return 0;
}

/** A fake tgdl-core; `onHash(req, body, res)` decides what /v1/hash does. */
async function fakeCore(onHash) {
    const state = { hashCalls: 0 };
    const srv = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.setHeader('content-type', 'application/json');
            res.end(
                JSON.stringify({
                    ok: true,
                    service: 'tgdl-core',
                    version: '0.1.0',
                    features: ['hash'],
                }),
            );
            return;
        }
        let raw = '';
        req.on('data', (c) => {
            raw += c;
        });
        req.on('end', () => {
            state.hashCalls++;
            onHash(req, JSON.parse(raw || '{}'), res);
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    client.setEndpoint(`http://127.0.0.1:${srv.address().port}`, 'tok', ['hash']);
    return state;
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function statBody(p) {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
}

beforeAll(async () => {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    fs.writeFileSync(FILE, PAYLOAD);
    process.env.TGDL_DATA_DIR = path.join(TMP, 'data');
    delete process.env.TGDL_DOWNLOADS_DIR;
    delete process.env.TGDL_CORE_ALLOW_ROOTS;
    client = await import('../src/core/gocore/client.js');
    router = await import('../src/core/gocore/hash.js');
    checksum = await import('../src/core/checksum.js');
    spawnMod = await import('../src/core/gocore/spawn.js');
    hashWorker = await import('../src/core/hash-worker.js');
    ({ metrics } = await import('../src/core/metrics.js'));
});

beforeEach(() => {
    process.env.TGDL_GO_CORE = 'on';
    delete process.env.TGDL_GO_FEATURES;
    delete process.env.TGDL_CORE_BIN;
    client._resetForTests();
    router._resetForTests();
});

afterEach(async () => {
    await router._drainForTests();
    while (servers.length) {
        const s = servers.pop();
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
    spawnMod.stopGoCore();
});

afterAll(async () => {
    await hashWorker.shutdownHashPool();
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Node fallback (fake tgdl-core)', () => {
    it('binary missing: start reports it and hashing uses Node', async () => {
        process.env.TGDL_CORE_BIN = path.join(TMP, 'nope', 'tgdl-core');
        expect(await spawnMod.startGoCore()).toBe(false);
        const st = spawnMod.getGoCoreStatus();
        expect(st.state).toBe('binary_missing');
        expect(st.features.hash.active).toBe('node');
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
    });

    it('wrong token (401): Node result, counted as an error', async () => {
        const fake = await fakeCore((req, body, res) =>
            json(res, 401, { error: { code: 'EAUTH', message: 'bad token' } }),
        );
        const before = counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'error' });
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(fake.hashCalls).toBe(1);
        expect(counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'error' })).toBe(
            before + 1,
        );
        expect(router.getHashStats().fallbacks).toBe(1);
    });

    it('timeout: Node result once the deadline passes', { timeout: 15_000 }, async () => {
        router._setTuningForTests({ minTimeoutMs: 300, minBytesPerSec: 1e12 });
        await fakeCore(() => {
            /* never answers */
        });
        const before = counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'timeout' });
        const t0 = Date.now();
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(Date.now() - t0).toBeLessThan(5_000);
        expect(counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'timeout' })).toBe(
            before + 1,
        );
    });

    it('crash mid-request (socket dropped): Node result', async () => {
        await fakeCore((req) => req.socket.destroy());
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(router.getHashStats().fallbacks).toBe(1);
    });

    it('nothing listening: Node result', async () => {
        const fake = await fakeCore(() => {});
        const port = servers[0].address().port;
        await new Promise((r) => servers.pop().close(r));
        client.setEndpoint(`http://127.0.0.1:${port}`, 'tok', ['hash']);
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(fake.hashCalls).toBe(0);
    });

    it('malformed / 500 answers: Node result', async () => {
        let n = 0;
        await fakeCore((req, body, res) => {
            n++;
            if (n === 1) json(res, 200, { sha256: 'not-hex', size: 1 });
            else if (n === 2) json(res, 500, { error: { code: 'EINTERNAL', message: 'boom' } });
            else {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('garbage');
            }
        });
        for (let i = 0; i < 3; i++) expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(router.getHashStats().fallbacks).toBe(3);
    });

    it('a file error from Go (422) falls back without tripping the breaker', async () => {
        await fakeCore((req, body, res) =>
            json(res, 422, { error: { code: 'EACCES', message: 'denied' } }),
        );
        for (let i = 0; i < 6; i++) expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(client.breakerState('hash').state).toBe('closed');
    });

    it('EOUTSIDE (403): Node result, not an error, breaker untouched', async () => {
        const fake = await fakeCore((req, body, res) =>
            json(res, 403, { error: { code: 'EOUTSIDE', message: 'outside the roots' } }),
        );
        const errors = counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'error' });
        const outside = counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'outside' });
        for (let i = 0; i < 7; i++) expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(fake.hashCalls).toBe(7);
        expect(counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'error' })).toBe(
            errors,
        );
        expect(counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'outside' })).toBe(
            outside + 7,
        );
        const s = router.getHashStats();
        expect(s.outside).toBe(7);
        expect(s.fallbacks).toBe(7);
        expect(client.breakerState('hash')).toMatchObject({ state: 'closed', recentFailures: 0 });
    });

    it('shadow: EOUTSIDE is a skipped comparison, not a mismatch', async () => {
        process.env.TGDL_GO_CORE = 'shadow';
        router._setTuningForTests({ sampleEvery: 1 });
        await fakeCore((req, body, res) =>
            json(res, 403, { error: { code: 'EOUTSIDE', message: 'outside the roots' } }),
        );
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        await router._drainForTests();
        const s = router.getHashStats();
        expect(s).toMatchObject({ parityMismatches: 0, paritySkipped: 1, outside: 1 });
    });

    it('breaker: 5 failures in 60 s stop calls until a healthy probe', async () => {
        const fake = await fakeCore((req, body, res) =>
            json(res, 500, { error: { code: 'EINTERNAL', message: 'boom' } }),
        );
        for (let i = 0; i < 8; i++) expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(fake.hashCalls).toBe(5);
        expect(client.breakerState('hash').state).toBe('open');
        expect(client.isAvailable('hash')).toBe(false);
        client.markHealthy(await client.health());
        expect(client.breakerState('hash').state).toBe('closed');
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(fake.hashCalls).toBe(6);
    });

    it('a file Node cannot read fails exactly as before, without asking Go', async () => {
        const fake = await fakeCore((req, body, res) => json(res, 200, { sha256: WRONG, size: 0 }));
        const missing = path.join(TMP, 'missing.bin');
        const viaNode = await hashWorker.hashFile(missing).catch((e) => e);
        const routed = await checksum.sha256OfFileViaPool(missing).catch((e) => e);
        expect(routed).toBeInstanceOf(Error);
        expect(routed.message).toBe(viaNode.message);
        expect(fake.hashCalls).toBe(0);
    });

    it('off: Go is never called', async () => {
        process.env.TGDL_GO_CORE = 'off';
        const fake = await fakeCore((req, body, res) => json(res, 200, { sha256: WRONG, size: 0 }));
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(fake.hashCalls).toBe(0);
    });

    it('TGDL_GO_FEATURES overrides the global mode', async () => {
        process.env.TGDL_GO_CORE = 'on';
        process.env.TGDL_GO_FEATURES = 'hash=off';
        const fake = await fakeCore((req, body, res) => json(res, 200, { sha256: WRONG, size: 0 }));
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(fake.hashCalls).toBe(0);
    });

    it('shadow: Node result is returned; a Go mismatch is only counted', async () => {
        process.env.TGDL_GO_CORE = 'shadow';
        router._setTuningForTests({ sampleEvery: 1 });
        await fakeCore((req, body, res) =>
            json(res, 200, { sha256: WRONG, ...statBody(body.path) }),
        );
        const before = counter('tgdl_gocore_parity_mismatch_total', { feature: 'hash' });
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        await router._drainForTests();
        expect(counter('tgdl_gocore_parity_mismatch_total', { feature: 'hash' })).toBe(before + 1);
        expect(router.getHashStats().parityMismatches).toBe(1);
    });

    it('shadow: only ~1 in 20 files is compared, never files over 256 MB', async () => {
        process.env.TGDL_GO_CORE = 'shadow';
        const fake = await fakeCore((req, body, res) =>
            json(res, 200, { sha256: EXPECTED, ...statBody(body.path) }),
        );
        for (let i = 0; i < 40; i++) {
            expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
            await router._drainForTests();
        }
        expect(fake.hashCalls).toBe(2);
        expect(router.getHashStats().parityChecks).toBe(2);
        expect(router.SAMPLE_MAX_BYTES).toBe(256 * 1024 * 1024);
    });

    it('shadow: a file deleted before Go reads it is skipped, not a mismatch', async () => {
        process.env.TGDL_GO_CORE = 'shadow';
        router._setTuningForTests({ sampleEvery: 1 });
        await fakeCore((req, body, res) =>
            json(res, 422, { error: { code: 'ENOENT', message: 'gone' } }),
        );
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        await router._drainForTests();
        const s = router.getHashStats();
        expect(s.parityMismatches).toBe(0);
        expect(s.paritySkipped).toBe(1);
    });

    it('auto: a background Node check demotes the feature after a mismatch', async () => {
        process.env.TGDL_GO_CORE = 'auto';
        router._setTuningForTests({ sampleEvery: 1 });
        await fakeCore((req, body, res) =>
            json(res, 200, { sha256: WRONG, ...statBody(body.path) }),
        );
        // First call trusts Go (that is what auto means) …
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(WRONG);
        await router._drainForTests();
        // … the sampled Node re-check catches it and auto drops to shadow.
        expect(router.getHashStats().demoted).toBe(true);
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(router.getHashStats().active).toBe('shadow');
    });
});

describe('Node fallback (real tgdl-core)', () => {
    let bin = null;
    beforeAll(async () => {
        bin = await findOrBuildGoCore();
    }, 300_000);

    it('killed mid-request: every caller still gets the Node digest, then it restarts', {
        timeout: 60_000,
    }, async ({ skip }) => {
        if (!bin) skip();
        const big = path.join(DOWNLOADS, 'big.bin');
        const buf = crypto.randomBytes(64 * 1024 * 1024);
        fs.writeFileSync(big, buf);
        const bigHex = crypto.createHash('sha256').update(buf).digest('hex');
        process.env.TGDL_CORE_BIN = bin;
        expect(await spawnMod.startGoCore()).toBe(true);
        const { pid, restarts } = spawnMod.getGoCoreStatus();

        const jobs = [];
        for (let i = 0; i < 8; i++) jobs.push(checksum.sha256OfFileViaPool(i % 2 ? big : FILE));
        await sleep(5);
        // SIGKILL = a crash on every OS. (On Linux a plain kill is SIGTERM,
        // which tgdl-core answers with a graceful drain: the in-flight
        // hashes finish and the process is still up for a moment.)
        process.kill(pid, 'SIGKILL');
        const out = await Promise.all(jobs);
        out.forEach((hex, i) => {
            expect(hex).toBe(i % 2 ? bigHex : EXPECTED);
        });

        // The exit is observed (restart counter) and a new process comes
        // up after the backoff (2 s for the first restart).
        const deadline = Date.now() + 30_000;
        let st = spawnMod.getGoCoreStatus();
        while (!(st.state === 'running' && st.pid && st.pid !== pid) && Date.now() < deadline) {
            await sleep(25);
            st = spawnMod.getGoCoreStatus();
        }
        expect(st.restarts).toBe(restarts + 1);
        expect(st.state).toBe('running');
        expect(st.pid).not.toBe(pid);
        const goBefore = router.getHashStats().go;
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(router.getHashStats().go).toBe(goBefore + 1);
    });

    it('wrong token against the real binary: Node digest', { timeout: 30_000 }, async ({
        skip,
    }) => {
        if (!bin) skip();
        process.env.TGDL_CORE_BIN = bin;
        expect(await spawnMod.startGoCore()).toBe(true);
        const ep = client.getEndpoint();
        client.setEndpoint(ep.url, 'definitely-not-the-token', ['hash']);
        await expect(client.hashFile(FILE)).rejects.toMatchObject({ kind: 'auth', status: 401 });
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
    });

    it('a file outside the allowed roots is hashed by Node', { timeout: 30_000 }, async ({
        skip,
    }) => {
        if (!bin) skip();
        process.env.TGDL_CORE_BIN = bin;
        expect(await spawnMod.startGoCore()).toBe(true);
        const outsideFile = path.join(TMP, 'not-under-downloads.bin');
        fs.writeFileSync(outsideFile, PAYLOAD);
        await expect(client.hashFile(outsideFile)).rejects.toMatchObject({
            kind: 'outside',
            code: 'EOUTSIDE',
        });
        expect(await checksum.sha256OfFileViaPool(outsideFile)).toBe(EXPECTED);
        expect(router.getHashStats()).toMatchObject({ outside: 1, go: 0 });
        expect(client.breakerState('hash').recentFailures).toBe(0);
        // Inside still goes to Go.
        expect(await checksum.sha256OfFileViaPool(FILE)).toBe(EXPECTED);
        expect(router.getHashStats().go).toBe(1);
    });

    it('exits when its parent dies (no orphan)', { timeout: 30_000 }, async ({ skip }) => {
        if (!bin) skip();
        // An intermediate Node process spawns tgdl-core the way spawn.js
        // does (stdin pipe kept open) and is then killed outright.
        const script = `
            const { spawn } = require('child_process');
            const c = spawn(process.argv[1], ['serve'], {
                env: { ...process.env, TGDL_CORE_TOKEN: 't', TGDL_CORE_WATCH_STDIN: '1' },
                stdio: ['pipe', 'pipe', 'inherit'],
                windowsHide: true,
            });
            c.stdout.once('data', () => console.log('PID ' + c.pid));
            setInterval(() => {}, 1000);
        `;
        const parent = spawn(process.execPath, ['-e', script, bin], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const line = await new Promise((resolve, reject) => {
            const rl = readline.createInterface({ input: parent.stdout });
            rl.on('line', (l) => l.startsWith('PID ') && resolve(l));
            setTimeout(() => reject(new Error('no PID line')), 15_000);
        });
        const goPid = Number(line.slice(4));
        const alive = (pid) => {
            try {
                process.kill(pid, 0);
            } catch {
                return false;
            }
            // An exited orphan can linger as a zombie until init reaps it.
            try {
                return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
            } catch {
                return true;
            }
        };
        expect(alive(goPid)).toBe(true);
        parent.kill('SIGKILL');
        const t0 = Date.now();
        while (alive(goPid) && Date.now() - t0 < 10_000) await sleep(50);
        expect(alive(goPid)).toBe(false);
    });
});
