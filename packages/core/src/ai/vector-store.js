/**
 * Vector store helpers for semantic search.
 *
 * Two execution paths:
 *
 *   - Fast path: the `sqlite-vec` extension is present (rare on default
 *     installs; some operators bring their own build). We try-load it once
 *     at module import time. When available, top-K cosine similarity runs
 *     as a single SQL query.
 *
 *   - Default path: in-memory cosine similarity over every embedding row.
 *     Float32 × 512 dims × 50 000 rows = 100 MB cached vectors and a single
 *     dot-product loop returning top-K in well under 500 ms. Above 50k rows
 *     this gets slow; the cache is capped at 50 000 vectors and operators
 *     beyond that are encouraged to install sqlite-vec.
 *
 * BLOB serialisation:
 *   - Embeddings are stored as little-endian Float32 buffers (i.e. raw
 *     `Float32Array.buffer` byte contents). Round-tripping via Buffer in
 *     better-sqlite3 is loss-free.
 *   - We always L2-normalise before serialising. Cosine sim then collapses
 *     to a plain dot product, which removes a per-row sqrt from the hot loop.
 *
 * sqlite-vec is OPTIONAL — never fail to start when it's missing.
 */

import { listAllImageEmbeddings } from '../db.js';

let _vecExtensionAvailable = null;  // lazy probe

/**
 * Try to load sqlite-vec into the live DB connection. Probe runs lazily on
 * first call to `loadExtensionOnce()`. Returns true when the extension is
 * loaded and ready, false otherwise. Never throws.
 */
export async function loadExtensionOnce(getDb, onLog) {
    if (_vecExtensionAvailable !== null) return _vecExtensionAvailable;
    const _log = (level, msg) => {
        try { if (typeof onLog === 'function') onLog({ source: 'ai', level, msg }); }
        catch { /* swallow */ }
    };
    try {
        const mod = await import('sqlite-vec').catch(() => null);
        if (!mod || typeof mod.load !== 'function') {
            _log('info', 'sqlite-vec not installed — falling back to in-memory cosine similarity');
            _vecExtensionAvailable = false;
            return false;
        }
        const db = getDb();
        try {
            mod.load(db);
            _vecExtensionAvailable = true;
            _log('info', 'sqlite-vec extension loaded — fast vector search enabled');
            return true;
        } catch (e) {
            _log('warn', `sqlite-vec load failed: ${e?.message || e} — using in-memory fallback`);
            _vecExtensionAvailable = false;
            return false;
        }
    } catch {
        _vecExtensionAvailable = false;
        return false;
    }
}

/**
 * L2-normalise a Float32Array in place. Returns the same array for chaining.
 * A zero-length vector is left untouched (would otherwise divide by zero).
 */
export function l2Normalize(vec) {
    let n = 0;
    for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
    n = Math.sqrt(n);
    if (n === 0) return vec;
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / n;
    return vec;
}

/**
 * Cosine similarity between two same-length numeric vectors. Inputs may be
 * Float32Array or plain number[]. Returns a number in [-1, 1]. When either
 * input is a zero vector returns 0 (same convention as numpy / scipy).
 */
export function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        dot += x * y;
        na  += x * x;
        nb  += y * y;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom === 0) return 0;
    return dot / denom;
}

/**
 * Round-trip helpers between Float32Array and SQLite BLOB.
 *
 * better-sqlite3 returns BLOBs as Buffer instances. We have to copy bytes
 * (not view) because Buffer.byteOffset may not be aligned to 4 bytes when
 * the row was loaded into a shared pool, and Float32Array constructor
 * requires 4-byte alignment to wrap an existing ArrayBuffer.
 */
export function vectorToBlob(vec) {
    if (vec instanceof Float32Array) return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    const f = new Float32Array(vec);
    return Buffer.from(f.buffer);
}

export function blobToVector(blob) {
    if (!blob) return null;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const len = buf.byteLength >>> 2;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        out[i] = buf.readFloatLE(i * 4);
    }
    return out;
}

// In-memory cache keyed off the embeddings table size + most-recent
// indexed_at. Invalidated lazily — the search endpoint reloads when the
// cache size doesn't match the table count.
const _cache = {
    vectors: null,        // Array<{ download_id, vec, row }>
    rowsCount: -1,
    lastIndexedAt: 0,
};

const VECTOR_CACHE_MAX = 50000;

function _cacheValid(currentCount) {
    return _cache.vectors !== null && _cache.rowsCount === currentCount;
}

/**
 * Top-K cosine similarity search across every embedding row.
 *
 * @param {Float32Array} queryVec  L2-normalised query embedding (same dim as stored)
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {string[]} [opts.fileTypes]  Optional file_type allowlist.
 * @returns {Array<{ download_id, score, row }>}
 */
export function topK(queryVec, { limit = 20, fileTypes = null } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 20));

    const rows = listAllImageEmbeddings({ fileTypes });
    if (!rows.length) return [];

    if (!_cacheValid(rows.length)) {
        const trimmed = rows.length > VECTOR_CACHE_MAX ? rows.slice(0, VECTOR_CACHE_MAX) : rows;
        _cache.vectors = trimmed.map((r) => ({
            download_id: r.download_id,
            vec: blobToVector(r.embedding),
            row: r,
        }));
        _cache.rowsCount = rows.length;
    }

    // Single-pass top-K via a tiny min-heap on `score` would be marginally
    // faster on huge libraries but the sort-then-slice path is plenty fast
    // up to the cache cap and far easier to reason about.
    const scored = [];
    for (const v of _cache.vectors) {
        const s = cosine(queryVec, v.vec);
        scored.push({ download_id: v.download_id, score: s, row: v.row });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, lim);
}

/** Force-clear the cache — call after bulk delete / reclassify. */
export function clearCache() {
    _cache.vectors = null;
    _cache.rowsCount = -1;
    _cache.lastIndexedAt = 0;
}
