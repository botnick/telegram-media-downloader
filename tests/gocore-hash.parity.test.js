// Go (tgdl-core) vs Node SHA-256 parity.
//
// Every file is hashed by crypto.createHash (reference), the Node
// streamer (checksum.sha256OfFile), the worker pool (hash-worker.hashFile)
// and tgdl-core (POST /v1/hash); all four must agree exactly. Then the
// routed path (sha256OfFileViaPool) is checked in `on` and `shadow` modes.
//
// Runs with TGDL_GO_CORE_TEST=1 (CI's "node + tgdl-core" jobs); skipped
// otherwise. The files live under the data dir's downloads folder, which
// the app passes to tgdl-core as an allowed root.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findOrBuildGoCore } from './helpers/gocore-bin.js';

const MiB = 1024 * 1024;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-parity-'));
// TGDL_DATA_DIR/downloads is an allowed root; OUTSIDE is not.
const DOWNLOADS = path.join(TMP, 'data', 'downloads');
const OUTSIDE = path.join(TMP, 'elsewhere');
const ENV_KEYS = [
    'TGDL_CORE_BIN',
    'TGDL_GO_CORE',
    'TGDL_GO_FEATURES',
    'TGDL_DATA_DIR',
    'TGDL_DOWNLOADS_DIR',
    'TGDL_CORE_ALLOW_ROOTS',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let bin = null;
let spawnMod, client, router, checksum, hashWorker;
const files = []; // { name, abs, size, expected }

function addFile(rel, buf) {
    const abs = path.join(DOWNLOADS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    files.push({ name: rel, abs, size: buf.length, expected });
}

function patterned(n, seed) {
    const b = Buffer.allocUnsafe(n);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        b[i] = x & 0xff;
    }
    return b;
}

beforeAll(async () => {
    bin = await findOrBuildGoCore();
    if (!bin) return;
    addFile('empty.bin', Buffer.alloc(0));
    addFile('one.bin', Buffer.from([0x42]));
    addFile('exact-1MiB.bin', patterned(MiB, 1));
    addFile('1MiB-minus-1.bin', patterned(MiB - 1, 2));
    addFile('1MiB-plus-1.bin', patterned(MiB + 1, 3));
    addFile('large-50MB.bin', crypto.randomBytes(50 * 1000 * 1000));
    addFile('ไฟล์ทดสอบภาษาไทย.jpg', patterned(4096, 4));
    addFile('🎬 clip 😀 ✨.mp4', patterned(70_000, 5));
    addFile(path.join('โฟลเดอร์ 📁', 'ซ้อน 🎉.png'), patterned(12_345, 6));
    // Past Windows' MAX_PATH (260).
    let deep = '';
    while (path.join(DOWNLOADS, deep).length < 300) {
        deep = path.join(deep, `segment-${'x'.repeat(30)}`);
    }
    addFile(path.join(deep, 'long-path-ยาว.bin'), patterned(3 * MiB + 17, 7));

    process.env.TGDL_CORE_BIN = bin;
    process.env.TGDL_GO_CORE = 'on';
    delete process.env.TGDL_GO_FEATURES;
    delete process.env.TGDL_DOWNLOADS_DIR;
    delete process.env.TGDL_CORE_ALLOW_ROOTS;
    process.env.TGDL_DATA_DIR = path.join(TMP, 'data');

    spawnMod = await import('../src/core/gocore/spawn.js');
    client = await import('../src/core/gocore/client.js');
    router = await import('../src/core/gocore/hash.js');
    checksum = await import('../src/core/checksum.js');
    hashWorker = await import('../src/core/hash-worker.js');
    router._resetForTests();
    client._resetForTests();
    const ok = await spawnMod.startGoCore();
    if (!ok)
        throw new Error(`tgdl-core did not start: ${JSON.stringify(spawnMod.getGoCoreStatus())}`);
}, 300_000);

afterAll(async () => {
    try {
        spawnMod?.stopGoCore();
    } catch {}
    try {
        await hashWorker?.shutdownHashPool();
    } catch {}
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe('tgdl-core hash parity with Node', () => {
    it('has a long path over 260 characters in the set', ({ skip }) => {
        if (!bin) skip();
        expect(Math.max(...files.map((f) => f.abs.length))).toBeGreaterThan(260);
    });

    it('Go, the Node streamer and the worker pool agree byte for byte', {
        timeout: 120_000,
    }, async ({ skip }) => {
        if (!bin) skip();
        for (const f of files) {
            const [streamer, pool, go] = await Promise.all([
                checksum.sha256OfFile(f.abs),
                hashWorker.hashFile(f.abs),
                client.hashFile(f.abs, { timeoutMs: 60_000 }),
            ]);
            expect(streamer, f.name).toBe(f.expected);
            expect(pool, f.name).toBe(f.expected);
            expect(go.sha256, f.name).toBe(f.expected);
            expect(go.size, f.name).toBe(f.size);
            const st = fs.statSync(f.abs);
            expect(Math.abs(go.mtimeMs - st.mtimeMs), f.name).toBeLessThan(1);
        }
    });

    it('routes sha256OfFileViaPool to Go in `on` mode', { timeout: 120_000 }, async ({ skip }) => {
        if (!bin) skip();
        const before = router.getHashStats();
        for (const f of files) {
            expect(await checksum.sha256OfFileViaPool(f.abs), f.name).toBe(f.expected);
        }
        const after = router.getHashStats();
        expect(after.go - before.go).toBe(files.length);
        expect(after.fallbacks).toBe(before.fallbacks);
    });

    it('stays correct under concurrent load', { timeout: 120_000 }, async ({ skip }) => {
        if (!bin) skip();
        const jobs = [];
        for (let i = 0; i < 4; i++) for (const f of files) jobs.push(f);
        const out = await Promise.all(jobs.map((f) => checksum.sha256OfFileViaPool(f.abs)));
        out.forEach((hex, i) => {
            expect(hex, jobs[i].name).toBe(jobs[i].expected);
        });
    });

    it('shadow mode returns Node digests and records zero mismatches', {
        timeout: 120_000,
    }, async ({ skip }) => {
        if (!bin) skip();
        process.env.TGDL_GO_CORE = 'shadow';
        try {
            router._setTuningForTests({ sampleEvery: 1 });
            const before = router.getHashStats();
            for (const f of files) {
                expect(await checksum.sha256OfFileViaPool(f.abs), f.name).toBe(f.expected);
                await router._drainForTests();
            }
            const after = router.getHashStats();
            // Every file ≤ 256 MB is sampled and compared.
            expect(after.parityChecks - before.parityChecks).toBe(files.length);
            expect(after.parityMismatches).toBe(0);
            expect(after.go).toBe(before.go);
        } finally {
            process.env.TGDL_GO_CORE = 'on';
            router._setTuningForTests({ sampleEvery: 20 });
        }
    });

    it('only reads inside its allowed roots; Node hashes the rest', async ({ skip }) => {
        if (!bin) skip();
        expect(spawnMod.getGoCoreStatus().allowRoots).toContain(path.resolve(DOWNLOADS));
        fs.mkdirSync(OUTSIDE, { recursive: true });
        const outsideFile = path.join(OUTSIDE, 'not-a-download.bin');
        const buf = patterned(10_000, 9);
        fs.writeFileSync(outsideFile, buf);
        const want = crypto.createHash('sha256').update(buf).digest('hex');
        await expect(client.hashFile(outsideFile)).rejects.toMatchObject({
            kind: 'outside',
            code: 'EOUTSIDE',
            status: 403,
        });
        // `..` out of the root is refused the same way.
        await expect(
            client.hashFile(path.join(DOWNLOADS, '..', '..', 'elsewhere', 'not-a-download.bin')),
        ).rejects.toMatchObject({ code: 'EOUTSIDE' });
        const before = router.getHashStats();
        expect(await checksum.sha256OfFileViaPool(outsideFile)).toBe(want);
        const after = router.getHashStats();
        expect(after.outside - before.outside).toBe(1);
        expect(after.fallbacks - before.fallbacks).toBe(1);
        expect(client.breakerState('hash').recentFailures).toBe(0);
    });

    it('reports the same failure as Node for a missing file', async ({ skip }) => {
        if (!bin) skip();
        const missing = path.join(DOWNLOADS, 'does-not-exist.bin');
        const nodeErr = await checksum.sha256OfFile(missing).catch((e) => e);
        const routedErr = await checksum.sha256OfFileViaPool(missing).catch((e) => e);
        expect(nodeErr.code).toBe('ENOENT');
        // The worker pool forwards only the message; that is unchanged.
        expect(routedErr.message).toMatch(/ENOENT/);
        await expect(client.hashFile(missing)).rejects.toMatchObject({
            kind: 'file',
            code: 'ENOENT',
        });
        await expect(client.hashFile(DOWNLOADS)).rejects.toMatchObject({
            kind: 'file',
            code: 'EISDIR',
        });
    });
});
