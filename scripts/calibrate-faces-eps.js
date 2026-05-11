#!/usr/bin/env node
/**
 * Face clustering ε calibration tool.
 *
 * Walks a sample of photos from `data/downloads`, posts each to the
 * running sidecar (`/detect`), collects every face embedding, then runs
 * DBSCAN at multiple ε values and prints cluster counts so the operator
 * can pick a sensible default for their library.
 *
 * Requires the sidecar to be reachable. Defaults to http://127.0.0.1:8011
 * (the documented standalone port). Override with the FACES_URL env.
 *
 * Usage:
 *   node scripts/calibrate-faces-eps.js [--sample 200] [--root data/downloads]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACES_URL = process.env.FACES_URL || 'http://127.0.0.1:8011';

// CLI
const args = Object.fromEntries(
    process.argv
        .slice(2)
        .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null))
        .filter(Boolean),
);
const SAMPLE = args.all === undefined && args.all !== null ? Number(args.sample) || 200 : 0;
const ALL = 'all' in args;
const CONCURRENCY = Number(args.concurrency) || 4;
const PHOTO_ROOT = path.resolve(ROOT, args.root || 'data/downloads');

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function walkPhotos(dir) {
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
            if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') {
                out.push(full);
            }
        }
    }
    await visit(dir);
    return out;
}

async function detectOne(filePath) {
    const buf = await fs.readFile(filePath);
    const b64 = buf.toString('base64');
    const res = await fetch(`${FACES_URL}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: b64 }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j?.faces) ? j.faces : [];
}

// ---- DBSCAN ----
function euclidean(a, b) {
    let s = 0;
    const n = a.length;
    for (let i = 0; i < n; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return Math.sqrt(s);
}

function regionQuery(points, idx, eps) {
    const out = [];
    const p = points[idx];
    for (let j = 0; j < points.length; j++) {
        if (euclidean(p, points[j]) <= eps) out.push(j);
    }
    return out;
}

function dbscan(points, eps, minPts) {
    const n = points.length;
    const labels = new Int32Array(n).fill(-1); // -1 = unvisited, -2 = noise
    let cluster = 0;
    for (let i = 0; i < n; i++) {
        if (labels[i] !== -1) continue;
        const neighbours = regionQuery(points, i, eps);
        if (neighbours.length < minPts) {
            labels[i] = -2;
            continue;
        }
        labels[i] = cluster;
        const queue = neighbours.slice();
        for (let k = 0; k < queue.length; k++) {
            const q = queue[k];
            if (labels[q] === -2) labels[q] = cluster;
            if (labels[q] !== -1) continue;
            labels[q] = cluster;
            const more = regionQuery(points, q, eps);
            if (more.length >= minPts) queue.push(...more);
        }
        cluster++;
    }
    return { labels, clusterCount: cluster };
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
    const big = [...sizes.values()].filter((v) => v >= minPts);
    big.sort((a, b) => b - a);
    return {
        clusters: big.length,
        clustered: big.reduce((a, b) => a + b, 0),
        noise,
        top: big.slice(0, 5),
    };
}

async function main() {
    console.log(`Photo root : ${PHOTO_ROOT}`);
    console.log(`Sidecar    : ${FACES_URL}`);
    console.log(`Sample size: ${SAMPLE}`);
    console.log('');

    console.log('Walking photo tree…');
    const all = await walkPhotos(PHOTO_ROOT);
    console.log(`Found ${all.length} photos.`);
    if (!all.length) {
        console.error('No photos to test.');
        process.exit(1);
    }
    let sample;
    if (ALL) {
        sample = all.slice();
    } else {
        shuffle(all);
        sample = all.slice(0, SAMPLE);
    }
    console.log(`Detecting faces on ${sample.length} photos (concurrency=${CONCURRENCY})…`);

    const embeddings = [];
    let withFaces = 0;
    let totalFaces = 0;
    let done = 0;
    const t0 = Date.now();

    // Concurrent worker pool. detect() is dominated by sidecar GPU time
    // (~1 s/image on DML for buffalo_l) so 4-way concurrency cuts total
    // wall time without saturating the GPU (insightface holds one
    // session lock per request, but the sidecar's uvicorn thread pool
    // overlaps base64 decode + post-processing across requests).
    async function worker(start) {
        for (let i = start; i < sample.length; i += CONCURRENCY) {
            const faces = await detectOne(sample[i]).catch(() => []);
            if (faces.length) withFaces++;
            for (const f of faces) {
                if (Array.isArray(f.embedding) && f.embedding.length === 512) {
                    embeddings.push(new Float32Array(f.embedding));
                    totalFaces++;
                }
            }
            done++;
            if (done % 50 === 0 || done === sample.length) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                const rate = (done / Math.max(0.001, (Date.now() - t0) / 1000)).toFixed(2);
                const remaining =
                    sample.length > done
                        ? Math.round((sample.length - done) / Math.max(0.001, rate))
                        : 0;
                console.log(
                    `  ${done}/${sample.length}  (${elapsed}s, ${rate}/s, ~${remaining}s remaining, ${totalFaces} faces collected)`,
                );
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k)));
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('');
    console.log(`Done in ${elapsed}s.`);
    console.log(`  photos sampled       : ${sample.length}`);
    console.log(
        `  photos with faces    : ${withFaces} (${((withFaces / sample.length) * 100).toFixed(1)}%)`,
    );
    console.log(`  total face embeddings: ${totalFaces}`);
    console.log('');

    if (totalFaces < 4) {
        console.log('Not enough faces to cluster meaningfully. Try a larger --sample.');
        return;
    }

    // Try ε values across the realistic ArcFace range.
    const epsValues = [0.6, 0.7, 0.8, 0.9, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3];
    const minPtsValues = [2, 3];
    console.log('DBSCAN sweep:');
    console.log('  ε      minPts  clusters  clustered  noise  topSizes');
    console.log('  ─────  ──────  ────────  ─────────  ─────  ────────');
    for (const eps of epsValues) {
        for (const minPts of minPtsValues) {
            const { labels } = dbscan(embeddings, eps, minPts);
            const s = clusterStats(labels, minPts);
            const top = s.top.join(',');
            console.log(
                `  ${eps.toFixed(2)}   ${minPts}       ${String(s.clusters).padStart(8)}  ${String(s.clustered).padStart(9)}  ${String(s.noise).padStart(5)}  [${top}]`,
            );
        }
    }

    console.log('');
    console.log('How to read this:');
    console.log('  - "clusters"  = distinct people DBSCAN surfaced');
    console.log('  - "clustered" = faces placed in a cluster (rest = noise)');
    console.log('  - "noise"     = faces too lonely to form a cluster');
    console.log('  - "topSizes"  = sizes of the 5 biggest clusters');
    console.log('');
    console.log('Pick the ε row where:');
    console.log('  - clusters > 0 (at least some people surfaced)');
    console.log('  - noise is moderate (some noise is fine; 100% noise = ε too tight)');
    console.log('  - top cluster sizes look reasonable (no single mega-cluster = ε too loose)');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
