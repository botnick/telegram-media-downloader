/**
 * Canonical content-hash helper.
 *
 * Single source of truth for "what does THIS download's checksum look
 * like" so every code path that hashes media (the post-write hash in
 * `downloader.js`, the catch-up scan in `dedup.js`, any future per-file
 * verification) produces a value that compares 1:1 across the codebase.
 *
 * Algorithm:           SHA-256
 * Encoding:            lowercase hex (64 chars)
 * Read strategy:       streaming via fs.createReadStream — works for
 *                      multi-GB files without OOM, doesn't depend on
 *                      mmap / sendfile semantics.
 *
 * Why SHA-256 (vs BLAKE2 / xxhash):
 *   - Ships in Node core, zero deps.
 *   - Fast enough for media files (HDD I/O dominates, not CPU).
 *   - Collision probability is irrelevant at this dataset scale.
 *
 * If you ever need to migrate the algorithm, change ALGO + bump
 * `CHECKSUM_VERSION` and add a re-hash sweep — the column type in the
 * `downloads` table is plain TEXT so the new digest fits without a
 * migration.
 */

import crypto from 'crypto';
import { createReadStream } from 'fs';

export const CHECKSUM_ALGO = 'sha256';
export const CHECKSUM_VERSION = 1;
// Hex SHA-256 → exactly 64 lowercase characters. Anchor for sanity-check
// regexes / quick "is this a checksum field" tests in callers.
export const CHECKSUM_HEX_LENGTH = 64;
export const CHECKSUM_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Stream-hash a file already on disk and return the hex digest.
 *
 * @param {string} absPath  Absolute path to the file
 * @returns {Promise<string>} Lowercase 64-char hex digest
 * @throws {Error} on read errors (caller decides whether to fall back)
 */
export function sha256OfFile(absPath) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash(CHECKSUM_ALGO);
        const s = createReadStream(absPath);
        s.on('error', reject);
        s.on('data', (chunk) => h.update(chunk));
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/**
 * Worker-pool-backed equivalent of `sha256OfFile`. Same return value, same
 * algorithm, but runs the hash on a `worker_threads` pool so the main
 * event loop stays free for HTTP / WebSocket traffic during multi-GB
 * post-write hashing. Falls back to the inline streamer if the worker
 * pool is disabled (`HASH_WORKER_DISABLE=1`) or unavailable.
 *
 * Lazy import keeps this module's dep graph free of `worker_threads`
 * for tests / contexts that never opt into the pool.
 *
 * @param {string} absPath
 * @returns {Promise<string>}
 */
export async function sha256OfFileViaPool(absPath) {
    const mod = await import('./hash-worker.js');
    return mod.hashFile(absPath, CHECKSUM_ALGO);
}

/** True when `s` looks like a value produced by sha256OfFile. */
export function isValidChecksum(s) {
    return typeof s === 'string' && CHECKSUM_HEX_RE.test(s);
}
