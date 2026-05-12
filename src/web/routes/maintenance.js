import path from 'path';
import { fileURLToPath } from 'url';
import fs, { existsSync } from 'fs';
import express from 'express';
import { loadConfig } from '../../config/manager.js';
import { getDb } from '../../core/db.js';
import { runtime } from '../../core/runtime.js';
import { writeConfigAtomic } from '../lib/config-writer.js';
import * as integrity from '../../core/integrity.js';
import { kvGet, kvSet } from '../../core/db/kv.js';
import {
    getOrCreateThumb,
    purgeThumbsForDownload,
    hasCachedThumb,
    DEFAULT_WIDTH as THUMB_DEFAULT_WIDTH,
    thumbKindTypes,
    buildAllThumbnails,
    purgeAllThumbs,
} from '../../core/thumbs.js';
import { buildAllSeekbar, purgeAllSeekbar } from '../../core/seekbar/scan-runner.js';
import {
    generateForDownload as generateSeekbarForDownload,
    getSpritePath as getSeekbarSpritePath,
} from '../../core/seekbar/generator.js';
import {
    getSeekbarCacheStats,
    getMetaForDownload as getSeekbarMetaForDownload,
} from '../../core/seekbar/index.js';
import {
    getSidecarStatus as getSeekbarSidecarStatus,
    refreshSidecar as refreshSeekbarSidecar,
} from '../../core/seekbar/spawn.js';
import { probeHwaccel as probeSeekbarHwaccel } from '../../core/seekbar/client.js';
import { getSeekbarSprite } from '../../core/db/seekbar.js';
import {
    NSFW_DEFAULTS,
    startScan as nsfwStartScan,
    cancelScan as nsfwCancelScan,
    isScanRunning as nsfwIsScanRunning,
} from '../../core/nsfw.js';
import {
    whitelistNsfw,
    unwhitelistNsfw,
    getNsfwDeleteCandidates,
    NSFW_TIERS,
} from '../../core/db/faces.js';
import {
    deleteByIds as dedupDeleteByIds,
    findDuplicates as dedupFindDuplicates,
} from '../../core/dedup.js';
import { deleteGroupDownloads } from '../../core/db/groups.js';
import {
    getNsfwStats,
    getNsfwTierCounts,
    getNsfwHistogram,
    getNsfwListByTier,
    getNsfwIdsByTier,
    reclassifyNsfw,
} from '../../core/db/faces.js';
import {
    ALLOWED_WIDTHS as THUMB_WIDTHS,
    getThumbsCacheStats,
    hasFfmpeg,
} from '../../core/thumbs.js';
import { loginVerify, isAuthConfigured, revokeAllSessions } from '../../core/web-auth.js';
import {
    getScanState as nsfwGetScanState,
    preloadClassifier as nsfwPreloadClassifier,
    clearClassifierCache as nsfwClearCache,
} from '../../core/nsfw.js';
import { readConfigSafe } from '../lib/config-cache.js';
import { saveConfig } from '../../config/manager.js';
import { tgAuthErrorBody } from '../lib/tg-error.js';

const fsSync = fs;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../../data');

export function createMaintenanceRouter({
    broadcast,
    log,
    jobTrackers,
    getAccountManager,
    resolveEntityAcrossAccounts,
    downloadProfilePhoto,
}) {
    const router = express.Router();

    // ============ MAINTENANCE ENDPOINTS ===========================================
    //
    // Web parity for everything the CLI used to be the only path to do. Every
    // destructive endpoint here:
    //   - lives behind the global checkAuth middleware (so only logged-in users
    //     hit it),
    //   - requires `confirm: true` in the JSON body to prevent CSRF / fat-finger
    //     accidents,
    //   - logs what it did to stdout for the audit trail.
    //
    // Read endpoints (resync dialogs, log download, integrity check) don't need
    // the confirm flag — they don't mutate user data.

    const LOGS_DIR = path.join(DATA_DIR, 'logs');
    const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

    function _requireConfirm(req, res) {
        if (req.body?.confirm !== true) {
            res.status(400).json({
                error: 'Pass {"confirm": true} in the request body to proceed.',
            });
            return false;
        }
        return true;
    }

    // Stronger guard for irreversible / sensitive ops (export Telegram session,
    // sign-out-everywhere). Forces the user to retype their dashboard password
    // in the request body — the cookie alone isn't enough because a session
    // hijacker would already have it.
    async function _requirePassword(req, res) {
        const supplied = req.body?.password;
        if (typeof supplied !== 'string' || !supplied) {
            res.status(400).json({ error: 'Password required' });
            return false;
        }
        try {
            const config = await readConfigSafe();
            if (!isAuthConfigured(config.web)) {
                res.status(403).json({ error: 'Auth not configured' });
                return false;
            }
            // SECURITY: loginVerify returns `{ok: boolean, upgrade?: boolean}`,
            // NOT a bare boolean. Treating the object as truthy (the previous
            // bug) made any non-empty string a valid "password" — turning
            // Export-Session into a full account-takeover surface for anyone
            // who already holds a session cookie.
            const result = loginVerify(supplied, config.web);
            if (!result?.ok) {
                res.status(403).json({ error: 'Invalid password' });
                return false;
            }
        } catch {
            res.status(500).json({ error: 'Internal error' });
            return false;
        }
        return true;
    }

    // Force re-resolve every group entity (name + photo) against Telegram. This is
    // /api/groups/refresh-info under a friendlier name; the SPA already calls the
    // underlying handler, this is the explicit "Resync now" button.
    //
    // Fire-and-forget — with many accounts × big dialog lists this is multi-
    // second. Progress streams via `resync_dialogs_progress`, final result via
    // `resync_dialogs_done`. Pre-flight account check stays sync so the caller
    // gets an immediate explanation when no Telegram accounts exist.
    router.post('/maintenance/resync-dialogs', async (req, res) => {
        let am;
        try {
            am = await getAccountManager();
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            return res
                .status(status === 400 ? 500 : status)
                .json(body.error ? body : { error: e.message });
        }
        if (am.count === 0) return res.status(409).json({ error: 'No Telegram accounts loaded' });
        const tracker = jobTrackers.resyncDialogs;
        const r = tracker.tryStart(async ({ onProgress }) => {
            try {
                entityCache.clear();
            } catch {}
            const config = loadConfig();
            const ids = new Set((config.groups || []).map((g) => String(g.id)));
            try {
                const rows = getDb()
                    .prepare('SELECT DISTINCT group_id FROM downloads LIMIT 10000')
                    .all();
                for (const rr of rows) ids.add(String(rr.group_id));
            } catch {}

            let updated = 0;
            let mutated = false;
            const total = ids.size;
            let processed = 0;
            const pendingDbUpdates = [];
            onProgress({ processed: 0, total, updated: 0, stage: 'resolving' });
            for (const id of ids) {
                const resolved = await resolveEntityAcrossAccounts(id);
                if (resolved) {
                    const e = resolved.entity;
                    const realName =
                        e?.title ||
                        (e?.firstName && e.firstName + (e.lastName ? ' ' + e.lastName : '')) ||
                        e?.username ||
                        null;
                    if (realName) {
                        const cg = (config.groups || []).find((g) => String(g.id) === id);
                        if (
                            cg &&
                            (!cg.name ||
                                cg.name === 'Unknown' ||
                                cg.name === id ||
                                cg.name.startsWith('Group '))
                        ) {
                            cg.name = realName;
                            mutated = true;
                        }
                        pendingDbUpdates.push([realName, id]);
                        updated++;
                    }
                    await downloadProfilePhoto(id).catch(() => {});
                }
                processed++;
                onProgress({ processed, total, updated, stage: 'resolving' });
            }
            if (pendingDbUpdates.length > 0) {
                try {
                    const db = getDb();
                    const stmt = db.prepare(
                        `UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`,
                    );
                    const tx = db.transaction((rows) => {
                        for (const [name, gid] of rows) stmt.run(name, gid, gid);
                    });
                    tx(pendingDbUpdates);
                } catch (err) {
                    console.warn('[resync-dialogs] batch update failed:', err.message);
                }
            }
            if (mutated) await writeConfigAtomic(config);
            _dialogsResponseCache = { at: 0, body: null };
            _dialogsNameCache = { at: 0, byId: new Map() };
            broadcast({ type: 'config_updated' });
            return { scanned: total, updated };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'Resync already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/maintenance/resync-dialogs/status', async (req, res) => {
        res.json(jobTrackers.resyncDialogs.getStatus());
    });

    // Restart the realtime monitor: stop → start. Useful after settings changes
    // (proxy, accounts, rate limits) without needing to bounce the container.
    // Fire-and-forget for consistency with the other Settings → Maintenance
    // buttons; final status broadcast via `restart_monitor_done`.
    router.post('/maintenance/restart-monitor', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        const t = jobTrackers.restartMonitor;
        const r = t.tryStart(async () => {
            const wasRunning = runtime.state === 'running';
            if (runtime.state !== 'stopped') {
                try {
                    await runtime.stop();
                } catch (e) {
                    console.warn('restart-monitor stop:', e.message);
                }
            }
            if (!wasRunning) {
                return { restarted: false, note: 'Monitor was not running; nothing to restart.' };
            }
            const am = await getAccountManager();
            if (am.count === 0) {
                const err = new Error('No Telegram accounts loaded');
                err.code = 'NO_ACCOUNTS';
                throw err;
            }
            await runtime.start({ config: loadConfig(), accountManager: am });
            return { restarted: true, status: runtime.status() };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'Restart already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/maintenance/restart-monitor/status', async (req, res) => {
        res.json(jobTrackers.restartMonitor.getStatus());
    });

    // SQLite integrity check (PRAGMA integrity_check). Returns "ok" on a clean DB
    // or a list of corruption messages. Read-only.
    //
    // Usually fast (~seconds) but on a corrupt DB can spin for a long time —
    // converted to fire-and-forget for symmetry + Cloudflare safety.
    router.post('/maintenance/db/integrity', async (req, res) => {
        const t = jobTrackers.dbIntegrity;
        const r = t.tryStart(async () => {
            const db = getDb();
            const rows = db.prepare('PRAGMA integrity_check').all();
            const messages = rows.map((rr) => rr.integrity_check).filter(Boolean);
            const ok = messages.length === 1 && messages[0] === 'ok';
            return { ok, messages };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'An integrity check is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/maintenance/db/integrity/status', async (req, res) => {
        res.json(jobTrackers.dbIntegrity.getStatus());
    });

    // Walk every download row, drop the ones whose file is missing or
    // 0 bytes. Same logic as the periodic boot-time sweep, surfaced as a
    // button so users can force-clean stale entries on demand.
    //
    // Fire-and-forget — a 50k-row library can take a minute, well past
    // Cloudflare's 100 s tunnel timeout when the user has had the dashboard
    // open for a while. POST returns 200 immediately; progress + result land
    // over WS as `files_verify_progress` / `files_verify_done`. Page hydrates
    // running state from `/files/verify/status` on mount.
    router.post('/maintenance/files/verify', async (req, res) => {
        const t = jobTrackers.filesVerify;
        const r = t.tryStart(async ({ onProgress }) => {
            const result = await integrity.sweep(onProgress);
            // Persist a small summary for the duplicates page's "Last run"
            // chip — the JobTracker holds the running state in process
            // memory, so without this kv blob a server restart erases the
            // last-completed snapshot.
            try {
                kvSet('files_verify_last_run', {
                    finishedAt: Date.now(),
                    removed: result?.removed ?? result?.dropped ?? 0,
                    scanned: result?.scanned ?? result?.total ?? 0,
                });
            } catch {}
            return result;
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'A verify is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/maintenance/files/verify/status', async (req, res) => {
        res.json(jobTrackers.filesVerify.getStatus());
    });

    router.get('/maintenance/files/verify/stats', async (req, res) => {
        try {
            const lastRun = kvGet('files_verify_last_run') || null;
            res.json({ lastRun });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Re-index from disk — the inverse of /files/verify. Walks
    // data/downloads/ and inserts rows for files the catalogue doesn't
    // know about. Idempotent (INSERT OR IGNORE on (group_id, message_id)).
    // Used to recover a wiped DB (Purge all, fresh install over an existing
    // downloads/ tree, restore from backups/ snapshot) without re-downloading
    // from Telegram. Background-driven; progress broadcast via WS
    // `reindex_progress` and final `reindex_done` so the page can render a
    // determinate bar without polling.
    // Migrated from a hand-rolled `_reindexBgRunning` flag that OR'd with
    // `integrity.isReindexRunning()` to determine the running state. The
    // dual-source-of-truth meant a status snapshot could report `running:
    // true` while neither subsystem was actually progressing — masking
    // which component owned the job. Now there's one tracker. Prefix
    // 'reindex' is preserved so the duplicates page's listeners need no
    // change.
    router.post('/maintenance/reindex', async (req, res) => {
        const tracker = jobTrackers.reindex;
        const r = tracker.tryStart(async ({ onProgress }) => {
            const cfg = await readConfigSafe();
            const groups = Array.isArray(cfg?.groups) ? cfg.groups : [];
            const result = await integrity.reindexFromDisk(groups, (p) => onProgress(p));
            try {
                kvSet('reindex_last_run', {
                    finishedAt: Date.now(),
                    added: result?.added ?? result?.indexed ?? 0,
                    scanned: result?.scanned ?? result?.total ?? 0,
                });
            } catch {}
            return result;
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'already_running', code: r.code || 'ALREADY_RUNNING' });
        }
        res.json({ ok: true, started: true });
    });

    router.get('/maintenance/reindex/status', async (req, res) => {
        const snap = jobTrackers.reindex.getStatus();
        res.json({ ...snap, ...(snap.progress || {}) });
    });

    router.get('/maintenance/reindex/stats', async (req, res) => {
        try {
            const lastRun = kvGet('reindex_last_run') || null;
            res.json({ lastRun });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // VACUUM the SQLite database. Reclaims space after lots of deletions.
    // Locks the DB briefly — guard with confirm so the user can't trigger it by
    // accident in the middle of a heavy backfill.
    //
    // Fire-and-forget: VACUUM blocks the process for the duration of the
    // rebuild (multiple minutes on a multi-GB library), well past Cloudflare's
    // edge timeout. POST returns 200 immediately; final reclaim numbers land
    // via `db_vacuum_done` WS event.
    router.post('/maintenance/db/vacuum', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        const t = jobTrackers.dbVacuum;
        const r = t.tryStart(async () => {
            const db = getDb();
            const beforePages = db.pragma('page_count', { simple: true });
            const pageSize = db.pragma('page_size', { simple: true });
            db.exec('VACUUM');
            const afterPages = db.pragma('page_count', { simple: true });
            return {
                beforeBytes: Number(beforePages) * Number(pageSize),
                afterBytes: Number(afterPages) * Number(pageSize),
                reclaimedBytes: Math.max(
                    0,
                    (Number(beforePages) - Number(afterPages)) * Number(pageSize),
                ),
            };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'A vacuum is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/maintenance/db/vacuum/status', async (req, res) => {
        res.json(jobTrackers.dbVacuum.getStatus());
    });

    // ====== Duplicate finder (checksum-based) ==================================
    //
    // One-shot scan that:
    //   1. Computes SHA-256 for every download row missing a hash (the column
    //      has been in the schema since v2 but never populated).
    //   2. Groups by hash and returns sets where COUNT > 1.
    //
    // First scan is O(bytes-on-disk); subsequent scans are nearly free since
    // only newly-downloaded files lack a hash. Progress is broadcast over WS
    // (`dedup_progress`) so the UI can render a determinate bar.
    //
    // Two-step UX: scan returns the duplicate sets to the client, the user
    // picks which copies to keep, and the explicit /delete call removes the
    // rest. The endpoint never auto-deletes.
    // Fire-and-forget pattern — same as thumbs/build-all and nsfw/scan.
    // On a 50 GB library the SHA-256 sweep can take minutes; previously we
    // awaited the result inside the POST handler, which Cloudflare's tunnel
    // timeout (100 s default) would 524 long before the scan finished. The
    // scan now runs in the background; clients learn about progress and the
    // final duplicate sets via WS (`dedup_progress`, `dedup_done`) and can
    // recover the in-flight state via GET `/dedup/status` after a tab close.
    // Migrated from a hand-rolled `_dedupRunning` flag to the shared
    // JobTracker for free single-flight, abort, attempt counters, and
    // duration tracking. WS event prefix stays 'dedup' — the duplicates
    // page's existing `dedup_progress` / `dedup_done` listeners are
    // unaffected.
    router.post('/maintenance/dedup/scan', async (req, res) => {
        const tracker = jobTrackers.dedupScan;
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            const result = await dedupFindDuplicates({
                onProgress: (p) => onProgress({ ...p, running: true }),
                signal,
            });
            // Persist a small summary so a server restart still surfaces
            // "Last scan: 2 h ago — N duplicates" on the duplicates page
            // without having to recompute. The full duplicate-sets payload
            // stays in tracker memory — no point persisting megabytes of
            // file rows that the next scan rebuilds.
            try {
                const sets = Array.isArray(result?.duplicateSets) ? result.duplicateSets : [];
                const extras = sets.reduce((s, x) => s + Math.max(0, (x.count || 0) - 1), 0);
                const reclaim = sets.reduce(
                    (s, x) => s + Number(x.fileSize || 0) * Math.max(0, (x.count || 0) - 1),
                    0,
                );
                kvSet('dedup_last_scan', {
                    finishedAt: Date.now(),
                    scanned: result?.scanned || 0,
                    hashed: result?.hashed || 0,
                    duplicateSets: sets.length,
                    extraCopies: extras,
                    reclaimableBytes: reclaim,
                });
            } catch {}
            return result;
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A dedup scan is already running',
                code: r.code || 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true });
    });

    // Status endpoint — returns the latest scan state including the result
    // payload from the most recent completed run, so a re-opened page can
    // render the duplicate-sets table without re-running the scan. The
    // tracker stores the last result on the snapshot's `.result` field, so
    // the duplicates page reads `r.result.duplicateSets`.
    router.get('/maintenance/dedup/status', async (req, res) => {
        const snap = jobTrackers.dedupScan.getStatus();
        // Flatten progress into top-level fields for the existing front-end
        // contract (it reads `.processed`, `.total`, `.stage` directly off
        // the response). The tracker keeps progress under `progress.*`.
        res.json({ ...snap, ...(snap.progress || {}) });
    });

    // Library hash-coverage stats — total rows, how many already have a SHA-256
    // (cheap re-scans), how many are still awaiting a hash (the next scan's
    // O(bytes) cost), plus the persisted summary of the last completed scan.
    // The duplicates page uses this to render a "library status" panel above
    // the buttons so the operator can answer "what will Scan even do here?"
    // before clicking — and to show a "Last scan" line that survives a
    // server restart.
    router.get('/maintenance/dedup/stats', async (req, res) => {
        try {
            const db = getDb();
            const totalFiles = db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n || 0;
            const hashed =
                db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE file_hash IS NOT NULL').get()
                    .n || 0;
            // Same predicate the dedup scanner uses to decide what to hash —
            // mirrors src/core/dedup.js findDuplicates() so the "Awaiting hash"
            // count matches what a Scan will actually walk.
            const missing =
                db
                    .prepare(`
                SELECT COUNT(*) AS n FROM downloads
                 WHERE file_hash IS NULL
                   AND file_path IS NOT NULL
                   AND COALESCE(file_size, 0) > 0
            `)
                    .get().n || 0;
            let lastScan = null;
            try {
                const stored = kvGet('dedup_last_scan');
                if (stored && typeof stored === 'object') lastScan = stored;
            } catch {}
            res.json({ totalFiles, hashed, missing, lastScan });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Bulk-delete N files. Used by both the duplicate finder ("delete the
    // non-keep copies") and the gallery selection bar ("delete N tiles").
    // At N=10k disk I/O can run for minutes — fire-and-forget so the request
    // returns instantly and progress streams over WS.
    //
    // Validates synchronously; only the actual delete loop runs in the
    // background. Status is per-shared-tracker, NOT per-call — concurrent
    // gallery-selection deletes are serialised, the second caller gets 409.
    router.post('/maintenance/dedup/delete', async (req, res) => {
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) {
            return res.status(400).json({ error: 'ids array required' });
        }
        const cleanIds = ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
        if (!cleanIds.length) {
            return res.status(400).json({ error: 'No valid ids supplied' });
        }
        const tracker = jobTrackers.dedupDelete;
        const r = tracker.tryStart(async ({ onProgress }) => {
            // Batch the work so a 10k-row delete doesn't block the event loop
            // for minutes (every fs.unlinkSync inside `dedupDeleteByIds` runs
            // on the main thread). Each batch is small enough that progress
            // events flush between iterations and the WS dashboard sees a
            // live bar instead of a frozen UI followed by a timeout.
            const total = cleanIds.length;
            const BATCH = 50;
            const aggregate = { removed: 0, freedBytes: 0, missingFiles: 0 };
            let processed = 0;
            onProgress({ processed: 0, total, stage: 'deleting' });
            for (let off = 0; off < cleanIds.length; off += BATCH) {
                const slice = cleanIds.slice(off, off + BATCH);
                const part = dedupDeleteByIds(slice);
                aggregate.removed += part.removed || 0;
                aggregate.freedBytes += part.freedBytes || 0;
                aggregate.missingFiles += part.missingFiles || 0;
                for (const id of slice) {
                    try {
                        await purgeThumbsForDownload(id);
                    } catch {}
                }
                processed += slice.length;
                onProgress({ processed, total, stage: 'deleting' });
                // Yield to the event loop so the WS broadcast above actually
                // flushes before the next batch starts hammering the disk.
                await new Promise((r) => setImmediate(r));
            }
            try {
                broadcast({ type: 'bulk_delete', ids: cleanIds });
            } catch {}
            return { ...aggregate, requested: cleanIds.length, ids: cleanIds };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'A bulk delete is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true, queued: cleanIds.length });
    });

    router.get('/maintenance/dedup/delete/status', async (req, res) => {
        res.json(jobTrackers.dedupDelete.getStatus());
    });

    // ====== Thumbnails =========================================================
    //
    // `GET /api/thumbs/:id?w=240` returns a small WebP thumbnail for an
    // image or video download row. Cache-first: hits stat in microseconds
    // and stream from disk; misses fork sharp / ffmpeg once and the result
    // lives in `data/thumbs/`. The frontend uses these for every gallery
    // tile (replacing the previous full-resolution `/files/*?inline=1` for
    // images and the `<video preload="none">` for desktop video tiles)
    // — much smaller transfers, no decoder pressure on the client.
    //
    // Returns 404 when the source is not thumbnailable (audio/document) so
    // the SPA's <img onerror> fallback can kick in and render an icon.
    // Throttle log spam — a 1000-tile gallery scrolling past missing files
    // would otherwise flood the buffer. Three layers of quieting:
    //   1. WINDOW_MS — count is bucketed into 15-minute windows (was 1 min,
    //      then 5 min — busy operators still saw it as flood)
    //   2. FLOOR — a window only warns if the burst crossed 200 misses;
    //      small bursts (a few audio rows scrolled past) stay silent
    //   3. COOLDOWN_MS — after one warning fires, the next one is held off
    //      for 30 minutes regardless of count, so a chatty afternoon emits
    //      at most ~2 warnings instead of 4
    // Operators who want it fully silent set `advanced.thumbs.warnMisses`
    // to false in /api/config (validated server-side as boolean).
    const THUMB_MISS_WINDOW_MS = 15 * 60_000;
    const THUMB_MISS_FLOOR = 200;
    const THUMB_MISS_COOLDOWN_MS = 30 * 60_000;
    let _thumbMissBatch = { count: 0, resetAt: 0, lastWarnedAt: 0 };
    router.get('/thumbs/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).type('text/plain').send('Bad id');
            }
            const thumb = await getOrCreateThumb(id, req.query.w);
            if (!thumb) {
                const now = Date.now();
                if (now - _thumbMissBatch.resetAt > THUMB_MISS_WINDOW_MS) {
                    // Window rollover — emit a consolidated warning if (a) the
                    // burst crossed the floor AND (b) we're past the cooldown
                    // since the last emission. Both gates have to pass; either
                    // alone leaves it quiet.
                    let warnMisses = true;
                    try {
                        const cfg = loadConfig();
                        warnMisses = cfg?.advanced?.thumbs?.warnMisses !== false;
                    } catch {
                        /* no config yet → default on */
                    }
                    if (
                        warnMisses &&
                        _thumbMissBatch.count >= THUMB_MISS_FLOOR &&
                        now - _thumbMissBatch.lastWarnedAt >= THUMB_MISS_COOLDOWN_MS
                    ) {
                        const mins = Math.round(THUMB_MISS_WINDOW_MS / 60_000);
                        log({
                            source: 'thumbs',
                            level: 'warn',
                            msg: `${_thumbMissBatch.count} thumb misses in the last ${mins} min (DB row missing, file off disk, or source not thumbnailable). Try Maintenance → Verify files / Re-index.`,
                        });
                        _thumbMissBatch.lastWarnedAt = now;
                    }
                    _thumbMissBatch.count = 1;
                    _thumbMissBatch.resetAt = now;
                } else {
                    _thumbMissBatch.count += 1;
                }
                // No-store on the miss path. Without this header the browser
                // remembers the 404 + text/plain body for the URL's default
                // heuristic window and keeps replaying it from cache after
                // the thumb finally lands on disk — operator sees "ภาพอื่น
                // โหลด ปกติ id X ไม่ขึ้น แม้ generated แล้ว". Forcing the
                // client to re-request next time fixes that.
                res.setHeader('Cache-Control', 'no-store');
                return res.status(404).type('text/plain').send('No thumb');
            }

            res.setHeader('Content-Type', 'image/webp');
            // Browser cache for an hour + must-revalidate so stale entries
            // (e.g. a 404 the client cached before this URL had a real thumb
            // on disk) get rechecked against Last-Modified instead of being
            // served forever from the local cache. `immutable` was the wrong
            // hint for this URL: the same id+width can legitimately serve
            // different bytes after a source replacement or a manual purge.
            res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
            // ETag derived from mtime + size so a regenerated thumb produces
            // a different validator and the browser can't reuse the old
            // body byte-for-byte under a 304.
            const stMtime = Math.floor(thumb.mtime);
            const etag = `"thumb-${id}-${thumb.width || 'd'}-${stMtime}"`;
            res.setHeader('ETag', etag);
            const lastMod = new Date(thumb.mtime).toUTCString();
            res.setHeader('Last-Modified', lastMod);
            if (
                req.headers['if-none-match'] === etag ||
                req.headers['if-modified-since'] === lastMod
            ) {
                return res.status(304).end();
            }
            return res.sendFile(thumb.path, (err) => {
                if (err && !res.headersSent) res.status(500).end();
            });
        } catch (e) {
            console.error('thumb serve:', e);
            if (!res.headersSent) res.status(500).type('text/plain').send('Internal error');
        }
    });

    // Maintenance — wipe the entire thumbnail cache. Used by the
    // "Rebuild thumbnails" UI to force regeneration (e.g. after a quality
    // tweak or a corruption scare). On-demand generation refills the cache
    // on the next gallery scroll, gated by the thumbs.js semaphores.
    //
    // Fire-and-forget: a 100k-thumb cache can take a noticeable amount of
    // time to walk and unlink. POST returns immediately; final count lands
    // via `thumbs_rebuild_done` WS event.
    router.post('/maintenance/thumbs/rebuild', async (req, res) => {
        const tracker = jobTrackers.thumbsRebuild;
        // Optional body.kind scopes the wipe to one media class — e.g.
        // {"kind":"video"} only purges the cache rows whose downloads.file_type
        // matches the video bucket. Defaults to the full directory unlink.
        const kindRaw = String(req.body?.kind || 'all').toLowerCase();
        const kind = thumbKindTypes(kindRaw) ? kindRaw : 'all';
        const r = tracker.tryStart(async () => {
            const removed = await purgeAllThumbs({ kind });
            return { removed, kind };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'A thumbnail wipe is already running', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true, kind });
    });

    router.get('/maintenance/thumbs/rebuild/status', async (req, res) => {
        res.json(jobTrackers.thumbsRebuild.getStatus());
    });

    // Rebuild one tile. Used by the gallery's per-tile retry action — purges
    // the cached widths for that id; the next /api/thumbs/:id hit regenerates
    // on demand. Cheap, idempotent, admin-only.
    router.post('/maintenance/thumbs/rebuild-one/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ error: 'Bad id' });
            }
            const removed = await purgeThumbsForDownload(id);
            // Best-effort warm of the default width so the client's retry doesn't
            // stare at a 404 + skeleton. Failures here are non-fatal — the
            // on-demand path handles the next request.
            try {
                await getOrCreateThumb(id, THUMB_DEFAULT_WIDTH);
            } catch {}
            res.json({ success: true, removed, cached: hasCachedThumb(id) });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Maintenance — generate thumbnails for every download row that doesn't
    // already have one cached at the default width. Covers downloads that
    // landed before pre-generation existed. Honours the per-kind concurrency
    // caps in thumbs.js so the gallery stays responsive while the sweep runs.
    //
    // Fire-and-forget: returns 200 with `started: true` immediately. The
    // actual build runs in the background, broadcasting `thumbs_progress`
    // over WS and a final `thumbs_done`. A re-opened page can call
    // `/api/maintenance/thumbs/build/status` to recover the in-flight state.
    // Field names mirror what `buildAllThumbnails()` returns + emits via
    // onProgress: `processed / total / built / skipped / errored / scanned`.
    // Renamed from `done/errors` (the original placeholders) so the status
    // JSON, the WS frames, and the log line all agree — previously the log
    // printed `done=undefined errors=undefined`.
    // Migrated from a hand-rolled `_thumbBuildRunning` flag. The previous
    // implementation broadcast `thumbs_done` on caught errors BEFORE the
    // `finally` block reset the flag — a double-click after a failed build
    // landed in the race window and got a spurious 409 ALREADY_RUNNING.
    // JobTracker resets `running` and broadcasts `_done` atomically, so the
    // retry succeeds. Prefix 'thumbs' preserved.
    router.post('/maintenance/thumbs/build-all', async (req, res) => {
        const tracker = jobTrackers.thumbsBuild;
        // Optional body.kind scopes the build to one media class. Accepts
        // 'all' | 'image' | 'video' | 'audio'; unknown values fall back to 'all'
        // so the existing client (no body) still works untouched.
        const kindRaw = String(req.body?.kind || 'all').toLowerCase();
        const kind = thumbKindTypes(kindRaw) ? kindRaw : 'all';
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            const result = await buildAllThumbnails({
                kind,
                onProgress: (p) => onProgress({ ...p, kind }),
                signal,
            });
            try {
                kvSet('thumbs_last_build', {
                    finishedAt: Date.now(),
                    kind,
                    built: result?.built ?? 0,
                    skipped: result?.skipped ?? 0,
                    errored: result?.errored ?? 0,
                    scanned: result?.scanned ?? 0,
                });
            } catch {}
            return { ...result, kind };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A thumbnail build is already running',
                code: r.code || 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true, kind });
    });

    // Cancel an in-flight build sweep. Idempotent — if nothing is running, the
    // tracker just reports false and the client treats it as already-stopped.
    // JobTracker emits a final `thumbs_done` with `cancelled:true`.
    router.post('/maintenance/thumbs/build/cancel', async (req, res) => {
        const cancelled = jobTrackers.thumbsBuild.cancel();
        res.json({ success: true, cancelled });
    });

    router.get('/maintenance/thumbs/build/status', async (req, res) => {
        const snap = jobTrackers.thumbsBuild.getStatus();
        res.json({ ...snap, ...(snap.progress || {}) });
    });

    router.get('/maintenance/thumbs/build/stats', async (req, res) => {
        try {
            const lastRun = kvGet('thumbs_last_build') || null;
            res.json({ lastRun });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Paginated thumbnail preview for the Build thumbnails page. Cursor-based
    // (id DESC) so the operator's scrolling feels stable — new downloads land
    // at the top, scrolling pulls older rows. Capped at 200 per page so the
    // frontend's virtual window can drain a request in one paint.
    //
    // Kinds:
    //   image  — file_type IN ('photo','image')
    //   video  — file_type = 'video'
    //   all    — both
    //
    // Big-data note: id is the PK index; the `WHERE id < ?` clause is a sargable
    // range scan, no LIMIT/OFFSET on a 1M-row library.
    router.get('/maintenance/thumbs/list', async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 60));
            const rawCursor = parseInt(req.query.cursor, 10);
            const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? rawCursor : null;
            const kindRaw = String(req.query.kind || 'all').toLowerCase();
            const types = thumbKindTypes(kindRaw) || thumbKindTypes('all');
            const placeholders = types.map(() => '?').join(',');
            const args = [...types];
            // `file_path IS NOT NULL` matches what `buildAllThumbnails` walks —
            // hides rows whose files were deleted but whose DB entries linger,
            // so the gallery doesn't paint tiles that will only ever 404.
            let where = `file_type IN (${placeholders}) AND file_path IS NOT NULL`;
            if (cursor !== null) {
                where += ' AND id < ?';
                args.push(cursor);
            }
            const db = getDb();
            const rows = db
                .prepare(
                    // file_path is needed so the gallery's lightbox click can
                    // build /files/<path>?inline=1 — without it the click
                    // would have to round-trip to /api/downloads/:id just to
                    // resolve the path, doubling the request rate of a fast
                    // operator clicking through tiles.
                    `SELECT id, file_name, file_type, file_size, file_path, created_at
                 FROM downloads
                 WHERE ${where}
                 ORDER BY id DESC
                 LIMIT ?`,
                )
                .all(...args, limit);
            // Decorate with `cached:true|false` — the gallery uses this to
            // surface "12 not built yet" without round-tripping per tile.
            const out = rows.map((r) => ({ ...r, cached: hasCachedThumb(r.id) }));
            const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
            // COUNT(*) is the expensive part on a 1M-row library (index scan,
            // not stat cache because of the WHERE). Send it only on the first
            // page; subsequent pages re-use the value the client already has.
            let total = null;
            if (cursor === null) {
                total =
                    db
                        .prepare(
                            `SELECT COUNT(*) AS c FROM downloads
                     WHERE file_type IN (${placeholders}) AND file_path IS NOT NULL`,
                        )
                        .get(...types).c || 0;
            }
            res.json({ rows: out, nextCursor, hasMore: nextCursor !== null, total });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Probe which ffmpeg hardware-acceleration backends actually work on
    // this host. Runs `ffmpeg -hide_banner -hwaccels` and returns the parsed
    // list. Used by Settings → Advanced → Video thumb hardware acceleration
    // → "Detect available" so the admin doesn't have to SSH in to find out
    // whether VAAPI/QSV/CUDA/etc. are available on the host's ffmpeg build.
    router.get('/maintenance/thumbs/hwaccel-probe', async (req, res) => {
        try {
            const thumbs = await import('../../core/thumbs.js');
            const { compiledIn, available, ffmpegPath } = await thumbs.probeHwaccel();
            // The dropdown only exposes options we have UI rows for; pick the
            // first verified backend in that subset so "Recommended" matches
            // something the user can actually select. Falls back to null when
            // nothing on this host passed the device-init test.
            const recommended =
                available.find((b) =>
                    ['vaapi', 'qsv', 'cuda', 'videotoolbox', 'd3d11va'].includes(b),
                ) || null;
            res.json({ available, compiledIn, ffmpegPath, recommended });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e), available: [] });
        }
    });

    // Maintenance — cache footprint (count + bytes) and capability check
    // (whether ffmpeg is present). Drives the "Thumbnail cache" admin panel
    // + grays out the video / audio-cover capabilities when ffmpeg is
    // missing on this host.
    router.get('/maintenance/thumbs/stats', async (req, res) => {
        try {
            const r = await getThumbsCacheStats();
            res.json({
                success: true,
                ffmpegAvailable: hasFfmpeg(),
                allowedWidths: THUMB_WIDTHS,
                ...r,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ====== Seekbar hover-preview sprites ====================================
    //
    // Sidecar-backed sprite-sheet generator (see seekbar-service/). All
    // long-running operations follow the JobTracker pattern so the
    // maintenance page can recover live state across reloads.

    router.post('/maintenance/seekbar/build-all', async (req, res) => {
        const tracker = jobTrackers.seekbarBuild;
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            const result = await buildAllSeekbar({ onProgress, signal });
            try {
                kvSet('seekbar_last_build', { finishedAt: Date.now(), ...result });
            } catch {}
            return result;
        });
        if (!r.started) return res.status(409).json(r);
        res.json({ started: true });
    });

    router.post('/maintenance/seekbar/build/cancel', async (req, res) => {
        jobTrackers.seekbarBuild.cancel();
        res.json({ success: true });
    });

    router.get('/maintenance/seekbar/build/status', async (req, res) => {
        res.json(jobTrackers.seekbarBuild.getStatus());
    });

    router.get('/maintenance/seekbar/build/stats', async (req, res) => {
        res.json({ lastBuild: kvGet('seekbar_last_build') || null });
    });

    router.post('/maintenance/seekbar/rebuild', async (req, res) => {
        const tracker = jobTrackers.seekbarRebuild;
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            const wiped = await purgeAllSeekbar();
            onProgress({ phase: 'wiped', wiped });
            if (signal?.aborted) return { wiped, regenerated: 0 };
            const result = await buildAllSeekbar({ onProgress, signal });
            try {
                kvSet('seekbar_last_build', { finishedAt: Date.now(), ...result, wiped });
            } catch {}
            return { wiped, ...result };
        });
        if (!r.started) return res.status(409).json(r);
        res.json({ started: true });
    });

    router.get('/maintenance/seekbar/rebuild/status', async (req, res) => {
        res.json(jobTrackers.seekbarRebuild.getStatus());
    });

    router.post('/maintenance/seekbar/regen/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid id' });
            }
            const db = (await import('../../core/db.js')).getDb();
            const row = db
                .prepare('SELECT id, file_path, file_type FROM downloads WHERE id = ?')
                .get(id);
            if (!row) return res.status(404).json({ error: 'not_found' });
            if (row.file_type !== 'video') {
                return res.status(400).json({ error: 'not a video' });
            }
            const r = await generateSeekbarForDownload(row, null, { overwrite: 'always' });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/maintenance/seekbar/stats', async (req, res) => {
        try {
            const stats = getSeekbarCacheStats();
            const sidecar = getSeekbarSidecarStatus();
            res.json({ success: true, sidecar, ffmpegAvailable: hasFfmpeg(), ...stats });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/maintenance/seekbar/list', async (req, res) => {
        try {
            const db = (await import('../../core/db.js')).getDb();
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
            const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
            const rows = db
                .prepare(
                    `SELECT s.download_id AS id, s.bytes, s.frames, s.cols, s.rows, s.duration_sec,
                        s.format, s.generated_at, d.file_name
                   FROM seekbar_sprites s
                   JOIN downloads d ON d.id = s.download_id
                  ORDER BY s.generated_at DESC
                  LIMIT ? OFFSET ?`,
                )
                .all(limit, offset);
            const total = db.prepare('SELECT COUNT(*) AS n FROM seekbar_sprites').get().n;
            res.json({ rows, total, limit, offset, hasMore: offset + rows.length < total });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/maintenance/seekbar/health', async (req, res) => {
        // Aggregate diagnostic surface — the maintenance page's System
        // health card reads this. Keeps the client to one round-trip on
        // mount and one snapshot every WS state change.
        try {
            const sidecar = getSeekbarSidecarStatus();
            let hwaccel = null;
            if (sidecar?.ok) {
                try {
                    hwaccel = await probeSeekbarHwaccel();
                } catch (e) {
                    hwaccel = { error: String(e?.message || e).slice(0, 200) };
                }
            }
            res.json({
                success: true,
                sidecar,
                hwaccel,
                ffmpegAvailable: hasFfmpeg(),
                version: SEEKBAR_SIDECAR_VERSION,
                platform: `${process.platform}/${process.arch}`,
                node: process.version,
            });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/maintenance/seekbar/hwaccel-probe', async (req, res) => {
        try {
            if (!getSeekbarSidecarStatus()?.ok) {
                return res.json({
                    available: [],
                    compiled: [],
                    ffmpeg_path: '',
                    error: 'sidecar not running',
                });
            }
            const r = await probeSeekbarHwaccel();
            res.json(r);
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.post('/maintenance/seekbar/sidecar/restart', async (req, res) => {
        try {
            await refreshSeekbarSidecar();
            res.json({ success: true, sidecar: getSeekbarSidecarStatus() });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Public sprite + meta — admin and guest both can fetch (sprites are
    // derived assets that already gate behind the share-link / library ACL
    // on the row itself).
    router.get('/seekbar/sprite/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
            const row = getSeekbarSprite(id);
            if (!row?.sprite_path) {
                res.set('Cache-Control', 'no-store');
                return res.status(404).end();
            }
            const spritePath = getSeekbarSpritePath(id, row.format || 'webp');
            const finalPath = (await import('fs')).existsSync(row.sprite_path)
                ? row.sprite_path
                : spritePath;
            const etag = `"sk-${id}-${row.generated_at || 0}"`;
            if (req.headers['if-none-match'] === etag) {
                res.set('ETag', etag);
                return res.status(304).end();
            }
            res.set('ETag', etag);
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
            res.set('Content-Type', row.format === 'jpeg' ? 'image/jpeg' : 'image/webp');
            res.sendFile(finalPath);
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.get('/seekbar/meta/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
            const meta = await getSeekbarMetaForDownload(id);
            if (!meta) {
                res.set('Cache-Control', 'no-store');
                return res.status(404).end();
            }
            res.set('Cache-Control', 'public, max-age=300');
            res.json(meta);
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ====== Video faststart optimiser (v2.6.10) ==============================
    //
    // MP4s with their `moov` atom at the end of the file confuse the
    // browser's HTML5 player — seek breaks, audio appears missing, the
    // "loaded" range stalls until the entire `mdat` has streamed in.
    // `_generateVideoThumb` was patched in v2.6.9 to handle the case where
    // such files exist; this adds the fix at the source: rewrite each
    // file with `+faststart` so the player gets `moov` immediately.
    //
    // Three endpoints, mirroring the thumbs build/rebuild pattern:
    //   POST /api/maintenance/faststart/scan   — fire-and-forget sweep
    //   GET  /api/maintenance/faststart/status — recover live state
    //   GET  /api/maintenance/faststart/stats  — counts for the dashboard
    //
    // Auto-fixed inline by the downloader (see faststartInBackground in
    // downloader.js); the sweep is for the existing library.
    // Migrated from a hand-rolled `_faststartRunning` flag with the same
    // broadcast-before-flag-reset race as thumbs/build-all. JobTracker
    // closes the window. Prefix 'faststart' preserved.
    router.post('/maintenance/faststart/scan', async (req, res) => {
        const tracker = jobTrackers.faststart;
        const r = tracker.tryStart(async ({ onProgress, signal }) => {
            const { optimizeAll } = await import('../../core/faststart.js');
            const result = await optimizeAll({
                onProgress: (p) => onProgress(p),
                signal,
            });
            try {
                kvSet('faststart_last_run', {
                    finishedAt: Date.now(),
                    optimized: result?.optimized ?? 0,
                    already: result?.already ?? 0,
                    skipped: result?.skipped ?? 0,
                    errored: result?.errored ?? 0,
                    scanned: result?.scanned ?? 0,
                });
            } catch {}
            return result;
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A faststart sweep is already running',
                code: r.code || 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true });
    });

    router.get('/maintenance/faststart/status', async (req, res) => {
        const snap = jobTrackers.faststart.getStatus();
        res.json({ ...snap, ...(snap.progress || {}) });
    });

    router.get('/maintenance/faststart/stats', async (req, res) => {
        try {
            const { getStats } = await import('../../core/faststart.js');
            const r = await getStats();
            // Merge in the persisted last-run summary alongside the live
            // library stats. The video page already reads {optimized,
            // pending, ...} from this endpoint; lastRun is additive.
            let lastRun = null;
            try {
                lastRun = kvGet('faststart_last_run') || null;
            } catch {}
            res.json({ success: true, ffmpegAvailable: hasFfmpeg(), ...r, lastRun });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Counters maintained by the post-download auto-optimise hook (see
    // `optimizeDownloadInBackground` in `src/core/faststart.js`). Read-only
    // snapshot of `kv['faststart_stats']` — the maintenance UI uses this to
    // surface "auto-optimised since boot: N optimised / M total" without
    // polling the heavier `/stats` endpoint that walks every video row.
    router.get('/maintenance/faststart/auto-stats', async (req, res) => {
        try {
            const { getAutoStats } = await import('../../core/faststart.js');
            res.json({ success: true, ...getAutoStats() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ====== NSFW review tool (Phase 1: photos only) ===========================
    //
    // Curated 18+ libraries get noise from auto-download — non-18+ photos
    // that snuck in. The classifier flags low-score rows (likely NOT 18+)
    // for admin review + manual delete. High-score rows (the genuine 18+
    // content) are kept untouched.
    //
    // All endpoints are admin-only via the v2.3.26 chokepoint. Status +
    // candidate listing is read-only and cheap; scan + delete + whitelist
    // guard against concurrent calls / missing config.

    function _nsfwCfg() {
        try {
            const cfg = loadConfig().advanced?.nsfw || {};
            return {
                enabled: cfg.enabled === true,
                model: cfg.model || NSFW_DEFAULTS.model,
                threshold: Number.isFinite(cfg.threshold) ? cfg.threshold : NSFW_DEFAULTS.threshold,
                concurrency: Number.isFinite(cfg.concurrency)
                    ? cfg.concurrency
                    : NSFW_DEFAULTS.concurrency,
                batchSize: Number.isFinite(cfg.batchSize) ? cfg.batchSize : NSFW_DEFAULTS.batchSize,
                fileTypes:
                    Array.isArray(cfg.fileTypes) && cfg.fileTypes.length
                        ? cfg.fileTypes
                        : NSFW_DEFAULTS.fileTypes,
                cacheDir: cfg.cacheDir || NSFW_DEFAULTS.cacheDir,
            };
        } catch {
            return { ...NSFW_DEFAULTS, enabled: false };
        }
    }

    router.get('/maintenance/nsfw/status', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const state = nsfwGetScanState(cfg);
            res.json({
                enabled: cfg.enabled,
                running: state.running,
                scanned: state.scanned,
                total: state.total,
                candidates: state.candidates,
                keep: state.keep,
                whitelisted: state.whitelisted,
                totalEligible: state.totalEligible,
                lastCheckedAt: state.lastCheckedAt,
                startedAt: state.startedAt,
                finishedAt: state.finishedAt,
                error: state.error,
                model: cfg.model,
                threshold: cfg.threshold,
                fileTypes: cfg.fileTypes,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/maintenance/nsfw/scan', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            if (!cfg.enabled) {
                return res.status(503).json({
                    error: 'NSFW review is disabled. Open Maintenance → NSFW review and toggle it on first.',
                    code: 'NSFW_DISABLED',
                });
            }
            if (nsfwIsScanRunning()) {
                return res
                    .status(409)
                    .json({ error: 'A scan is already running', code: 'ALREADY_RUNNING' });
            }
            log({
                source: 'nsfw',
                level: 'info',
                msg: `scan starting — model=${cfg.model} threshold=${cfg.threshold} fileTypes=[${(cfg.fileTypes || []).join(',')}] concurrency=${cfg.concurrency}`,
            });
            let _lastLoggedScanned = 0;
            const r = await nsfwStartScan(
                cfg,
                (p) => {
                    try {
                        broadcast({ type: 'nsfw_progress', ...p });
                    } catch {}
                    // Throttle log spam — emit at most every 25 rows so a 10 000
                    // row library doesn't pump 10 000 lines into the web log.
                    if (typeof p?.scanned === 'number' && p.scanned - _lastLoggedScanned >= 25) {
                        _lastLoggedScanned = p.scanned;
                        log({
                            source: 'nsfw',
                            level: 'info',
                            msg: `scan progress — ${p.scanned}/${p.total} (candidates=${p.candidates ?? 0}, keep=${p.keep ?? 0})`,
                        });
                    }
                },
                (p) => {
                    try {
                        broadcast({ type: 'nsfw_done', ...p });
                    } catch {}
                    if (p?.error) {
                        log({
                            source: 'nsfw',
                            level: 'error',
                            msg: `scan finished with error: ${p.error}`,
                        });
                    } else {
                        log({
                            source: 'nsfw',
                            level: 'info',
                            msg: `scan done — scanned=${p?.scanned ?? 0} candidates=${p?.candidates ?? 0} keep=${p?.keep ?? 0} elapsed=${p?.finishedAt && p?.startedAt ? Math.round((p.finishedAt - p.startedAt) / 1000) + 's' : 'n/a'}`,
                        });
                    }
                },
                (p) => {
                    try {
                        broadcast({ type: 'nsfw_model_downloading', ...p });
                    } catch {}
                    log({
                        source: 'nsfw',
                        level: 'info',
                        msg: `model load — ${p?.status || 'progress'} ${p?.file || ''} ${p?.progress != null ? Math.round(p.progress) + '%' : ''}`,
                    });
                },
                // onLog — internal nsfw.js events flow into the same realtime
                // log stream the v2 page subscribes to.
                (entry) => log(entry),
            );
            if (r?.alreadyRunning) {
                log({
                    source: 'nsfw',
                    level: 'warn',
                    msg: 'scan request rejected — already running',
                });
            }
            res.json({ success: true, ...r });
        } catch (e) {
            log({
                source: 'nsfw',
                level: 'error',
                msg: `scan failed to start: ${e?.message || e} (code=${e?.code || 'UNKNOWN'})`,
            });
            console.error('nsfw/scan:', e);
            const status = e.code === 'NSFW_LIB_MISSING' ? 503 : 500;
            res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
        }
    });

    router.post('/maintenance/nsfw/scan/cancel', async (req, res) => {
        const ok = nsfwCancelScan();
        res.json({ success: true, cancelled: ok });
    });

    // Pre-fetch the classifier weights without scanning a single file. Lets
    // the operator warm the cache from the UI so the next scan starts
    // instantly. Returns immediately; download progress flows over the
    // existing `nsfw_model_downloading` WS event + realtime log channel.
    router.post('/maintenance/nsfw/preload', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const r = await nsfwPreloadClassifier(
                cfg,
                (p) => {
                    try {
                        broadcast({ type: 'nsfw_model_downloading', ...p });
                    } catch {}
                },
                (entry) => log(entry),
            );
            res.json({ success: true, ...r });
        } catch (e) {
            log({
                source: 'nsfw',
                level: 'error',
                msg: `preload failed to start: ${e?.message || e}`,
            });
            const status = e.code === 'NSFW_LIB_MISSING' ? 503 : 500;
            res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
        }
    });

    // Snapshot of the in-process classifier load state. Polled by the
    // /maintenance/nsfw page so the model-status pill reflects reality
    // even between WS messages.
    router.get('/maintenance/nsfw/model-status', async (req, res) => {
        res.json({ success: true, ...nsfwClassifierReady() });
    });

    // Wipe the cached weights on disk. Confirm-gated in the UI; safe-by-
    // design here (the cache dir is allow-listed via _resolveCacheDirAbs
    // inside nsfw.js — there's no caller-supplied path).
    router.delete('/maintenance/nsfw/cache', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const r = await nsfwClearCache(cfg);
            log({
                source: 'nsfw',
                level: 'info',
                msg: `cleared model cache — removed ${r.files} file(s) / ${r.bytes} bytes`,
            });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/maintenance/nsfw/results', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
            const r = getNsfwDeleteCandidates({
                fileTypes: cfg.fileTypes,
                threshold: cfg.threshold,
                page,
                limit,
            });
            res.json({
                success: true,
                ...r,
                threshold: cfg.threshold,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Delete reviewed candidates. Reuses the dedup-delete pathway (which
    // removes file from disk + DB row) and purges the corresponding
    // thumbnail cache entries so a stale WebP doesn't keep serving.
    router.post('/maintenance/nsfw/delete', async (req, res) => {
        try {
            const { ids } = req.body || {};
            if (!Array.isArray(ids) || !ids.length) {
                return res.status(400).json({ error: 'ids array required' });
            }
            const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
            if (!cleanIds.length) {
                return res.status(400).json({ error: 'No valid ids supplied' });
            }
            const r = dedupDeleteByIds(cleanIds);
            for (const id of cleanIds) {
                try {
                    await purgeThumbsForDownload(id);
                } catch {}
            }
            try {
                broadcast({ type: 'bulk_delete', ids: cleanIds });
            } catch {}
            try {
                broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
            } catch {}
            res.json({ success: true, ...r });
        } catch (e) {
            console.error('nsfw/delete:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Mark rows as admin-confirmed-18+ (keep, never re-flag). Use when the
    // classifier produced a false negative — i.e. the photo IS 18+ but
    // scored low. Future scans skip these rows entirely.
    router.post('/maintenance/nsfw/whitelist', async (req, res) => {
        try {
            const { ids } = req.body || {};
            if (!Array.isArray(ids) || !ids.length) {
                return res.status(400).json({ error: 'ids array required' });
            }
            const cleanIds = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
            if (!cleanIds.length) {
                return res.status(400).json({ error: 'No valid ids supplied' });
            }
            const updated = whitelistNsfw(cleanIds);
            try {
                broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
            } catch {}
            res.json({ success: true, updated });
        } catch (e) {
            console.error('nsfw/whitelist:', e);
            res.status(500).json({ error: e.message });
        }
    });

    function _nsfwStateLight() {
        try {
            const cfg = _nsfwCfg();
            const s = getNsfwStats(cfg.fileTypes, cfg.threshold);
            return { ...s, running: nsfwIsScanRunning() };
        } catch {
            return {};
        }
    }

    // ---- NSFW v2 (tier-aware review page) -------------------------------------
    //
    // The original endpoints (status / scan / results / delete / whitelist) are
    // preserved so existing UI keeps working. The v2 endpoints power the
    // dedicated /maintenance/nsfw page, which shows per-tier stats, a score
    // histogram, paginated browse-by-tier, and bulk score-range actions.

    // Expose the tier dictionary so the front-end doesn't have to hard-code
    // the boundaries — change the bands in db.js and the UI follows.
    router.get('/maintenance/nsfw/v2/tiers-meta', async (req, res) => {
        res.json({ tiers: NSFW_TIERS });
    });

    router.get('/maintenance/nsfw/v2/tiers', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const counts = getNsfwTierCounts(cfg.fileTypes);
            log({
                source: 'nsfw',
                level: 'info',
                msg: `tier counts polled — scanned=${counts.scanned}/${counts.totalEligible}`,
            });
            res.json({ ...counts, threshold: cfg.threshold, tiers_meta: NSFW_TIERS });
        } catch (e) {
            log({
                source: 'nsfw',
                level: 'error',
                msg: `nsfw/v2/tiers failed: ${e?.message || e}`,
            });
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/maintenance/nsfw/v2/histogram', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const bins = Number(req.query.bins) || 20;
            res.json(getNsfwHistogram(cfg.fileTypes, bins));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/maintenance/nsfw/v2/list', async (req, res) => {
        try {
            const cfg = _nsfwCfg();
            const list = getNsfwListByTier({
                tier: req.query.tier || null,
                fileTypes: cfg.fileTypes,
                groupId: req.query.group || null,
                includeWhitelisted: req.query.include_whitelisted === '1',
                page: Number(req.query.page) || 1,
                limit: Number(req.query.limit) || 50,
            });
            res.json(list);
        } catch (e) {
            log({ source: 'nsfw', level: 'error', msg: `nsfw/v2/list failed: ${e?.message || e}` });
            res.status(500).json({ error: e.message });
        }
    });

    // Resolve a bulk-action filter into an explicit id list, then run the
    // requested action. Single funnel keeps the four bulk endpoints (delete /
    // whitelist / unwhitelist / reclassify) consistent — they all accept the
    // same `{ tier?, scoreMax?, scoreMin?, groupId?, fileTypes?, ids? }` body.
    //
    // One SQL statement covers the largest tiers; scoreMin/scoreMax are
    // pushed into the WHERE clause so a narrow band doesn't pull the whole
    // tier into memory.
    function _resolveBulkIds(body) {
        if (Array.isArray(body?.ids) && body.ids.length) {
            return body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        }
        const cfg = _nsfwCfg();
        const fileTypes =
            Array.isArray(body?.fileTypes) && body.fileTypes.length
                ? body.fileTypes
                : cfg.fileTypes;
        return getNsfwIdsByTier({
            tier: body?.tier || null,
            fileTypes,
            groupId: body?.groupId || null,
            includeWhitelisted: body?.includeWhitelisted === true,
            scoreMin: Number.isFinite(body?.scoreMin) ? Number(body.scoreMin) : null,
            scoreMax: Number.isFinite(body?.scoreMax) ? Number(body.scoreMax) : null,
        });
    }

    // All four NSFW v2 bulk endpoints share a single `nsfwBulk` tracker so
    // they're mutually exclusive — the operations all touch the same review
    // queue and racing them would produce inconsistent counts. Each endpoint
    // returns 200 with `{started:true}` immediately; the resolved id list +
    // final result land via `nsfw_bulk_done` (with an `op` field so the UI
    // can branch on which one finished).
    //
    // Cancellation is supported by the tracker but the actual DB operations
    // run in a tight loop and complete fast enough that we don't honour the
    // signal mid-batch — a click on Cancel just stops re-broadcasting
    // progress; the in-flight DB tx finishes naturally.
    router.post('/maintenance/nsfw/v2/bulk-delete', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        const body = req.body || {};
        const tracker = jobTrackers.nsfwBulk;
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'resolving', op: 'delete' });
            const ids = await _resolveBulkIds(body);
            if (!ids.length) return { op: 'delete', deleted: 0, ids: [] };
            log({ source: 'nsfw', level: 'warn', msg: `bulk-delete starting: ${ids.length} rows` });
            const total = ids.length;
            const BATCH = 50;
            const aggregate = { removed: 0, freedBytes: 0, missingFiles: 0 };
            let processed = 0;
            onProgress({ stage: 'deleting', op: 'delete', processed: 0, total });
            for (let off = 0; off < ids.length; off += BATCH) {
                const slice = ids.slice(off, off + BATCH);
                // Batch the sync fs.unlinkSync inside dedupDeleteByIds — without
                // this a 47 k-row delete blocks the event loop for minutes and
                // every WS progress event queues behind it (UI freezes at 0/N
                // until the whole job finishes; users perceive it as a hang).
                const part = dedupDeleteByIds(slice);
                aggregate.removed += part.removed || 0;
                aggregate.freedBytes += part.freedBytes || 0;
                aggregate.missingFiles += part.missingFiles || 0;
                for (const id of slice) {
                    try {
                        await purgeThumbsForDownload(id);
                    } catch {}
                }
                processed += slice.length;
                onProgress({ stage: 'deleting', op: 'delete', processed, total });
                await new Promise((r) => setImmediate(r));
            }
            try {
                broadcast({ type: 'bulk_delete', ids });
            } catch {}
            try {
                broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
            } catch {}
            log({
                source: 'nsfw',
                level: 'info',
                msg: `bulk-delete done: removed=${aggregate.removed} of ${ids.length}`,
            });
            return { op: 'delete', deleted: aggregate.removed, ids, ...aggregate };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A bulk NSFW operation is already running',
                code: 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true });
    });

    router.post('/maintenance/nsfw/v2/bulk-whitelist', async (req, res) => {
        const body = req.body || {};
        const tracker = jobTrackers.nsfwBulk;
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'resolving', op: 'whitelist' });
            const ids = await _resolveBulkIds(body);
            if (!ids.length) return { op: 'whitelist', updated: 0, ids: [] };
            onProgress({ stage: 'updating', op: 'whitelist', total: ids.length });
            const updated = whitelistNsfw(ids);
            try {
                broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
            } catch {}
            log({
                source: 'nsfw',
                level: 'info',
                msg: `bulk-whitelist: marked ${updated} rows as 18+`,
            });
            return { op: 'whitelist', updated, ids };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A bulk NSFW operation is already running',
                code: 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true });
    });

    // Unwhitelist accepts the same `{tier|ids|...}` body shape as the other
    // three bulk endpoints — when a tier filter is supplied we force
    // includeWhitelisted=true on the resolver because the whole point of the
    // op is to act on whitelisted rows (which the default resolver hides).
    router.post('/maintenance/nsfw/v2/unwhitelist', async (req, res) => {
        const body = req.body || {};
        const tracker = jobTrackers.nsfwBulk;
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'resolving', op: 'unwhitelist' });
            const resolveBody =
                Array.isArray(body.ids) && body.ids.length
                    ? body
                    : { ...body, includeWhitelisted: true };
            const ids = _resolveBulkIds(resolveBody);
            if (!ids.length) return { op: 'unwhitelist', updated: 0, ids: [] };
            onProgress({ stage: 'updating', op: 'unwhitelist', total: ids.length });
            const updated = unwhitelistNsfw(ids);
            try {
                broadcast({ type: 'nsfw_progress', ..._nsfwStateLight() });
            } catch {}
            log({
                source: 'nsfw',
                level: 'info',
                msg: `unwhitelist: ${updated} rows back into review`,
            });
            return { op: 'unwhitelist', updated, ids };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A bulk NSFW operation is already running',
                code: 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true });
    });

    router.post('/maintenance/nsfw/v2/reclassify', async (req, res) => {
        const body = req.body || {};
        const tracker = jobTrackers.nsfwBulk;
        const r = tracker.tryStart(async ({ onProgress }) => {
            onProgress({ stage: 'resolving', op: 'reclassify' });
            const ids = await _resolveBulkIds(body);
            if (!ids.length) return { op: 'reclassify', cleared: 0, ids: [] };
            onProgress({ stage: 'clearing', op: 'reclassify', total: ids.length });
            const cleared = reclassifyNsfw(ids);
            log({
                source: 'nsfw',
                level: 'info',
                msg: `reclassify: cleared ${cleared} rows for re-scan`,
            });
            return { op: 'reclassify', cleared, ids };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A bulk NSFW operation is already running',
                code: 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true });
    });

    router.get('/maintenance/nsfw/v2/bulk/status', async (req, res) => {
        res.json(jobTrackers.nsfwBulk.getStatus());
    });

    // ====== Recovery cleanup ====================================================
    //
    // Surfaces every group whose id starts with `unknown:` OR whose
    // `_resolveFailedAt` is set — typically the residue of `npm run recover`
    // against a downloads table that had folders from a different Telegram
    // account. The Recovery cleanup page (Maintenance → Recovery cleanup)
    // renders this list + bulk operations so the operator doesn't have to
    // edit kv['config'] by hand.
    function _classifyRecoveryGroup(g, dbStats) {
        const id = String(g.id);
        const isSynthetic = id.startsWith('unknown:');
        const failed = !!g._resolveFailedAt;
        if (!isSynthetic && !failed) return null;
        const stats = dbStats.get(id) || { files: 0, lastSeen: null };
        return {
            id,
            name: g.name || id,
            enabled: !!g.enabled,
            isSynthetic,
            resolveFailedAt: g._resolveFailedAt || null,
            resolveFailedReason: g._resolveFailedReason || (isSynthetic ? 'index_miss' : null),
            monitorAccount: g.monitorAccount || null,
            fileCount: stats.files || 0,
            lastSeenAt: stats.lastSeen || null,
        };
    }

    router.get('/maintenance/recovery/list', async (req, res) => {
        try {
            const config = loadConfig();
            const groups = Array.isArray(config.groups) ? config.groups : [];
            // Pre-fetch per-group file count + lastSeen with one query so the
            // list endpoint stays cheap even for large libraries.
            const dbStats = new Map();
            try {
                const rows = getDb()
                    .prepare(`
                    SELECT group_id, COUNT(*) AS files, MAX(created_at) AS lastSeen
                      FROM downloads
                     GROUP BY group_id
                `)
                    .all();
                for (const r of rows) {
                    dbStats.set(String(r.group_id), {
                        files: Number(r.files) || 0,
                        lastSeen: r.lastSeen || null,
                    });
                }
            } catch {
                /* fresh install — no rows */
            }
            const items = [];
            for (const g of groups) {
                const it = _classifyRecoveryGroup(g, dbStats);
                if (it) items.push(it);
            }
            if (req.query.countOnly === '1') {
                return res.json({ success: true, total: items.length });
            }
            res.json({ success: true, items, total: items.length });
        } catch (e) {
            console.error('recovery/list:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Re-run the resolver against the supplied group ids. Useful after the
    // operator adds a fresh Telegram account that might be a member of the
    // recovery channels.
    router.post('/maintenance/recovery/resolve', async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
        if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
        const tracker = jobTrackers.recoveryBulk;
        const r = tracker.tryStart(async ({ onProgress }) => {
            const monitor = runtime._monitor;
            if (!monitor) {
                return { op: 'resolve', resolved: 0, results: [], note: 'monitor not running' };
            }
            const idx = await monitor._buildDialogsIndex();
            let resolved = 0;
            const results = [];
            const total = ids.length;
            let processed = 0;
            for (const id of ids) {
                const cfg = loadConfig();
                const g = (cfg.groups || []).find((x) => String(x.id) === id);
                if (!g) {
                    results.push({ id, status: 'not_found' });
                    processed += 1;
                    onProgress({ op: 'resolve', processed, total });
                    continue;
                }
                // Resolver only handles `unknown:` ids — everything else just
                // gets a probe attempt to clear the `_resolveFailedAt` flag.
                if (!String(g.id).startsWith('unknown:')) {
                    // Try the probe loop directly.
                    const client = await monitor.discoverClientForGroup(g, idx);
                    if (client) {
                        // Clear the failure marker.
                        delete g._resolveFailedAt;
                        delete g._resolveFailedReason;
                        saveConfig(cfg);
                        results.push({ id, status: 'resolved', numericId: id });
                        resolved += 1;
                    } else {
                        results.push({
                            id,
                            status: 'still_unknown',
                            reason: monitor._lastResolveReason?.get?.(id) || 'probe_failed',
                        });
                    }
                } else {
                    const r2 = await monitor._resolveUnknownGroup(g, idx).catch(() => null);
                    if (r2) {
                        results.push({ id, status: 'resolved', numericId: r2.numericId });
                        resolved += 1;
                    } else {
                        results.push({
                            id,
                            status: 'still_unknown',
                            reason: monitor._lastResolveReason?.get?.(id) || 'index_miss',
                        });
                    }
                }
                processed += 1;
                onProgress({ op: 'resolve', processed, total });
                await new Promise((r3) => setImmediate(r3));
            }
            return { op: 'resolve', resolved, results, total };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A recovery bulk operation is already running',
                code: 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true });
    });

    // Auto-disable any subset (keeps config entry, just flips enabled:false).
    router.post('/maintenance/recovery/disable', async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
        if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
        try {
            const cfg = loadConfig();
            let n = 0;
            for (const g of cfg.groups || []) {
                if (ids.includes(String(g.id))) {
                    g.enabled = false;
                    n += 1;
                }
            }
            if (n) saveConfig(cfg);
            res.json({ success: true, disabled: n });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Hard-delete from kv['config'].groups. Optionally also drops downloads
    // rows + on-disk files via `?purgeDownloads=1`. The data wipe goes through
    // the same `_groupPurgeTracker` per-group as the existing /purge endpoint.
    router.post('/maintenance/recovery/delete', async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
        if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
        const purgeDownloads = !!req.body?.purgeDownloads;
        try {
            const cfg = loadConfig();
            const before = (cfg.groups || []).length;
            cfg.groups = (cfg.groups || []).filter((g) => !ids.includes(String(g.id)));
            const removed = before - (cfg.groups || []).length;
            if (removed) saveConfig(cfg);
            let purged = { totalRows: 0, totalFiles: 0 };
            if (purgeDownloads) {
                // Synchronous per-id wipe — the Recovery cleanup page already
                // shows a progress bar via the recoveryBulk tracker for the
                // /resolve path; this endpoint is a one-shot click and the
                // caller can poll /api/maintenance/recovery/list to confirm.
                for (const id of ids) {
                    try {
                        const r = deleteGroupDownloads(id);
                        purged.totalRows += r.deletedDownloads || 0;
                        // We don't try to delete the on-disk folder here —
                        // it's keyed by sanitised name not group_id, and the
                        // operator should use /purge for that. The DB delete
                        // is enough to clear the gallery sidebar.
                    } catch {}
                }
            }
            res.json({ success: true, removed, purgeDownloads, ...purged });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Pin a group to a specific account + re-run the resolver. Lets the
    // operator wire a freshly-added Telegram account to the recovery groups
    // it actually owns.
    router.post('/maintenance/recovery/reassign', async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x)) : [];
        const monitorAccount = req.body?.monitorAccount;
        if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
        if (!monitorAccount) return res.status(400).json({ error: 'monitorAccount required' });
        try {
            const cfg = loadConfig();
            let n = 0;
            for (const g of cfg.groups || []) {
                if (ids.includes(String(g.id))) {
                    g.monitorAccount = String(monitorAccount);
                    // Clear the failure marker so the resolver gives this
                    // (account, group) pair a fresh shot.
                    delete g._resolveFailedAt;
                    delete g._resolveFailedReason;
                    n += 1;
                }
            }
            if (n) saveConfig(cfg);
            res.json({ success: true, reassigned: n, monitorAccount });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/maintenance/recovery/status', async (req, res) => {
        res.json(jobTrackers.recoveryBulk.getStatus());
    });

    // List logfiles under data/logs/ with size + mtime — used by the SPA to
    // populate the "Download log" picker.
    router.get('/maintenance/logs', async (req, res) => {
        try {
            if (!existsSync(LOGS_DIR)) return res.json({ files: [] });
            const names = fsSync.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log'));
            const files = names
                .map((name) => {
                    try {
                        const st = fsSync.statSync(path.join(LOGS_DIR, name));
                        return { name, size: st.size, modified: st.mtime.toISOString() };
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);
            files.sort((a, b) => b.modified.localeCompare(a.modified));
            res.json({ files });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Stream the tail of a logfile as plain text. `name` is restricted to a single
    // path segment so a malicious caller can't traverse out of LOGS_DIR.
    router.get('/maintenance/logs/download', async (req, res) => {
        try {
            const name = String(req.query.name || '');
            if (
                !name ||
                name.includes('/') ||
                name.includes('\\') ||
                name.includes('\0') ||
                !name.endsWith('.log')
            ) {
                return res.status(400).json({ error: 'Invalid log name' });
            }
            const lines = Math.max(10, Math.min(100000, parseInt(req.query.lines, 10) || 5000));
            const filePath = path.join(LOGS_DIR, name);
            if (!existsSync(filePath)) return res.status(404).json({ error: 'Log not found' });

            // Realpath check defends against symlink escapes that the basename
            // filter can't catch (e.g. logs/foo.log -> /etc/passwd). Resolve
            // both sides so a case-insensitive FS or a symlinked LOGS_DIR still
            // compares cleanly.
            try {
                const realFile = fsSync.realpathSync(filePath);
                const realLogs = fsSync.realpathSync(LOGS_DIR);
                if (realFile !== realLogs && !realFile.startsWith(realLogs + path.sep)) {
                    return res.status(400).json({ error: 'Path escape detected' });
                }
            } catch {
                return res.status(400).json({ error: 'Invalid log name' });
            }

            // Naive tail — read whole file (logs are bounded), keep last N lines.
            // Acceptable up to a few hundred MB; if logs ever grow bigger we'd
            // switch to a stream-with-ring-buffer reader.
            const raw = await fs.readFile(filePath, 'utf8');
            const all = raw.split(/\r?\n/);
            const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            // RFC 5987 — strip non-ASCII for the basic param, keep UTF-8 in filename*.
            const asciiLogName = String(name).replace(/[^\x20-\x7e]/g, '_');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${asciiLogName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            );
            res.send(tail);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Export a Telegram account session as a portable string. The session is
    // AES-256 encrypted on disk under data/sessions/<id>.enc; this endpoint
    // decrypts it with the local SecureSession key and returns the raw gramJS
    // string (which itself is the long-form telegram session payload). The user
    // can paste this into another instance to migrate without re-doing the OTP
    // flow. We never log the value.
    router.post('/maintenance/session/export', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        if (!(await _requirePassword(req, res))) return;
        try {
            const { accountId } = req.body || {};
            if (typeof accountId !== 'string' || !accountId) {
                return res.status(400).json({ error: 'accountId required' });
            }
            // Path-segment guard — accountId becomes a filename.
            if (
                accountId.includes('/') ||
                accountId.includes('\\') ||
                accountId.includes('..') ||
                accountId.includes('\0')
            ) {
                return res.status(400).json({ error: 'Invalid accountId' });
            }
            const sessionFile = path.join(SESSIONS_DIR, `${accountId}.enc`);
            if (!existsSync(sessionFile)) {
                return res.status(404).json({ error: 'Session file not found for that account' });
            }
            const raw = await fs.readFile(sessionFile, 'utf8');
            const encrypted = JSON.parse(raw);
            const sessionString = _secureSession.decrypt(encrypted);
            res.json({ success: true, accountId, session: sessionString });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Revoke every dashboard session token. Forces every browser (including the
    // caller) back to the login page. Useful after a suspected compromise or after
    // rotating the password from another device.
    router.post('/maintenance/sessions/revoke-all', async (req, res) => {
        if (!_requireConfirm(req, res)) return;
        if (!(await _requirePassword(req, res))) return;
        try {
            revokeAllSessions();
            res.clearCookie('tg_dl_session', SESSION_COOKIE_OPTS);
            broadcast({ type: 'sessions_revoked' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Surface the raw config.json (with secrets redacted) so power users can
    // review what's on disk without SSHing into the container. Sensitive fields
    // are stripped — see /api/config for the existing redaction policy.
    router.get('/maintenance/config/raw', async (req, res) => {
        try {
            const config = loadConfig();
            if (config.telegram?.apiHash) config.telegram.apiHash = '••••••• (redacted)';
            if (config.web?.passwordHash) config.web.passwordHash = '••••••• (redacted)';
            if (config.web?.password) config.web.password = '••••••• (redacted)';
            if (config.proxy?.password) config.proxy.password = '••••••• (redacted)';
            if (Array.isArray(config.accounts)) {
                // Phone numbers are stored alongside the metadata; keep but show
                // the user what they're about to download.
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.send(JSON.stringify(config, null, 2));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
