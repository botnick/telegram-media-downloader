#!/usr/bin/env node
/**
 * tgdl-core benchmark: the Node code it replaced vs tgdl-core, for every
 * feature, on this machine.
 *
 *   node scripts/bench-gocore.js [--only stat,walk,dbscan,hash]
 *        [--dir <path>] [--files 50000] [--dbscan 5000,20000] [--dim 512]
 *        [--hash-mb 2000]
 *
 *   stat    the integrity sweep: pages of 64 rows, fs.stat each
 *           (Promise.all, the removed Node block) vs tgdl-core stat-batch
 *   walk    the disk-usage scan and the re-index walk over the same tree
 *           (the removed Node recursive readdir + stat) vs tgdl-core walk
 *   dbscan  face clustering on n × dim embeddings: dbscan.js on a worker
 *           thread (the removed cluster-worker path) vs tgdl-core
 *   hash    SHA-256 of a file set: crypto over fs.createReadStream on the
 *           main thread vs tgdl-core (phase 1; the worker pool is gone)
 *
 * For each run: wall time and the main event loop's delay (p50 / p99 /
 * max, monitorEventLoopDelay at 1 ms resolution) and utilisation — what
 * the dashboard feels while the job runs. Results are checked equal.
 *
 * tgdl-core is found like the app finds it; run `npm run build:core` (or
 * `npm run install:core`) first. The file tree is created once under
 * --dir (default: the OS temp dir) and reused.
 */

import crypto from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { Worker } from 'worker_threads';

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const ONLY = new Set(String(opt('only', 'stat,walk,dbscan,hash')).split(','));
const DIR = path.resolve(opt('dir', path.join(os.tmpdir(), 'tgdl-core-bench')));
const N_FILES = Number(opt('files', 50_000));
const DBSCAN_NS = String(opt('dbscan', '5000,20000')).split(',').map(Number).filter(Boolean);
const DIM = Number(opt('dim', 512));
const HASH_MB = Number(opt('hash-mb', 2000));
const TREE = path.join(DIR, 'tree');
const HASHSET = path.join(DIR, 'hash');

process.env.TGDL_CORE_ALLOW_ROOTS = [TREE, HASHSET].join(path.delimiter);

async function measure(label, fn) {
    const h = monitorEventLoopDelay({ resolution: 1 });
    const elu0 = performance.eventLoopUtilization();
    h.enable();
    const t0 = performance.now();
    const result = await fn();
    const ms = performance.now() - t0;
    h.disable();
    const elu = performance.eventLoopUtilization(elu0);
    return {
        result,
        row: {
            run: label,
            'wall s': (ms / 1000).toFixed(3),
            'loop p50 ms': (h.percentile(50) / 1e6).toFixed(2),
            'loop p99 ms': (h.percentile(99) / 1e6).toFixed(2),
            'loop max ms': (h.max / 1e6).toFixed(1),
            'loop util %': (elu.utilization * 100).toFixed(1),
        },
    };
}

// ---- file tree (stat / walk) -------------------------------------------------

function makeTree() {
    const marker = path.join(TREE, '.tree.json');
    try {
        const prev = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (prev.n === N_FILES) return prev.rows;
    } catch {}
    console.log(`creating ${N_FILES} files under ${TREE} …`);
    fs.rmSync(TREE, { recursive: true, force: true });
    const groups = 50;
    const types = ['images', 'videos', 'documents'];
    const rows = [];
    for (let i = 0; i < N_FILES; i++) {
        const g = `group-${i % groups}`;
        const t = types[i % types.length];
        const rel = `${g}/${t}/2024-01-01T00_00_00_${i}.bin`;
        const abs = path.join(TREE, g, t, `2024-01-01T00_00_00_${i}.bin`);
        if (i < groups * types.length) fs.mkdirSync(path.dirname(abs), { recursive: true });
        const size = 256 + ((i * 7919) % 4096);
        // Every 20th row points at a file that isn't there (pruned rows).
        if (i % 20 !== 0) fs.writeFileSync(abs, Buffer.alloc(size, i & 0xff));
        rows.push({ id: i + 1, file_path: rel, file_size: i % 50 === 1 ? 0 : size });
    }
    fs.writeFileSync(marker, JSON.stringify({ n: N_FILES, rows }));
    return rows;
}

async function benchStat(rows) {
    const { oracleSweepChecks } = await import('../tests/helpers/node-fs-oracle.js');
    const { statMany } = await import('../src/core/gocore/fs.js');
    const MISSING = new Set(['ENOENT', 'ENOTDIR']);
    const PAGE = 64;
    const node = await measure(`stat sweep ${rows.length} rows — Node fs.stat`, async () => {
        const del = [];
        let fixes = 0;
        for (let i = 0; i < rows.length; i += PAGE) {
            const r = await oracleSweepChecks(rows.slice(i, i + PAGE), TREE);
            del.push(...r.deleteIds);
            fixes += r.sizeFixes.length;
            await new Promise((res) => setImmediate(res));
        }
        return { del: del.length, fixes };
    });
    const go = await measure(`stat sweep ${rows.length} rows — tgdl-core`, async () => {
        let del = 0;
        let fixes = 0;
        for (let i = 0; i < rows.length; i += PAGE) {
            const page = rows.slice(i, i + PAGE);
            const st = await statMany(page.map((r) => path.resolve(TREE, r.file_path)));
            page.forEach((r, k) => {
                const s = st[k];
                if (s.ok) {
                    if (s.size <= 0) del++;
                    else if ((Number(r.file_size) || 0) !== s.size) fixes++;
                } else if (MISSING.has(s.code)) del++;
            });
            await new Promise((res) => setImmediate(res));
        }
        return { del, fixes };
    });
    // What integrity.sweep does: read pages of 64 rows but stat up to ~1000
    // rows (16 pages) per tgdl-core request, then decide page by page.
    const goAhead = await measure(
        `stat sweep ${rows.length} rows — tgdl-core, 1024 per request`,
        async () => {
            let del = 0;
            let fixes = 0;
            for (let i = 0; i < rows.length; i += PAGE * 16) {
                const chunk = rows.slice(i, i + PAGE * 16);
                const st = await statMany(chunk.map((r) => path.resolve(TREE, r.file_path)));
                for (let p = 0; p < chunk.length; p += PAGE) {
                    chunk.slice(p, p + PAGE).forEach((r, k) => {
                        const s = st[p + k];
                        if (s.ok) {
                            if (s.size <= 0) del++;
                            else if ((Number(r.file_size) || 0) !== s.size) fixes++;
                        } else if (MISSING.has(s.code)) del++;
                    });
                    await new Promise((res) => setImmediate(res));
                }
            }
            return { del, fixes };
        },
    );
    for (const r of [go, goAhead]) {
        if (JSON.stringify(node.result) !== JSON.stringify(r.result)) {
            throw new Error(
                `stat mismatch ${JSON.stringify(node.result)} vs ${JSON.stringify(r.result)}`,
            );
        }
    }
    return [node.row, go.row, goAhead.row];
}

async function benchWalk() {
    const { oracleDiskUsage, oracleReindex } = await import('../tests/helpers/node-fs-oracle.js');
    const { diskUsage, walkTree } = await import('../src/core/gocore/fs.js');
    const out = [];
    const nu = await measure('disk usage — Node readdir + stat', () => oracleDiskUsage(TREE));
    const gu = await measure('disk usage — tgdl-core walk', () => diskUsage(TREE));
    if (nu.result !== gu.result) throw new Error(`disk usage ${nu.result} vs ${gu.result}`);
    out.push(nu.row, gu.row);
    const nr = await measure('re-index walk — Node readdir + stat', async () => {
        let n = 0;
        await oracleReindex(TREE, [], () => {
            n++;
            return { changes: 1 };
        });
        return n;
    });
    const gr = await measure('re-index walk — tgdl-core walk', async () => {
        const top = await walkTree(TREE, { maxDepth: 1 });
        let n = 0;
        for (const ev of top.events) {
            if (ev.t !== 'd' || ev.p === '.deleted') continue;
            const { events } = await walkTree(path.join(TREE, ev.p), {
                maxDepth: 2,
                stat: 'files',
            });
            for (const e of events) {
                if (e.t === 'f' && e.k === 'file' && e.ok && e.isFile && e.size > 0) n++;
            }
        }
        return n;
    });
    if (nr.result !== gr.result) throw new Error(`re-index ${nr.result} vs ${gr.result}`);
    out.push(nr.row, gr.row);
    return out;
}

// ---- DBSCAN ------------------------------------------------------------------

function embeddings(n, dim, seed) {
    // Same shape as tests/helpers/synth-faces.js, flat.
    let s = seed >>> 0;
    const rnd = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const k = Math.max(8, Math.round(n / 80));
    const unitInto = (dst, off, src) => {
        let t = 0;
        for (let i = 0; i < dim; i++) t += src[i] * src[i];
        t = Math.sqrt(t);
        for (let i = 0; i < dim; i++) dst[off + i] = src[i] / t;
    };
    const centres = [];
    const tmp = new Float64Array(dim);
    for (let c = 0; c < k; c++) {
        for (let i = 0; i < dim; i++) tmp[i] = gauss();
        const v = new Float32Array(dim);
        unitInto(v, 0, tmp);
        centres.push(v);
    }
    const data = new Float32Array(n * dim);
    const weights = new Float64Array(n);
    for (let p = 0; p < n; p++) {
        const stranger = rnd() < 0.2;
        const base = stranger ? null : centres[Math.floor(rnd() * k)];
        for (let i = 0; i < dim; i++) tmp[i] = stranger ? gauss() : base[i] + gauss() * 0.045;
        unitInto(data, p * dim, tmp);
        weights[p] = p % 5 === 0 ? Number.NaN : 0.3 + rnd();
    }
    return { data, n, dim, weights };
}

function nodeWorkerCluster({ data, n, dim, weights }, opts) {
    // The removed path: dbscan.js clusterFlat on a worker thread.
    const src = `
        const { parentPort, workerData } = require('worker_threads');
        import(workerData.url).then(({ clusterFlat }) => {
            const { data, n, dim, weights, eps, minPts } = workerData;
            const { clusters, noise } = clusterFlat(data, n, dim, weights, { eps, minPts });
            parentPort.postMessage({ count: clusters.length, noise: noise.length,
                members: clusters.map((c) => Array.from(c.memberIdxs)),
                centroids: clusters.map((c) => Buffer.from(c.centroid.buffer).toString('base64')) });
        });`;
    return new Promise((resolve, reject) => {
        const w = new Worker(src, {
            eval: true,
            workerData: {
                url: new URL('../src/core/ai/dbscan.js', import.meta.url).href,
                data,
                n,
                dim,
                weights,
                ...opts,
            },
        });
        w.once('message', (m) => {
            w.terminate();
            resolve(m);
        });
        w.once('error', reject);
    });
}

async function benchDbscan() {
    const faces = await import('../src/core/ai/faces.js');
    const opts = { eps: 1.05, minPts: 2 };
    const out = [];
    for (const n of DBSCAN_NS) {
        const set = embeddings(n, DIM, 20260929 + n);
        const node = await measure(`DBSCAN ${n}×${DIM} — dbscan.js on a worker`, () =>
            nodeWorkerCluster(set, opts),
        );
        const go = await measure(`DBSCAN ${n}×${DIM} — tgdl-core`, () =>
            faces.clusterFacesOffThread(set, opts),
        );
        const g = go.result;
        const same =
            g.clusters.length === node.result.count &&
            g.noiseCount === node.result.noise &&
            g.clusters.every(
                (c, i) =>
                    JSON.stringify(Array.from(c.memberIdxs)) ===
                        JSON.stringify(node.result.members[i]) &&
                    Buffer.from(
                        c.centroid.buffer,
                        c.centroid.byteOffset,
                        c.centroid.byteLength,
                    ).toString('base64') === node.result.centroids[i],
            );
        if (!same) throw new Error(`DBSCAN ${n}: results differ`);
        out.push(
            { ...node.row, clusters: node.result.count, noise: node.result.noise },
            { ...go.row, clusters: g.clusters.length, noise: g.noiseCount },
        );
    }
    return out;
}

// ---- hash ----------------------------------------------------------------------

function makeHashSet() {
    const marker = path.join(HASHSET, '.set.json');
    try {
        const prev = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (prev.mb === HASH_MB) return prev.files;
    } catch {}
    console.log(`creating ${HASH_MB} MB of files under ${HASHSET} …`);
    fs.rmSync(HASHSET, { recursive: true, force: true });
    fs.mkdirSync(HASHSET, { recursive: true });
    const chunk = crypto.randomBytes(8 * 1024 * 1024);
    const files = [];
    let left = HASH_MB * 1024 * 1024;
    for (let i = 0; left > 0; i++) {
        const size = Math.min(left, 1024 * 1024 * (1 + ((i * 37) % 40)));
        const p = path.join(HASHSET, `f${i}.bin`);
        const fd = fs.openSync(p, 'w');
        for (let off = 0; off < size; off += chunk.length) {
            chunk[i % chunk.length] ^= 0x5a;
            fs.writeSync(fd, chunk, 0, Math.min(chunk.length, size - off));
        }
        fs.closeSync(fd);
        files.push(p);
        left -= size;
    }
    fs.writeFileSync(marker, JSON.stringify({ mb: HASH_MB, files }));
    return files;
}

function streamHash(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        createReadStream(p)
            .on('data', (c) => h.update(c))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
    });
}

async function benchHash() {
    const { sha256OfFile } = await import('../src/core/checksum.js');
    const files = makeHashSet();
    for (const f of files) await streamHash(f); // warm the page cache
    const seq = async (fn) => {
        const out = [];
        for (const f of files) out.push(await fn(f));
        return out;
    };
    const node = await measure(`hash ${HASH_MB} MB — Node main thread`, () => seq(streamHash));
    const go = await measure(`hash ${HASH_MB} MB — tgdl-core`, () => seq(sha256OfFile));
    if (JSON.stringify(node.result) !== JSON.stringify(go.result)) throw new Error('hash mismatch');
    return [node.row, go.row];
}

async function main() {
    fs.mkdirSync(TREE, { recursive: true });
    fs.mkdirSync(HASHSET, { recursive: true });
    const spawnMod = await import('../src/core/gocore/spawn.js');
    if (!(await spawnMod.startGoCore())) {
        console.error('tgdl-core did not start:', spawnMod.getGoCoreStatus());
        process.exit(1);
    }
    const st = spawnMod.getGoCoreStatus();
    console.log(
        `tgdl-core ${st.version} (${st.binary?.source}); ${os.cpus().length} CPUs (${os.cpus()[0]?.model}); node ${process.version}; ${process.platform}/${process.arch}`,
    );
    const rows = [];
    if (ONLY.has('stat') || ONLY.has('walk')) {
        const tree = makeTree();
        // Warm the metadata cache once so both sides see the same state.
        await (await import('../tests/helpers/node-fs-oracle.js')).oracleDiskUsage(TREE);
        if (ONLY.has('stat')) rows.push(...(await benchStat(tree)));
        if (ONLY.has('walk')) rows.push(...(await benchWalk()));
    }
    if (ONLY.has('dbscan')) rows.push(...(await benchDbscan()));
    if (ONLY.has('hash')) rows.push(...(await benchHash()));
    console.table(rows);
    spawnMod.stopGoCore();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
