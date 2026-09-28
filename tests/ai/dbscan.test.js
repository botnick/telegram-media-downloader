// Flat DBSCAN (src/core/ai/dbscan.js) must stay label-for-label identical
// to the original array-of-vectors implementation it replaced — existing
// People groups and their carried-over names depend on it. The reference
// below is the pre-rewrite faces.js code, verbatim apart from naming.

import { describe, expect, it } from 'vitest';

import { clusterFlat, dbscanFlat, packPoints } from '../../src/core/ai/dbscan.js';
import { clusterFaces, clusterFacesOffThread, dbscan } from '../../src/core/ai/faces.js';

// ---- reference (original) implementation ---------------------------------

function refEuclidean(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

function refCentroid(vecs, weights = null) {
    const dim = vecs[0].length;
    const out = new Float32Array(dim);
    let totalW = 0;
    for (let vi = 0; vi < vecs.length; vi++) {
        const v = vecs[vi];
        if (!v || v.length !== dim) continue;
        const w = weights && Number.isFinite(weights[vi]) && weights[vi] > 0 ? weights[vi] : 1.0;
        totalW += w;
        for (let i = 0; i < dim; i++) out[i] += v[i] * w;
    }
    if (totalW <= 0) totalW = 1;
    for (let i = 0; i < dim; i++) out[i] /= totalW;
    return out;
}

function refRegionQuery(points, idx, eps) {
    const out = [];
    const p = points[idx];
    for (let j = 0; j < points.length; j++) {
        if (j === idx) continue;
        if (refEuclidean(p, points[j]) <= eps) out.push(j);
    }
    return out;
}

function refDbscan(points, { eps, minPts }) {
    minPts = Math.max(2, minPts);
    const N = points.length;
    const labels = new Array(N).fill(-2);
    let cluster = -1;
    for (let i = 0; i < N; i++) {
        if (labels[i] !== -2) continue;
        const neighbors = refRegionQuery(points, i, eps);
        if (neighbors.length + 1 < minPts) {
            labels[i] = -1;
            continue;
        }
        cluster++;
        labels[i] = cluster;
        const stack = neighbors.slice();
        while (stack.length) {
            const j = stack.shift();
            if (labels[j] === -1) labels[j] = cluster;
            if (labels[j] !== -2) continue;
            labels[j] = cluster;
            const sub = refRegionQuery(points, j, eps);
            if (sub.length + 1 >= minPts) {
                for (const k of sub) {
                    if (labels[k] === -2) stack.push(k);
                }
            }
        }
    }
    return labels;
}

function refClusterFaces(faces, opts) {
    const points = faces.map((f) => f.embedding);
    const labels = refDbscan(points, opts);
    const groups = new Map();
    const noise = [];
    labels.forEach((label, idx) => {
        if (label < 0) {
            noise.push(idx);
            return;
        }
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(idx);
    });
    const clusters = [...groups.values()]
        .map((memberIdxs) => ({
            memberIdxs,
            centroid: refCentroid(
                memberIdxs.map((i) => points[i]),
                memberIdxs.map((i) =>
                    Number.isFinite(faces[i].qualityScore) ? faces[i].qualityScore : 1.0,
                ),
            ),
            faceCount: memberIdxs.length,
        }))
        .sort((a, b) => b.faceCount - a.faceCount);
    return { clusters, noise };
}

// ---- fixtures ---------------------------------------------------------------

// Unit vectors around `k` identity centres + strangers; `noise` controls how
// much pairs straddle eps. Deterministic LCG so failures reproduce.
function synthFaces(n, { k = 8, dim = 64, seed = 1, noise = 0.12, strangers = 0.15 } = {}) {
    let s = seed >>> 0;
    const rnd = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const unit = (a) => {
        let t = 0;
        for (const v of a) t += v * v;
        t = Math.sqrt(t);
        return a.map((v) => v / t);
    };
    const centres = Array.from({ length: k }, () =>
        unit(Float32Array.from({ length: dim }, gauss)),
    );
    return Array.from({ length: n }, (_, i) => {
        const base =
            rnd() < strangers
                ? unit(Float32Array.from({ length: dim }, gauss))
                : centres[Math.floor(rnd() * k)];
        const e = unit(Float32Array.from(base, (v) => v + gauss() * noise));
        return { id: i + 1, embedding: e, qualityScore: i % 5 === 0 ? null : 0.3 + rnd() };
    });
}

function expectSameClusters(actual, expected) {
    expect(actual.noise).toEqual(expected.noise);
    expect(actual.clusters.length).toBe(expected.clusters.length);
    actual.clusters.forEach((c, i) => {
        const e = expected.clusters[i];
        expect(Array.from(c.memberIdxs)).toEqual(e.memberIdxs);
        expect(c.faceCount).toBe(e.faceCount);
        // Byte-identical centroids — they are persisted and matched against
        // labelled clusters on the next run.
        expect(Buffer.from(c.centroid.buffer).equals(Buffer.from(e.centroid.buffer))).toBe(true);
    });
}

const CASES = [
    ['mixed identities', synthFaces(300, { seed: 3 }), { eps: 1.05, minPts: 2 }],
    ['minPts 3 (border points)', synthFaces(300, { seed: 5 }), { eps: 1.05, minPts: 3 }],
    ['straddling eps', synthFaces(250, { seed: 7, noise: 0.16 }), { eps: 1.05, minPts: 2 }],
    ['tight eps', synthFaces(250, { seed: 9 }), { eps: 0.6, minPts: 2 }],
    [
        'one dominant person',
        synthFaces(180, { seed: 11, k: 1, strangers: 0.05 }),
        { eps: 1.05, minPts: 2 },
    ],
];

describe('flat DBSCAN matches the original implementation', () => {
    for (const [name, faces, opts] of CASES) {
        it(`${name}: identical labels`, () => {
            const points = faces.map((f) => f.embedding);
            expect(dbscan(points, opts)).toEqual(refDbscan(points, opts));
        });
        it(`${name}: identical clusters + centroids`, () => {
            expectSameClusters(clusterFaces(faces, opts), refClusterFaces(faces, opts));
        });
    }

    it('rows of a different dimension are never neighbours (old Infinity distance)', () => {
        const faces = synthFaces(40, { seed: 13 });
        faces[5] = { ...faces[5], embedding: faces[5].embedding.slice(0, 32) };
        const points = faces.map((f) => f.embedding);
        const opts = { eps: 1.05, minPts: 2 };
        const labels = dbscan(points, opts);
        expect(labels[5]).toBe(-1);
        expect(labels).toEqual(refDbscan(points, opts));
    });

    it('enqueues each point once — a 2 000-face person stays fast', () => {
        // The old queue pushed a point once per core neighbour and popped
        // with shift(): ~2 M entries and minutes of CPU for this input.
        const faces = synthFaces(2000, { seed: 17, k: 1, dim: 16, noise: 0.05, strangers: 0 });
        const { data, n, dim } = packPoints(faces.map((f) => f.embedding));
        const t0 = Date.now();
        const labels = dbscanFlat(data, n, dim, { eps: 1.05, minPts: 2 });
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(new Set(labels).size).toBe(1);
    });
});

describe('clusterFacesOffThread', () => {
    it('worker result equals the in-process result', async () => {
        const faces = synthFaces(400, { seed: 19 });
        const opts = { eps: 1.05, minPts: 2 };
        const expected = clusterFaces(faces, opts);
        const { data, n, dim } = packPoints(faces.map((f) => f.embedding));
        const weights = Float64Array.from(faces, (f) =>
            Number.isFinite(f.qualityScore) ? f.qualityScore : Number.NaN,
        );
        const progress = [];
        const got = await clusterFacesOffThread(
            { data, n, dim, weights },
            { ...opts, onProgress: (done) => progress.push(done) },
        );
        expect(got.noiseCount).toBe(expected.noise.length);
        expectSameClusters({ clusters: got.clusters, noise: expected.noise }, expected);
    });

    it('rejects with AbortError when the signal fires', async () => {
        const faces = synthFaces(3000, { seed: 23, dim: 128 });
        const { data, n, dim } = packPoints(faces.map((f) => f.embedding));
        const ctrl = new AbortController();
        const p = clusterFacesOffThread(
            { data, n, dim },
            { eps: 1.05, minPts: 2, signal: ctrl.signal },
        );
        setTimeout(() => ctrl.abort(), 20);
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('small inputs run inline and match', async () => {
        const faces = synthFaces(50, { seed: 29 });
        const opts = { eps: 1.05, minPts: 2 };
        const { data, n, dim } = packPoints(faces.map((f) => f.embedding));
        const weights = Float64Array.from(faces, (f) =>
            Number.isFinite(f.qualityScore) ? f.qualityScore : Number.NaN,
        );
        const got = await clusterFacesOffThread({ data, n, dim, weights }, opts);
        const expected = refClusterFaces(faces, opts);
        expectSameClusters({ clusters: got.clusters, noise: expected.noise }, expected);
    });
});

describe('clusterFlat', () => {
    it('handles an empty input', () => {
        expect(clusterFlat(new Float32Array(0), 0, 0, null, { eps: 1, minPts: 2 })).toEqual({
            clusters: [],
            noise: [],
        });
    });
});
