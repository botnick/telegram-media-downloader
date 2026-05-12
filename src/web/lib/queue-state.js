import { kvGet, kvSet } from '../../core/db.js';
import { runtime } from '../../core/runtime.js';

const QUEUE_HISTORY_KV = 'queue_history';
export const QUEUE_HISTORY_CAP = 100;
const FAILED_JOB_META_CAP = 5000;

// Newest first. Persisted to kv['queue_history'] with a 1.5 s debounce.
let _history = [];
let _dirty = false;
let _flushTimer = null;

// Map<key, jobMeta> — keeps original job objects so /retry can re-enqueue
// without the client round-tripping the message ref. LRU-capped at 5 000
// entries; real LRU on touch (delete + re-insert bumps insertion order).
export const failedJobMeta = new Map();

(function loadQueueHistory() {
    try {
        const stored = kvGet(QUEUE_HISTORY_KV);
        if (Array.isArray(stored)) _history = stored.slice(0, QUEUE_HISTORY_CAP);
    } catch {
        /* first-run, no row yet */
    }
})();

export function getHistory() {
    return _history;
}

export function clearHistory() {
    _history = [];
    flushSoon();
}

export function flushSoon() {
    _dirty = true;
    if (_flushTimer) return;
    // 1.5 s debounce keeps a chatty download stream from hammering the kv
    // upsert. Each kvSet is one short SQLite transaction; cheap, but the
    // batching still saves a few dozen writes/min on a busy queue.
    _flushTimer = setTimeout(() => {
        _flushTimer = null;
        if (!_dirty) return;
        _dirty = false;
        try {
            kvSet(QUEUE_HISTORY_KV, _history.slice(0, QUEUE_HISTORY_CAP));
        } catch (e) {
            console.error("kv['queue_history'] write failed:", e?.message || e);
        }
    }, 1500).unref?.();
}

export function pushHistory(entry) {
    if (!entry?.key) return;
    // Dedup by key — last write wins so retry → success replaces the old
    // failed row instead of stacking duplicates.
    _history = [entry, ..._history.filter((e) => e.key !== entry.key)].slice(0, QUEUE_HISTORY_CAP);
    flushSoon();
}

// Wire downloader error/complete events the moment the engine starts running.
runtime.on('state', (s) => {
    if (s.state !== 'running' || !runtime._downloader) return;
    const dl = runtime._downloader;
    if (dl.__queueWired) return;
    dl.__queueWired = true;
    dl.on('error', ({ job }) => {
        if (!job?.key) return;
        // Re-set bumps insertion order to the back → oldest entries fall
        // off the front when we hit the cap. Real LRU on touch.
        if (failedJobMeta.has(job.key)) failedJobMeta.delete(job.key);
        failedJobMeta.set(job.key, job);
        while (failedJobMeta.size > FAILED_JOB_META_CAP) {
            const first = failedJobMeta.keys().next().value;
            if (first === undefined) break;
            failedJobMeta.delete(first);
        }
    });
    dl.on('complete', (job) => {
        if (job?.key) failedJobMeta.delete(job.key);
    });
});
