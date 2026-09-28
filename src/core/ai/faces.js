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

import { clusterFlat, dbscanFlat, packPoints } from './dbscan.js';
import { getSidecarUrl, SidecarUnavailableError } from './faces-client.js';

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
 *
 * `opts.throwOnUnavailable` — throw `SidecarUnavailableError` instead of
 * returning null when the sidecar (not the file) is the problem, so the
 * caller can leave the row for a later scan.
 */
export async function detectFaces(absPath, cfg = {}, onLog, opts = {}) {
    if (!absPath || !existsSync(absPath)) return null;
    const strict = opts?.throwOnUnavailable === true;
    const url = getSidecarUrl();
    if (!url) {
        if (strict) throw new SidecarUnavailableError('sidecar URL unset');
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
        detected = await mod.detectFaces(absPath, cfg, onLog, { throwOnUnavailable: strict });
    } catch (e) {
        if (strict && e?.code === 'SIDECAR_UNAVAILABLE') throw e;
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

/** Weighted mean of a set of equal-length vectors. */
export function centroid(vecs, weights = null) {
    if (!Array.isArray(vecs) || !vecs.length) return null;
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

// DBSCAN itself lives in `dbscan.js` (flat Float32Array, queue-once
// expansion, early-exit distance) so it can run inside a worker thread.
// The two wrappers below keep the historical array-of-vectors API and
// produce label-for-label identical output.

function _resolveClusterOpts(opts = {}) {
    return {
        eps: Number.isFinite(opts.eps) ? opts.eps : FACE_DEFAULTS.facesEpsilon,
        minPts: Math.max(
            2,
            Number.isFinite(opts.minPts) ? opts.minPts : FACE_DEFAULTS.facesMinPoints,
        ),
    };
}

/**
 * Classic DBSCAN. `points` is an array of equal-length Float32Array.
 * Returns an array, same length as `points`, where each entry is either
 * a non-negative cluster id or `-1` for noise/outlier.
 *
 * `opts.eps`     — neighborhood radius (default `FACE_DEFAULTS.facesEpsilon`).
 * `opts.minPts`  — minimum cluster size (default `FACE_DEFAULTS.facesMinPoints`).
 *
 * O(N²·dim) — runs on the calling thread. The scan runner uses
 * `clusterFacesOffThread()` instead so Phase B never blocks the event loop.
 */
export function dbscan(points, opts = {}) {
    if (!points?.length) return [];
    const { data, n, dim } = packPoints(points);
    return Array.from(dbscanFlat(data, n, dim, _resolveClusterOpts(opts)));
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
    if (!faces?.length) return { clusters: [], noise: [] };
    const { data, n, dim } = packPoints(faces.map((f) => f.embedding));
    const weights = Float64Array.from(faces, (f) =>
        Number.isFinite(f.qualityScore) ? f.qualityScore : Number.NaN,
    );
    return clusterFlat(data, n, dim, weights, _resolveClusterOpts(opts));
}

// Below this many points the worker round-trip (spawn + module load,
// ~30-60 ms) costs more than the clustering itself.
const OFF_THREAD_MIN_POINTS = 256;

/**
 * Cluster pre-packed embeddings on a worker thread so a large library
 * (O(N²) — minutes at 50 k faces) can't starve the event loop, which is
 * what the container healthcheck watches. Falls back to the calling
 * thread for tiny inputs or when a worker can't be started.
 *
 * `data` is transferred to the worker (zero-copy) and is detached on
 * return — callers must not reuse it.
 *
 * @param {{data: Float32Array, n: number, dim: number, weights?: Float64Array}} flat
 * @param {object} opts  `{ eps, minPts, signal?, onProgress?(done, n) }`
 * @returns {Promise<{clusters: {memberIdxs: Int32Array|number[], centroid: Float32Array, faceCount: number}[], noiseCount: number}>}
 */
export async function clusterFacesOffThread(flat, opts = {}) {
    const { eps, minPts } = _resolveClusterOpts(opts);
    const { data, n, dim } = flat;
    const weights = flat.weights || null;
    const signal = opts.signal || null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    if (signal?.aborted) throw _abortError();

    const inline = () => {
        const { clusters, noise } = clusterFlat(data, n, dim, weights, { eps, minPts });
        return { clusters, noiseCount: noise.length };
    };
    if (n < OFF_THREAD_MIN_POINTS || opts.inline === true) return inline();

    let worker;
    try {
        const { Worker } = await import('node:worker_threads');
        worker = new Worker(new URL('./cluster-worker.js', import.meta.url));
    } catch {
        return inline();
    }
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            worker.terminate().catch(() => {});
            fn(value);
        };
        const onAbort = () => finish(reject, _abortError());
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        worker.on('message', (msg) => {
            if (msg?.type === 'progress') {
                try {
                    onProgress?.(msg.done, msg.n);
                } catch {}
                return;
            }
            if (msg?.type === 'error') return finish(reject, new Error(msg.message));
            if (msg?.type !== 'result') return;
            // Unpack: members concatenated in cluster order + offsets.
            const clusters = [];
            for (let c = 0; c < msg.count; c++) {
                const memberIdxs = msg.members.subarray(msg.starts[c], msg.starts[c + 1]);
                clusters.push({
                    memberIdxs,
                    centroid: msg.centroids.slice(c * dim, (c + 1) * dim),
                    faceCount: memberIdxs.length,
                });
            }
            finish(resolve, { clusters, noiseCount: msg.noiseCount });
        });
        worker.on('error', (e) => finish(reject, e));
        worker.on('exit', (code) => {
            if (!settled) finish(reject, new Error(`cluster worker exited with code ${code}`));
        });
        const transfer = [data.buffer];
        if (weights?.buffer) transfer.push(weights.buffer);
        worker.postMessage({ type: 'cluster', data, n, dim, weights, eps, minPts }, transfer);
    });
}

function _abortError() {
    const e = new Error('clustering aborted');
    e.name = 'AbortError';
    return e;
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
