import express from 'express';
import { loadConfig, watchConfig } from '../../config/manager.js';
import { getDb } from '../../core/db.js';
import {
    startFacesScan as aiStartFacesScan,
    cancelScan as aiCancelScan,
    isScanRunning as aiIsScanRunning,
    getScanState as aiGetScanState,
    _bgQueueDepths as aiBgQueueDepths,
} from '../../core/ai/index.js';
import { startTagsScan as aiStartTagsScan } from '../../core/ai/scan-runner.js';
import {
    getAiCounts,
    listPeople,
    listPhotosForPerson,
    renamePerson,
    deletePerson,
    resetAllAiData,
    getUnindexedAiBatch,
} from '../../core/db/faces.js';
import { pregenerateAi as aiPregenerateAi } from '../../core/ai/index.js';

export function createAiRouter({ broadcast, log, jobTrackers }) {
    const router = express.Router();

    // Provide jobTrackers-compatible access via the injected jobTrackers dep.
    function _aiTrackerFor(feature) {
        if (feature === 'faces') return jobTrackers.aiPeople;
        if (feature === 'tags') return jobTrackers.aiTags;
        return null;
    }

    function _aiStarterFor(feature) {
        if (feature === 'faces') return aiStartFacesScan;
        if (feature === 'tags') return aiStartTagsScan;
        return null;
    }

    // ====== AI subsystem (semantic search + auto-tag + face clustering) =========
    //
    // Three independent scans share one page (Maintenance → AI). Each is
    // admin-only by virtue of the global mutation gate, opt-in via
    // `config.advanced.ai.{enabled,semanticSearch,autoTags,faceClustering}`.
    // Patterns mirror the NSFW route group:
    //   - status returns the kv flags + scan states + counts in one round trip
    //   - scan/start uses the same JobTracker `tryStart` contract
    //   - search endpoints are reads against `image_embeddings` (in-memory cosine)
    //   - tags + people endpoints are list/paginate against the persisted rows
    //
    // Bug-class avoidance:
    //   - Every read goes through paginated DB helpers (LIMIT/OFFSET) so
    //     CLAUDE.md → Big-data rule 1 stays honoured.
    //   - All 503s carry `code` so the client can render targeted help.
    function _aiCfg() {
        try {
            const live = loadConfig();
            return live?.advanced?.ai || {};
        } catch {
            return {};
        }
    }

    // ---- AI status -----------------------------------------------------------
    //
    // Faces-only build — the prior `/api/ai/status` payload exposed embed +
    // tag pipeline state, vec extension probe, model preset metadata, etc.
    // All of that's gone with the Search/Tags removal; this is the minimum
    // the AI maintenance page actually reads now.

    // 5 s in-memory cache for the live `/info` probe. The dashboard polls
    // /api/ai/status every few seconds; without the cache we'd hit the
    // sidecar each time + spike when many tabs are open.
    const _SIDECAR_INFO_CACHE = { url: null, ts: 0, data: null };
    const _SIDECAR_INFO_TTL_MS = 5000;
    async function _fetchSidecarInfo(url) {
        const now = Date.now();
        if (
            _SIDECAR_INFO_CACHE.url === url &&
            now - _SIDECAR_INFO_CACHE.ts < _SIDECAR_INFO_TTL_MS &&
            _SIDECAR_INFO_CACHE.data
        ) {
            return _SIDECAR_INFO_CACHE.data;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/info`, {
                signal: controller.signal,
            });
            if (!res.ok) return null;
            const data = await res.json();
            _SIDECAR_INFO_CACHE.url = url;
            _SIDECAR_INFO_CACHE.ts = now;
            _SIDECAR_INFO_CACHE.data = data;
            return data;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    router.get('/ai/status', async (_req, res) => {
        try {
            const cfg = _aiCfg();
            const counts = (() => {
                try {
                    return getAiCounts({ fileTypes: cfg.fileTypes || ['photo'] });
                } catch {
                    return { totalEligible: 0, indexed: 0, withFaces: 0 };
                }
            })();
            // Surface the nested `faces` block too so the AI maintenance
            // page can hydrate the provider dropdown without a second
            // /api/config call. Keeping the flat `facesEpsilon` / etc.
            // siblings preserves backward compat with any in-flight code
            // that still reads the legacy shape.
            const facesBlock = cfg.faces && typeof cfg.faces === 'object' ? cfg.faces : {};
            res.json({
                success: true,
                config: {
                    enabled: cfg.enabled === true,
                    faceClustering: cfg.faceClustering !== false,
                    federateFaces: cfg.federateFaces === true,
                    fileTypes: cfg.fileTypes || ['photo'],
                    facesEpsilon: Number.isFinite(cfg.facesEpsilon) ? cfg.facesEpsilon : 0.5,
                    facesMinPoints: Number.isFinite(cfg.facesMinPoints) ? cfg.facesMinPoints : 3,
                    facesDetector: cfg.facesDetector || 'tiny',
                    facesDetectorModel: String(
                        facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                    ),
                    faces: {
                        providers: String(facesBlock.providers || 'auto').toLowerCase(),
                        detectorModel: String(
                            facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                        ),
                        includeVideos: facesBlock.includeVideos === true,
                        videoFrameIntervalSec: Number(facesBlock.videoFrameIntervalSec || 8),
                        videoMaxFrames: Number(facesBlock.videoMaxFrames || 24),
                    },
                },
                counts,
                scans: {
                    faces: aiGetScanState('faces'),
                    tags: aiGetScanState('tags'),
                },
                models: {
                    faces: await (async () => {
                        // Surface the operator-chosen insightface preset
                        // (buffalo_l / antelopev2 / buffalo_m / buffalo_s /
                        // buffalo_sc) in the human-readable id. The legacy
                        // `cfg.facesModel` free-text override still wins
                        // when set (advanced operator path); otherwise use
                        // the dropdown-saved `facesDetectorModel`.
                        const preset = String(
                            facesBlock.detectorModel || cfg.facesDetectorModel || 'buffalo_l',
                        );
                        const id =
                            (cfg.facesModel || '').trim() ||
                            `insightface ${preset} (Python sidecar)`;
                        // Live provider list — probe the running sidecar's
                        // `/info` so the dashboard's "GPU acceleration"
                        // chip reflects the actually-loaded EP, not the
                        // saved hint. The probe is best-effort: a 2 s
                        // timeout caps the worst case so a dead sidecar
                        // doesn't slow the status page down. Result is
                        // cached for 5 s so the page can poll without
                        // hammering the sidecar.
                        let providers = null;
                        try {
                            const facesSpawn = await import('../../core/ai/faces-spawn.js');
                            const sidecarUrl = facesSpawn.getSidecarStatus()?.url;
                            if (sidecarUrl) {
                                const info = await _fetchSidecarInfo(sidecarUrl);
                                if (info?.providers) providers = info.providers;
                            }
                        } catch {
                            /* sidecar offline / fetch failed — fall through */
                        }
                        return {
                            id,
                            preset,
                            dim: 512,
                            dtype: 'fp32',
                            source: cfg.facesModel ? 'override' : 'bundled',
                            enabled: cfg.faceClustering !== false,
                            loaded: !cfg.facesModel,
                            bundled: !cfg.facesModel,
                            providers,
                            providersRequested: String(facesBlock.providers || 'auto'),
                        };
                    })(),
                    tags: await (async () => {
                        const enabled = cfg.imageTagging === true;
                        let loaded = false;
                        let vocabularySize = 0;
                        let modelId = '';
                        try {
                            const facesClient = await import('../../core/ai/faces-client.js');
                            const url = facesClient.getSidecarUrl();
                            if (url) {
                                const info = await _fetchSidecarInfo(url);
                                if (info) {
                                    loaded = info.clip_ready === true;
                                    vocabularySize = info.clip_vocabulary_size || 0;
                                    modelId = info.clip_model || '';
                                }
                            }
                        } catch {
                            /* probe failed — leave defaults */
                        }
                        return {
                            id: modelId || 'Xenova/clip-vit-base-patch32',
                            dim: 512,
                            dtype: 'fp32',
                            enabled,
                            loaded,
                            vocabularySize,
                        };
                    })(),
                },
                bgQueue: (() => {
                    try {
                        return aiBgQueueDepths();
                    } catch {
                        return { realtime: 0, backfill: 0 };
                    }
                })(),
                trackers: {
                    aiPeople: jobTrackers.aiPeople.getStatus(),
                    aiTags: jobTrackers.aiTags.getStatus(),
                },
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- Tag browsing ---------------------------------------------------------

    router.get('/ai/tags/list', async (req, res) => {
        try {
            const { listAllTags } = await import('../../core/db/faces.js');
            const tags = listAllTags({ minCount: 1 });
            res.json({ success: true, tags });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/tags/photos', async (req, res) => {
        try {
            const tag = String(req.query.tag || '').trim();
            if (!tag) return res.status(400).json({ error: 'tag query param required' });
            const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const { listPhotosForTag } = await import('../../core/db/faces.js');
            const result = listPhotosForTag(tag, { limit, offset });
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/tags/suggestions', async (req, res) => {
        try {
            const minRate = Math.max(0, Math.min(1, Number(req.query.minRate) || 0.6));
            const minImages = Math.max(1, Number(req.query.minImages) || 2);
            const { getTagCooccurrenceSuggestions } = await import('../../core/db/faces.js');
            const suggestions = getTagCooccurrenceSuggestions({
                minCooccurrenceRate: minRate,
                minImagesPerTag: minImages,
            });
            res.json({ success: true, suggestions });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- Scan controls -------------------------------------------------------
    //
    // Faces is the only feature left; the legacy `feature: 'embed' | 'tags'`
    // branches have been removed. The handler still accepts a `feature`
    // field so older clients fail with a clear `unknown feature` error
    // rather than a silent no-op.
    const AI_SCAN_FEATURES = new Set(['faces', 'tags']);

    // JobTracker integration for AI scans:
    //   The scan-runner module already owns the per-feature state machine
    //   (running/scanned/total/abort) and broadcasts its own WS events; the
    //   tracker is wired in via a one-shot tryStart so re-mounted pages can
    //   recover via `jobTrackers.aiX.getStatus()` and so the "ai_index_done"
    //   WS event still fires through the tracker's standard finish hook. The
    //   inner runFn returns a Promise that resolves on the scan-runner's
    //   onDone callback so tracker.success/failure semantics line up with
    //   the actual work.
    router.post('/ai/scan/start', async (req, res) => {
        try {
            const cfg = _aiCfg();
            if (cfg.enabled !== true) {
                return res.status(503).json({
                    error: 'AI subsystem disabled — enable it in Maintenance → AI first.',
                    code: 'AI_DISABLED',
                });
            }
            const feature = String(req.body?.feature || '').toLowerCase();
            if (!AI_SCAN_FEATURES.has(feature)) {
                return res.status(400).json({ error: 'feature must be embed|tags|faces' });
            }
            if (aiIsScanRunning(feature)) {
                return res
                    .status(409)
                    .json({ error: 'Scan already running', code: 'ALREADY_RUNNING' });
            }
            const tracker = _aiTrackerFor(feature);
            const starter = _aiStarterFor(feature);
            const claim = tracker.tryStart(({ onProgress, signal }) => {
                return new Promise((resolve, reject) => {
                    // Forward the runner's signal abort -> our internal
                    // cancelScan, so /api/ai/scan/cancel and the tracker's
                    // own abort path both terminate the same scan.
                    if (signal && typeof signal.addEventListener === 'function') {
                        signal.addEventListener('abort', () => {
                            try {
                                aiCancelScan(feature);
                            } catch {}
                        });
                    }
                    starter(
                        cfg,
                        (p) => {
                            // tracker.onProgress already _safeBroadcasts
                            // `${prefix}_progress` with the merged status — a
                            // second broadcast here would double every event
                            // on the wire. Keep tracker as the single source.
                            try {
                                onProgress(p);
                            } catch {}
                        },
                        (p) => {
                            // tracker auto-broadcasts `${prefix}_done` on
                            // resolve/reject — surface scan errors back into
                            // the tracker promise so it logs + finishes once.
                            if (p?.error) reject(new Error(p.error));
                            else resolve(p || {});
                        },
                        (entry) => log(entry),
                    );
                });
            });
            if (!claim.started) {
                return res.status(409).json({ error: 'Tracker busy', code: claim.code });
            }
            log({ source: 'ai', level: 'info', msg: `${feature} scan starting` });
            res.json({ success: true, started: true });
        } catch (e) {
            log({ source: 'ai', level: 'error', msg: `scan/start failed: ${e?.message || e}` });
            const status =
                e.code === 'AI_LIB_MISSING' || e.code === 'FACES_LIB_MISSING' ? 503 : 500;
            res.status(status).json({ error: e.message, code: e.code || 'UNKNOWN' });
        }
    });

    router.post('/ai/scan/cancel', async (req, res) => {
        const feature = String(req.body?.feature || '').toLowerCase();
        if (!AI_SCAN_FEATURES.has(feature)) {
            return res.status(400).json({ error: 'feature must be embed|tags|faces' });
        }
        const ok = aiCancelScan(feature);
        res.json({ success: true, cancelled: ok });
    });

    router.get('/ai/scan/status', async (req, res) => {
        const feature = String(req.query?.feature || '').toLowerCase();
        if (!AI_SCAN_FEATURES.has(feature)) {
            return res.status(400).json({ error: 'feature must be embed|tags|faces' });
        }
        res.json({ success: true, state: aiGetScanState(feature) });
    });

    // ---- Provider probe (face sidecar onnxruntime backends) -----------------
    //
    // Mirrors the ffmpeg `hwaccel-probe` endpoint pattern used by the Build
    // thumbnails page. Proxies to the Python sidecar's `/providers` route
    // which spins up a tiny onnxruntime session against each candidate
    // provider — only backends that genuinely allocate a session end up in
    // `available`. Surfaces a clear 503 when the sidecar isn't running.
    router.get('/ai/faces/provider-probe', async (_req, res) => {
        try {
            const facesClient = await import('../../core/ai/faces-client.js');
            const url = facesClient.getSidecarUrl();
            if (!url) {
                return res
                    .status(503)
                    .json({ error: 'Face sidecar not running', code: 'SIDECAR_OFFLINE' });
            }
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 10_000);
            let r;
            try {
                r = await globalThis.fetch(`${url}/providers`, { signal: ctrl.signal });
            } finally {
                clearTimeout(t);
            }
            if (!r.ok) {
                return res
                    .status(r.status)
                    .json({ error: `Sidecar returned HTTP ${r.status}`, code: 'SIDECAR_ERROR' });
            }
            const body = await r.json();
            res.json(body);
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Restart the sidecar so a config change (e.g. provider switch) takes
    // effect without an app restart. The spawn module's stopSidecar() sends
    // SIGTERM with a SIGKILL fallback after KILL_GRACE_MS; startSidecar()
    // then re-reads `loadConfig()` + env so the new provider is picked up.
    router.post('/ai/faces/restart', async (_req, res) => {
        try {
            const spawn = await import('../../core/ai/faces-spawn.js');
            spawn.stopSidecar();
            // Fire-and-forget — startSidecar() is idempotent and never
            // throws (errors surface via `getSidecarStatus()` + WS).
            spawn.startSidecar().catch(() => {});
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Auto-detect-platform installer for the Python sidecar. Runs
    // `python -m tgdl_faces.install`, which picks the right onnxruntime EP
    // (DirectML on Windows, CUDA on Linux+NVIDIA, OpenVINO on Linux+Intel,
    // CoreML/CPU elsewhere) and pip-installs it. Progress streams over WS
    // as `ai_faces_install_progress` / `ai_faces_install_done`. Body accepts
    // optional `{force: 'cpu'|'gpu'|'directml'|'openvino'}` for operators
    // who want to override detection. Single-flight inside faces-spawn.
    router.post('/ai/faces/install-deps', async (req, res) => {
        try {
            const spawnMod = await import('../../core/ai/faces-spawn.js');
            const force = typeof req.body?.force === 'string' ? req.body.force : undefined;
            spawnMod.resetAutoInstallGuard();
            // Fire-and-forget — pip can take 1-5 min on first run while
            // downloading onnxruntime wheels. Progress flows over WS.
            spawnMod
                .installPythonDeps({ force })
                .then((r) => {
                    if (r.ok) {
                        try {
                            spawnMod.stopSidecar();
                        } catch {}
                        try {
                            spawnMod.startSidecar().catch(() => {});
                        } catch {}
                    }
                })
                .catch(() => {});
            res.json({ started: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // Full reindex — clears every face detection + every cluster, then
    // flips every photo's `ai_indexed_at` back to NULL so the next scan
    // re-detects from scratch. Use when:
    //   - switching `facesDetectorModel` (embedding space changes)
    //   - a previous run produced obviously-wrong clusters (bad threshold)
    //   - the operator wants a clean slate
    //
    // This is DESTRUCTIVE — the People grid wipes immediately and the
    // next scan re-builds it. Caller MUST gate this behind a confirm
    // sheet UI-side. The Node side enforces a single-flight guard against
    // any scan that's currently running.
    // Phase B only — re-cluster existing face embeddings without
    // re-detecting. Lets the operator tweak ε / minPoints and see the new
    // People grid in seconds (vs minutes for a full re-scan). Implemented
    // by triggering the standard faces scan-runner; Phase A is a no-op when
    // every photo carries `ai_indexed_at IS NOT NULL`, so for fully-indexed
    // libraries this lands in Phase B immediately. For partially-indexed
    // libraries (a scan was cancelled mid-way), Phase A picks up where it
    // left off — same as clicking "Scan now".
    router.post('/ai/faces/recluster', async (_req, res) => {
        try {
            if (aiIsScanRunning && aiIsScanRunning('faces')) {
                return res.status(409).json({
                    error: 'scan_running',
                    message: 'A face scan is already in progress.',
                });
            }
            try {
                if (aiStartFacesScan) aiStartFacesScan().catch(() => {});
            } catch {}
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    router.post('/ai/faces/reindex', async (_req, res) => {
        try {
            if (aiIsScanRunning && aiIsScanRunning('faces')) {
                return res.status(409).json({
                    error: 'scan_running',
                    message: 'A face scan is already in progress. Cancel it before reindexing.',
                });
            }
            const cfg = _aiCfg();
            const types = cfg.fileTypes || ['photo'];
            const placeholders = types.map(() => '?').join(',');
            const db = getDb();
            const tx = db.transaction(() => {
                db.prepare(`DELETE FROM faces`).run();
                db.prepare(`DELETE FROM people`).run();
                db.prepare(
                    `UPDATE downloads SET ai_indexed_at = NULL WHERE file_type IN (${placeholders})`,
                ).run(...types);
            });
            tx();
            broadcast({ type: 'ai_faces_reindexed', ts: Date.now() });
            // Kick off the scan immediately so the operator sees progress
            // right away. Fire-and-forget — the scan owns its own state
            // machine + WS events.
            try {
                if (aiStartFacesScan) aiStartFacesScan().catch(() => {});
            } catch {}
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e?.message || String(e) });
        }
    });

    // ---- People (face clusters) ---------------------------------------------

    router.get('/ai/people', async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 100));
            const offset = Math.max(0, Number(req.query?.offset) || 0);
            const scope = String(req.query?.scope || 'local').toLowerCase();
            const local = listPeople({ limit, offset });
            if (scope !== 'federated') {
                return res.json({ success: true, scope: 'local', ...local });
            }
            // Federated — list local clusters first, then peer summaries
            // tagged with the owning peer id. The UI's cover thumbnail is
            // resolved via the peer-aware /api/thumbs/* path.
            let peerErrors = 0;
            try {
                const { listPeers } = await import('../../core/cluster/peers.js');
                const { relayTo } = await import('../../core/cluster/relay.js');
                const peers = listPeers();
                const peerLists = await Promise.all(
                    peers.map(async (p) => {
                        try {
                            const r = await relayTo({
                                targetPeerId: p.peerId,
                                method: 'GET',
                                path: `/api/ai/people?limit=${limit}`,
                            });
                            if (!r.ok) return [];
                            const json = await r.json();
                            const rows = Array.isArray(json?.people) ? json.people : [];
                            return rows.map((row) => ({
                                ...row,
                                _peerId: p.peerId,
                                _peerName: p.name || p.peerId,
                            }));
                        } catch {
                            peerErrors += 1;
                            return [];
                        }
                    }),
                );
                const merged = [
                    ...(local.people || []).map((row) => ({ ...row, _peerId: 'local' })),
                    ...peerLists.flat(),
                ];
                return res.json({
                    success: true,
                    scope: 'federated',
                    people: merged,
                    total: merged.length,
                    peerErrors,
                });
            } catch (e) {
                return res.json({ success: true, scope: 'local', ...local });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Faces detected on a single download — used by the viewer's overlay
    // to draw face boxes over the image. Cheap (single indexed SELECT)
    // + small payload (tens of rows max per photo).
    router.get('/ai/faces/by-download/:id', async (req, res) => {
        try {
            const downloadId = Number(req.params.id);
            if (!Number.isFinite(downloadId) || downloadId <= 0) {
                return res.status(400).json({ error: 'invalid download id' });
            }
            const rows = getDb()
                .prepare(`
                SELECT f.id, f.x, f.y, f.w, f.h, f.person_id, f.quality_score,
                       p.label AS person_label
                  FROM faces f
                  LEFT JOIN people p ON p.id = f.person_id
                 WHERE f.download_id = ?
                 ORDER BY f.id ASC
            `)
                .all(downloadId);
            res.json({ success: true, downloadId, faces: rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/group-by-person', async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
            const rows = getDb()
                .prepare(`
                SELECT p.id, p.label, p.face_count,
                       (SELECT f.download_id FROM faces f WHERE f.person_id = p.id LIMIT 1) AS cover_download_id
                  FROM people p
                 ORDER BY p.face_count DESC, p.id ASC
                 LIMIT ?
            `)
                .all(limit);
            res.json({ success: true, groups: rows });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/ai/people/:id/photos', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid person id' });
            }
            const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
            const offset = Math.max(0, Number(req.query?.offset) || 0);
            const result = listPhotosForPerson(id, { limit, offset });
            res.json({ success: true, personId: id, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.patch('/ai/people/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid person id' });
            }
            const label = String(req.body?.label || '')
                .trim()
                .slice(0, 100);
            const changes = renamePerson(id, label || null);
            if (!changes) return res.status(404).json({ error: 'person not found' });
            res.json({ success: true, id, label });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Merge person `otherId` INTO `id`. Every face previously labelled
    // `otherId` now belongs to `id`; the empty cluster is deleted. The
    // preserved cluster keeps its label. Used by the UI when two clusters
    // turn out to be the same person.
    router.post('/ai/people/:id/merge', async (req, res) => {
        try {
            const id = Number(req.params.id);
            const otherId = Number(req.body?.otherId);
            if (!Number.isFinite(id) || !Number.isFinite(otherId) || id === otherId) {
                return res.status(400).json({ error: 'id + otherId required and must differ' });
            }
            const { mergeFacePerson } = await import('../../core/db.js');
            const r = mergeFacePerson(id, otherId);
            log({
                source: 'ai',
                level: 'info',
                msg: `people/merge: target=${id} other=${otherId} moved=${r.moved} deleted=${r.deleted}`,
            });
            res.json({ success: true, target: id, other: otherId, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Pull selected faces out of their current cluster(s) and create a
    // fresh cluster from them. Used when DBSCAN over-merged two similar
    // people — operator picks the faces that look wrong, calls split,
    // gets a new cluster they can rename.
    router.post('/ai/people/:id/split', async (req, res) => {
        try {
            const faceIds = Array.isArray(req.body?.faceIds) ? req.body.faceIds : [];
            const label =
                String(req.body?.label || '')
                    .trim()
                    .slice(0, 100) || null;
            if (!faceIds.length) {
                return res.status(400).json({ error: 'faceIds required (non-empty array)' });
            }
            const { splitFacePerson } = await import('../../core/db.js');
            const r = splitFacePerson(faceIds, label);
            if (!r.personId) {
                return res.status(404).json({ error: 'no faces matched the supplied ids' });
            }
            log({
                source: 'ai',
                level: 'info',
                msg: `people/split: new personId=${r.personId} moved=${r.moved} label=${label || '(unlabelled)'}`,
            });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Move a single face to a different cluster (or to `null` = unassigned).
    // Used for "this one face was put in the wrong cluster" repair.
    router.post('/ai/faces/:id/reassign', async (req, res) => {
        try {
            const faceId = Number(req.params.id);
            if (!Number.isFinite(faceId) || faceId <= 0) {
                return res.status(400).json({ error: 'invalid face id' });
            }
            const target =
                req.body?.personId == null || req.body.personId === ''
                    ? null
                    : Number(req.body.personId);
            if (target != null && !Number.isFinite(target)) {
                return res.status(400).json({ error: 'invalid personId' });
            }
            const { reassignFace } = await import('../../core/db.js');
            const r = reassignFace(faceId, target);
            if (!r.ok) return res.status(404).json({ error: 'face not found' });
            log({
                source: 'ai',
                level: 'info',
                msg: `faces/reassign: face=${faceId} from=${r.oldPersonId} to=${r.newPersonId}`,
            });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.delete('/ai/people/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isFinite(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid person id' });
            }
            const changes = deletePerson(id);
            if (!changes) return res.status(404).json({ error: 'person not found' });
            res.json({ success: true, id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Re-index — full reset. Drops every AI artefact (embeddings, tags,
    // faces, people) and clears `ai_indexed_at` on every download so the
    // next scan starts from scratch. Use after changing model/dtype/label
    // list when the partial-clear of `clearStaleEmbeddings` isn't enough
    // (e.g. label list shrunk and the operator wants stale tags gone too).
    //
    // Aborts every in-flight scan first to avoid the race where the loop
    // keeps re-stamping `ai_indexed_at` while we're trying to null it out.
    router.post('/ai/reindex', async (req, res) => {
        try {
            // Cancel any in-flight scan before nuking the artefacts.
            let cancelled = 0;
            for (const f of ['embed', 'tags', 'faces']) {
                if (aiCancelScan(f)) cancelled += 1;
            }
            // Settle one tick so the scan loops see the abort signal.
            if (cancelled) await new Promise((r) => setTimeout(r, 100));
            const r = resetAllAiData();
            log({
                source: 'ai',
                level: 'info',
                msg: `re-index — wiped embeddings=${r.embeddings} tags=${r.tags} faces=${r.faces} people=${r.people}; re-queued=${r.requeued}; cancelled-scans=${cancelled}`,
            });
            try {
                broadcast({ type: 'ai_reindex', ...r });
            } catch {}
            res.json({ success: true, cancelled, ...r });
        } catch (e) {
            log({ source: 'ai', level: 'error', msg: `re-index failed: ${e?.message || e}` });
            res.status(500).json({ error: e.message });
        }
    });

    // AI auto-scan drip timer — wakes every `autoScanIntervalMs`, checks
    // the live config + queue depth, then pushes up to `autoScanBatchSize`
    // un-indexed photos onto the backfill queue. The existing
    // `pregenerateAi` drain picks them up and runs them through the
    // embed/tag/face pipelines using the operator's current model + dtype
    // settings.
    //
    // Why drip + queue (not direct scan loop):
    //   - Queue path is shared with realtime downloads, so live monitor
    //     jobs always preempt drip work (realtime is `priority='realtime'`,
    //     drip is `'backfill'`).
    //   - Resume-safe: state lives in `cfg.autoScan`. A restart leaves the
    //     state untouched, the timer rearms on boot, and we resume from
    //     wherever `ai_indexed_at IS NULL` says we left off.
    //   - Cancel-safe: switching to 'paused' / 'idle' just makes the next
    //     tick a no-op. In-flight work in the existing queue finishes
    //     gracefully (operator stops new work, not the row currently
    //     being embedded).
    let _aiAutoScanTimer = null;
    let _aiAutoScanLastTickAt = 0;
    let _aiAutoScanLastEnqueued = 0;

    function _aiAutoScanTick() {
        try {
            const cfg = _aiCfg();
            if (cfg.enabled !== true) return;
            if (cfg.autoScan !== 'running') return;
            const ceiling = Math.max(1, Number(cfg.autoScanQueueCeiling) || 50);
            const batchSize = Math.max(1, Number(cfg.autoScanBatchSize) || 10);
            let depths;
            try {
                depths = aiBgQueueDepths();
            } catch {
                depths = { realtime: 0, backfill: 0 };
            }
            // Back off when the backfill queue is already saturated — the
            // drain reads from it FIFO, so dumping more in just grows the
            // in-memory list without speeding work up.
            if (depths.backfill >= ceiling) {
                _aiAutoScanLastTickAt = Date.now();
                _aiAutoScanLastEnqueued = 0;
                return;
            }
            // Realtime traffic gets priority — if there's live work
            // happening, skip the drip this tick so the user-visible path
            // finishes faster.
            if (depths.realtime > 0) {
                _aiAutoScanLastTickAt = Date.now();
                _aiAutoScanLastEnqueued = 0;
                return;
            }
            const fileTypes = cfg.fileTypes || ['photo'];
            const batch = getUnindexedAiBatch({ fileTypes, limit: batchSize });
            if (!batch.length) {
                _aiAutoScanLastTickAt = Date.now();
                _aiAutoScanLastEnqueued = 0;
                return;
            }
            for (const row of batch) {
                try {
                    aiPregenerateAi(row.id, { priority: 'backfill' });
                } catch {}
            }
            _aiAutoScanLastTickAt = Date.now();
            _aiAutoScanLastEnqueued = batch.length;
            log({
                source: 'ai-autoscan',
                level: 'info',
                msg: `tick: enqueued=${batch.length} backfillDepth=${depths.backfill} ceiling=${ceiling}`,
            });
        } catch (e) {
            log({
                source: 'ai-autoscan',
                level: 'warn',
                msg: `tick failed: ${e?.message || e}`,
            });
        }
    }

    function _aiAutoScanRearm() {
        try {
            if (_aiAutoScanTimer) {
                clearInterval(_aiAutoScanTimer);
                _aiAutoScanTimer = null;
            }
            const cfg = _aiCfg();
            if (cfg.enabled !== true) return;
            if (cfg.autoScan !== 'running') return;
            const ms = Math.max(
                5_000,
                Math.min(3_600_000, Number(cfg.autoScanIntervalMs) || 60_000),
            );
            _aiAutoScanTimer = setInterval(_aiAutoScanTick, ms);
            _aiAutoScanTimer.unref?.();
            // Kick once right away so the operator sees a tick land before
            // the first full interval elapses.
            setImmediate(_aiAutoScanTick);
            log({
                source: 'ai-autoscan',
                level: 'info',
                msg: `armed: interval=${ms}ms batchSize=${cfg.autoScanBatchSize ?? 10}`,
            });
        } catch (e) {
            log({
                source: 'ai-autoscan',
                level: 'warn',
                msg: `rearm failed: ${e?.message || e}`,
            });
        }
    }
    // Arm on boot — picks up the persisted state automatically. The
    // config-change subscriber below also rearms on every save.
    setImmediate(_aiAutoScanRearm);
    try {
        watchConfig(() => _aiAutoScanRearm());
    } catch {}

    // Start / Pause / Stop control — single endpoint, action enum so the
    // state machine stays explicit. Resume is just `action='start'` from
    // a paused state — the un-indexed cursor (ai_indexed_at IS NULL)
    // keeps the picks identical so progress persists.
    router.post('/ai/auto-scan', async (req, res) => {
        try {
            const action = String(req.body?.action || '').toLowerCase();
            const ACTIONS = { start: 'running', pause: 'paused', stop: 'idle' };
            const next = ACTIONS[action];
            if (!next) {
                return res.status(400).json({ error: 'action must be one of: start, pause, stop' });
            }
            const { loadConfig, saveConfig } = await import('../../config/manager.js');
            const live = loadConfig();
            const merged = {
                ...live,
                advanced: {
                    ...(live.advanced || {}),
                    ai: { ...(live.advanced?.ai || {}), autoScan: next },
                },
            };
            await saveConfig(merged);
            _aiAutoScanRearm();
            log({
                source: 'ai-autoscan',
                level: 'info',
                msg: `state: ${live.advanced?.ai?.autoScan || 'idle'} → ${next} (action=${action})`,
            });
            res.json({ success: true, state: next });
        } catch (e) {
            log({
                source: 'ai-autoscan',
                level: 'error',
                msg: `state change failed: ${e?.message || e}`,
            });
            res.status(500).json({ error: e.message });
        }
    });

    // AI health check / doctor strip — surfaces the Python face sidecar's
    // install + runtime surface (binary, interpreter, provider, model, index
    // progress). UI renders the response as a list of ✓/⚠/✗ rows so the
    // operator can spot a missing dep in one look. Each `check` has a stable
    // `id` so the UI can color-code without parsing the label string.
    //
    // Hardening rules (carried over from the v2.12.1 hardening pass):
    //   - Every probe wrapped in try/catch — one failing probe never
    //     fails the request.
    //   - Every setTimeout / spawn uses an integer literal — no NaN risk
    //     that could surface as `TimeoutNaNWarning` in the docker logs.
    //   - Every fetch / child spawn carries an AbortController or hard
    //     timeout so a wedged dep can't hang the request.

    // Doctor — sidecar-aligned probe set. Six rows that cover the actual
    // install surface (Python sidecar + onnxruntime backends + buffalo_l):
    //
    //   1. Python face sidecar reachability (auto-spawn lifecycle state).
    //   2. Host Python on PATH — informational, used by the fallback spawn
    //      path when the prebuilt binary is unavailable.
    //   3. Prebuilt sidecar binary on disk (auto-downloaded on first scan).
    //   4. Inference provider resolved by onnxruntime inside the sidecar.
    //   5. Model loaded (insightface buffalo_l).
    //   6. Photos indexed (kept — drives the operator's progress sense).
    //
    // Each probe is wrapped in try/catch — one failing probe never fails the
    // request. Every fetch / spawn carries a fixed-integer timeout so a
    // black-holed dep can't hang the request.
    router.get(['/ai/doctor', '/ai/health'], async (_req, res) => {
        const checks = [];

        // 1. Sidecar reachability — drives the headline OK/spawning/failed
        //    state. We surface the spawn module's lifecycle directly so the
        //    operator sees "downloading…" / "starting up…" instead of a bare
        //    fail row while the binary is being fetched in the background.
        try {
            const { getSidecarStatus } = await import('../../core/ai/faces-spawn.js');
            const st = getSidecarStatus();
            if (st.state === 'healthy') {
                checks.push({
                    id: 'sidecar',
                    label: 'Python face sidecar',
                    status: 'ok',
                    detail: `running at ${st.url}`,
                });
            } else if (st.state === 'downloading') {
                checks.push({
                    id: 'sidecar',
                    label: 'Python face sidecar',
                    status: 'info',
                    detail: 'downloading binary…',
                });
            } else if (st.state === 'spawning') {
                checks.push({
                    id: 'sidecar',
                    label: 'Python face sidecar',
                    status: 'info',
                    detail: 'starting up…',
                });
            } else if (st.state === 'failed') {
                checks.push({
                    id: 'sidecar',
                    label: 'Python face sidecar',
                    status: 'fail',
                    detail: st.error || 'failed to start',
                });
            } else {
                checks.push({
                    id: 'sidecar',
                    label: 'Python face sidecar',
                    status: 'info',
                    detail: 'disabled',
                });
            }
        } catch (e) {
            checks.push({
                id: 'sidecar',
                label: 'Python face sidecar',
                status: 'warn',
                detail: e?.message || 'probe failed',
            });
        }

        // 2. Host Python — informational. The auto-spawn flow prefers the
        //    PyInstaller binary; Python on the host is only consulted as a
        //    fallback when the prebuilt binary fails to launch. Never fails
        //    the card on absence — most installs run the prebuilt and never
        //    need a host interpreter.
        try {
            const { execFile } = await import('node:child_process');
            const bin = process.platform === 'win32' ? 'python' : 'python3';
            const out = await new Promise((resolve, reject) => {
                execFile(bin, ['--version'], { timeout: 2000 }, (err, stdout, stderr) => {
                    if (err) reject(err);
                    else resolve(String(stdout || stderr).trim());
                });
            });
            const m = out.match(/Python (\d+)\.(\d+)(?:\.(\d+))?/);
            const major = m ? Number(m[1]) : 0;
            const minor = m ? Number(m[2]) : 0;
            if (major >= 3 && minor >= 10) {
                checks.push({
                    id: 'python',
                    label: 'Host Python',
                    status: 'ok',
                    detail: `${out} (fallback path available)`,
                });
            } else if (major >= 3) {
                checks.push({
                    id: 'python',
                    label: 'Host Python',
                    status: 'warn',
                    detail: `${out} — sidecar prefers 3.10+`,
                });
            } else {
                checks.push({
                    id: 'python',
                    label: 'Host Python',
                    status: 'info',
                    detail: `${out} (using prebuilt binary)`,
                });
            }
        } catch {
            checks.push({
                id: 'python',
                label: 'Host Python',
                status: 'info',
                detail: 'no Python on PATH (using prebuilt binary)',
            });
        }

        // 3. Prebuilt sidecar binary on disk. Mirrors the path resolution
        //    used by faces-spawn.js so the doctor card reports the same
        //    location the spawn flow actually writes to (including
        //    TGDL_DATA_DIR overrides used in tests).
        try {
            const { promises: fs } = await import('node:fs');
            const dataDir = process.env.TGDL_DATA_DIR
                ? path.resolve(process.env.TGDL_DATA_DIR)
                : DATA_DIR;
            const plat =
                process.platform === 'win32'
                    ? 'win'
                    : process.platform === 'darwin'
                      ? 'mac'
                      : 'linux';
            const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
            const ext = process.platform === 'win32' ? '.exe' : '';
            const binPath = path.join(
                dataDir,
                'faces-service',
                'bin',
                `tgdl-faces-${plat}-${arch}${ext}`,
            );
            const st = await fs.stat(binPath);
            const sizeMb = (st.size / (1024 * 1024)).toFixed(1);
            checks.push({
                id: 'binary',
                label: 'Prebuilt sidecar binary',
                status: 'ok',
                detail: `cached: ${sizeMb} MB`,
            });
        } catch {
            // First-run setup hint — until the GitHub Release lands the
            // download will 404, so the operator needs to know about the two
            // recovery paths (docker compose or `pip install -e faces-service/`).
            checks.push({
                id: 'binary',
                label: 'Prebuilt sidecar binary',
                status: 'info',
                detail:
                    'not yet downloaded — `docker compose --profile faces up` or ' +
                    '`pip install -e faces-service/` from the repo root, then restart',
            });
        }

        // 4 + 5. Provider + model — both pulled from the sidecar. `/health`
        //    carries the model + ready flag; the resolved onnxruntime
        //    providers list lives on `/info` (set after the model loads).
        //    Merging both keeps the doctor card aligned with the sidecar's
        //    wire format without forcing a Python-side change.
        try {
            const facesClient = await import('../../core/ai/faces-client.js');
            const url = facesClient.getSidecarUrl();
            const h = await facesClient.health();
            if (h.ok) {
                let providers = [];
                if (url) {
                    try {
                        const ctrl = new AbortController();
                        const t = setTimeout(() => ctrl.abort(), 2000);
                        try {
                            const r = await globalThis.fetch(`${url}/info`, {
                                signal: ctrl.signal,
                            });
                            if (r.ok) {
                                const info = await r.json();
                                if (Array.isArray(info?.providers)) providers = info.providers;
                            }
                        } finally {
                            clearTimeout(t);
                        }
                    } catch {
                        /* /info is best-effort — fall through to CPU default */
                    }
                }
                const top = providers[0] || 'CPUExecutionProvider';
                const providerLabel =
                    {
                        CUDAExecutionProvider: 'GPU acceleration: CUDA',
                        CoreMLExecutionProvider: 'GPU acceleration: Apple Silicon (CoreML)',
                        DmlExecutionProvider: 'GPU acceleration: DirectML',
                        CPUExecutionProvider: 'CPU-only (no GPU detected)',
                    }[top] || top;
                checks.push({
                    id: 'provider',
                    label: 'Inference provider',
                    status: 'ok',
                    detail: providerLabel,
                });
                checks.push({
                    id: 'model',
                    label: 'Model loaded',
                    status: h.ready ? 'ok' : 'warn',
                    detail: h.ready
                        ? `${h.model || 'buffalo_l'} (${h.dim || 512}-dim)`
                        : 'not loaded yet (first scan will load)',
                });
            } else {
                checks.push({
                    id: 'provider',
                    label: 'Inference provider',
                    status: 'warn',
                    detail: 'unable to probe (sidecar offline)',
                });
                checks.push({
                    id: 'model',
                    label: 'Model loaded',
                    status: 'warn',
                    detail: 'unable to probe (sidecar offline)',
                });
            }
        } catch (e) {
            checks.push({
                id: 'provider',
                label: 'Inference provider',
                status: 'warn',
                detail: e?.message || 'probe failed',
            });
            checks.push({
                id: 'model',
                label: 'Model loaded',
                status: 'warn',
                detail: e?.message || 'probe failed',
            });
        }

        // 6. Photos indexed — kept from the prior probe set. Drives the
        //    operator's sense of progress; cheap (single SQL aggregate).
        try {
            const c = getAiCounts({ fileTypes: ['photo'] });
            const pct = c.totalEligible ? Math.floor((c.indexed / c.totalEligible) * 100) : 0;
            checks.push({
                id: 'indexed',
                label: 'Photos indexed',
                status: 'ok',
                detail: `${c.indexed}/${c.totalEligible} (${pct}%) · with faces ${c.withFaces || 0}`,
            });
        } catch (e) {
            checks.push({
                id: 'indexed',
                label: 'Photos indexed',
                status: 'warn',
                detail: e?.message || String(e),
            });
        }

        res.json({ success: true, checks });
    });
    return router;
}
