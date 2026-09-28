#!/usr/bin/env node
/**
 * Hash benchmark: Node worker pool vs Node main thread vs tgdl-core.
 *
 *   node scripts/bench-gocore-hash.js [--dir <path>] [--files 400] [--mb 1600]
 *                                     [--big 2] [--big-mb 256] [--keep]
 *
 * Creates (or reuses) a file set, warms the page cache, then hashes the
 * whole set with each engine, sequentially (like the duplicate scan) and
 * with `pool size` requests in flight (like parallel downloads). For each
 * run it reports wall time, MB/s, the main event loop's delay (p50 / p99 /
 * max via monitorEventLoopDelay) and utilisation, and checks every engine
 * produced the same digests.
 *
 * tgdl-core is found like the app finds it (TGDL_CORE_BIN, Docker path,
 * core-service/bin, data download); run `npm run build:core` first.
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const DIR = path.resolve(opt('dir', path.join(os.tmpdir(), 'tgdl-hash-bench')));
const N_FILES = Number(opt('files', 400));
const SMALL_MB = Number(opt('mb', 1600));
const N_BIG = Number(opt('big', 2));
const BIG_MB = Number(opt('big-mb', 256));
const KEEP = args.includes('--keep');
const MiB = 1024 * 1024;

function makeSet() {
    fs.mkdirSync(DIR, { recursive: true });
    const marker = path.join(DIR, '.set.json');
    const spec = { N_FILES, SMALL_MB, N_BIG, BIG_MB };
    try {
        const prev = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (JSON.stringify(prev.spec) === JSON.stringify(spec)) return prev.files;
    } catch {}
    console.log(`creating file set in ${DIR} …`);
    const files = [];
    // Sizes spread log-uniformly between 16 KiB and ~4x the mean, scaled
    // so the small files add up to SMALL_MB.
    const raw = Array.from({ length: N_FILES }, (_, i) => 2 ** (14 + ((i * 7919) % 1000) / 100));
    const scale = (SMALL_MB * MiB) / raw.reduce((a, b) => a + b, 0);
    const chunk = crypto.randomBytes(8 * MiB);
    const write = (name, size) => {
        const p = path.join(DIR, name);
        const fd = fs.openSync(p, 'w');
        let left = size;
        let off = 0;
        while (left > 0) {
            const n = Math.min(left, chunk.length - (off % chunk.length));
            fs.writeSync(fd, chunk, off % chunk.length, n);
            // Perturb so files differ.
            chunk[(off * 31) % chunk.length] ^= 0xa5;
            left -= n;
            off += n;
        }
        fs.closeSync(fd);
        files.push({ path: p, size });
    };
    raw.forEach((r, i) =>
        write(`f${String(i).padStart(4, '0')}-ไฟล์.bin`, Math.max(1, Math.round(r * scale))),
    );
    for (let i = 0; i < N_BIG; i++) write(`big-${i}.bin`, BIG_MB * MiB);
    fs.writeFileSync(marker, JSON.stringify({ spec, files }));
    return files;
}

// Resident memory of another process, in MiB (sampled after a run, never
// during one: the sync exec would stall the loop being measured).
function rssOfPid(pid) {
    try {
        if (process.platform === 'win32') {
            const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
                encoding: 'utf8',
            });
            const kb = Number(
                csv
                    .split('","')
                    .pop()
                    .replace(/[^0-9]/g, ''),
            );
            return Math.round(kb / 1024);
        }
        return Math.round(
            Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })) /
                1024,
        );
    } catch {
        return null;
    }
}

async function runPool(files, hashOne, concurrency) {
    const out = new Array(files.length);
    let next = 0;
    const worker = async () => {
        while (next < files.length) {
            const i = next++;
            out[i] = await hashOne(files[i].path);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return out;
}

async function measure(label, files, hashOne, concurrency) {
    const h = monitorEventLoopDelay({ resolution: 1 });
    const elu0 = performance.eventLoopUtilization();
    h.enable();
    let rssPeak = process.memoryUsage().rss;
    const rssTimer = setInterval(() => {
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 50);
    const t0 = performance.now();
    const digests = await runPool(files, hashOne, concurrency);
    const ms = performance.now() - t0;
    clearInterval(rssTimer);
    h.disable();
    const elu = performance.eventLoopUtilization(elu0);
    const bytes = files.reduce((a, f) => a + f.size, 0);
    const row = {
        run: label,
        conc: concurrency,
        'wall s': (ms / 1000).toFixed(2),
        'MB/s': (bytes / 1e6 / (ms / 1000)).toFixed(0),
        'loop p50 ms': (h.percentile(50) / 1e6).toFixed(2),
        'loop p99 ms': (h.percentile(99) / 1e6).toFixed(2),
        'loop max ms': (h.max / 1e6).toFixed(1),
        'loop util %': (elu.utilization * 100).toFixed(1),
        'node rss MB': Math.round(rssPeak / MiB),
    };
    return { row, digests };
}

async function main() {
    const files = makeSet();
    const total = files.reduce((a, f) => a + f.size, 0);
    console.log(
        `${files.length} files, ${(total / 1e9).toFixed(2)} GB; ${os.cpus().length} CPUs (${os.cpus()[0]?.model}); node ${process.version}`,
    );

    const hashWorker = await import('../src/core/hash-worker.js');
    const { sha256OfFile } = await import('../src/core/checksum.js');
    const spawnMod = await import('../src/core/gocore/spawn.js');
    const client = await import('../src/core/gocore/client.js');
    process.env.TGDL_GO_CORE = 'on';
    process.env.TGDL_DATA_DIR ||= path.join(DIR, '.data');
    // The bench set isn't under the downloads dir: allow it explicitly.
    process.env.TGDL_CORE_ALLOW_ROOTS = [DIR, process.env.TGDL_CORE_ALLOW_ROOTS]
        .filter(Boolean)
        .join(path.delimiter);
    if (!(await spawnMod.startGoCore())) {
        console.error('tgdl-core did not start:', spawnMod.getGoCoreStatus());
        process.exit(1);
    }
    const goCap = (await client.health()).hash?.concurrency;
    // Same pool size both sides (HASH_WORKER_POOL_SIZE semantics).
    const conc = goCap || 4;
    await hashWorker.hashFile(files[0].path); // spin the pool up

    console.log('warming the page cache …');
    await runPool(files, (p) => sha256OfFile(p), 8);

    const engines = {
        'node pool': (p) => hashWorker.hashFile(p),
        'node main thread': (p) => sha256OfFile(p),
        'go (tgdl-core)': async (p) => (await client.hashFile(p, { timeoutMs: 600_000 })).sha256,
    };
    const rows = [];
    const results = {};
    for (const c of [1, conc]) {
        for (let round = 0; round < 2; round++) {
            for (const [name, fn] of Object.entries(engines)) {
                const { row, digests } = await measure(name, files, fn, c);
                if (name.startsWith('go'))
                    row['go rss MB'] = rssOfPid(spawnMod.getGoCoreStatus().pid);
                if (round === 1) rows.push(row);
                results[name] ||= digests;
                if (digests.some((d, i) => d !== results[name][i]))
                    throw new Error(`${name}: unstable`);
            }
        }
    }
    const ref = results['node pool'];
    for (const [name, d] of Object.entries(results)) {
        const bad = d.filter((x, i) => x !== ref[i]).length;
        console.log(
            `${name}: ${bad === 0 ? 'all digests match the node pool' : `${bad} MISMATCHES`}`,
        );
    }
    console.table(rows);
    spawnMod.stopGoCore();
    await hashWorker.shutdownHashPool();
    if (!KEEP) fs.rmSync(DIR, { recursive: true, force: true });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
