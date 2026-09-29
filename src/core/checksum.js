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
 * Computed by:         tgdl-core (Go), streaming — multi-GB files are fine.
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

export const CHECKSUM_ALGO = 'sha256';
export const CHECKSUM_VERSION = 1;
// Hex SHA-256 → exactly 64 lowercase characters. Anchor for sanity-check
// regexes / quick "is this a checksum field" tests in callers.
export const CHECKSUM_HEX_LENGTH = 64;
export const CHECKSUM_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * SHA-256 of a file already on disk, as lowercase hex — computed by
 * tgdl-core (src/core/gocore/hash.js), off the event loop, with the same
 * digest crypto.createHash('sha256') over fs.createReadStream gives.
 *
 * Rejects like fs would when the file can't be read (err.code ENOENT,
 * EACCES, …), or with a GoCoreError (err.status 503) when tgdl-core isn't
 * available; callers treat both as "no hash for this file".
 *
 * @param {string} absPath  Absolute path to the file
 * @returns {Promise<string>} Lowercase 64-char hex digest
 */
export async function sha256OfFile(absPath) {
    const { hashFileViaCore } = await import('./gocore/hash.js');
    return hashFileViaCore(absPath);
}

/** True when `s` looks like a value produced by sha256OfFile. */
export function isValidChecksum(s) {
    return typeof s === 'string' && CHECKSUM_HEX_RE.test(s);
}
