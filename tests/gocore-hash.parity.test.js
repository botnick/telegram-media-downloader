// SHA-256 is computed by tgdl-core only. Every digest must equal
// crypto.createHash('sha256') over the file (the reference the removed
// worker pool used), and a file that can't be read must fail the way fs
// would (same err.code and message).
//
// The files live under the data dir's downloads folder, which the app
// passes to tgdl-core as an allowed root; one lives outside, which the app
// hashes in-process (EOUTSIDE) — also with the same digest.

import crypto from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';

const MiB = 1024 * 1024;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-parity-'));
const DOWNLOADS = path.join(TMP, 'data', 'downloads');
const OUTSIDE = path.join(TMP, 'elsewhere');

let spawnMod;
let client;
let checksum;
let metrics;
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

/** What the removed Node paths did: stream through crypto. */
function nodeStreamHash(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = createReadStream(p);
        s.on('error', reject);
        s.on('data', (c) => h.update(c));
        s.on('end', () => resolve(h.digest('hex')));
    });
}

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

beforeAll(async () => {
    requireCoreBin();
    addFile('empty.bin', Buffer.alloc(0));
    addFile('one.bin', Buffer.from([0x42]));
    addFile('exact-1MiB.bin', patterned(MiB, 1));
    addFile('1MiB-minus-1.bin', patterned(MiB - 1, 2));
    addFile('1MiB-plus-1.bin', patterned(MiB + 1, 3));
    addFile('large-50MB.bin', crypto.randomBytes(50 * 1000 * 1000));
    addFile('ไฟล์ทดสอบภาษาไทย.jpg', patterned(4096, 4));
    addFile('🎬 clip 😀 ✨.mp4', patterned(70_000, 5));
    addFile(path.join('โฟลเดอร์ 📁', 'ซ้อน 🎉.png'), patterned(12_345, 6));
    let deep = '';
    while (path.join(DOWNLOADS, deep).length < 300)
        deep = path.join(deep, `segment-${'x'.repeat(30)}`);
    addFile(path.join(deep, 'long-path-ยาว.bin'), patterned(3 * MiB + 17, 7));

    delete process.env.TGDL_DOWNLOADS_DIR;
    delete process.env.TGDL_CORE_ALLOW_ROOTS;
    process.env.TGDL_DATA_DIR = path.join(TMP, 'data');
    spawnMod = await import('../src/core/gocore/spawn.js');
    client = await import('../src/core/gocore/client.js');
    checksum = await import('../src/core/checksum.js');
    ({ metrics } = await import('../src/core/metrics.js'));
    const ok = await spawnMod.startGoCore();
    if (!ok)
        throw new Error(`tgdl-core did not start: ${JSON.stringify(spawnMod.getGoCoreStatus())}`);
}, 300_000);

afterAll(async () => {
    spawnMod?.stopGoCore();
    delete process.env.TGDL_DATA_DIR;
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(TMP, { recursive: true, force: true });
});

describe('tgdl-core SHA-256', () => {
    it('includes a path over 260 characters', () => {
        expect(Math.max(...files.map((f) => f.abs.length))).toBeGreaterThan(260);
    });

    it('equals crypto.createHash over the file, byte for byte', { timeout: 120_000 }, async () => {
        const before = counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'ok' });
        for (const f of files) {
            const [viaApp, reference, raw] = await Promise.all([
                checksum.sha256OfFile(f.abs),
                nodeStreamHash(f.abs),
                client.hashFile(f.abs, { timeoutMs: 60_000 }),
            ]);
            expect(reference, f.name).toBe(f.expected);
            expect(viaApp, f.name).toBe(f.expected);
            expect(raw.sha256, f.name).toBe(f.expected);
            expect(raw.size, f.name).toBe(f.size);
            expect(Math.abs(raw.mtimeMs - fs.statSync(f.abs).mtimeMs), f.name).toBeLessThan(1);
        }
        // Every digest above came from Go (twice per file).
        const after = counter('tgdl_gocore_calls_total', { feature: 'hash', result: 'ok' });
        expect(after - before).toBe(files.length * 2);
    });

    it('stays correct under concurrent load', { timeout: 120_000 }, async () => {
        const jobs = [];
        for (let i = 0; i < 4; i++) for (const f of files) jobs.push(f);
        const out = await Promise.all(jobs.map((f) => checksum.sha256OfFile(f.abs)));
        out.forEach((hex, i) => expect(hex, jobs[i].name).toBe(jobs[i].expected));
    });

    it('hashes a real batch in input order', { timeout: 120_000 }, async () => {
        const batch = await client.hashBatch(
            files.map((f) => f.abs),
            { timeoutMs: 120_000 },
        );
        expect(batch).toHaveLength(files.length);
        batch.forEach((result, i) => {
            expect(result.sha256, files[i].name).toBe(files[i].expected);
            expect(result.size, files[i].name).toBe(files[i].size);
        });
    });

    it('a file outside the allowed roots is hashed in-process, same digest', async () => {
        expect(spawnMod.getGoCoreStatus().allowRoots).toContain(path.resolve(DOWNLOADS));
        fs.mkdirSync(OUTSIDE, { recursive: true });
        const outsideFile = path.join(OUTSIDE, 'not-a-download.bin');
        const buf = patterned(10_000, 9);
        fs.writeFileSync(outsideFile, buf);
        await expect(client.hashFile(outsideFile)).rejects.toMatchObject({
            kind: 'outside',
            code: 'EOUTSIDE',
            status: 403,
        });
        await expect(
            client.hashFile(path.join(DOWNLOADS, '..', '..', 'elsewhere', 'not-a-download.bin')),
        ).rejects.toMatchObject({ code: 'EOUTSIDE' });
        expect(await checksum.sha256OfFile(outsideFile)).toBe(
            crypto.createHash('sha256').update(buf).digest('hex'),
        );
    });

    it('fails like fs for a file that cannot be read', async () => {
        for (const p of [path.join(DOWNLOADS, 'does-not-exist.bin'), DOWNLOADS]) {
            const nodeErr = await nodeStreamHash(p).catch((e) => e);
            const goErr = await checksum.sha256OfFile(p).catch((e) => e);
            expect(goErr).toBeInstanceOf(Error);
            expect({ code: goErr.code, message: goErr.message }).toEqual({
                code: nodeErr.code,
                message: nodeErr.message,
            });
        }
    });
});
