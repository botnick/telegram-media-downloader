/**
 * Routes SHA-256 file hashing between Node and tgdl-core.
 *
 * `routeHash(absPath, nodeHash)` is called by checksum.sha256OfFileViaPool;
 * `nodeHash` is today's implementation (the worker pool, or the main-thread
 * streamer under HASH_WORKER_DISABLE=1). What happens depends on the
 * feature mode (see flags.js):
 *
 *   off / tgdl-core not usable   nodeHash(), exactly as before.
 *   shadow (default)             nodeHash() is returned. About 1 in 20
 *                                files of ≤ 256 MB are hashed again by Go
 *                                afterwards, in the background, and the
 *                                two digests compared.
 *   on                           Go's digest; any failure → nodeHash().
 *   auto                         like on, plus background Node re-checks
 *                                on the same sample; a mismatch demotes
 *                                the feature to shadow for this process.
 *
 * Nothing here throws anything nodeHash() wouldn't: every Go failure ends
 * in a nodeHash() call, and a file Node can't read fails the same way it
 * always did.
 */

import { promises as fsp } from 'fs';
import path from 'path';

import { metrics } from '../metrics.js';
import * as client from './client.js';
import { resolveFeatureMode } from './flags.js';

const FEATURE = 'hash';

export const SAMPLE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_SAMPLE_EVERY = 20;
// Background comparisons in flight at once; extra samples are skipped
// rather than queued, so shadow mode can't pile up work.
const MAX_BACKGROUND_CHECKS = 2;

// Request deadline: a floor plus the time the file takes at a slow-disk
// read rate (8 MiB/s: a 4 GiB file gets ~9 min). A slower disk just
// falls back to Node.
let _minTimeoutMs = 30_000;
let _minBytesPerSec = 8 * 1024 * 1024;
let _sampleEvery = DEFAULT_SAMPLE_EVERY;

let _sampleCounter = 0;
let _backgroundChecks = 0;
let _demoted = false;
const _stats = {
    go: 0, // digests returned from Go
    node: 0, // digests returned from Node
    fallbacks: 0, // Go tried, Node answered
    parityChecks: 0,
    parityMismatches: 0,
    paritySkipped: 0, // file changed / vanished between the two hashes
    lastMismatch: null,
};

export function hashTimeoutMs(size) {
    const n = Math.max(0, Number(size) || 0);
    return _minTimeoutMs + Math.ceil((n / _minBytesPerSec) * 1000);
}

function _sampleDue() {
    _sampleCounter = (_sampleCounter + 1) % _sampleEvery;
    return _sampleCounter === 0;
}

function _sameFile(a, b) {
    return (
        a &&
        b &&
        Number(a.size) === Number(b.size) &&
        Math.abs(Number(a.mtimeMs) - Number(b.mtimeMs)) < 1
    );
}

async function _statOrNull(p) {
    try {
        return await fsp.stat(p);
    } catch {
        return null;
    }
}

function _recordParity(match, absPath, goHex, nodeHex) {
    _stats.parityChecks++;
    metrics.inc('tgdl_gocore_parity_checks_total', 1, { feature: FEATURE });
    if (match) return true;
    _stats.parityMismatches++;
    _stats.lastMismatch = { at: Date.now(), file: path.basename(absPath) };
    metrics.inc('tgdl_gocore_parity_mismatch_total', 1, { feature: FEATURE });
    console.warn(
        `[go-core] hash parity mismatch for ${path.basename(absPath)}: node=${nodeHex} go=${goHex}`,
    );
    return false;
}

async function _node(nodeHash) {
    const hex = await nodeHash();
    _stats.node++;
    return hex;
}

/** Shadow: Node answers; Go re-hashes a sample afterwards for comparison. */
async function _shadow(absPath, nodeHash) {
    if (!_sampleDue() || _backgroundChecks >= MAX_BACKGROUND_CHECKS) return _node(nodeHash);
    _backgroundChecks++;
    let handedOff = false;
    try {
        const before = await _statOrNull(absPath);
        if (!before?.isFile() || before.size > SAMPLE_MAX_BYTES) return await _node(nodeHash);
        const nodeHex = await _node(nodeHash);
        handedOff = true;
        _goCheck(absPath, nodeHex, before).finally(() => {
            _backgroundChecks--;
        });
        return nodeHex;
    } finally {
        if (!handedOff) _backgroundChecks--;
    }
}

async function _goCheck(absPath, nodeHex, before) {
    try {
        const g = await client.hashFile(absPath, { timeoutMs: hashTimeoutMs(before.size) });
        const after = await _statOrNull(absPath);
        if (!_sameFile(before, g) || !_sameFile(before, after)) {
            _stats.paritySkipped++;
            return;
        }
        _recordParity(g.sha256 === nodeHex, absPath, g.sha256, nodeHex);
    } catch {
        // Counted by the client (calls_total / breaker). A vanished file
        // (dedup unlinks duplicates right after hashing) lands here too.
        _stats.paritySkipped++;
    }
}

/** auto: Node re-hashes a sample of Go's answers in the background. */
async function _nodeCheck(absPath, goHex, before, nodeHash) {
    try {
        const nodeHex = await nodeHash();
        const after = await _statOrNull(absPath);
        if (!_sameFile(before, after)) {
            _stats.paritySkipped++;
            return;
        }
        if (!_recordParity(goHex === nodeHex, absPath, goHex, nodeHex) && !_demoted) {
            _demoted = true;
            console.warn('[go-core] hash: auto mode demoted to shadow after a parity mismatch');
        }
    } catch {
        _stats.paritySkipped++;
    }
}

async function _goFirst(absPath, nodeHash, mode) {
    const st = await _statOrNull(absPath);
    // Missing / unreadable / not a regular file: let Node produce the
    // exact error callers have always seen.
    if (!st?.isFile()) return _node(nodeHash);
    let g;
    try {
        g = await client.hashFile(absPath, { timeoutMs: hashTimeoutMs(st.size) });
    } catch {
        _stats.fallbacks++;
        return _node(nodeHash);
    }
    _stats.go++;
    if (
        mode === 'auto' &&
        st.size <= SAMPLE_MAX_BYTES &&
        _sampleDue() &&
        _backgroundChecks < MAX_BACKGROUND_CHECKS
    ) {
        _backgroundChecks++;
        _nodeCheck(absPath, g.sha256, st, nodeHash).finally(() => {
            _backgroundChecks--;
        });
    }
    return g.sha256;
}

/**
 * Hash `absPath`, choosing Node or Go per the feature mode.
 *
 * @param {string} absPath
 * @param {() => Promise<string>} nodeHash  today's implementation
 * @returns {Promise<string>} lowercase 64-char hex SHA-256
 */
export async function routeHash(absPath, nodeHash) {
    const { mode } = resolveFeatureMode(FEATURE);
    if (mode === 'off' || !client.isAvailable(FEATURE)) return _node(nodeHash);
    // Node's cwd and tgdl-core's differ; only ever send absolute paths.
    const abs = path.resolve(absPath);
    if (mode === 'shadow' || (mode === 'auto' && _demoted)) return _shadow(abs, nodeHash);
    return _goFirst(abs, nodeHash, mode);
}

/** Counters for /api/system/health. */
export function getHashStats() {
    const { mode, source } = resolveFeatureMode(FEATURE);
    let active = 'node';
    if (mode !== 'off' && client.isAvailable(FEATURE)) {
        active = mode === 'shadow' || (mode === 'auto' && _demoted) ? 'shadow' : 'go';
    }
    return {
        mode,
        source,
        active,
        demoted: _demoted,
        breaker: client.breakerState(FEATURE),
        sampleEvery: _sampleEvery,
        sampleMaxBytes: SAMPLE_MAX_BYTES,
        ..._stats,
    };
}

/** Test hook: shrink deadlines / sample every call. */
export function _setTuningForTests({ minTimeoutMs, minBytesPerSec, sampleEvery } = {}) {
    if (minTimeoutMs !== undefined) _minTimeoutMs = minTimeoutMs;
    if (minBytesPerSec !== undefined) _minBytesPerSec = minBytesPerSec;
    if (sampleEvery !== undefined) _sampleEvery = Math.max(1, sampleEvery);
    _sampleCounter = 0;
}

/** Test hook: forget demotion and counters. */
export function _resetForTests() {
    _minTimeoutMs = 30_000;
    _minBytesPerSec = 8 * 1024 * 1024;
    _sampleEvery = DEFAULT_SAMPLE_EVERY;
    _sampleCounter = 0;
    _backgroundChecks = 0;
    _demoted = false;
    for (const k of Object.keys(_stats)) _stats[k] = k === 'lastMismatch' ? null : 0;
}

/** Test hook: resolves once no background comparison is running. */
export async function _drainForTests(timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs;
    while (_backgroundChecks > 0 && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 10));
    }
}
