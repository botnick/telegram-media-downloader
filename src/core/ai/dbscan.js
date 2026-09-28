/**
 * Flat-buffer DBSCAN for face embeddings. Pure math — no fs / DB / sidecar
 * imports — so the same code runs in-process (small inputs, tests) and
 * inside `cluster-worker.js` (the scan runner's Phase B), where a
 * multi-minute clustering pass can't starve the dashboard's event loop.
 *
 * Output is label-for-label identical to the original array-of-
 * Float32Array implementation that lived in faces.js:
 *
 *   - same visit order (outer loop by index, FIFO expansion queue),
 *   - same distance arithmetic (`Σ (a[i] − b[i])²` accumulated in one
 *     double, in dimension order, then `Math.sqrt(sum) <= eps`),
 *   - same quirks (a noise point only becomes a border point when it is
 *     in the seed's own neighbourhood; later expansions only enqueue
 *     unvisited points).
 *
 * What changed is the cost, not the answer:
 *
 *   1. Embeddings live in one contiguous Float32Array (`n × dim`) instead
 *      of n separately-allocated typed arrays — cache friendly, and one
 *      transferable buffer for the worker hand-off.
 *   2. Points are marked QUEUED when enqueued, so each point enters the
 *      expansion queue at most once per cluster. The old code pushed a
 *      point once per core neighbour and popped with `Array#shift()`
 *      (O(n)), which made one 1 000-face person cost ~500 k queue entries
 *      and minutes of CPU. The queue is now a preallocated Int32Array
 *      with a head pointer.
 *   3. The distance loop bails out as soon as the running sum can no
 *      longer be within `eps` (partial sums of squares only grow). The
 *      bound is picked so the early exit never disagrees with the full
 *      `Math.sqrt(sum) <= eps` test — see `_rejectBound`.
 */

const UNVISITED = -2;
const NOISE = -1;
const QUEUED = -3;

// Check the running sum every CHECK_EVERY dimensions. 32 keeps the branch
// out of the inner loop's way while still exiting ~40 % early on the
// typical different-person pair (L2² ≈ 1.8 vs eps² ≈ 1.1).
const CHECK_EVERY = 32;

/**
 * Smallest-ish bound B such that `sum > B` guarantees
 * `Math.sqrt(sum) > eps` in IEEE doubles. Math.sqrt is correctly rounded
 * and therefore monotonic, so any B with `Math.sqrt(B) > eps` works; we
 * start at eps² and nudge upward until that holds.
 */
function _rejectBound(eps) {
    if (!(eps >= 0)) return -Infinity; // NaN / negative eps: nothing is ever within
    if (eps === Infinity) return Infinity;
    let b = eps * eps;
    if (b === 0) b = Number.MIN_VALUE;
    while (!(Math.sqrt(b) > eps)) b += Math.max(b * Number.EPSILON, Number.MIN_VALUE);
    return b;
}

/**
 * Indices of every point within `eps` of point `idx`, written into `out`
 * in ascending order. Returns the count. O(n · dim) per call.
 */
function _regionQuery(data, n, dim, idx, eps, bound, out) {
    const base = idx * dim;
    let count = 0;
    for (let j = 0; j < n; j++) {
        if (j === idx) continue;
        let sum = 0;
        let i = 0;
        let p = base;
        let q = j * dim;
        let rejected = false;
        while (i < dim) {
            const stop = i + CHECK_EVERY < dim ? i + CHECK_EVERY : dim;
            // Unrolled ×4 but still ONE accumulator in dimension order —
            // splitting the sum would change rounding and could flip a
            // pair sitting exactly on the eps boundary.
            for (; i + 4 <= stop; i += 4, p += 4, q += 4) {
                let d = data[p] - data[q];
                sum += d * d;
                d = data[p + 1] - data[q + 1];
                sum += d * d;
                d = data[p + 2] - data[q + 2];
                sum += d * d;
                d = data[p + 3] - data[q + 3];
                sum += d * d;
            }
            for (; i < stop; i++, p++, q++) {
                const d = data[p] - data[q];
                sum += d * d;
            }
            if (sum > bound) {
                rejected = true;
                break;
            }
        }
        if (!rejected && Math.sqrt(sum) <= eps) out[count++] = j;
    }
    return count;
}

/**
 * DBSCAN over `n` points of `dim` floats packed row-major in `data`.
 *
 * @param {Float32Array} data   n × dim embeddings
 * @param {number} n
 * @param {number} dim
 * @param {object} opts
 * @param {number} opts.eps     neighbourhood radius (Euclidean)
 * @param {number} opts.minPts  minimum neighbourhood size incl. the point (≥ 2)
 * @param {function?} opts.onProgress  `(done, n)` — called roughly every
 *        `progressEveryMs` with the number of region queries finished
 * @param {number?} opts.progressEveryMs  default 1000
 * @returns {Int32Array} label per point: cluster id ≥ 0, or -1 for noise
 */
export function dbscanFlat(data, n, dim, opts = {}) {
    const eps = Number(opts.eps);
    const minPts = Math.max(2, Number.isFinite(opts.minPts) ? opts.minPts : 2);
    const bound = _rejectBound(eps);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const progressEveryMs = Number.isFinite(opts.progressEveryMs) ? opts.progressEveryMs : 1000;

    const labels = new Int32Array(n).fill(UNVISITED);
    if (n === 0) return labels;
    const nbr = new Int32Array(n);
    const queue = new Int32Array(n);
    let cluster = -1;
    let queries = 0;
    let lastReport = Date.now();
    const tick = () => {
        queries++;
        if (onProgress && (queries & 63) === 0) {
            const now = Date.now();
            if (now - lastReport >= progressEveryMs) {
                lastReport = now;
                onProgress(queries, n);
            }
        }
    };

    for (let i = 0; i < n; i++) {
        if (labels[i] !== UNVISITED) continue;
        const seedCount = _regionQuery(data, n, dim, i, eps, bound, nbr);
        tick();
        if (seedCount + 1 < minPts) {
            labels[i] = NOISE;
            continue;
        }
        cluster++;
        labels[i] = cluster;
        // Every neighbour of the seed is enqueued (noise ones become
        // border points on pop); unvisited ones are marked so later
        // expansions don't enqueue them a second time.
        let head = 0;
        let tail = 0;
        for (let t = 0; t < seedCount; t++) {
            const k = nbr[t];
            queue[tail++] = k;
            if (labels[k] === UNVISITED) labels[k] = QUEUED;
        }
        while (head < tail) {
            const j = queue[head++];
            if (labels[j] === NOISE) labels[j] = cluster; // border point
            if (labels[j] !== QUEUED) continue;
            labels[j] = cluster;
            const subCount = _regionQuery(data, n, dim, j, eps, bound, nbr);
            tick();
            if (subCount + 1 >= minPts) {
                for (let t = 0; t < subCount; t++) {
                    const k = nbr[t];
                    if (labels[k] === UNVISITED) {
                        labels[k] = QUEUED;
                        queue[tail++] = k;
                    }
                }
            }
        }
    }
    if (onProgress) onProgress(n, n);
    return labels;
}

/**
 * Weighted mean of the member rows. Same arithmetic as faces.js
 * `centroid()` (Float32Array accumulator, weights ≤ 0 / non-finite count
 * as 1.0) so persisted centroids stay byte-identical.
 */
function _centroidOf(data, dim, memberIdxs, weights) {
    const out = new Float32Array(dim);
    let totalW = 0;
    for (let m = 0; m < memberIdxs.length; m++) {
        const idx = memberIdxs[m];
        const raw = weights ? weights[idx] : 1.0;
        const w = Number.isFinite(raw) && raw > 0 ? raw : 1.0;
        totalW += w;
        const off = idx * dim;
        for (let i = 0; i < dim; i++) out[i] += data[off + i] * w;
    }
    if (totalW <= 0) totalW = 1;
    for (let i = 0; i < dim; i++) out[i] /= totalW;
    return out;
}

/**
 * Cluster + summarise. Mirrors faces.js `clusterFaces()` exactly:
 * clusters in first-appearance order (by point index), then a stable
 * sort by face count DESC.
 *
 * @param {Float32Array} data     n × dim embeddings
 * @param {number} n
 * @param {number} dim
 * @param {Float64Array|number[]|null} weights  per-point quality weight
 *        (NaN / null → 1.0)
 * @param {object} opts  `{ eps, minPts, onProgress, progressEveryMs }`
 * @returns {{ clusters: {memberIdxs: number[], centroid: Float32Array, faceCount: number}[],
 *             noise: number[] }}
 */
export function clusterFlat(data, n, dim, weights, opts = {}) {
    const labels = dbscanFlat(data, n, dim, opts);
    const groups = new Map();
    const noise = [];
    for (let idx = 0; idx < n; idx++) {
        const label = labels[idx];
        if (label < 0) {
            noise.push(idx);
            continue;
        }
        let g = groups.get(label);
        if (!g) {
            g = [];
            groups.set(label, g);
        }
        g.push(idx);
    }
    const clusters = [...groups.values()]
        .map((memberIdxs) => ({
            memberIdxs,
            centroid: _centroidOf(data, dim, memberIdxs, weights),
            faceCount: memberIdxs.length,
        }))
        .sort((a, b) => b.faceCount - a.faceCount);
    return { clusters, noise };
}

/**
 * Pack `points` (array of equal-length vectors) into one Float32Array.
 * Rows whose length differs from the first row's are left as NaN — they
 * can never be within eps of anything, which matches the old
 * `euclidean()` returning Infinity on a length mismatch.
 */
export function packPoints(points) {
    const n = points?.length || 0;
    const dim = n ? points[0]?.length || 0 : 0;
    const data = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) {
        const p = points[i];
        if (p && p.length === dim) data.set(p, i * dim);
        else data.fill(Number.NaN, i * dim, (i + 1) * dim);
    }
    return { data, n, dim };
}
