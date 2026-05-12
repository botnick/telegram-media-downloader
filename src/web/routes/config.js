import express from 'express';
import { loadConfig } from '../../config/manager.js';
import { runtime } from '../../core/runtime.js';
import { writeConfigAtomic } from '../lib/config-writer.js';
import { getDb } from '../../core/db.js';
import { getRescueStats } from '../../core/db/downloads.js';
import { getRescueSweeper } from '../../core/rescue.js';
import { applyShareLimits } from '../../core/share.js';
import { getDiskRotator } from '../../core/disk-rotator.js';
import { refreshSidecar as refreshSeekbarSidecar } from '../../core/seekbar/spawn.js';

export function createConfigRouter({
    broadcast,
    invalidateDialogsCache,
    invalidateShareConfigCache,
    refreshRateLimitConfig,
}) {
    const router = express.Router();

    router.get('/config', async (req, res) => {
        try {
            const config = loadConfig();
            const safe = JSON.parse(JSON.stringify(config));
            // The Telegram apiId is essentially public (it identifies the
            // application registration, not a user) so we surface it to the SPA
            // for editing. apiHash IS sensitive — replace with a presence flag.
            if (safe.telegram) {
                const hashSet = !!safe.telegram.apiHash;
                delete safe.telegram.apiHash;
                safe.telegram.apiHashSet = hashSet;
            }
            if (safe.web) {
                delete safe.web.password;
                delete safe.web.passwordHash;
            }
            if (Array.isArray(safe.accounts)) {
                safe.accounts = safe.accounts.map((a) => ({
                    id: a.id,
                    name: a.name,
                    username: a.username,
                }));
            }
            // Per-group account assignments are an internal mapping; surface only
            // a boolean so the SPA can show "(custom account)".
            if (Array.isArray(safe.groups)) {
                safe.groups = safe.groups.map((g) => {
                    const out = { ...g };
                    if (out.monitorAccount) {
                        out.hasMonitorAccount = true;
                        delete out.monitorAccount;
                    }
                    if (out.forwardAccount) {
                        out.hasForwardAccount = true;
                        delete out.forwardAccount;
                    }
                    return out;
                });
            }
            res.json(safe);
        } catch (error) {
            console.error('GET /api/config:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // Rescue Mode stats — counters for the SPA's Rescue panel.
    router.get('/rescue/stats', async (req, res) => {
        try {
            res.json(getRescueStats());
        } catch (e) {
            console.error('GET /api/rescue/stats:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // 7b. Config Update
    router.post('/config', async (req, res) => {
        try {
            // Reject anything that smells like an attempt to inject auth state
            // through the config endpoint. Web auth lives in dedicated routes.
            if (req.body?.web?.password || req.body?.web?.passwordHash) {
                return res.status(400).json({
                    error: 'Use /api/auth/setup or /api/auth/change-password to manage dashboard auth.',
                });
            }

            // Defence-in-depth against prototype pollution. JSON.parse already
            // rejects __proto__ as a key on most engines, but a cooperating
            // client could still attempt `constructor.prototype` etc. Strip
            // those keys recursively before any spread/merge below.
            const sanitizePollutionKeys = (obj) => {
                if (!obj || typeof obj !== 'object') return obj;
                for (const k of ['__proto__', 'constructor', 'prototype']) {
                    if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
                }
                for (const v of Object.values(obj)) {
                    if (v && typeof v === 'object') sanitizePollutionKeys(v);
                }
                return obj;
            };
            sanitizePollutionKeys(req.body);

            const currentConfig = loadConfig();
            const newConfig = { ...currentConfig, ...req.body };

            // Deep-merge sub-sections so a partial PATCH (e.g., only telegram.apiId)
            // doesn't blow away the rest of that section (e.g., telegram.apiHash).
            if (req.body.telegram)
                newConfig.telegram = { ...currentConfig.telegram, ...req.body.telegram };
            if (req.body.download)
                newConfig.download = { ...currentConfig.download, ...req.body.download };
            if (req.body.rateLimits)
                newConfig.rateLimits = { ...currentConfig.rateLimits, ...req.body.rateLimits };
            if (req.body.diskManagement)
                newConfig.diskManagement = {
                    ...currentConfig.diskManagement,
                    ...req.body.diskManagement,
                };
            if (req.body.rescue)
                newConfig.rescue = { ...(currentConfig.rescue || {}), ...req.body.rescue };
            if (req.body.proxy === null)
                newConfig.proxy = null; // explicit clear
            else if (req.body.proxy && typeof req.body.proxy === 'object') {
                // Deep-merge so the SPA can omit unchanged fields (e.g., the
                // password) without wiping them. Pass an explicit `null` for a
                // field to remove it.
                const merged = { ...(currentConfig.proxy || {}), ...req.body.proxy };
                for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
                newConfig.proxy = merged;
            }
            if (req.body.web) {
                // Allow toggling enabled flag, but never let the route alter
                // password/passwordHash regardless of source.
                const safeWeb = { ...currentConfig.web, ...req.body.web };
                delete safeWeb.password;
                if (!currentConfig.web?.passwordHash) delete safeWeb.passwordHash;
                else safeWeb.passwordHash = currentConfig.web.passwordHash;
                newConfig.web = safeWeb;
            }

            // Cluster namespace — match the deep-merge convention used for every
            // other top-level config section. Settings → Federation patches
            // `cluster.replicate.<key>` and `cluster.failover_grace_minutes`
            // independently; the panel currently reads full current cluster
            // before each save (client-side read-modify-write), but the server
            // contract should be defensive so a future caller that PATCHes just
            // one field doesn't accidentally erase the rest. Two-level merge:
            // top-level cluster keys are merged with current; `replicate` is
            // merged one level deeper so a single-key toggle preserves the rest
            // of the policy map.
            if (req.body.cluster && typeof req.body.cluster === 'object') {
                const curCluster = currentConfig.cluster || {};
                const incCluster = req.body.cluster;
                const merged = { ...curCluster, ...incCluster };
                if (incCluster.replicate && typeof incCluster.replicate === 'object') {
                    merged.replicate = { ...(curCluster.replicate || {}), ...incCluster.replicate };
                }
                newConfig.cluster = merged;
            }

            // Advanced runtime tuning — two-level deep-merge so a PATCH that
            // touches one sub-namespace (e.g. only advanced.downloader) keeps the
            // others intact. Per-field clamping below; out-of-range values are
            // silently dropped to the original constants instead of 400-ing the
            // whole save (the SPA shouldn't fail to save the rest of the form
            // because someone typed `0` into a number field).
            if (req.body.advanced && typeof req.body.advanced === 'object') {
                const cur = currentConfig.advanced || {};
                const inc = req.body.advanced || {};
                const clampInt = (v, lo, hi, def) => {
                    const n = parseInt(v, 10);
                    if (!Number.isFinite(n)) return def;
                    return Math.max(lo, Math.min(hi, n));
                };
                const merged = {
                    downloader: {
                        ...(cur.downloader || {}),
                        ...(inc.downloader || {}),
                    },
                    history: {
                        ...(cur.history || {}),
                        ...(inc.history || {}),
                    },
                    diskRotator: {
                        ...(cur.diskRotator || {}),
                        ...(inc.diskRotator || {}),
                    },
                    integrity: {
                        ...(cur.integrity || {}),
                        ...(inc.integrity || {}),
                    },
                    web: {
                        ...(cur.web || {}),
                        ...(inc.web || {}),
                    },
                    share: {
                        ...(cur.share || {}),
                        ...(inc.share || {}),
                    },
                    nsfw: {
                        ...(cur.nsfw || {}),
                        ...(inc.nsfw || {}),
                    },
                    thumbs: {
                        ...(cur.thumbs || {}),
                        ...(inc.thumbs || {}),
                    },
                    ai: (() => {
                        const merged = { ...(cur.ai || {}), ...(inc.ai || {}) };
                        // Deep-merge the nested `faces` sub-block so a partial
                        // patch (e.g. `{faces:{epsilon:0.65}}` from the slider)
                        // doesn't wipe siblings like `providers`, `sidecarUrl`,
                        // `arRange`, etc. Without this, every slider tweak
                        // would reset the rest of the faces config to defaults
                        // on the next `_mergeAi` round.
                        if (inc.ai?.faces && typeof inc.ai.faces === 'object') {
                            merged.faces = {
                                ...((cur.ai || {}).faces || {}),
                                ...inc.ai.faces,
                            };
                        }
                        return merged;
                    })(),
                    // Seekbar subsystem — sprite-sheet generator for the video
                    // hover preview. Mirrors the `nsfw`/`thumbs` shape: shallow
                    // merge here, per-field clamp + allow-list below. Without
                    // this branch, every POST /api/config that touches the
                    // `advanced.*` block would silently drop `advanced.seekbar`
                    // because `newConfig.advanced = merged` replaces the entire
                    // namespace with whatever `merged` lists.
                    seekbar: {
                        ...(cur.seekbar || {}),
                        ...(inc.seekbar || {}),
                    },
                };
                // ffmpeg hwaccel — allow-list validation. An attacker who
                // got past the admin gate could otherwise pass arbitrary
                // text into the ffmpeg `-hwaccel <…>` arg. Allow-list keeps
                // the universe of accepted values explicit; anything off-list
                // falls back to '' (CPU). Documented in docs/DEPLOY.md.
                const HWACCEL_ALLOW = new Set([
                    '',
                    'vaapi',
                    'qsv',
                    'cuda',
                    'videotoolbox',
                    'd3d11va',
                    'dxva2',
                ]);
                const hwIn = String(merged.thumbs?.hwaccel || '')
                    .toLowerCase()
                    .trim();
                merged.thumbs.hwaccel = HWACCEL_ALLOW.has(hwIn) ? hwIn : '';
                // warnMisses — boolean, default true. Coerce non-false to true
                // so a hand-edited string ("yes", 1) doesn't quietly disable
                // the helpful warning.
                merged.thumbs.warnMisses = merged.thumbs.warnMisses !== false;
                // Clamp every numeric so a typo can't ban the user from logging
                // in (sessionTtlDays=0) or hose the downloader (minConcurrency=0).
                const d = merged.downloader;
                d.minConcurrency = clampInt(d.minConcurrency, 1, 100, 3);
                d.maxConcurrency = clampInt(d.maxConcurrency, 1, 100, 20);
                if (d.maxConcurrency < d.minConcurrency) d.maxConcurrency = d.minConcurrency;
                d.scalerIntervalSec = clampInt(d.scalerIntervalSec, 1, 600, 5);
                d.idleSleepMs = clampInt(d.idleSleepMs, 50, 10000, 200);
                d.spilloverThreshold = clampInt(d.spilloverThreshold, 100, 100000, 2000);

                const h = merged.history;
                h.backpressureCap = clampInt(
                    h.backpressureCap,
                    10,
                    100000,
                    BACKPRESSURE_CAP_DEFAULT,
                );
                h.backpressureMaxWaitMs = clampInt(h.backpressureMaxWaitMs, 5000, 3600000, 900000);
                h.shortBreakEveryN = clampInt(h.shortBreakEveryN, 0, 100000, 100);
                h.longBreakEveryN = clampInt(h.longBreakEveryN, 0, 1000000, 1000);
                // Recent-backfills retention. Anything older than this gets
                // pruned at next read of kv['history_jobs']. 1-3650 days.
                h.retentionDays = clampInt(h.retentionDays, 1, 3650, 30);
                // v2.3.34 — auto-backfill knobs
                h.autoFirstBackfill = h.autoFirstBackfill !== false; // default ON
                h.autoFirstLimit = clampInt(h.autoFirstLimit, 0, 10000, 100);
                h.autoCatchUp = h.autoCatchUp !== false; // default ON
                h.autoCatchUpThreshold = clampInt(h.autoCatchUpThreshold, 1, 100000, 5);
                h.batchInsertSize = clampInt(h.batchInsertSize, 1, 500, 50);
                h.batchInsertMaxAgeMs = clampInt(h.batchInsertMaxAgeMs, 100, 60000, 1000);

                const sh = merged.share;
                // 1 second floor / 10 years ceiling. Defaults match the spec
                // values share.js uses pre-config (60 / 90d / 7d).
                sh.ttlMinSec = clampInt(sh.ttlMinSec, 1, 315360000, 60);
                sh.ttlMaxSec = clampInt(sh.ttlMaxSec, sh.ttlMinSec, 315360000, 7776000);
                // ttlDefault must lie inside [min, max] — clamped here so the
                // SPA can't ship an out-of-range default that fails the picker.
                sh.ttlDefaultSec = clampInt(sh.ttlDefaultSec, sh.ttlMinSec, sh.ttlMaxSec, 604800);
                sh.rateLimitWindowMs = clampInt(sh.rateLimitWindowMs, 1000, 3600000, 60000);
                sh.rateLimitMax = clampInt(sh.rateLimitMax, 1, 100000, 60);

                // NSFW review tool. All values are config-driven — no hardcoded
                // model id, threshold, or concurrency in code.
                const ns = merged.nsfw;
                ns.enabled = ns.enabled === true; // explicit opt-in only
                // Threshold is on a 0-1 score axis; clamped via integer math by
                // multiplying through so the same clampInt helper works.
                const tInt = Math.round((Number(ns.threshold) || NSFW_DEFAULTS.threshold) * 1000);
                ns.threshold = clampInt(tInt, 100, 990, 600) / 1000;
                ns.concurrency = clampInt(ns.concurrency, 1, 4, NSFW_DEFAULTS.concurrency);
                ns.batchSize = clampInt(ns.batchSize, 10, 500, NSFW_DEFAULTS.batchSize);
                // Model id + cache dir + fileTypes are strings/arrays — light
                // validation only (string coerce, allowlist-strip).
                ns.model =
                    typeof ns.model === 'string' && ns.model.trim()
                        ? ns.model.trim()
                        : NSFW_DEFAULTS.model;
                // dtype controls which ONNX variant is fetched from HuggingFace.
                // Allow-list keeps a typo from sending arbitrary text to the
                // transformers.js loader and helps the UI fall back to the
                // documented default when the operator clears the field.
                const NSFW_DTYPES = new Set(['q8', 'fp16', 'fp32', 'q4']);
                const dIn = String(ns.dtype || '')
                    .toLowerCase()
                    .trim();
                ns.dtype = NSFW_DTYPES.has(dIn) ? dIn : NSFW_DEFAULTS.dtype;
                ns.cacheDir =
                    typeof ns.cacheDir === 'string' && ns.cacheDir.trim()
                        ? ns.cacheDir.trim()
                        : NSFW_DEFAULTS.cacheDir;
                const ALLOWED_TYPES = ['photo', 'video', 'sticker', 'document'];
                ns.fileTypes = (
                    Array.isArray(ns.fileTypes) ? ns.fileTypes : NSFW_DEFAULTS.fileTypes
                )
                    .map((s) => String(s).toLowerCase())
                    .filter((s) => ALLOWED_TYPES.includes(s));
                if (!ns.fileTypes.length) ns.fileTypes = NSFW_DEFAULTS.fileTypes.slice();

                // AI subsystem (semantic search + auto-tag + face clustering).
                // All values are config-driven — same posture as NSFW. Master
                // switch defaults OFF; sub-feature toggles default ON so once
                // an operator flips master to true they get all three out of
                // the box.
                const ai = merged.ai;
                ai.enabled = ai.enabled === true;
                ai.semanticSearch = ai.semanticSearch !== false;
                ai.autoTags = ai.autoTags !== false;
                ai.faceClustering = ai.faceClustering !== false;
                ai.model =
                    typeof ai.model === 'string' && ai.model.trim()
                        ? ai.model.trim()
                        : 'Xenova/clip-vit-base-patch32';
                // Per-capability overrides — string only, empty = inherit
                // from the master `model`. Trimmed; never auto-filled so the
                // UI can render an empty field as "inherit".
                for (const k of ['searchModel', 'tagsModel', 'facesModel']) {
                    ai[k] = typeof ai[k] === 'string' ? ai[k].trim() : '';
                }
                const AI_DTYPES = new Set(['q8', 'fp16', 'fp32', 'q4']);
                const aiDIn = String(ai.dtype || '')
                    .toLowerCase()
                    .trim();
                ai.dtype = AI_DTYPES.has(aiDIn) ? aiDIn : 'q8';
                ai.indexConcurrency = clampInt(ai.indexConcurrency, 1, 4, 1);
                ai.batchSize = clampInt(ai.batchSize, 1, 200, 16);
                ai.maxTagsPerImage = clampInt(ai.maxTagsPerImage, 1, 20, 5);
                // tagsMode allow-list — anything off-list snaps back to 'auto'.
                const TAGS_MODES = new Set(['auto', 'zero-shot', 'classifier']);
                ai.tagsMode = TAGS_MODES.has(String(ai.tagsMode || '').toLowerCase())
                    ? String(ai.tagsMode).toLowerCase()
                    : 'auto';
                // Float clamps via integer round-trip so the same helper applies.
                ai.minTagScore =
                    clampInt(Math.round((Number(ai.minTagScore) || 0.2) * 1000), 0, 1000, 200) /
                    1000;
                ai.facesEpsilon =
                    clampInt(Math.round((Number(ai.facesEpsilon) || 0.5) * 1000), 100, 1500, 500) /
                    1000;
                ai.facesMinPoints = clampInt(ai.facesMinPoints, 2, 50, 3);
                const AI_FILE_TYPES = ['photo'];
                ai.fileTypes = (Array.isArray(ai.fileTypes) ? ai.fileTypes : ['photo'])
                    .map((s) => String(s).toLowerCase())
                    .filter((s) => AI_FILE_TYPES.includes(s));
                if (!ai.fileTypes.length) ai.fileTypes = ['photo'];
                // Tag labels — strip non-strings + dedup. Cap at 200 so a
                // pasted thesaurus can't blow up tokenizer batch size.
                ai.tagLabels = (Array.isArray(ai.tagLabels) ? ai.tagLabels : [])
                    .map((s) => String(s).trim())
                    .filter(Boolean);
                ai.tagLabels = [...new Set(ai.tagLabels)].slice(0, 200);
                if (!ai.tagLabels.length) {
                    // Fall back to the default list if the operator wiped it
                    // — saving an empty list would otherwise silently disable
                    // tagging until they edited config again.
                    ai.tagLabels = [
                        'portrait',
                        'landscape',
                        'group_photo',
                        'selfie',
                        'food',
                        'document',
                        'screenshot',
                        'meme',
                        'logo',
                        'indoor',
                        'outdoor',
                        'animal',
                        'pet',
                        'vehicle',
                        'building',
                        'art',
                        'text',
                    ];
                }
                // hfToken — string only; trim. Empty string = no token, which
                // is the recommended default (every model is public).
                ai.hfToken = typeof ai.hfToken === 'string' ? ai.hfToken.trim().slice(0, 200) : '';
                // federateFaces — explicit opt-in only (biometric data).
                ai.federateFaces = ai.federateFaces === true;
                // facesDetector allow-list — 'tiny' (default) or 'ssd'.
                const FACE_DETECTORS = new Set(['tiny', 'ssd']);
                ai.facesDetector = FACE_DETECTORS.has(String(ai.facesDetector || '').toLowerCase())
                    ? String(ai.facesDetector).toLowerCase()
                    : 'tiny';
                // autoScan state machine — allow-list keeps the timer logic
                // simple. Old boolean values get migrated:
                //   true  → 'running'
                //   false → 'idle'
                const AUTO_SCAN_STATES = new Set(['idle', 'running', 'paused']);
                const rawAutoScan =
                    ai.autoScan === true
                        ? 'running'
                        : ai.autoScan === false
                          ? 'idle'
                          : String(ai.autoScan || 'idle').toLowerCase();
                ai.autoScan = AUTO_SCAN_STATES.has(rawAutoScan) ? rawAutoScan : 'idle';
                ai.autoScanIntervalMs = clampInt(ai.autoScanIntervalMs, 5_000, 3_600_000, 60_000);
                ai.autoScanBatchSize = clampInt(ai.autoScanBatchSize, 1, 200, 10);
                ai.autoScanQueueCeiling = clampInt(ai.autoScanQueueCeiling, 1, 200, 50);

                const r = merged.diskRotator;
                r.sweepBatch = clampInt(r.sweepBatch, 1, 1000, 50);
                r.maxDeletesPerSweep = clampInt(r.maxDeletesPerSweep, 1, 100000, 5000);

                const it = merged.integrity;
                it.intervalMin = clampInt(it.intervalMin, 1, 10080, 60);
                it.batchSize = clampInt(it.batchSize, 1, 1024, 64);

                const w = merged.web;
                w.sessionTtlDays = clampInt(w.sessionTtlDays, 1, 365, 7);

                // Seekbar sprite-sheet generator. Every knob clamps to a safe
                // range so a hand-edited config can't OOM the Go sidecar
                // (maxTiles=10000) or DoS ffmpeg (concurrency=64). format +
                // hwaccel are allow-lists; everything off-list snaps back to
                // the documented default. Empty string for hwaccel = inherit
                // from advanced.thumbs.hwaccel (resolved inside core/seekbar/
                // generator.js so the SPA doesn't need to know).
                const sk = merged.seekbar;
                // Master + auto switches — boolean coercion mirrors the AI /
                // NSFW pattern. Default ON because the feature ships dark by
                // default at the sidecar level (binary needs to download).
                sk.enabled = sk.enabled !== false;
                sk.autoOnDownload = sk.autoOnDownload !== false;
                sk.intervalSec = clampInt(sk.intervalSec, 1, 60, 4);
                sk.tileWidth = clampInt(sk.tileWidth, 64, 480, 160);
                sk.columns = clampInt(sk.columns, 2, 30, 10);
                sk.maxTiles = clampInt(sk.maxTiles, 12, 1000, 240);
                sk.quality = clampInt(sk.quality, 10, 100, 75);
                sk.concurrency = clampInt(sk.concurrency, 1, 16, 4);
                sk.maxRetries = clampInt(sk.maxRetries, 0, 10, 3);
                const SEEKBAR_FORMATS = new Set(['webp', 'jpeg']);
                const fmtIn = String(sk.format || '')
                    .toLowerCase()
                    .trim();
                sk.format = SEEKBAR_FORMATS.has(fmtIn) ? fmtIn : 'webp';
                const SEEKBAR_OVERWRITE = new Set(['never', 'if-changed', 'always']);
                const owIn = String(sk.overwrite || '')
                    .toLowerCase()
                    .trim();
                sk.overwrite = SEEKBAR_OVERWRITE.has(owIn) ? owIn : 'if-changed';
                // Same allow-list as `advanced.thumbs.hwaccel` plus the
                // platform-extra backends the Go sidecar supports. `''` means
                // "inherit from thumbs"; `'none'` is an explicit CPU-only
                // override that the generator forwards as no `-hwaccel` flag.
                const SEEKBAR_HWACCEL = new Set([
                    '',
                    'auto',
                    'none',
                    'cuda',
                    'vaapi',
                    'qsv',
                    'd3d11va',
                    'dxva2',
                    'videotoolbox',
                    'v4l2m2m',
                ]);
                const skHw = String(sk.hwaccel ?? '')
                    .toLowerCase()
                    .trim();
                sk.hwaccel = SEEKBAR_HWACCEL.has(skHw) ? skHw || null : null;
                // sidecarUrl / apiToken — string only, trimmed; empty = use
                // the auto-spawned local binary. We never leak the token
                // back in GET /api/config (`_sanitizeConfigForRead` redacts
                // it alongside the dashboard passwordHash).
                sk.sidecarUrl = typeof sk.sidecarUrl === 'string' ? sk.sidecarUrl.trim() : '';
                sk.apiToken =
                    typeof sk.apiToken === 'string' ? sk.apiToken.trim().slice(0, 256) : '';

                newConfig.advanced = merged;
            }

            // Range / type sanity for the most-abused fields
            const dl = newConfig.download || {};
            if (dl.concurrent != null && (dl.concurrent < 1 || dl.concurrent > 50)) {
                return res.status(400).json({ error: 'download.concurrent must be 1-50' });
            }
            if (dl.retries != null && (dl.retries < 0 || dl.retries > 50)) {
                return res.status(400).json({ error: 'download.retries must be 0-50' });
            }
            if (newConfig.pollingInterval != null && newConfig.pollingInterval < 1) {
                return res.status(400).json({ error: 'pollingInterval must be >= 1 (seconds)' });
            }

            // Persist to kv['config'] via the same writer every other endpoint
            // uses. The legacy file-write here pre-dates the JSON→SQLite migration
            // and bypassed loadConfig()'s storage backend, so saves silently drifted
            // from the live row and got archived to config.json.migrated on the
            // next boot's state-migration sweep — the symptom users reported as
            // "settings don't save on Docker".
            await writeConfigAtomic(newConfig);
            // Re-apply runtime knobs that depend on advanced.share / advanced.history
            // so a save takes effect immediately without a process restart.
            try {
                applyShareLimits(newConfig.advanced?.share || {});
                invalidateShareConfigCache();
            } catch {}

            // Reset the lazy AccountManager singleton if Telegram credentials
            // changed — a stale instance would still be wired to the old apiId.
            if (req.body.telegram && _accountManager) {
                try {
                    await _accountManager.disconnectAll();
                } catch {}
                _accountManager = null;
            }

            // Refresh the cached rate-limit config so the toggle / RPM change
            // takes effect immediately instead of waiting for the 30s sweep.
            if (req.body.web?.rateLimit) refreshRateLimitConfig();

            // Restart the disk rotator if the user changed any diskManagement
            // field — picks up the new cap / enabled / interval on the very next
            // sweep instead of waiting for whatever was already scheduled.
            if (req.body.diskManagement || req.body.advanced?.diskRotator) {
                try {
                    getDiskRotator()?.restart();
                } catch (e) {
                    console.warn('[disk-rotator] restart failed:', e.message);
                }
            }
            // Same story for the rescue sweeper — sweep cadence (and the global
            // enabled flag, since per-group 'auto' follows it) needs to take
            // effect immediately, not on the next scheduled tick.
            if (req.body.rescue) {
                try {
                    getRescueSweeper()?.restart();
                } catch (e) {
                    console.warn('[rescue] restart failed:', e.message);
                }
            }
            // Re-arm the integrity sweeper when its cadence/batch changes so the
            // user doesn't have to wait a full hour for the new interval to kick
            // in. Reads the merged config (newConfig) for the latest values.
            if (req.body.advanced?.integrity) {
                try {
                    const cfg = newConfig?.advanced?.integrity || {};
                    integrity.start({
                        broadcast,
                        intervalMin: Number(cfg.intervalMin) > 0 ? Number(cfg.intervalMin) : 60,
                        batchSize: Number(cfg.batchSize) > 0 ? Number(cfg.batchSize) : 64,
                    });
                } catch (e) {
                    console.warn('[integrity] restart failed:', e.message);
                }
            }

            // Seekbar sidecar — runtime knobs (concurrency, hwaccel, format,
            // tileWidth, etc.) are forwarded as env vars when the Go process
            // spawns. So when an operator tweaks those on the Maintenance →
            // Seekbar page, we need to relaunch the sidecar so the new values
            // take effect — otherwise the next sprite would be generated with
            // the *previous* boot's env. URL / token changes also need a fresh
            // connect because client.js caches them at module scope.
            // Fire-and-forget: the dashboard pill flips through `stopped` →
            // `starting` → `running` as the sidecar comes back up; the GET
            // /api/maintenance/seekbar/health endpoint surfaces the live mode
            // either way.
            if (req.body.advanced?.seekbar) {
                try {
                    refreshSeekbarSidecar().catch((e) =>
                        console.warn(
                            '[seekbar-sidecar] config-change refresh failed:',
                            e?.message || e,
                        ),
                    );
                } catch (e) {
                    console.warn('[seekbar-sidecar] config-change refresh threw:', e?.message || e);
                }
                // Broadcast so any open `/maintenance/seekbar` page can
                // refresh its System Health card + KPI strip without waiting
                // for the operator to click Refresh.
                try {
                    broadcast({ type: 'seekbar_config_changed' });
                } catch {}
            }

            // Invalidate the dialogs response cache so the next /api/dialogs hit
            // rebuilds `inConfig` from the freshly-saved config. Without this,
            // adding a group via POST /api/config keeps showing the dialog as
            // "not in config" (and absent from the Monitored Only tab) for up
            // to DIALOG_CACHE_TTL_MS — the operator sees their group on the
            // sidebar but not in the picker filter.
            invalidateDialogsCache();
            broadcast({ type: 'config_updated' });
            res.json({ success: true });
        } catch (error) {
            console.error('POST /api/config:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    return router;
}
