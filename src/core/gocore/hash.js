/**
 * SHA-256 of a file on disk, computed by tgdl-core.
 *
 * `hashFileViaCore(absPath)` resolves the lowercase hex digest of the
 * whole file (read until EOF) — byte-identical to
 * crypto.createHash('sha256') over fs.createReadStream — or rejects:
 *
 *   - the file can't be read: an Error shaped like the one fs would throw
 *     (code ENOENT / EACCES / EISDIR …, syscall 'open', path);
 *   - tgdl-core isn't available: GoCoreError (kind 'unavailable', 503,
 *     message with the fix).
 *
 * A path outside the directories tgdl-core may read (EOUTSIDE — a folder
 * linked in from another disk, a download path that was changed since)
 * is hashed here with a plain stream, exactly as the app always did.
 */

import crypto from 'crypto';
import { createReadStream, promises as fsp } from 'fs';
import path from 'path';

import * as client from './client.js';
import { uvError } from './fs.js';

// Request deadline: a floor plus the time the file takes at a slow-disk
// read rate (8 MiB/s: a 4 GiB file gets ~9 min).
let _minTimeoutMs = 30_000;
let _minBytesPerSec = 8 * 1024 * 1024;

export function hashTimeoutMs(size) {
    const n = Math.max(0, Number(size) || 0);
    return _minTimeoutMs + Math.ceil((n / _minBytesPerSec) * 1000);
}

function _sha256Stream(absPath) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = createReadStream(absPath);
        s.on('error', reject);
        s.on('data', (chunk) => h.update(chunk));
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/**
 * @param {string} absPath
 * @returns {Promise<string>} lowercase 64-char hex SHA-256
 */
export async function hashFileViaCore(absPath) {
    // tgdl-core's working directory differs from ours: send absolute paths.
    const abs = path.resolve(absPath);
    let size = 0;
    try {
        size = (await fsp.stat(abs)).size;
    } catch {
        // Only sizes the deadline; tgdl-core reports the real error.
    }
    try {
        const r = await client.hashFile(abs, { timeoutMs: hashTimeoutMs(size) });
        return r.sha256;
    } catch (e) {
        if (e?.kind === 'outside') return _sha256Stream(abs);
        if (e?.kind === 'file') {
            // fs.createReadStream opens a directory fine and fails the read.
            throw e.code === 'EISDIR'
                ? uvError('EISDIR', 'read')
                : uvError(e.code || 'EIO', 'open', abs);
        }
        throw e;
    }
}

/** Test hook: shrink the deadlines. */
export function _setTuningForTests({ minTimeoutMs, minBytesPerSec } = {}) {
    if (minTimeoutMs !== undefined) _minTimeoutMs = minTimeoutMs;
    if (minBytesPerSec !== undefined) _minBytesPerSec = minBytesPerSec;
}

export function _resetForTests() {
    _minTimeoutMs = 30_000;
    _minBytesPerSec = 8 * 1024 * 1024;
}
