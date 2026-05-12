import crypto from 'crypto';
import express from 'express';
import { loadConfig } from '../../config/manager.js';
import { runtime } from '../../core/runtime.js';
import { getDb, kvSet } from '../../core/db.js';
import { BACKFILL_MAX_LIMIT } from '../../core/constants.js';
import { writeConfigAtomic } from '../lib/config-writer.js';
import {
    historyJobs,
    activeBackfillsByGroup,
    loadHistoryJobsFromStore,
    saveHistoryJobsToStore,
    scheduleHistoryJobCleanup,
    HISTORY_JOBS_KV,
} from '../lib/history-state.js';

export function createHistoryRouter({ getAccountManager, broadcast, log, invalidateDialogsCache }) {
    const router = express.Router();

    // Run an out-of-band backfill against a configured group. Re-uses the
    // runtime's downloader if it's running so the worker pool isn't doubled;
    // otherwise spins one up just for this request and tears it down on
    // completion.
    router.post('/history', async (req, res) => {
        try {
            const { groupId, limit = 100, offsetId = 0, mode } = req.body || {};
            if (!groupId) return res.status(400).json({ error: 'groupId required' });
            const groupKey = String(groupId);
            if (activeBackfillsByGroup.has(groupKey)) {
                return res.status(409).json({
                    error: 'A backfill is already running for this group',
                    code: 'ALREADY_RUNNING',
                    jobId: activeBackfillsByGroup.get(groupKey),
                });
            }
            // limit === 0 (or "0") means "no limit" → backfill the entire history.
            const limRaw = parseInt(limit, 10);
            const lim =
                limRaw === 0
                    ? null
                    : Math.max(
                          1,
                          Math.min(BACKFILL_MAX_LIMIT, Number.isFinite(limRaw) ? limRaw : 100),
                      );

            const am = await getAccountManager();
            if (am.count === 0)
                return res.status(409).json({ error: 'No Telegram accounts loaded' });

            const config = loadConfig();
            let group = (config.groups || []).find((g) => String(g.id) === String(groupId));

            // Sidebar surfaces "download-only" groups — rows that have files
            // in `downloads` but never made it into `config.groups`. Auto-register
            // here when we can resolve the dialog from any connected account.
            if (!group) {
                let resolved = null;
                try {
                    const probe = await import('../../core/dialogs-resolver.js').catch(() => null);
                    if (probe?.resolveDialogName) {
                        resolved = await probe.resolveDialogName(String(groupId)).catch(() => null);
                    }
                } catch {}
                let dbName = null;
                try {
                    const row = getDb()
                        .prepare(
                            "SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL AND group_name != '' AND group_name != 'Unknown' LIMIT 1",
                        )
                        .get(String(groupId));
                    if (row?.group_name) dbName = row.group_name;
                } catch {}
                const idForConfig =
                    String(groupId).startsWith('-') &&
                    Number.isSafeInteger(parseInt(String(groupId), 10))
                        ? parseInt(String(groupId), 10)
                        : groupId;
                group = {
                    id: idForConfig,
                    name: resolved || dbName || `Group ${groupId}`,
                    enabled: false,
                    filters: {
                        photos: true,
                        videos: true,
                        files: true,
                        links: true,
                        voice: false,
                        gifs: false,
                        stickers: false,
                    },
                    autoForward: {
                        enabled: false,
                        destination: null,
                        deleteAfterForward: false,
                        keepImages: false,
                        keepVideos: false,
                    },
                    trackUsers: { enabled: false, users: [] },
                    topics: { enabled: false, ids: [] },
                };
                config.groups = config.groups || [];
                config.groups.push(group);
                try {
                    await writeConfigAtomic(config);
                    invalidateDialogsCache();
                    broadcast({ type: 'config_updated' });
                    log({
                        source: 'history',
                        level: 'info',
                        msg: `auto-registered group ${groupId} ("${group.name}") before backfill — was present in downloads but missing from config`,
                    });
                } catch (e) {
                    console.warn('[history] auto-register failed:', e.message);
                    return res.status(404).json({
                        error: 'Group not configured — add it from Manage Groups first',
                        code: 'GROUP_NOT_CONFIGURED',
                    });
                }
            }

            const { HistoryDownloader } = await import('../../core/history.js');
            const { DownloadManager } = await import('../../core/downloader.js');
            const { RateLimiter } = await import('../../core/security.js');

            const standalone = !runtime._downloader;
            const downloader =
                runtime._downloader ||
                new DownloadManager(
                    am.getDefaultClient(),
                    config,
                    new RateLimiter(config.rateLimits),
                );
            if (standalone) {
                await downloader.init();
                downloader.start();
            }

            const history = new HistoryDownloader(am.getDefaultClient(), downloader, config, am);

            const jobId = crypto.randomBytes(6).toString('hex');
            const job = {
                id: jobId,
                state: 'running',
                processed: 0,
                downloaded: 0,
                error: null,
                group: group.name,
                groupId: String(group.id),
                limit: lim,
                startedAt: Date.now(),
                finishedAt: null,
                cancelled: false,
                _runner: history,
            };
            historyJobs.set(jobId, job);
            activeBackfillsByGroup.set(groupKey, jobId);

            history.on('progress', (s) => {
                job.processed = s.processed;
                job.downloaded = s.downloaded;
                broadcast({
                    type: 'history_progress',
                    jobId,
                    ...s,
                    group: group.name,
                    groupId: job.groupId,
                    limit: job.limit,
                    startedAt: job.startedAt,
                    mode: job.mode || 'pull-older',
                });
            });
            // Mirror the chosen mode onto the job so the UI shows it.
            history.on('start', (s) => {
                if (s?.mode) job.mode = s.mode;
            });

            history
                .downloadHistory(groupId, {
                    limit: lim ?? undefined,
                    offsetId: parseInt(offsetId, 10) || 0,
                    mode: mode === 'catch-up' || mode === 'rescan' ? mode : 'pull-older',
                })
                .then(() => {
                    job.state = job.cancelled ? 'cancelled' : 'done';
                    job.finishedAt = Date.now();
                    delete job._runner;
                    const evt = job.cancelled ? 'history_cancelled' : 'history_done';
                    broadcast({ type: evt, jobId, group: group.name, ...job });
                    if (standalone) downloader.stop().catch(() => {});
                    saveHistoryJobsToStore();
                    if (activeBackfillsByGroup.get(groupKey) === jobId) {
                        activeBackfillsByGroup.delete(groupKey);
                    }
                    scheduleHistoryJobCleanup(jobId);
                })
                .catch((err) => {
                    job.state = 'error';
                    job.error = err?.message || String(err);
                    job.finishedAt = Date.now();
                    delete job._runner;
                    broadcast({
                        type: 'history_error',
                        jobId,
                        error: job.error,
                        group: group.name,
                        groupId: job.groupId,
                    });
                    const hint = /no available account/i.test(job.error)
                        ? ' (no logged-in account can read this group — check Settings → Telegram Accounts and make sure at least one is a member)'
                        : '';
                    log({
                        source: 'backfill',
                        level: 'error',
                        msg: `backfill failed for "${group.name}" (${group.id}): ${job.error}${hint}`,
                    });
                    if (standalone) downloader.stop().catch(() => {});
                    saveHistoryJobsToStore();
                    if (activeBackfillsByGroup.get(groupKey) === jobId) {
                        activeBackfillsByGroup.delete(groupKey);
                    }
                });

            log({
                source: 'backfill',
                level: 'info',
                msg: `backfill started for "${group.name}" (${group.id}) — limit=${lim} mode=${job.mode || 'pull-older'}`,
            });
            res.json({
                success: true,
                jobId,
                group: group.name,
                limit: lim,
                mode: job.mode || 'pull-older',
            });
        } catch (e) {
            console.error('POST /api/history:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // MUST be mounted before /history/:jobId so :jobId doesn't swallow "/jobs".
    router.get('/history/jobs', async (req, res) => {
        try {
            const onDisk = loadHistoryJobsFromStore();
            const live = Array.from(historyJobs.values()).map(({ _runner, ...rest }) => rest);
            const byId = new Map();
            for (const j of onDisk) byId.set(j.id, j);
            for (const j of live) byId.set(j.id, j);
            const all = Array.from(byId.values()).sort(
                (a, b) => (b.startedAt || 0) - (a.startedAt || 0),
            );
            const recent = all.filter((j) => j.state !== 'running').slice(0, 30);
            res.json({
                active: all.filter((j) => j.state === 'running'),
                recent,
                past: recent,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/history/:jobId/cancel', (req, res) => {
        const job = historyJobs.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (job.state !== 'running') {
            return res.status(409).json({ error: `Job is ${job.state}, cannot cancel` });
        }
        try {
            job.cancelled = true;
            if (typeof job._runner?.cancel === 'function') job._runner.cancel();
            broadcast({ type: 'history_cancelling', jobId: job.id, group: job.group });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/history/:jobId', (req, res) => {
        const job = historyJobs.get(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const { _runner, ...safe } = job;
        res.json(safe);
    });

    // Remove a single finished history entry. Running jobs must be cancelled first.
    router.delete('/history/:jobId', async (req, res) => {
        try {
            const id = req.params.jobId;
            const inMem = historyJobs.get(id);
            if (inMem && inMem.state === 'running') {
                return res
                    .status(409)
                    .json({ error: 'Cannot delete a running job — cancel first.' });
            }
            if (inMem) historyJobs.delete(id);

            const onDisk = loadHistoryJobsFromStore();
            const filtered = onDisk.filter((j) => j.id !== id);
            try {
                kvSet(HISTORY_JOBS_KV, filtered);
            } catch (e) {
                console.error("kv['history_jobs'] write failed:", e?.message || e);
            }

            broadcast({ type: 'history_deleted', jobId: id });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Clear every finished entry. Running jobs are preserved.
    router.delete('/history', async (req, res) => {
        try {
            let removed = 0;
            for (const [id, job] of Array.from(historyJobs.entries())) {
                if (job.state !== 'running') {
                    historyJobs.delete(id);
                    removed++;
                }
            }
            try {
                kvSet(HISTORY_JOBS_KV, []);
            } catch (e) {
                console.error("kv['history_jobs'] wipe failed:", e?.message || e);
            }
            broadcast({ type: 'history_cleared' });
            res.json({ success: true, removed });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/history', (req, res) => {
        res.json(Array.from(historyJobs.values()).map(({ _runner, ...rest }) => rest));
    });

    return router;
}
