/**
 * Face detection + embedding + DBSCAN clustering.
 *
 * Detection backend moved out-of-process: faces are detected by the
 * Python sidecar at `getSidecarUrl()` (see `faces-client.js`). The
 * sidecar runs insightface buffalo_l (MIT, 512-dim) — same MIT terms as
 * the previous in-process FaceNet path, better accuracy, no native
 * Node binding to ABI-mismatch on Windows / Pi / DSM. The clustering
 * math below is dimension-agnostic so a fresh sidecar install (512-dim)
 * and a legacy DB row (128-dim) both work — though mixing dims in one
 * DBSCAN pass is meaningless and the spawn layer handles the 128→512
 * one-time migration.
 *
 * Clustering: DBSCAN with the buffalo_l cosine-distance-equivalent
 * threshold (`facesEpsilon` default 0.5). DBSCAN remains the right
 * pick for this problem:
 *   - Number of clusters is unknown ahead of time (we don't ask the
 *     operator how many people are in their library).
 *   - Outlier rejection is free — bad detections / single-shot
 *     strangers stay unassigned instead of being forced into a cluster.
 *   - O(N²) worst-case but with `minPts=3` and a tight eps the typical
 *     case is well-bounded for libraries up to ~50k faces.
 *
 * Public surface (unchanged for callers):
 *   - detectFaces(absPath, cfg, onLog) -> [{ x, y, w, h, score, embedding, landmarks? }, …] | null
 *   - qualityFilter(detections, cfg)   -> filtered list
 *   - dbscan(points, opts)             -> [clusterIdxOrNoise, …]
 *   - clusterFaces(faces, opts)        -> { clusters, noise }
 *   - euclidean(a, b)                  -> number
 *   - centroid(vecs)                   -> Float32Array
 */

import { existsSync } from 'fs';

import { getSidecarUrl } from './faces-client.js';

// ArcFace 512-dim embeddings are L2-normalised to unit length, so the
// Euclidean distance between two unit vectors maps to cosine similarity
// via L2² = 2·(1 − cos). Same-person pairs typically land at L2 ≈
// 0.3-1.0 (cos sim 0.95-0.5); different-person pairs at L2 ≈ 1.0-1.4.
// Calibrated against real 926-photo / 689-face data (see
// scripts/calibrate-faces-eps.js):
//   ε=1.05 → 80 distinct clusters (peak, low false-merge risk)
//   ε=1.10 → 79 (starting to merge — top jumps to 89)
//   ε=1.15 → 45 (mega-merge begins — top jumps to 449 ⚠)
//   ε=1.20 → 7  (catastrophic collapse — top is 641)
// ε=1.05 is the production sweet spot: maximum distinct people
// surfaced without false merges. The previous default ε=0.5 was
// FaceNet-era (legacy face-api 128-dim) and silently kept the People
// grid empty on ArcFace 512-dim libraries.
export const FACE_DEFAULTS = Object.freeze({
    facesEpsilon: 1.05, // DBSCAN radius (buffalo_l 512-dim L2-normalised ArcFace embeddings)
    facesMinPoints: 2, // smallest cluster we'll surface as a "person" — 2 surfaces rarer faces
    minDetectionScore: 0.5, // sidecar detector confidence floor
    inputSize: 320, // kept for backwards compat; sidecar ignores it (its own preprocessor)
    facesDetector: 'buffalo_l', // hint forwarded to the sidecar; currently single model
});

// Throttle the "no sidecar configured" log so a busy scan doesn't spam.
let _warnedNoSidecar = false;

/**
 * Detect every face in one image via the Python sidecar, then post-filter
 * through `qualityFilter` so operator-overridable thresholds (face-size,
 * aspect-ratio) stay authoritative on the Node side. The sidecar already
 * applies a baseline filter — running a second pass keeps thresholds in
 * one place (cfg) regardless of which sidecar version is talking.
 *
 * Returns:
 *   - `null` when the sidecar is unconfigured, unreachable, or had a hard
 *     failure (file gone, decode died, retries exhausted). scan-runner
 *     stamps `ai_indexed_at` and moves on so the loop doesn't re-spin.
 *   - `[]` when the sidecar replied but found no faces.
 *   - `[{x, y, w, h, score, embedding: Float32Array, landmarks?}, …]` on success.
 */
export async function detectFaces(absPath, cfg = {}, onLog) {
    if (!absPath || !existsSync(absPath)) return null;
    const url = getSidecarUrl();
    if (!url) {
        if (!_warnedNoSidecar) {
            _warnedNoSidecar = true;
            try {
                if (typeof onLog === 'function') {
                    onLog({
                        source: 'ai-faces',
                        level: 'info',
                        msg: 'faces sidecar not configured yet — skipping detection (subsequent calls suppressed)',
                    });
                }
            } catch {
                /* swallow — never throw out of the shim */
            }
        }
        return null;
    }
    // Dynamic import so vitest can mock `./faces-client.js` without the
    // mock being shadowed by an ESM static binding.
    let detected;
    try {
        const mod = await import('./faces-client.js');
        detected = await mod.detectFaces(absPath, cfg, onLog);
    } catch (e) {
        try {
            if (typeof onLog === 'function') {
                onLog({
                    source: 'ai-faces',
                    level: 'warn',
                    msg: `sidecar detect failed for ${absPath}: ${e?.message || e}`,
                });
            }
        } catch {
            /* swallow */
        }
        return null;
    }
    if (!Array.isArray(detected)) return null;
    return qualityFilter(detected, cfg);
}

/**
 * Drop low-quality face detections so the cluster pass doesn't hallucinate
 * "people" out of garbage. Three rules:
 *
 *   1. `score < minScore` — sidecar detector confidence floor.
 *      Default 0.5 — empirical for buffalo_l; lower lets in false
 *      positives (textures, distant heads, partial occlusion).
 *   2. `min(w, h) < minBoxPx` — too small to embed reliably.
 *      Default 80 px — the sidecar already normalises crops, but
 *      anything smaller has too few pixels to encode identity well.
 *   3. Aspect ratio outside [0.5, 2.0] — the detector occasionally
 *      returns very-elongated boxes from non-face textures (window
 *      frames, chair legs). Real faces are roughly square.
 *
 * Returns the filtered list. The caller persists what comes back.
 */
export function qualityFilter(detections, cfg = {}) {
    if (!Array.isArray(detections)) return [];
    const minScore = Number.isFinite(cfg.minDetectionScore)
        ? cfg.minDetectionScore
        : FACE_DEFAULTS.minDetectionScore;
    const minBoxPx = Number.isFinite(cfg.minFaceSizePx) ? cfg.minFaceSizePx : 60;
    return detections.filter((d) => {
        if (!d) return false;
        if (Number.isFinite(d.score) && d.score < minScore) return false;
        const w = Number(d.w) || 0;
        const h = Number(d.h) || 0;
        if (Math.min(w, h) < minBoxPx) return false;
        const ratio = w > 0 && h > 0 ? w / h : 0;
        if (ratio < 0.5 || ratio > 2.0) return false;
        return true;
    });
}

// ---- Math + DBSCAN -------------------------------------------------------

/** Euclidean distance between two equal-length vectors. */
export function euclidean(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

/** Mean of a set of equal-length vectors. */
export function centroid(vecs) {
    if (!Array.isArray(vecs) || !vecs.length) return null;
    const dim = vecs[0].length;
    const out = new Float32Array(dim);
    for (const v of vecs) {
        if (!v || v.length !== dim) continue;
        for (let i = 0; i < dim; i++) out[i] += v[i];
    }
    for (let i = 0; i < dim; i++) out[i] /= vecs.length;
    return out;
}

/**
 * Region-query: indices of every point within `eps` of point[idx].
 * O(N) per call; the full DBSCAN is O(N²). Acceptable for libraries up
 * to ~50k faces — beyond that an approximate-NN structure (HNSW, vp-tree)
 * would be the next move.
 */
function _regionQuery(points, idx, eps) {
    const out = [];
    const p = points[idx];
    for (let j = 0; j < points.length; j++) {
        if (j === idx) continue;
        if (euclidean(p, points[j]) <= eps) out.push(j);
    }
    return out;
}

/**
 * Classic DBSCAN. `points` is an array of equal-length Float32Array.
 * Returns an array, same length as `points`, where each entry is either
 * a non-negative cluster id or `-1` for noise/outlier.
 *
 * `opts.eps`     — neighborhood radius (default `FACE_DEFAULTS.facesEpsilon`).
 * `opts.minPts`  — minimum cluster size (default `FACE_DEFAULTS.facesMinPoints`).
 */
export function dbscan(points, opts = {}) {
    const eps = Number.isFinite(opts.eps) ? opts.eps : FACE_DEFAULTS.facesEpsilon;
    const minPts = Math.max(
        2,
        Number.isFinite(opts.minPts) ? opts.minPts : FACE_DEFAULTS.facesMinPoints,
    );
    const N = points?.length || 0;
    const labels = new Array(N).fill(-2); // -2 = unvisited, -1 = noise, >=0 = cluster id
    let cluster = -1;

    for (let i = 0; i < N; i++) {
        if (labels[i] !== -2) continue;
        const neighbors = _regionQuery(points, i, eps);
        if (neighbors.length + 1 < minPts) {
            labels[i] = -1;
            continue;
        }
        cluster++;
        labels[i] = cluster;
        const stack = neighbors.slice();
        while (stack.length) {
            const j = stack.shift();
            if (labels[j] === -1) labels[j] = cluster; // border point
            if (labels[j] !== -2) continue;
            labels[j] = cluster;
            const sub = _regionQuery(points, j, eps);
            if (sub.length + 1 >= minPts) {
                for (const k of sub) {
                    if (labels[k] === -2) stack.push(k);
                }
            }
        }
    }
    return labels;
}

/**
 * Cluster a list of face records (objects with `embedding: Float32Array`).
 * Returns:
 *   { clusters: [{ memberIdxs: number[], centroid: Float32Array, faceCount }],
 *     noise: number[] }
 *
 * `clusters` are ordered DESC by face count so the UI's "biggest cluster
 * first" heuristic works without a second sort.
 */
export function clusterFaces(faces, opts = {}) {
    const points = faces.map((f) => f.embedding);
    const labels = dbscan(points, opts);
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
            centroid: centroid(memberIdxs.map((i) => points[i])),
            faceCount: memberIdxs.length,
        }))
        .sort((a, b) => b.faceCount - a.faceCount);
    return { clusters, noise };
}

/** Reset module-local state — for tests only. */
export function _resetForTests() {
    _warnedNoSidecar = false;
    // Also clear the faces-client cache so a subsequent test that
    // exercises detectFaces against a mocked sidecar starts clean.
    // Use dynamic import to avoid a static cycle.
    import('./faces-client.js')
        .then((m) => {
            if (typeof m._resetForTests === 'function') m._resetForTests();
        })
        .catch(() => {
            /* test-only helper; swallow */
        });
}
