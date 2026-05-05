/**
 * Hash worker pool.
 *
 * Streams a file from disk and SHA-256s it on a worker_thread instead of
 * the main event loop, so a single multi-GB hash never blocks WS broadcasts,
 * the WebSocket heartbeat, or HTTP request handling.
 *
 * Cross-platform notes:
 *   - `worker_threads` ships with Node ≥12. No native deps, works on
 *     Windows / macOS / Linux / Alpine / Docker without rebuilds.
 *   - The same file is loaded as both the parent module (exports
 *     `hashFile()`) AND the worker entrypoint (when `isMainThread === false`
 *     it runs the hashing branch). Re-exports the same algorithm constants
 *     as `checksum.js` so callers can swap one for the other 1-1.
 *
 * Configuration (env, no hardcoded numbers):
 *   - `HASH_WORKER_POOL_SIZE` — total live workers in the pool. Default
 *     `Math.max(2, Math.floor(os.cpus().length / 2))` (capped at 8 to
 *     keep the surface small for embedded NAS / Pi 4 hosts).
 *   - `HASH_WORKER_DISABLE=1` — fall back to the main-thread streamer
 *     unconditionally. Useful for environments where worker spawn is
 *     restricted (e.g. some sandboxed runtimes).
 *
 * Usage:
 *   import { hashFile } from './hash-worker.js';
 *   const hex = await hashFile('/abs/path/to/file');
 *
 * The pool is lazily created on first call, so importing this module is
 * essentially free.
 */

import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';
import { createReadStream } from 'fs';

import { CHECKSUM_ALGO, CHECKSUM_VERSION, CHECKSUM_HEX_LENGTH, CHECKSUM_HEX_RE } from './checksum.js';

export { CHECKSUM_ALGO, CHECKSUM_VERSION, CHECKSUM_HEX_LENGTH, CHECKSUM_HEX_RE };

// ============================================================================
// Worker entrypoint
// ----------------------------------------------------------------------------
// When this module is executed as a worker (isMainThread === false), it
// listens for {filePath, algo} jobs on the parent port, streams the file
// off disk, hashes it, and ships back {hex} or {error}. Each worker
// processes one job at a time — the parent rotates jobs across the pool.
// ============================================================================
if (!isMainThread) {
    const algoFromBoot = (workerData && workerData.algo) || CHECKSUM_ALGO;
    parentPort.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        const { filePath, algo, jobId } = msg;
        const useAlgo = algo || algoFromBoot;
        const h = crypto.createHash(useAlgo);
        const s = createReadStream(filePath);
        s.on('data', (chunk) => h.update(chunk));
        s.on('end', () => {
            parentPort.postMessage({ jobId, ok: true, hex: h.digest('hex') });
        });
        s.on('error', (err) => {
            parentPort.postMessage({ jobId, ok: false, error: err?.message || String(err) });
        });
    });
}

// ============================================================================
// Parent-side pool — only initialised when running as the main thread.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(__dirname, 'hash-worker.js');

const DEFAULT_POOL_SIZE = Math.max(2, Math.floor((os.cpus()?.length || 2) / 2));
function resolvePoolSize() {
    const env = parseInt(process.env.HASH_WORKER_POOL_SIZE, 10);
    if (Number.isFinite(env) && env >= 1) return Math.min(env, 32);
    return Math.min(DEFAULT_POOL_SIZE, 8);
}

const DISABLED = process.env.HASH_WORKER_DISABLE === '1';

/** @type {{worker: Worker, busy: boolean}[] | null} */
let _pool = null;
let _nextJobId = 1;
const _waiters = []; // queued { resolve, reject, filePath, algo }
const _inFlight = new Map(); // jobId → { resolve, reject, slotIdx }

function _slotForWorker(worker) {
    if (!_pool) return -1;
    return _pool.findIndex((s) => s.worker === worker);
}

function _ensurePool() {
    if (_pool || DISABLED) return;
    if (!isMainThread) return;
    const size = resolvePoolSize();
    _pool = [];
    for (let i = 0; i < size; i++) _pool.push(_makeSlot());
}

function _makeSlot() {
    const worker = new Worker(WORKER_FILE, {
        workerData: { algo: CHECKSUM_ALGO },
    });
    const slot = { worker, busy: false };
    worker.on('message', (msg) => {
        const { jobId, ok, hex, error } = msg || {};
        const pending = _inFlight.get(jobId);
        if (!pending) return; // late delivery after timeout / worker reset
        _inFlight.delete(jobId);
        slot.busy = false;
        if (ok) pending.resolve(hex);
        else pending.reject(new Error(error || 'hash worker error'));
        _drainWaiters();
    });
    worker.on('error', (err) => {
        // Reject any in-flight job assigned to this slot.
        for (const [jid, p] of _inFlight) {
            if (p.slotIdx === _slotForWorker(slot.worker)) {
                _inFlight.delete(jid);
                p.reject(err);
            }
        }
        // Replace the dead worker so the pool keeps draining.
        const idx = _slotForWorker(slot.worker);
        if (idx >= 0 && _pool) _pool[idx] = _makeSlot();
        _drainWaiters();
    });
    worker.on('exit', () => {
        // Same recovery path as 'error' — keep the pool the configured size
        // even if Node decides a worker should exit (rare, but possible
        // under memory pressure).
        const idx = _slotForWorker(slot.worker);
        if (idx >= 0 && _pool) _pool[idx] = _makeSlot();
        _drainWaiters();
    });
    return slot;
}

function _drainWaiters() {
    if (!_pool || !_waiters.length) return;
    for (const slot of _pool) {
        if (!_waiters.length) break;
        if (slot.busy) continue;
        const job = _waiters.shift();
        const jobId = _nextJobId++;
        slot.busy = true;
        _inFlight.set(jobId, {
            resolve: job.resolve,
            reject: job.reject,
            slotIdx: _slotForWorker(slot.worker),
        });
        try {
            slot.worker.postMessage({
                jobId,
                filePath: job.filePath,
                algo: job.algo || CHECKSUM_ALGO,
            });
        } catch (err) {
            slot.busy = false;
            _inFlight.delete(jobId);
            job.reject(err);
        }
    }
}

/**
 * Stream-hash `absPath` on a worker thread. Returns a lowercase 64-char
 * hex SHA-256 by default. When the pool is disabled (or the runtime
 * doesn't support `worker_threads`, e.g. a synthetic test env), falls
 * back to the same in-process streaming hash that `checksum.sha256OfFile`
 * uses — the result is byte-identical.
 *
 * @param {string} absPath
 * @param {string} [algo='sha256']
 * @returns {Promise<string>}
 */
export function hashFile(absPath, algo = CHECKSUM_ALGO) {
    if (DISABLED || !isMainThread) {
        return _hashOnMainThread(absPath, algo);
    }
    _ensurePool();
    if (!_pool) return _hashOnMainThread(absPath, algo);
    return new Promise((resolve, reject) => {
        _waiters.push({ resolve, reject, filePath: absPath, algo });
        _drainWaiters();
    });
}

function _hashOnMainThread(absPath, algo) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash(algo);
        const s = createReadStream(absPath);
        s.on('data', (chunk) => h.update(chunk));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

/**
 * Tear the pool down — used by tests and by graceful-shutdown paths.
 * Idempotent. Workers are terminated; pending waiters are rejected.
 */
export async function shutdownHashPool() {
    if (!_pool) return;
    const pool = _pool;
    _pool = null;
    while (_waiters.length) {
        const w = _waiters.shift();
        w.reject(new Error('hash worker pool shut down'));
    }
    for (const [jid, p] of _inFlight) {
        _inFlight.delete(jid);
        p.reject(new Error('hash worker pool shut down'));
    }
    await Promise.all(pool.map((s) => s.worker.terminate().catch(() => {})));
}

/** Internal — exported only for tests / diagnostics. */
export function _poolSize() { return _pool ? _pool.length : 0; }
