/**
 * Perceptual hash (pHash) — DCT-based 64-bit fingerprint.
 *
 * No external models needed. We resize to 32x32 grayscale via sharp (already
 * a hard dep), run a 2D DCT-II, drop the high-frequency coefficients, and
 * threshold the remaining 8x8 = 64 coefficients against the median. Two
 * images that differ by JPEG quality, slight crop, or mild colour shift
 * should land within Hamming distance 6 of each other.
 *
 * Output is a BigInt (64 bits). The DB column stores it as SQLite INTEGER;
 * `hammingDistance(a, b)` works on either two BigInts or two numbers — both
 * paths yield a count in [0, 64].
 *
 * This is the simplest of the four AI capabilities: deterministic, no model
 * download, no WASM, ~5-10 ms per image on a laptop. We expose it both as
 * a one-shot helper (`computePhash(absPath)`) and as the module factory the
 * AI manager hooks into the JobTracker scan loop.
 */

import { existsSync } from 'fs';
import sharp from 'sharp';

const SIZE = 32;     // pixel grid for the DCT input
const HASH = 8;      // top-left HASHxHASH coefficients become the bit signature

// Pre-compute the DCT-II cosine table so we don't recompute Math.cos on every
// call. SIZE × SIZE entries — tiny (8 KB).
let _cosTable = null;
function _ensureCosTable() {
    if (_cosTable) return _cosTable;
    _cosTable = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            _cosTable[i * SIZE + j] = Math.cos(((2 * i + 1) * j * Math.PI) / (2 * SIZE));
        }
    }
    return _cosTable;
}

/**
 * Apply a 2D DCT-II to the SIZExSIZE pixel buffer. Returns a Float64Array
 * of length SIZE*SIZE in row-major order.
 *
 * O(N^4) — fine for N=32 (~1M ops, well under a millisecond on any CPU).
 * No FFT-style optimisation is needed at this size; clarity > cleverness.
 */
function dct2d(pixels) {
    const cos = _ensureCosTable();
    const out = new Float64Array(SIZE * SIZE);
    for (let u = 0; u < SIZE; u++) {
        for (let v = 0; v < SIZE; v++) {
            let sum = 0;
            for (let i = 0; i < SIZE; i++) {
                const cu = cos[i * SIZE + u];
                for (let j = 0; j < SIZE; j++) {
                    sum += pixels[i * SIZE + j] * cu * cos[j * SIZE + v];
                }
            }
            out[u * SIZE + v] = sum;
        }
    }
    return out;
}

/**
 * Reduce the DCT result to a 64-bit hash.
 *
 * Standard pHash recipe: keep the top-left 8x8 block (skipping the DC term,
 * which encodes overall brightness — varies wildly between near-duplicates
 * and would dominate the median). Threshold each remaining coefficient
 * against the median value of the block. Bit = 1 if above median, else 0.
 */
function dctToHash(dct) {
    const block = new Float64Array(HASH * HASH);
    for (let i = 0; i < HASH; i++) {
        for (let j = 0; j < HASH; j++) {
            block[i * HASH + j] = dct[i * SIZE + j];
        }
    }
    // Median of the block excluding the DC term (index 0).
    const sorted = Array.from(block.slice(1)).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    let bits = 0n;
    for (let i = 0; i < HASH * HASH; i++) {
        bits = (bits << 1n) | (block[i] > median ? 1n : 0n);
    }
    return bits;
}

/**
 * Compute the pHash of an image file by absolute path.
 *
 * @param {string} absPath
 * @returns {Promise<bigint|null>}  null when the file can't be opened.
 */
export async function computePhash(absPath) {
    if (!absPath || !existsSync(absPath)) return null;
    let raw;
    try {
        raw = await sharp(absPath, { failOn: 'none' })
            .resize(SIZE, SIZE, { fit: 'fill' })
            .greyscale()
            .raw()
            .toBuffer();
    } catch {
        return null;
    }
    if (!raw || raw.length < SIZE * SIZE) return null;
    // sharp.raw() with .greyscale() yields one byte per pixel.
    const pixels = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) pixels[i] = raw[i];
    const dct = dct2d(pixels);
    return dctToHash(dct);
}

/**
 * Hamming distance between two 64-bit pHashes. Accepts BigInt or Number
 * inputs (the DB layer round-trips through BigInt; in-memory cache may keep
 * Numbers). Always returns an integer in [0, 64].
 */
export function hammingDistance(a, b) {
    let bigA, bigB;
    try { bigA = typeof a === 'bigint' ? a : BigInt(a); } catch { return 64; }
    try { bigB = typeof b === 'bigint' ? b : BigInt(b); } catch { return 64; }
    let xor = bigA ^ bigB;
    // Mask to 64 bits — handles the signed-INTEGER round-trip from SQLite
    // where a negative bigint shows up after the bit cast.
    xor = xor & 0xffffffffffffffffn;
    let n = 0;
    while (xor) {
        xor &= xor - 1n;
        n += 1;
    }
    return n;
}

/**
 * Group near-duplicate phashes. Single-link clustering: items within
 * `threshold` Hamming bits of any cluster member join the cluster.
 *
 * Inputs: array of `{ id, phash }` (phash may be BigInt or Number).
 * Output: array of clusters, each `{ ids: [...], size, repId }`. Only
 * clusters of size >= 2 are returned (single items aren't duplicates).
 *
 * O(N^2) brute-force comparison — acceptable up to ~50k photos (a 50k x 50k
 * lookup is 1.25 billion 64-bit XORs, which finishes in a few seconds in
 * pure JS). Above that, switch to a BK-tree or LSH; flagged for v2.6.x.
 */
export function groupNearDuplicates(rows, threshold = 6) {
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const t = Math.max(0, Math.min(64, Number(threshold) || 6));
    const visited = new Uint8Array(rows.length);
    const clusters = [];
    for (let i = 0; i < rows.length; i++) {
        if (visited[i]) continue;
        const seed = rows[i];
        const stack = [i];
        const ids = [];
        while (stack.length) {
            const k = stack.pop();
            if (visited[k]) continue;
            visited[k] = 1;
            ids.push(rows[k].id);
            const a = rows[k].phash;
            for (let j = 0; j < rows.length; j++) {
                if (visited[j] || j === k) continue;
                if (hammingDistance(a, rows[j].phash) <= t) {
                    stack.push(j);
                }
            }
        }
        if (ids.length >= 2) {
            clusters.push({ ids, size: ids.length, repId: seed.id });
        }
    }
    // Largest first — what the dedup UI surfaces at the top.
    clusters.sort((a, b) => b.size - a.size);
    return clusters;
}
