import { kvGet, kvSet } from '../../core/db.js';
import { loadConfig } from '../../config/manager.js';
import { HISTORY_JOB_TTL_MS } from '../../core/constants.js';

const HISTORY_JOBS_KV = 'history_jobs';

// jobId → { id, state, processed, downloaded, error, group, groupId, limit,
//           startedAt, finishedAt, cancelled, _runner }
// `_runner` is stripped before serialising (it's the live downloader).
export const historyJobs = new Map();

// groupId(string) → jobId(string). At most one backfill per group at a time.
export const activeBackfillsByGroup = new Map();

function historyRetentionMs() {
    try {
        const days = Number(loadConfig().advanced?.history?.retentionDays);
        if (Number.isFinite(days) && days >= 1 && days <= 3650) {
            return days * 24 * 60 * 60 * 1000;
        }
    } catch {}
    return 30 * 24 * 60 * 60 * 1000;
}

export function loadHistoryJobsFromStore() {
    const stored = kvGet(HISTORY_JOBS_KV);
    if (!Array.isArray(stored)) return [];
    const cutoff = Date.now() - historyRetentionMs();
    return stored.filter((j) => j && (j.finishedAt || j.startedAt || 0) >= cutoff);
}

export function saveHistoryJobsToStore() {
    const finished = Array.from(historyJobs.values())
        .filter((j) => j.state !== 'running')
        .map(({ _runner, ...rest }) => rest);
    const onDisk = loadHistoryJobsFromStore();
    const byId = new Map();
    for (const j of onDisk) byId.set(j.id, j);
    for (const j of finished) byId.set(j.id, j);
    const cutoff = Date.now() - historyRetentionMs();
    const all = Array.from(byId.values())
        .filter((j) => (j.finishedAt || j.startedAt || 0) >= cutoff)
        .sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0));
    try {
        kvSet(HISTORY_JOBS_KV, all);
    } catch (e) {
        console.error("kv['history_jobs'] write failed:", e?.message || e);
    }
}

export function scheduleHistoryJobCleanup(jobId) {
    setTimeout(() => historyJobs.delete(jobId), HISTORY_JOB_TTL_MS);
}

export { HISTORY_JOBS_KV };
