import express from 'express';
import { runtime } from '../../core/runtime.js';
import {
    getHistory,
    clearHistory,
    flushSoon,
    failedJobMeta,
    QUEUE_HISTORY_CAP,
} from '../lib/queue-state.js';

function requireDownloader(res) {
    if (!runtime._downloader) {
        res.status(409).json({ error: 'Engine is not running. Start the monitor first.' });
        return null;
    }
    return runtime._downloader;
}

export function createQueueRouter({ broadcast }) {
    const router = express.Router();

    router.get('/queue/snapshot', (req, res) => {
        try {
            const dl = runtime._downloader;
            const snap = dl
                ? dl.snapshot()
                : {
                      active: [],
                      queued: [],
                      globalPaused: false,
                      pausedCount: 0,
                      workers: 0,
                      pending: 0,
                  };
            res.json({
                ...snap,
                recent: getHistory().slice(0, QUEUE_HISTORY_CAP),
                engineRunning: runtime.state === 'running',
                maxSpeed: runtime._downloader?.config?.download?.maxSpeed || null,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/queue/pause-all', (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        dl.pauseAll();
        broadcast({ type: 'queue_changed', payload: { op: 'pause-all' } });
        res.json({ success: true });
    });

    router.post('/queue/resume-all', (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        dl.resumeAll();
        broadcast({ type: 'queue_changed', payload: { op: 'resume-all' } });
        res.json({ success: true });
    });

    router.post('/queue/cancel-all', (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        const removed = dl.cancelAllQueued();
        broadcast({ type: 'queue_changed', payload: { op: 'cancel-all', removed } });
        res.json({ success: true, removed });
    });

    router.post('/queue/clear-finished', (req, res) => {
        clearHistory();
        flushSoon();
        failedJobMeta.clear();
        broadcast({ type: 'queue_changed', payload: { op: 'clear-finished' } });
        res.json({ success: true });
    });

    // Per-row routes. Keys look like "<chatId>_<messageId>"; URL-encode them.
    router.post('/queue/:key/pause', (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        const ok = dl.pauseJob(key);
        broadcast({ type: 'queue_changed', payload: { op: 'pause', key } });
        res.json({ success: ok });
    });

    router.post('/queue/:key/resume', (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        const ok = dl.resumeJob(key);
        broadcast({ type: 'queue_changed', payload: { op: 'resume', key } });
        res.json({ success: ok });
    });

    router.post('/queue/:key/cancel', async (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        // Best-effort delete of any partial file the worker may have left
        // behind. We don't know the exact path until the download path is
        // built (config-dependent), so this is intentionally a no-op for the
        // cases the downloader hasn't reached yet.
        const removed = dl.cancelJob(key);
        failedJobMeta.delete(key);
        broadcast({ type: 'queue_changed', payload: { op: 'cancel', key } });
        res.json({ success: removed });
    });

    router.post('/queue/:key/retry', async (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        const key = decodeURIComponent(req.params.key);
        const meta = failedJobMeta.get(key);
        if (!meta) {
            // No cached job means we never saw the original message — surface
            // a friendly error instead of silently doing nothing. The caller
            // can fall back to re-pasting the link from the viewer.
            return res.status(404).json({
                error: 'Cannot retry: original job no longer in memory. Re-trigger from the source (link / backfill / monitor).',
            });
        }
        dl.retryJob(meta);
        broadcast({ type: 'queue_changed', payload: { op: 'retry', key } });
        res.json({ success: true });
    });

    // Retry every failed job we still have a cached message for. Skips rows
    // whose source message has already aged out of failedJobMeta (cleared
    // by clear-finished or evicted on engine restart) — surfaced as
    // `skipped` in the response so the UI can toast "retried N, skipped M".
    router.post('/queue/retry-all', (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        let retried = 0;
        const skippedKeys = [];
        for (const [key, meta] of failedJobMeta) {
            if (!meta) {
                skippedKeys.push(key);
                continue;
            }
            try {
                dl.retryJob(meta);
                retried++;
            } catch (e) {
                skippedKeys.push(key);
            }
        }
        broadcast({ type: 'queue_changed', payload: { op: 'retry-all', retried } });
        res.json({ success: true, retried, skipped: skippedKeys.length });
    });

    // Multi-row batch action. Single endpoint instead of "POST /batch/pause",
    // "POST /batch/resume" etc. so the client can fire one request per user
    // gesture regardless of which action the floating bar invoked. Continues
    // past per-row failures so a single missing key (e.g. just-completed
    // between snapshot and click) doesn't abort the whole batch.
    router.post('/queue/batch', async (req, res) => {
        const dl = requireDownloader(res);
        if (!dl) return;
        const { keys, action } = req.body || {};
        if (!Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ error: 'keys must be a non-empty array' });
        }
        const ALLOWED = new Set(['pause', 'resume', 'cancel', 'retry', 'dismiss']);
        if (!ALLOWED.has(action)) {
            return res
                .status(400)
                .json({ error: `action must be one of: ${Array.from(ALLOWED).join(', ')}` });
        }
        let ok = 0;
        const failed = [];
        for (const rawKey of keys) {
            const key = String(rawKey || '');
            if (!key) {
                failed.push({ key: rawKey, reason: 'empty key' });
                continue;
            }
            try {
                if (action === 'pause') {
                    if (dl.pauseJob(key)) ok++;
                    else failed.push({ key, reason: 'not pausable' });
                } else if (action === 'resume') {
                    if (dl.resumeJob(key)) ok++;
                    else failed.push({ key, reason: 'not paused' });
                } else if (action === 'cancel') {
                    dl.cancelJob(key);
                    failedJobMeta.delete(key);
                    ok++;
                } else if (action === 'retry') {
                    const meta = failedJobMeta.get(key);
                    if (!meta) {
                        failed.push({ key, reason: 'meta evicted' });
                        continue;
                    }
                    dl.retryJob(meta);
                    ok++;
                } else if (action === 'dismiss') {
                    failedJobMeta.delete(key);
                    ok++;
                }
            } catch (e) {
                failed.push({ key, reason: e?.message || 'unknown' });
            }
        }
        // One coalesced WS frame instead of N. The Queue page already has
        // per-row WS hooks (queue_changed/pause/resume/cancel/retry) firing
        // through the downloader's emit chain — this is a hint to the SPA
        // that "a batch happened" so it can refresh aggregates / pill counts
        // in one tick.
        broadcast({
            type: 'queue_changed',
            payload: { op: 'batch', action, ok, failed: failed.length },
        });
        res.json({ success: true, ok, failed });
    });

    return router;
}
