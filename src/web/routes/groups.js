import path from 'path';
import { fileURLToPath } from 'url';
import fs, { existsSync } from 'fs';
import express from 'express';
import { loadConfig } from '../../config/manager.js';
import { getDb } from '../../core/db.js';
import { runtime } from '../../core/runtime.js';
import { writeConfigAtomic } from '../lib/config-writer.js';
import { createJobTracker } from '../../core/job-tracker.js';
import { bestGroupName } from '../lib/format.js';
import { listPeers } from '../../core/cluster/peers.js';
import { sanitizeName } from '../../core/downloader.js';
import { getGroupStats, listGroupFiles, deleteGroupDownloads } from '../../core/db/groups.js';
import {
    historyJobs as _historyJobs,
    activeBackfillsByGroup as _activeBackfillsByGroup,
    saveHistoryJobsToStore,
    scheduleHistoryJobCleanup,
} from '../lib/history-state.js';
import { BACKFILL_MAX_LIMIT } from '../../core/constants.js';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../../data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

// Module-level ref set by factory — lets server.js call _spawnInternalBackfill
// without an HTTP round-trip (used by the catch_up_needed runtime event).
let _spawnBackfillFn = null;
export function spawnBackfill(...args) {
    if (!_spawnBackfillFn) throw new Error('groups router not initialized');
    return _spawnBackfillFn(...args);
}

export function createGroupsRouter({
    broadcast,
    log,
    invalidateDialogsCache,
    getDialogsNameCache,
    dialogsTypeFor,
    resolveEntityAcrossAccounts,
    downloadProfilePhoto,
    jobTrackers,
    getAccountManager,
}) {
    const router = express.Router();

    // Per-group purge tracker — lazily created, capped at 32 live entries.
    const _groupPurgeTrackers = new Map();
    function _groupPurgeTracker(groupId) {
        const k = `groupPurge:${groupId}`;
        if (!_groupPurgeTrackers.has(k)) {
            if (_groupPurgeTrackers.size >= 32) {
                for (const [oldKey, t] of _groupPurgeTrackers) {
                    if (!t.isRunning()) {
                        _groupPurgeTrackers.delete(oldKey);
                        break;
                    }
                }
            }
            _groupPurgeTrackers.set(
                k,
                createJobTracker({
                    kind: k,
                    broadcast,
                    log,
                    eventPrefix: 'group_purge',
                }),
            );
        }
        return _groupPurgeTrackers.get(k);
    }

    router.get('/groups', async (req, res) => {
        try {
            const config = loadConfig();
            // Pull the best DB-side name per group_id so a config row with
            // "Unknown" doesn't shadow a real name we already saved at
            // download time. Plain MAX(group_name) misbehaves on this
            // schema because "Unknown" sorts above most ASCII titles —
            // a group with rows ["Unknown", "Cool Channel"] would surface
            // "Unknown". CASE-filter out the placeholders before MAX, then
            // fall back to MAX(any) only if every row was a placeholder.
            let dbNames = new Map();
            try {
                const rows = getDb()
                    .prepare(`
                SELECT group_id,
                       MAX(CASE
                             WHEN group_name IS NOT NULL
                              AND group_name != ''
                              AND group_name != 'Unknown'
                              AND group_name != 'unknown'
                              AND group_name NOT GLOB '-?[0-9]*'
                              AND group_name NOT GLOB 'Group [0-9]*'
                           THEN group_name END) AS best_name,
                       MAX(group_name) AS any_name
                  FROM downloads
                 GROUP BY group_id`)
                    .all();
                for (const r of rows) dbNames.set(String(r.group_id), r.best_name || r.any_name);
            } catch {}

            // Live dialogs from every connected account — same source the
            // Browse-chats picker uses, so the sidebar shows the same name.
            const dialogsNames = await getDialogsNameCache();

            const groupsWithPhotos = await Promise.all(
                (config.groups || []).map(async (group) => {
                    const photoPath = path.join(PHOTOS_DIR, `${group.id}.jpg`);
                    const hasPhoto = existsSync(photoPath);
                    return {
                        ...group,
                        name: bestGroupName(
                            group.id,
                            group.name,
                            dbNames.get(String(group.id)),
                            dialogsNames.get(String(group.id)),
                        ),
                        // Sidebar uses `type` to render the right corner icon
                        // (megaphone vs group vs user/bot). Without this the
                        // Downloaded Groups list defaulted to the id-prefix
                        // heuristic in createAvatar() which painted every
                        // supergroup as a channel.
                        type: group.type || dialogsTypeFor(group.id),
                        photoUrl: hasPhoto ? `/photos/${group.id}.jpg` : null,
                        // Federation surface — own groups carry peerId: null
                        // so the sidebar can distinguish them from peer rows
                        // appended below.
                        peerId: null,
                        peerName: null,
                    };
                }),
            );

            // Federation merge — append every paired peer's groups to the list,
            // deduplicated by id (own row wins; peer rows that share an id are
            // attached to the local row's `mirroredOn` array). Default off /
            // empty when no peers are paired so non-cluster operators see no
            // change. Each foreign group carries `peerId` + `peerName` so the
            // SPA can render a "from {peer}" badge and route per-group clicks
            // to /api/downloads/:id?include=peers&peerId=<id>.
            //
            // Guest sessions skip the merge — federation is admin-gated, so a
            // guest's sidebar stays local-only.
            if (req.role !== 'guest') {
                try {
                    const ownIdSet = new Set(groupsWithPhotos.map((g) => String(g.id)));
                    const peerGroupRows = getDb()
                        .prepare('SELECT peer_id, payload FROM peer_groups LIMIT 5000')
                        .all();
                    const peerNameMap = new Map();
                    try {
                        for (const p of listPeers())
                            peerNameMap.set(String(p.peerId), p.name || p.peerId);
                    } catch {
                        /* cluster not initialised — peer name stays null */
                    }
                    for (const r of peerGroupRows) {
                        let payload = null;
                        try {
                            payload = JSON.parse(r.payload);
                        } catch {
                            continue;
                        }
                        const peerGroups = Array.isArray(payload?.groups) ? payload.groups : [];
                        const peerName = peerNameMap.get(String(r.peer_id)) || null;
                        for (const pg of peerGroups) {
                            const idStr = String(pg.id);
                            if (ownIdSet.has(idStr)) {
                                // Local row already has this group — attach the
                                // peer to its mirroredOn list so the SPA can show
                                // a "+N peers also have this" badge later.
                                const localRow = groupsWithPhotos.find(
                                    (g) => String(g.id) === idStr,
                                );
                                if (localRow) {
                                    localRow.mirroredOn = Array.isArray(localRow.mirroredOn)
                                        ? localRow.mirroredOn
                                        : [];
                                    if (!localRow.mirroredOn.includes(r.peer_id)) {
                                        localRow.mirroredOn.push(r.peer_id);
                                    }
                                }
                                continue;
                            }
                            // Truly foreign group — append. Photo URL stays null
                            // (no cross-peer photo proxy in M1); the SPA falls
                            // back to a default avatar for these rows.
                            groupsWithPhotos.push({
                                ...pg,
                                peerId: r.peer_id,
                                peerName,
                                type: pg.type || dialogsTypeFor(pg.id),
                                photoUrl: null,
                            });
                            // Mark in the local set so two peers sharing the same
                            // foreign group don't surface twice.
                            ownIdSet.add(idStr);
                        }
                    }
                } catch (e) {
                    // Federation merge is purely additive — log and continue if it
                    // explodes, so a bad peer payload can't take down the sidebar.
                    console.warn('GET /api/groups federation merge failed:', e?.message || e);
                }
            }

            res.json(groupsWithPhotos);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.delete('/groups/:id/purge', async (req, res) => {
        const groupId = req.params.id;
        const tracker = _groupPurgeTracker(groupId);
        const r = tracker.tryStart(async ({ onProgress }) => {
            const config = loadConfig();
            const configGroup = (config.groups || []).find((g) => String(g.id) === String(groupId));
            const dbRow = getDb()
                .prepare(
                    'SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1',
                )
                .get(String(groupId));
            const groupName = configGroup?.name || dbRow?.group_name || 'unknown';
            const folderName = sanitizeName(groupName);
            onProgress({ stage: 'counting', groupId });

            // 1. Delete files on disk — count first so the UI can render a
            // determinate bar.
            const folderPath = path.join(DOWNLOADS_DIR, folderName);
            let filesDeleted = 0;
            if (existsSync(folderPath)) {
                const countFiles = (dir) => {
                    let count = 0;
                    const items = fs.readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        if (item.isDirectory()) count += countFiles(path.join(dir, item.name));
                        else count++;
                    }
                    return count;
                };
                filesDeleted = countFiles(folderPath);
                onProgress({ stage: 'deleting_files', groupId, total: filesDeleted, processed: 0 });
                await fs.rm(folderPath, { recursive: true, force: true });
                onProgress({
                    stage: 'deleting_files',
                    groupId,
                    total: filesDeleted,
                    processed: filesDeleted,
                });
            }

            // 2. Delete DB records
            onProgress({ stage: 'deleting_rows', groupId });
            const dbResult = deleteGroupDownloads(groupId);

            // 3. Remove from config
            config.groups = (config.groups || []).filter((g) => String(g.id) !== String(groupId));
            await writeConfigAtomic(config);

            // 4. Delete profile photo
            const photoPath = path.join(PHOTOS_DIR, `${groupId}.jpg`);
            if (existsSync(photoPath)) await fs.unlink(photoPath);

            console.log(
                `PURGED: ${groupName} — ${filesDeleted} files, ${dbResult.deletedDownloads} DB records`,
            );
            broadcast({ type: 'group_purged', groupId });
            return {
                groupId,
                deleted: {
                    files: filesDeleted,
                    dbRecords: dbResult.deletedDownloads,
                    queueRecords: dbResult.deletedQueue,
                    group: groupName,
                },
            };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A purge for this group is already running',
                code: 'ALREADY_RUNNING',
                snapshot: r.snapshot,
            });
        }
        res.json({ success: true, started: true, groupId });
    });

    router.get('/groups/:id/purge/status', async (req, res) => {
        const groupId = req.params.id;
        const tracker = _groupPurgeTracker(groupId);
        res.json(tracker.getStatus());
    });

    // 6b-bis. Per-group data viewer endpoints — the Group modal's "Data" tab
    // renders these. Stats is one index-only query (cheap); files is paginated.
    router.get('/groups/:id/stats', async (req, res) => {
        try {
            const groupId = req.params.id;
            if (!groupId) return res.status(400).json({ error: 'group id required' });
            const stats = getGroupStats(groupId);
            res.json({ success: true, ...stats });
        } catch (e) {
            console.error('groups/:id/stats:', e);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/groups/:id/files', async (req, res) => {
        try {
            const groupId = req.params.id;
            if (!groupId) return res.status(400).json({ error: 'group id required' });
            const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
            const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
            const type = typeof req.query.type === 'string' ? req.query.type : null;
            const r = listGroupFiles({ groupId, limit, offset, type });
            res.json({ success: true, ...r });
        } catch (e) {
            console.error('groups/:id/files:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // "Delete files only" — drops every download row + on-disk file for this
    // group BUT keeps the config entry + monitor enabled. Operator picks this
    // when they want to clear stale data and re-download fresh, instead of
    // the destructive `/purge` (which also removes the group from config).
    // Re-uses the per-group purge tracker so a parallel /purge can't race.
    router.post('/groups/:id/delete-files', async (req, res) => {
        const groupId = req.params.id;
        if (!groupId) return res.status(400).json({ error: 'group id required' });
        const tracker = _groupPurgeTracker(groupId);
        const r = tracker.tryStart(async ({ onProgress }) => {
            const config = loadConfig();
            const configGroup = (config.groups || []).find((g) => String(g.id) === String(groupId));
            const dbRow = getDb()
                .prepare(
                    'SELECT group_name FROM downloads WHERE group_id = ? AND group_name IS NOT NULL LIMIT 1',
                )
                .get(String(groupId));
            const groupName = configGroup?.name || dbRow?.group_name || 'unknown';
            const folderName = sanitizeName(groupName);
            onProgress({ stage: 'counting', groupId });
            const folderPath = path.join(DOWNLOADS_DIR, folderName);
            let filesDeleted = 0;
            if (existsSync(folderPath)) {
                const countFiles = (dir) => {
                    let count = 0;
                    const items = fs.readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        if (item.isDirectory()) count += countFiles(path.join(dir, item.name));
                        else count++;
                    }
                    return count;
                };
                filesDeleted = countFiles(folderPath);
                onProgress({ stage: 'deleting_files', groupId, total: filesDeleted, processed: 0 });
                await fs.rm(folderPath, { recursive: true, force: true });
                onProgress({
                    stage: 'deleting_files',
                    groupId,
                    total: filesDeleted,
                    processed: filesDeleted,
                });
            }
            onProgress({ stage: 'deleting_rows', groupId });
            const dbResult = deleteGroupDownloads(groupId);
            onProgress({ stage: 'done', groupId });
            try {
                broadcast({
                    type: 'group_files_deleted',
                    groupId: String(groupId),
                    groupName,
                    ...dbResult,
                    filesDeleted,
                });
            } catch {}
            return {
                groupId: String(groupId),
                groupName,
                filesDeleted,
                deletedDownloads: dbResult.deletedDownloads,
                deletedQueue: dbResult.deletedQueue,
            };
        });
        if (!r.started) {
            return res.status(409).json({
                error: 'A purge / delete is already running for this group',
                code: 'ALREADY_RUNNING',
            });
        }
        res.json({ success: true, started: true, groupId });
    });

    // 6c. Purge ALL (Everything — Factory Reset)
    //
    // Fire-and-forget — a full library wipe is the slowest, most destructive
    // admin action we have. Returns 200 immediately; final counts via
    // `purge_all_done`. Single-flight via the shared tracker.

    router.put('/groups/:id', async (req, res) => {
        try {
            const config = loadConfig();
            const groupId = req.params.id;
            let groupIndex = config.groups.findIndex((g) => String(g.id) === groupId);

            if (groupIndex === -1) {
                // Create new — resolve a real name from any loaded account.
                let groupName = req.body.name;
                if (
                    !groupName ||
                    groupName === 'Unknown' ||
                    groupName === groupId ||
                    groupName.startsWith('Group ')
                ) {
                    const r = await resolveEntityAcrossAccounts(groupId);
                    if (r?.entity) {
                        const e = r.entity;
                        groupName =
                            e.title ||
                            (e.firstName && e.firstName + (e.lastName ? ' ' + e.lastName : '')) ||
                            e.username ||
                            groupName;
                    }
                }
                const newGroup = {
                    id: groupId.startsWith('-') ? parseInt(groupId) : groupId,
                    name: groupName || `Unknown`,
                    enabled: req.body.enabled ?? false,
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
                config.groups.push(newGroup);
                groupIndex = config.groups.length - 1;
            }

            // Update fields
            const group = config.groups[groupIndex];
            if (req.body.enabled !== undefined) group.enabled = req.body.enabled;
            if (req.body.name) group.name = req.body.name;
            if (req.body.filters) {
                group.filters = { ...group.filters, ...req.body.filters };
            }
            if (req.body.autoForward) {
                group.autoForward = { ...group.autoForward, ...req.body.autoForward };
            }
            if (req.body.topics !== undefined) {
                // Allow {enabled, ids:[]} or null to clear.
                if (req.body.topics === null) delete group.topics;
                else
                    group.topics = {
                        enabled: !!req.body.topics.enabled,
                        ids: Array.isArray(req.body.topics.ids)
                            ? req.body.topics.ids.map(Number).filter(Number.isFinite)
                            : [],
                    };
            }

            // Comment media tracking — when enabled, the real-time monitor
            // and history backfill also poll the channel's linked discussion
            // group for comment media. These are stored with a 'comment:'
            // prefix in their group_id to distinguish them from the main channel.
            if (req.body.trackComments !== undefined) {
                group.trackComments = !!req.body.trackComments;
            }

            // Multi-Account assignments
            if (req.body.monitorAccount !== undefined) {
                if (!req.body.monitorAccount) delete group.monitorAccount;
                else group.monitorAccount = req.body.monitorAccount;
            }
            if (req.body.forwardAccount !== undefined) {
                if (!req.body.forwardAccount) delete group.forwardAccount;
                else group.forwardAccount = req.body.forwardAccount;
            }

            // Cluster routing — per-group owner / backup peer. Read by
            // src/core/cluster/router.js + failover.js. Empty string clears.
            // Server doesn't validate that the peer exists; an unknown id
            // simply means failover.js logs "owner offline" forever, which
            // matches the existing behaviour for a peer that's been revoked.
            if (req.body.ownerPeerId !== undefined) {
                if (!req.body.ownerPeerId) delete group.ownerPeerId;
                else group.ownerPeerId = String(req.body.ownerPeerId);
            }
            if (req.body.backupPeerId !== undefined) {
                if (!req.body.backupPeerId) delete group.backupPeerId;
                else group.backupPeerId = String(req.body.backupPeerId);
            }

            // Rescue Mode (per-group). 'auto' = follow global cfg.rescue.enabled,
            // 'on' / 'off' override. Empty / null falls back to default ('auto').
            if (req.body.rescueMode !== undefined) {
                const v = req.body.rescueMode;
                if (v === 'on' || v === 'off' || v === 'auto') group.rescueMode = v;
                else delete group.rescueMode;
            }
            if (req.body.rescueRetentionHours !== undefined) {
                const n = parseInt(req.body.rescueRetentionHours, 10);
                if (Number.isFinite(n) && n > 0) {
                    group.rescueRetentionHours = Math.max(1, Math.min(720, n));
                } else {
                    delete group.rescueRetentionHours;
                }
            }

            await writeConfigAtomic(config);
            // Drop the dialogs response cache so the picker filter re-derives
            // `inConfig` for the just-added/updated group. Otherwise the
            // "Monitored Only" tab keeps the group hidden for up to
            // DIALOG_CACHE_TTL_MS even though it's now in config.
            invalidateDialogsCache();
            broadcast({ type: 'config_updated', config });

            // Auto-backfill on first add (v2.3.34) — when a group transitions
            // from "never seen / disabled" → "enabled" AND has zero rows in
            // downloads yet, kick off a background backfill of the last N
            // messages so the user gets immediate gallery content without
            // having to navigate to the Backfill page. Bounded by config so
            // operators who don't want this behavior can disable it.
            try {
                if (req.body.enabled === true && !_activeBackfillsByGroup.has(String(group.id))) {
                    const histCfg = config.advanced?.history || {};
                    const autoOn = histCfg.autoFirstBackfill !== false; // default ON
                    const autoLim = Number(histCfg.autoFirstLimit ?? 100); // default 100
                    if (autoOn && autoLim > 0) {
                        const { count } = (await import('../../core/db.js')).getMessageIdRange(
                            String(group.id),
                        );
                        if (count === 0) {
                            // Fire-and-forget — POST /api/history would be the
                            // ideal way but we'd need to invoke it as an
                            // internal call. Calling our handler logic directly
                            // keeps everything in one process without an HTTP
                            // hop. Failures are non-fatal: the user can always
                            // trigger backfill manually from the Backfill page.
                            _spawnInternalBackfill({
                                groupId: String(group.id),
                                limit: Math.max(1, Math.min(10000, autoLim)),
                                mode: 'pull-older',
                                reason: 'auto-first',
                            }).catch((e) =>
                                console.warn('[auto-backfill] first-add failed:', e?.message || e),
                            );
                        }
                    }
                }
            } catch (e) {
                // Non-fatal — group save still succeeded.
                console.warn('[auto-backfill] hook error:', e?.message || e);
            }

            res.json({ success: true, group: config.groups[groupIndex] });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * Internal helper — spawn a backfill job exactly as POST /api/history
     * would, without going through the HTTP layer. Used by:
     *   - Auto-backfill on first group add (PUT /api/groups/:id new+enabled)
     *   - Catch-up backfill after monitor restart (monitor.js boot hook)
     *
     * Resolves once the job is *registered* (not when the actual download
     * finishes) so callers don't block. Returns the new jobId.
     */
    async function _spawnInternalBackfill({
        groupId,
        limit,
        mode = 'pull-older',
        reason = 'internal',
    }) {
        const groupKey = String(groupId);
        if (_activeBackfillsByGroup.has(groupKey)) return null;
        const am = await getAccountManager();
        if (am.count === 0) throw new Error('No Telegram accounts loaded');
        const config = loadConfig();
        const group = (config.groups || []).find((g) => String(g.id) === groupKey);
        if (!group) throw new Error('Group not configured');

        const { HistoryDownloader } = await import('../../core/history.js');
        const { DownloadManager } = await import('../../core/downloader.js');
        const { RateLimiter } = await import('../../core/security.js');
        const standalone = !runtime._downloader;
        const downloader =
            runtime._downloader ||
            new DownloadManager(am.getDefaultClient(), config, new RateLimiter(config.rateLimits));
        if (standalone) {
            await downloader.init();
            downloader.start();
        }
        const history = new HistoryDownloader(am.getDefaultClient(), downloader, config, am);

        const jobId = crypto.randomBytes(6).toString('hex');
        const lim =
            limit === null || limit === 0
                ? null
                : Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Number(limit) || 100));
        const job = {
            id: jobId,
            state: 'running',
            processed: 0,
            downloaded: 0,
            error: null,
            group: group.name,
            groupId: groupKey,
            limit: lim,
            startedAt: Date.now(),
            finishedAt: null,
            cancelled: false,
            mode,
            reason,
            _runner: history,
        };
        _historyJobs.set(jobId, job);
        _activeBackfillsByGroup.set(groupKey, jobId);
        history.on('progress', (s) => {
            job.processed = s.processed;
            job.downloaded = s.downloaded;
            broadcast({
                type: 'history_progress',
                jobId,
                ...s,
                group: group.name,
                groupId: groupKey,
                limit: job.limit,
                startedAt: job.startedAt,
                mode: job.mode,
            });
        });
        history.on('start', (s) => {
            if (s?.mode) job.mode = s.mode;
        });
        history
            .downloadHistory(groupKey, { limit: lim ?? undefined, mode })
            .then(() => {
                job.state = job.cancelled ? 'cancelled' : 'done';
                job.finishedAt = Date.now();
                delete job._runner;
                const evt = job.cancelled ? 'history_cancelled' : 'history_done';
                broadcast({ type: evt, jobId, group: group.name, ...job });
                if (standalone) downloader.stop().catch(() => {});
                saveHistoryJobsToStore();
                if (_activeBackfillsByGroup.get(groupKey) === jobId)
                    _activeBackfillsByGroup.delete(groupKey);
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
                    groupId: groupKey,
                });
                // Same hint flow as the user-triggered branch above so auto-
                // backfills (first-add bootstrap, post-restart catch-up) get
                // a readable diagnostic when they fail.
                const hint = /no available account/i.test(job.error)
                    ? ' (no logged-in account can read this group — check Settings → Telegram Accounts)'
                    : '';
                log({
                    source: 'backfill',
                    level: 'error',
                    msg: `auto-backfill failed for "${group.name}" (${groupKey}): ${job.error}${hint}`,
                });
                if (standalone) downloader.stop().catch(() => {});
                saveHistoryJobsToStore();
                if (_activeBackfillsByGroup.get(groupKey) === jobId)
                    _activeBackfillsByGroup.delete(groupKey);
            });
        return jobId;
    }
    _spawnBackfillFn = _spawnInternalBackfill;

    // 9. Profile Photos
    router.get('/groups/:id/photo', async (req, res) => {
        let id = req.params.id;
        // Comment-thread groups use `comment:<parentGroupId>` as their group_id.
        // Strip the prefix and serve the parent group's photo so the comment
        // group inherits the same avatar in the gallery / sidebar.
        if (typeof id === 'string' && id.startsWith('comment:')) {
            id = id.slice('comment:'.length);
        }
        // Synthetic IDs from `reindexFromDisk` (`unknown:<sanitisedFolderName>`)
        // carry no Telegram entity directly. Resolve them to a numeric ID by
        // matching the folder name against the live dialogs cache (the user's
        // own joined chats) — `sanitizeName(entity.title) === folderName` is
        // the same transform the downloader uses when bucketing files into
        // <group_name>/ folders, so the round-trip works on every chat the
        // active accounts can see. The photo bytes for the real entity are
        // then served and ALSO copied to a safe filename keyed by the
        // synthetic id, so subsequent hits skip the resolve loop.
        if (typeof id === 'string' && id.startsWith('unknown:')) {
            const rawKey = id.slice('unknown:'.length);
            if (!/^[A-Za-z0-9_.-]{1,128}$/.test(rawKey)) {
                return res.status(400).send('Invalid id');
            }
            const folderName = rawKey;
            const safeKey = rawKey;
            const photosRoot = path.resolve(PHOTOS_DIR);
            const synthPath = path.resolve(PHOTOS_DIR, `${safeKey}.jpg`);
            if (synthPath !== photosRoot && !synthPath.startsWith(photosRoot + path.sep)) {
                return res.status(400).send('Invalid id');
            }
            if (existsSync(synthPath)) {
                res.setHeader(
                    'Cache-Control',
                    'private, max-age=86400, stale-while-revalidate=604800',
                );
                return res.sendFile(synthPath);
            }
            try {
                const byId = await getDialogsNameCache();
                let matchId = null;
                for (const [nid, name] of byId) {
                    if (sanitizeName(name) === folderName) {
                        matchId = nid;
                        break;
                    }
                }
                if (matchId) {
                    // Reuse the numeric photo — fetch on demand if missing.
                    const numericPath = path.join(PHOTOS_DIR, `${matchId}.jpg`);
                    if (!existsSync(numericPath)) await downloadProfilePhoto(matchId);
                    if (existsSync(numericPath)) {
                        try {
                            await fs.copyFile(numericPath, synthPath);
                        } catch {}
                        res.setHeader(
                            'Cache-Control',
                            'private, max-age=86400, stale-while-revalidate=604800',
                        );
                        return res.sendFile(numericPath);
                    }
                }
            } catch {
                /* fall through to 404 */
            }
            return res.status(404).send('No photo for synthetic group id');
        }
        // Telegram entity IDs are signed integers — anything else is suspicious
        // (path-traversal attempts, control chars, NUL, etc.). Reject hard
        // before we touch the filesystem.
        if (!/^-?\d+$/.test(id)) return res.status(400).send('Invalid id');
        const photoPath = path.join(PHOTOS_DIR, `${id}.jpg`);

        // Realpath check defends against the case where PHOTOS_DIR or one of
        // its descendants is a symlink that points outside the data dir.
        const send = () => {
            try {
                const real = fs.realpathSync(photoPath);
                const realRoot = fs.realpathSync(PHOTOS_DIR);
                if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
                    return res.status(400).send('Path escape detected');
                }
                // Override the global /api/* `no-store` policy — avatar bytes
                // are content-addressed by group ID and the file is rewritten
                // in place when the group's photo changes, so a 1-day private
                // cache is safe AND eliminates the per-render avatar flicker
                // (every renderGroupsList re-paint was triggering a fresh
                // round trip thanks to no-store).
                res.setHeader(
                    'Cache-Control',
                    'private, max-age=86400, stale-while-revalidate=604800',
                );
                return res.sendFile(real);
            } catch {
                return res.status(404).send('Not found');
            }
        };

        if (existsSync(photoPath)) return send();

        // Try download if not exists
        const url = await downloadProfilePhoto(id);
        if (url && existsSync(photoPath)) return send();

        res.status(404).send('Not found');
    });

    // Walks every group (config-defined and DB-only) and tries to resolve a
    // human-readable name + cached profile photo. Used by the SPA when it
    // detects a row whose name is "Unknown" or just the numeric id.
    //
    // Fire-and-forget — with 100 groups × Telegram rate limits this can take
    // 30+ s. POST returns instantly; per-id progress streams via
    // `groups_refresh_info_progress`, the final `updates` array via
    // `groups_refresh_info_done`. The legacy `groups_refreshed` broadcast is
    // preserved for clients that already subscribe to it.
    router.post('/groups/refresh-info', async (req, res) => {
        const tracker = jobTrackers.groupsRefreshInfo;
        const r = tracker.tryStart(async ({ onProgress }) => {
            const config = loadConfig();
            const ids = new Set((config.groups || []).map((g) => String(g.id)));
            try {
                const rows = getDb()
                    .prepare('SELECT DISTINCT group_id, group_name FROM downloads LIMIT 10000')
                    .all();
                for (const rr of rows) ids.add(String(rr.group_id));
            } catch {}

            let updated = 0;
            let mutatedConfig = false;
            const updates = [];
            const total = ids.size;
            let processed = 0;
            onProgress({ processed: 0, total, updated: 0, stage: 'resolving' });
            for (const id of ids) {
                const resolved = await resolveEntityAcrossAccounts(id);
                if (resolved) {
                    const { entity } = resolved;
                    const realName =
                        entity?.title ||
                        (entity?.firstName &&
                            entity.firstName + (entity.lastName ? ' ' + entity.lastName : '')) ||
                        entity?.username ||
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
                            mutatedConfig = true;
                        }
                        try {
                            const stmt = getDb().prepare(
                                `UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name = '' OR group_name = 'Unknown' OR group_name = ?)`,
                            );
                            stmt.run(realName, id, id);
                        } catch {}
                        updates.push({ id, name: realName });
                        updated++;
                    }
                    await downloadProfilePhoto(id).catch(() => {});
                }
                processed += 1;
                onProgress({ processed, total, updated, stage: 'resolving' });
            }
            if (mutatedConfig) await writeConfigAtomic(config);
            if (updates.length) {
                try {
                    broadcast({ type: 'groups_refreshed', updates });
                } catch {}
            }
            return { updated, scanned: total, updates };
        });
        if (!r.started) {
            // Hydrate the snapshot so the front-end keeps the button disabled
            // and doesn't show a misleading "failed" toast.
            return res.status(409).json({
                error: 'Group refresh already in progress',
                code: 'ALREADY_RUNNING',
                snapshot: r.snapshot,
            });
        }
        res.json({ success: true, started: true });
    });

    router.get('/groups/refresh-info/status', async (req, res) => {
        res.json(jobTrackers.groupsRefreshInfo.getStatus());
    });

    router.post('/groups/refresh-photos', async (req, res) => {
        const tracker = jobTrackers.groupsRefreshPhotos;
        const r = tracker.tryStart(async ({ onProgress }) => {
            const config = loadConfig();
            const groups = config.groups || [];
            const total = groups.length;
            let processed = 0;
            const results = [];
            onProgress({ processed: 0, total, stage: 'downloading' });
            for (const group of groups) {
                const url = await downloadProfilePhoto(group.id).catch(() => null);
                results.push({ id: group.id, url });
                processed += 1;
                onProgress({ processed, total, stage: 'downloading' });
            }
            return { results };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'Photo refresh already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/groups/refresh-photos/status', async (req, res) => {
        res.json(jobTrackers.groupsRefreshPhotos.getStatus());
    });

    return router;
}
