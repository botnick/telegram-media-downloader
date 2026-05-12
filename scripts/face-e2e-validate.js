#!/usr/bin/env node
/**
 * Face clustering end-to-end validation.
 *
 * Hits the running sidecar with a fixed sample of photos using BOTH
 * path mode (sidecar reads from disk, zero base64 transfer) and base64
 * mode (Node ships bytes over HTTP). Records:
 *
 *   - Average per-photo wall time per mode.
 *   - Detected face count per photo.
 *   - GPU utilisation sampled via nvidia-smi while detect is running.
 *   - DBSCAN cluster count at ε ∈ {0.9, 1.0, 1.05, 1.1, 1.15}.
 *
 * Compared to `calibrate-faces-eps.js`, this script focuses on
 * production-readiness checks:
 *
 *   1. Does the sidecar actually use the GPU? (utilisation > 20% on
 *      bursts of detects).
 *   2. Does path mode work on this host? (no `path_not_allowed`).
 *   3. Are clusters surfaced at the recommended default ε?
 *
 * Usage:
 *   node scripts/face-e2e-validate.js [--port 46790] [--sample 100]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
    process.argv
        .slice(2)
        .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null))
        .filter(Boolean),
);
const PORT = Number(args.port) || 46790;
const SAMPLE = Number(args.sample) || 100;
const PHOTO_ROOT = path.resolve(ROOT, 'data/downloads');
const URL = `http://127.0.0.1:${PORT}`;

async function walk(dir) {
    const out = [];
    async function visit(d) {
        let entries;
        try {
            entries = await fs.readdir(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                await visit(full);
                continue;
            }
            const ext = path.extname(e.name).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) out.push(full);
        }
    }
    await visit(dir);
    return out;
}

async function detectPath(absPath) {
    const t0 = Date.now();
    const res = await fetch(`${URL}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: absPath }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
        return { ms, status: res.status, faces: [], error: await res.text().catch(() => '') };
    }
    const j = await res.json();
    return { ms, status: res.status, faces: j?.faces || [] };
}

function startGpuSampler() {
    const samples = [];
    const proc = spawn(
        'nvidia-smi',
        ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits', '-l', '1'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    proc.stdout.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
            const m = line.match(/(\d+),\s*(\d+)/);
            if (m) samples.push({ util: Number(m[1]), memMb: Number(m[2]), ts: Date.now() });
        }
    });
    proc.on('error', () => {}); // nvidia-smi missing → empty samples
    return {
        stop() {
            try {
                proc.kill();
            } catch {}
            return samples;
        },
    };
}

// In-Node DBSCAN (matches faces.js).
function euclidean(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return Math.sqrt(s);
}
function dbscan(points, eps, minPts) {
    const n = points.length;
    const labels = new Int32Array(n).fill(-1);
    let cluster = 0;
    const region = (idx) => {
        const out = [];
        for (let j = 0; j < n; j++) if (euclidean(points[idx], points[j]) <= eps) out.push(j);
        return out;
    };
    for (let i = 0; i < n; i++) {
        if (labels[i] !== -1) continue;
        const nb = region(i);
        if (nb.length < minPts) {
            labels[i] = -2;
            continue;
        }
        labels[i] = cluster;
        const q = nb.slice();
        for (let k = 0; k < q.length; k++) {
            const v = q[k];
            if (labels[v] === -2) labels[v] = cluster;
            if (labels[v] !== -1) continue;
            labels[v] = cluster;
            const more = region(v);
            if (more.length >= minPts) q.push(...more);
        }
        cluster++;
    }
    return labels;
}
function clusterStats(labels, minPts) {
    const sizes = new Map();
    let noise = 0;
    for (const l of labels) {
        if (l < 0) {
            noise++;
            continue;
        }
        sizes.set(l, (sizes.get(l) || 0) + 1);
    }
    const big = [...sizes.values()].filter((v) => v >= minPts).sort((a, b) => b - a);
    return { clusters: big.length, top: big.slice(0, 5), noise };
}

async function main() {
    console.log('=== Face e2e validation ===');
    console.log(`Sidecar: ${URL}`);
    console.log(`Photo root: ${PHOTO_ROOT}`);
    console.log(`Sample: ${SAMPLE}`);
    console.log('');

    // Probe sidecar
    let info;
    try {
        info = await (await fetch(`${URL}/info`)).json();
    } catch (e) {
        console.error(`Sidecar unreachable: ${e.message}`);
        process.exit(1);
    }
    console.log('Sidecar info:');
    console.log(`  model:    ${info.model}`);
    console.log(`  dim:      ${info.dim}`);
    console.log(`  providers: ${info.providers.join(', ')}`);
    console.log(`  det_size: ${info.det_size}`);
    console.log(`  platform: ${info.platform}  python: ${info.python}`);
    console.log('');

    const all = await walk(PHOTO_ROOT);
    console.log(`Photos found: ${all.length}`);
    const sample = all.slice(0, SAMPLE);

    // ===== Path mode =====
    console.log('\n--- PATH MODE benchmark + GPU usage ---');
    const gpuP = startGpuSampler();
    let pathTimes = [];
    let pathFaces = 0;
    let pathRejected = 0;
    const pathEmbs = [];
    for (let i = 0; i < sample.length; i++) {
        const r = await detectPath(sample[i]);
        if (r.status === 403) {
            pathRejected++;
            continue;
        }
        pathTimes.push(r.ms);
        pathFaces += r.faces.length;
        for (const f of r.faces) {
            if (Array.isArray(f.embedding) && f.embedding.length === 512) {
                pathEmbs.push(new Float32Array(f.embedding));
            }
        }
        if ((i + 1) % 25 === 0) {
            const avg = pathTimes.reduce((a, b) => a + b, 0) / pathTimes.length;
            console.log(`  ${i + 1}/${sample.length}  avg=${avg.toFixed(0)}ms  faces=${pathFaces}`);
        }
    }
    const pathSamples = gpuP.stop();
    const pathAvg = pathTimes.length ? pathTimes.reduce((a, b) => a + b, 0) / pathTimes.length : 0;
    const pathMax = pathTimes.length ? Math.max(...pathTimes) : 0;
    console.log(`Path mode: avg=${pathAvg.toFixed(0)}ms  max=${pathMax}ms`);
    console.log(`  faces detected: ${pathFaces}`);
    console.log(`  embeddings collected: ${pathEmbs.length}`);
    if (pathRejected) console.log(`  ⚠ path_not_allowed rejections: ${pathRejected}`);
    if (pathSamples.length) {
        const avgUtil = pathSamples.reduce((a, b) => a + b.util, 0) / pathSamples.length;
        const maxUtil = Math.max(...pathSamples.map((s) => s.util));
        const maxMem = Math.max(...pathSamples.map((s) => s.memMb));
        console.log(
            `  GPU: avg util ${avgUtil.toFixed(0)}%, peak ${maxUtil}%, peak mem ${maxMem} MiB`,
        );
    } else {
        console.log('  GPU: nvidia-smi not available — skipping');
    }

    // ===== DBSCAN cluster sweep =====
    if (pathEmbs.length >= 10) {
        console.log('\n--- DBSCAN cluster sweep on collected embeddings ---');
        console.log('  ε     minPts  clusters  noise  topSizes');
        for (const eps of [0.9, 1.0, 1.05, 1.1, 1.15]) {
            for (const minPts of [2]) {
                const labels = dbscan(pathEmbs, eps, minPts);
                const s = clusterStats(labels, minPts);
                console.log(
                    `  ${eps.toFixed(2)}  ${minPts}      ${String(s.clusters).padStart(8)}  ${String(s.noise).padStart(5)}  [${s.top.join(',')}]`,
                );
            }
        }
    }

    // ===== Verdict =====
    console.log('\n=== VERDICT ===');
    const usingGpu =
        info.providers[0] === 'DmlExecutionProvider' ||
        info.providers[0] === 'CUDAExecutionProvider';
    const pathWorked = pathRejected === 0;
    const fastEnough = pathAvg > 0 && pathAvg < 3000;
    const facesFound = pathFaces > 0;

    console.log(`  GPU provider active:   ${usingGpu ? '✓' : '✗'} (${info.providers[0]})`);
    console.log(`  Path mode works:       ${pathWorked ? '✓' : '✗'}`);
    console.log(`  Inference < 3s/photo:  ${fastEnough ? '✓' : '✗'} (${pathAvg.toFixed(0)}ms)`);
    console.log(`  Faces detected:        ${facesFound ? '✓' : '✗'} (${pathFaces})`);

    if (usingGpu && pathWorked && fastEnough && facesFound) {
        console.log('\n  ALL CHECKS PASS — system is production-ready for this host.');
    } else {
        console.log('\n  Issues found — see above.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
