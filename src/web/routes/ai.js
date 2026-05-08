/**
 * AI subsystem HTTP API.
 *
 * Every route is wrapped in `safe(...)` from `../lib/safe-route.js` so
 * an unhandled throw can never escape into `process.on('uncaughtException')`
 * and kill the dashboard. That single change is the reason this file exists:
 * before, an async error inside any AI route → 5 s drain → `process.exit(1)`.
 *
 * The router is a factory — it accepts the heavyweights (ai module, db
 * helpers, JobTracker map, broadcast, logger) so tests can mount it against
 * fakes without booting the full server.
 *
 * Behaviour preserved verbatim from the inline routes that used to live in
 * server.js (lines ~6682-7301). Only differences:
 *   - All sync + async throws are caught + JSON-enveloped.
 *   - New `/api/ai/health` endpoint (powers the Doctor card).
 *   - Every success response now carries BOTH `ok: true` and `success: true`
 *     so the legacy UI cache and the new UI both consume the same payload.
 */

import { Router } from 'express';
import { makeSafe, HttpError } from '../lib/safe-route.js';
import * as health from '../../core/ai/health.js';

const _MODEL_CAPS = [
    { cap: 'embeddings', cfgKey: 'embeddings', defaultKind: 'image-feature-extraction' },
    { cap: 'faces', cfgKey: 'faces', defaultKind: 'object-detection' },
    { cap: 'tags', cfgKey: 'tags', defaultKind: 'image-classification' },
];

/**
 * @param {object} deps
 * @param {object} deps.ai                    `import * as ai from '../core/ai/index.js'`
 * @param {object} deps.db                    bag of DB helpers (see `requiredDbHelpers` below)
 * @param {object} deps.jobTrackers           { aiIndex, aiPeople, aiPhash, aiTags }
 * @param {Function} deps.getDb               returns a live better-sqlite3 handle
 * @param {Function} deps.loadConfig          src/config/manager.js loadConfig
 * @param {(entry: object) => void} deps.log  structured logger
 * @param {(payload: object) => void} deps.broadcast  WebSocket fan-out
 * @returns {import('express').Router}
 */
export function createAiRouter(deps) {
    const { ai, db, jobTrackers, getDb, loadConfig, log, broadcast } = deps;

    if (!ai) throw new Error('createAiRouter: deps.ai is required');
    if (!db) throw new Error('createAiRouter: deps.db is required');
    if (!jobTrackers) throw new Error('createAiRouter: deps.jobTrackers is required');
    if (typeof getDb !== 'function')
        throw new Error('createAiRouter: deps.getDb must be a function');
    if (typeof loadConfig !== 'function')
        throw new Error('createAiRouter: deps.loadConfig must be a function');
    if (typeof log !== 'function') throw new Error('createAiRouter: deps.log must be a function');
    if (typeof broadcast !== 'function')
        throw new Error('createAiRouter: deps.broadcast must be a function');

    const {
        getAiCounts,
        listPeople,
        listPhotosForPerson,
        renamePerson,
        deletePerson,
        listAllTags,
        listPhotosForTag,
        listEmbeddingModels,
        clearStaleEmbeddings,
    } = db;

    const safe = makeSafe({ log, prefix: 'ai' });
    const router = Router();

    // Wire Transformers.js model-download progress into the WS bus exactly
    // once per router creation. Idempotent inside ai.setModelProgressHook —
    // calling it twice just overwrites the slot.
    try {
        ai.setModelProgressHook?.(({ kind, modelId, progress }) => {
            try {
                broadcast({
                    type: 'ai_model_progress',
                    kind,
                    modelId,
                    progress: progress || null,
                    ts: Date.now(),
                });
            } catch {
                /* never crash the loader */
            }
        });
    } catch {
        /* setModelProgressHook is optional */
    }

    /**
     * Read the live config, project it onto the AI shape, and fall back to
     * `ai.AI_DEFAULTS` for any missing keys. Never throws — a corrupt config
     * yields the default shape so the dashboard still answers.
     */
    function aiCfg() {
        try {
            const live = loadConfig();
            const cfg = live.advanced?.ai || {};
            return {
                enabled: cfg.enabled === true,
                hfToken: typeof cfg.hfToken === 'string' ? cfg.hfToken : '',
                embeddings: {
                    enabled: cfg.embeddings?.enabled === true,
                    model: cfg.embeddings?.model || ai.AI_DEFAULTS.embeddings.model,
                },
                faces: {
                    enabled: cfg.faces?.enabled === true,
                    model: cfg.faces?.model || ai.AI_DEFAULTS.faces.model,
                    epsilon: Number.isFinite(cfg.faces?.epsilon)
                        ? cfg.faces.epsilon
                        : ai.AI_DEFAULTS.faces.epsilon,
                    minPoints: Number.isFinite(cfg.faces?.minPoints)
                        ? cfg.faces.minPoints
                        : ai.AI_DEFAULTS.faces.minPoints,
                },
                tags: {
                    enabled: cfg.tags?.enabled === true,
                    model: cfg.tags?.model || ai.AI_DEFAULTS.tags.model,
                    topK: Number.isFinite(cfg.tags?.topK)
                        ? cfg.tags.topK
                        : ai.AI_DEFAULTS.tags.topK,
                },
                phash: { enabled: cfg.phash?.enabled === true },
                cacheDir: typeof cfg.cacheDir === 'string' ? cfg.cacheDir : null,
                indexConcurrency: Number.isFinite(cfg.indexConcurrency)
                    ? cfg.indexConcurrency
                    : ai.AI_DEFAULTS.indexConcurrency,
                batchSize: Number.isFinite(cfg.batchSize)
                    ? cfg.batchSize
                    : ai.AI_DEFAULTS.batchSize,
                fileTypes:
                    Array.isArray(cfg.fileTypes) && cfg.fileTypes.length
                        ? cfg.fileTypes
                        : ai.AI_DEFAULTS.fileTypes,
            };
        } catch {
            return { ...ai.AI_DEFAULTS };
        }
    }

    let _aiVecProbed = false;
    async function maybeProbeVec() {
        if (_aiVecProbed) return;
        _aiVecProbed = true;
        try {
            await ai.loadVecExtension(getDb, log);
        } catch {
            /* sqlite-vec is optional — fallback handles the rest */
        }
    }

    function requireEnabled(cfg) {
        if (!cfg.enabled) {
            throw new HttpError(
                503,
                'AI_DISABLED',
                'AI subsystem disabled. Toggle "Enable AI subsystem" in Maintenance → AI search.',
            );
        }
    }

    function requireCap(cfg, cap, code, label) {
        requireEnabled(cfg);
        if (!cfg[cap]?.enabled) {
            throw new HttpError(503, code, `${label} is disabled`);
        }
    }

    // ---- Diagnostics ------------------------------------------------------
    //
    // Two layers of crash-resistance live here:
    //   1. A 30 s in-process cache so repeated dashboard reloads (or panicked
    //      operators clicking Refresh) don't compound load on the underlying
    //      probes. Probes themselves are individually timeout-bounded inside
    //      `health.summary()`.
    //   2. A 20 s request socket timeout — if `summary()` ever managed to
    //      hang past every internal guard, the response socket still closes
    //      so the client doesn't dangle.
    //
    // Reason this exists: prior to v2.12.1, `health.summary()` ran four
    // probes in parallel via `Promise.all` with no per-check timeout. A
    // single hung native call (sharp's libvips, onnxruntime-node load,
    // sqlite-vec dlopen) could take the request offline; on memory-limited
    // hosts the OOM-kill produced "no logs" container restarts.

    const HEALTH_CACHE_TTL_MS = 30_000;
    let _healthCache = null; // { payload, ts }
    let _healthInflight = null; // dedupe concurrent requests

    async function _runHealthSummary(reqId) {
        log({
            source: 'ai-health',
            level: 'info',
            msg: `[${reqId}] cache miss — running summary()`,
        });
        const cfg = aiCfg();
        const t0 = Date.now();
        let payload;
        try {
            payload = await health.summary({ getDb, cacheDir: cfg.cacheDir, log });
        } catch (err) {
            log({
                source: 'ai-health',
                level: 'error',
                msg: `[${reqId}] summary() threw — ${err?.message || err}`,
                stack: err?.stack || null,
            });
            // Hand the caller a structured failure rather than letting the
            // safe-route wrapper turn this into a 500 with no diagnostic
            // detail. Operators want to see WHICH probe died.
            payload = {
                ok: false,
                checks: [
                    {
                        name: 'summary',
                        ok: false,
                        error: String(err?.message || err).slice(0, 240),
                        recommendation:
                            'Health summary aggregator crashed. Check server logs for the stack trace.',
                    },
                ],
                recommendations: [],
                platform: process.platform,
                nodeVersion: process.version,
                arch: process.arch,
                cpus: 1,
                ts: Date.now(),
                elapsedMs: Date.now() - t0,
                aggregatorError: true,
            };
        }
        log({
            source: 'ai-health',
            level: payload.ok ? 'info' : 'warn',
            msg: `[${reqId}] summary() returned ok=${payload.ok} in ${Date.now() - t0}ms`,
        });
        return payload;
    }

    router.get(
        '/health',
        safe(async (req, res) => {
            const reqId = `aih-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            log({
                source: 'ai-health',
                level: 'info',
                msg: `[${reqId}] GET /api/ai/health from ${req.ip || 'unknown'} ua="${(req.get('user-agent') || '').slice(0, 80)}"`,
            });

            // Defence in depth: even with per-probe timeouts inside
            // summary(), set a hard request-level timeout so the socket
            // can't dangle if the aggregator itself is somehow stuck.
            try {
                req.setTimeout?.(20_000);
                res.setTimeout?.(20_000);
            } catch {
                /* setTimeout is optional on some test transports */
            }

            // Serve cached payload if recent enough — keeps the dashboard
            // responsive when an operator is hammering Refresh.
            const now = Date.now();
            if (_healthCache && now - _healthCache.ts < HEALTH_CACHE_TTL_MS) {
                const ageMs = now - _healthCache.ts;
                log({
                    source: 'ai-health',
                    level: 'info',
                    msg: `[${reqId}] serving cached payload (age=${ageMs}ms)`,
                });
                res.json({
                    ok: true,
                    success: true,
                    ..._healthCache.payload,
                    cached: true,
                    cacheAgeMs: ageMs,
                });
                return;
            }

            // Dedupe concurrent first-hits — the in-flight promise is
            // shared so we don't run summary() twice in parallel.
            if (!_healthInflight) {
                _healthInflight = _runHealthSummary(reqId).finally(() => {
                    _healthInflight = null;
                });
            } else {
                log({
                    source: 'ai-health',
                    level: 'info',
                    msg: `[${reqId}] joining in-flight summary()`,
                });
            }

            const payload = await _healthInflight;
            _healthCache = { payload, ts: Date.now() };
            log({
                source: 'ai-health',
                level: 'info',
                msg: `[${reqId}] cache stored, responding`,
            });
            res.json({ ok: true, success: true, ...payload, cached: false });
        }),
    );

    // ---- Status -----------------------------------------------------------

    router.get(
        '/status',
        safe(async (_req, res) => {
            await maybeProbeVec();
            const cfg = aiCfg();
            let counts = { indexed: 0, totalEligible: 0 };
            try {
                counts = getAiCounts({ fileTypes: cfg.fileTypes });
            } catch {
                /* table missing on fresh installs — use zero defaults */
            }
            const gatedWarnings = [];
            for (const cap of ['embeddings', 'faces', 'tags']) {
                const cur = cfg[cap]?.model;
                const repl = ai.suggestPublicReplacement(cur);
                if (repl) gatedWarnings.push({ cap, currentId: cur, suggested: repl.suggested });
            }
            const currentEmbeddingModel = cfg.embeddings.model;
            let staleEmbeddings = { count: 0, distinctModels: [] };
            try {
                const rows = listEmbeddingModels();
                const stale = rows.filter((r) => r.model !== currentEmbeddingModel);
                staleEmbeddings = {
                    count: stale.reduce((n, r) => n + (Number(r.count) || 0), 0),
                    distinctModels: stale.map((r) => r.model || ''),
                };
            } catch {
                /* table missing on fresh installs */
            }
            res.json({
                ok: true,
                success: true,
                enabled: cfg.enabled,
                capabilities: {
                    master: cfg.enabled,
                    embeddings: cfg.embeddings.enabled,
                    faces: cfg.faces.enabled,
                    tags: cfg.tags.enabled,
                    phash: cfg.phash.enabled,
                },
                models: {
                    embeddings: cfg.embeddings.model,
                    faces: cfg.faces.model,
                    tags: cfg.tags.model,
                },
                counts,
                loadedPipelines: ai.loadedPipelines(),
                gatedWarnings,
                embeddingPresets: ai.EMBEDDING_PRESETS,
                currentEmbeddingModel,
                staleEmbeddings,
            });
        }),
    );

    // ---- HF token test ----------------------------------------------------

    router.post(
        '/hf/test',
        safe(async (req, res) => {
            let token = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
            if (!token) {
                try {
                    const cfg = loadConfig();
                    token = String(cfg?.advanced?.ai?.hfToken || '').trim();
                } catch {
                    /* config not ready */
                }
            }
            if (!token) {
                return res.status(400).json({
                    ok: false,
                    success: false,
                    status: 0,
                    code: 'NO_TOKEN',
                    message: 'No token to test. Paste one above first.',
                });
            }
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 5000);
            let r;
            try {
                r = await fetch('https://huggingface.co/api/whoami-v2', {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json',
                    },
                    signal: ac.signal,
                });
            } catch (e) {
                return res.json({
                    ok: false,
                    success: false,
                    status: 0,
                    code: e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
                    message:
                        e?.name === 'AbortError'
                            ? 'Timed out talking to huggingface.co.'
                            : `Network error: ${e?.message || e}`,
                });
            } finally {
                clearTimeout(timer);
            }
            if (r.status === 401 || r.status === 403) {
                return res.json({
                    ok: false,
                    success: false,
                    status: r.status,
                    code: 'UNAUTHORIZED',
                    message: 'Token rejected by HuggingFace. Re-create the token with Read role.',
                });
            }
            if (!r.ok) {
                return res.json({
                    ok: false,
                    success: false,
                    status: r.status,
                    code: 'HTTP_ERROR',
                    message: `HuggingFace returned HTTP ${r.status}.`,
                });
            }
            let body = null;
            try {
                body = await r.json();
            } catch {
                /* ignore */
            }
            const name = body?.name || body?.fullname || '(unknown)';
            const type = body?.type || 'user';
            return res.json({ ok: true, success: true, status: r.status, name, type });
        }),
    );

    // ---- Index (embeddings) scan -----------------------------------------

    router.post(
        '/index/scan',
        safe(async (_req, res) => {
            const cfg = aiCfg();
            requireEnabled(cfg);
            const tracker = jobTrackers.aiIndex;
            const r = tracker.tryStart(async ({ onProgress, signal }) =>
                ai.runIndexScan(cfg, { onProgress, signal, onLog: log }),
            );
            if (!r.started) {
                return res.status(409).json({
                    ok: false,
                    success: false,
                    code: 'ALREADY_RUNNING',
                    message: 'AI index scan already running',
                });
            }
            res.json({ ok: true, success: true, started: true });
        }),
    );

    router.post(
        '/index/reembed',
        safe(async (_req, res) => {
            const cfg = aiCfg();
            requireCap(cfg, 'embeddings', 'EMBEDDINGS_DISABLED', 'AI embeddings are');
            const tracker = jobTrackers.aiIndex;
            const r = tracker.tryStart(async ({ onProgress, signal }) => {
                let cleared = { dropped: 0, requeued: 0 };
                try {
                    cleared = clearStaleEmbeddings(cfg.embeddings.model);
                } catch (e) {
                    log({
                        source: 'ai',
                        level: 'error',
                        msg: `reembed wipe failed: ${e?.message || e}`,
                    });
                    throw e;
                }
                try {
                    ai.clearVectorCache?.();
                } catch {
                    /* cache helper not loaded — fine, it'll rebuild lazily */
                }
                log({
                    source: 'ai',
                    level: 'info',
                    msg: `reembed: dropped ${cleared.dropped} stale row(s), requeued ${cleared.requeued} download(s) for ${cfg.embeddings.model}`,
                });
                return ai.runIndexScan(cfg, { onProgress, signal, onLog: log });
            });
            if (!r.started) {
                return res.status(409).json({
                    ok: false,
                    success: false,
                    code: 'ALREADY_RUNNING',
                    message: 'AI index scan already running',
                });
            }
            res.json({ ok: true, success: true, started: true });
        }),
    );

    router.get(
        '/index/scan/status',
        safe(async (_req, res) => {
            res.json({ ok: true, success: true, ...jobTrackers.aiIndex.getStatus() });
        }),
    );

    router.post(
        '/index/cancel',
        safe(async (_req, res) => {
            const cancelled = jobTrackers.aiIndex.cancel();
            res.json({ ok: true, success: true, cancelled });
        }),
    );

    // ---- Search -----------------------------------------------------------

    router.post(
        '/search',
        safe(async (req, res) => {
            const { query, limit, fileTypes } = req.body || {};
            if (typeof query !== 'string' || !query.trim()) {
                throw new HttpError(400, 'QUERY_REQUIRED', 'query required');
            }
            const cfg = aiCfg();
            requireCap(cfg, 'embeddings', 'EMBEDDINGS_DISABLED', 'AI embeddings are');
            const r = await ai.searchByText(query.trim(), cfg, {
                limit: Number(limit) || 20,
                fileTypes: Array.isArray(fileTypes) && fileTypes.length ? fileTypes : null,
                onLog: log,
            });
            res.json({ ok: true, success: true, ...r });
        }),
    );

    router.post(
        '/search/similar',
        safe(async (req, res) => {
            const downloadId = Number(req.body?.downloadId);
            if (!Number.isInteger(downloadId) || downloadId <= 0) {
                throw new HttpError(400, 'BAD_DOWNLOAD_ID', 'downloadId required');
            }
            const cfg = aiCfg();
            requireCap(cfg, 'embeddings', 'EMBEDDINGS_DISABLED', 'AI embeddings are');
            const limit = Math.max(1, Math.min(200, Number(req.body?.limit) || 24));

            const { listAllImageEmbeddings } = await import('../../core/db.js');
            const rows = listAllImageEmbeddings({ fileTypes: cfg.fileTypes });
            const src = rows.find((r) => r.download_id === downloadId);
            if (!src || !src.embedding) {
                throw new HttpError(404, 'NO_EMBEDDING', 'no embedding for that download');
            }
            const { blobToVector, topK } = await import('../../core/ai/vector-store.js');
            const vec = blobToVector(src.embedding);
            if (!vec) {
                throw new HttpError(500, 'EMBEDDING_DECODE_FAILED', 'embedding decode failed');
            }
            const top = topK(vec, { limit: limit + 1, fileTypes: cfg.fileTypes });
            const results = top
                .filter((r) => r.download_id !== downloadId)
                .slice(0, limit)
                .map((r) => ({
                    download_id: r.download_id,
                    score: r.score,
                    file_name: r.row.file_name,
                    file_path: r.row.file_path,
                    file_type: r.row.file_type,
                    file_size: r.row.file_size,
                    group_id: r.row.group_id,
                    group_name: r.row.group_name,
                    created_at: r.row.created_at,
                }));
            res.json({
                ok: true,
                success: true,
                source: {
                    download_id: src.download_id,
                    file_name: src.file_name,
                    group_id: src.group_id,
                    group_name: src.group_name,
                },
                results,
                total: results.length,
            });
        }),
    );

    // ---- People (face clustering) ----------------------------------------

    router.post(
        '/people/scan',
        safe(async (_req, res) => {
            const cfg = aiCfg();
            requireCap(cfg, 'faces', 'FACES_DISABLED', 'Face clustering');
            const tracker = jobTrackers.aiPeople;
            const r = tracker.tryStart(async ({ onProgress, signal }) =>
                ai.runFaceClustering(cfg, { onProgress, signal, onLog: log }),
            );
            if (!r.started) {
                return res.status(409).json({
                    ok: false,
                    success: false,
                    code: 'ALREADY_RUNNING',
                    message: 'Face clustering already running',
                });
            }
            res.json({ ok: true, success: true, started: true });
        }),
    );

    router.get(
        '/people/scan/status',
        safe(async (_req, res) => {
            res.json({ ok: true, success: true, ...jobTrackers.aiPeople.getStatus() });
        }),
    );

    router.get(
        '/people',
        safe(async (req, res) => {
            const limit = Number(req.query.limit) || 200;
            const offset = Number(req.query.offset) || 0;
            res.json({ ok: true, success: true, ...listPeople({ limit, offset }) });
        }),
    );

    router.put(
        '/people/:id',
        safe(async (req, res) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                throw new HttpError(400, 'BAD_ID', 'bad id');
            }
            const label = req.body?.label;
            const updated = renamePerson(id, label == null ? null : String(label).slice(0, 80));
            log({ source: 'ai', level: 'info', msg: `person #${id} renamed to "${label}"` });
            res.json({ ok: true, success: true, updated });
        }),
    );

    router.delete(
        '/people/:id',
        safe(async (req, res) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                throw new HttpError(400, 'BAD_ID', 'bad id');
            }
            const deleted = deletePerson(id);
            log({ source: 'ai', level: 'info', msg: `person #${id} deleted (faces unclustered)` });
            res.json({ ok: true, success: true, deleted });
        }),
    );

    router.get(
        '/people/:id/photos',
        safe(async (req, res) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                throw new HttpError(400, 'BAD_ID', 'bad id');
            }
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;
            res.json({ ok: true, success: true, ...listPhotosForPerson(id, { limit, offset }) });
        }),
    );

    // ---- Perceptual dedup (pHash) ----------------------------------------

    router.post(
        '/perceptual-dedup/scan',
        safe(async (_req, res) => {
            const cfg = aiCfg();
            requireCap(cfg, 'phash', 'PHASH_DISABLED', 'Perceptual dedup');
            const tracker = jobTrackers.aiPhash;
            const r = tracker.tryStart(async ({ onProgress, signal }) =>
                ai.runPhashScan({ onProgress, signal, onLog: log, fileTypes: cfg.fileTypes }),
            );
            if (!r.started) {
                return res.status(409).json({
                    ok: false,
                    success: false,
                    code: 'ALREADY_RUNNING',
                    message: 'phash scan already running',
                });
            }
            res.json({ ok: true, success: true, started: true });
        }),
    );

    router.get(
        '/perceptual-dedup/scan/status',
        safe(async (_req, res) => {
            res.json({ ok: true, success: true, ...jobTrackers.aiPhash.getStatus() });
        }),
    );

    router.get(
        '/perceptual-dedup/groups',
        safe(async (req, res) => {
            const threshold = Math.max(0, Math.min(20, Number(req.query.threshold) || 6));
            const cfg = aiCfg();
            const r = ai.findPhashGroups({ threshold, fileTypes: cfg.fileTypes });
            res.json({ ok: true, success: true, ...r });
        }),
    );

    // ---- Auto-tag --------------------------------------------------------

    router.post(
        '/tags/scan',
        safe(async (_req, res) => {
            const cfg = aiCfg();
            requireCap(cfg, 'tags', 'TAGS_DISABLED', 'Auto-tagging');
            const tracker = jobTrackers.aiTags;
            // Reuse the full index scan with only tags enabled.
            const onlyTags = {
                ...cfg,
                embeddings: { ...cfg.embeddings, enabled: false },
                faces: { ...cfg.faces, enabled: false },
                phash: { enabled: false },
            };
            const r = tracker.tryStart(async ({ onProgress, signal }) =>
                ai.runIndexScan(onlyTags, { onProgress, signal, onLog: log }),
            );
            if (!r.started) {
                return res.status(409).json({
                    ok: false,
                    success: false,
                    code: 'ALREADY_RUNNING',
                    message: 'tags scan already running',
                });
            }
            res.json({ ok: true, success: true, started: true });
        }),
    );

    router.get(
        '/tags/scan/status',
        safe(async (_req, res) => {
            res.json({ ok: true, success: true, ...jobTrackers.aiTags.getStatus() });
        }),
    );

    router.get(
        '/tags',
        safe(async (req, res) => {
            const minCount = Math.max(1, Number(req.query.min_count) || 1);
            res.json({ ok: true, success: true, tags: listAllTags({ minCount }) });
        }),
    );

    router.get(
        '/tags/:tag/photos',
        safe(async (req, res) => {
            const tag = String(req.params.tag || '').trim();
            if (!tag) throw new HttpError(400, 'TAG_REQUIRED', 'tag required');
            const limit = Number(req.query.limit) || 50;
            const offset = Number(req.query.offset) || 0;
            res.json({ ok: true, success: true, ...listPhotosForTag(tag, { limit, offset }) });
        }),
    );

    // ---- Models panel ----------------------------------------------------

    router.get(
        '/models/status',
        safe(async (_req, res) => {
            const cfg = aiCfg();
            const meta = ai.pipelineMetaSnapshot();
            const errors = ai.pipelineErrorsSnapshot();
            const metaByKey = new Map(meta.map((m) => [m.key, m]));
            const errsByKey = new Map(errors.map((e) => [e.key, e]));

            const out = {};
            for (const desc of _MODEL_CAPS) {
                const capCfg = cfg[desc.cfgKey] || {};
                const modelId = capCfg.model || ai.AI_MODEL_DEFAULTS[desc.cfgKey]?.modelId || '';
                const kind = ai.AI_MODEL_DEFAULTS[desc.cfgKey]?.kind || desc.defaultKind;
                const key = `${kind}::${modelId}`;
                const m = metaByKey.get(key);
                const err = errsByKey.get(key);
                const cache = await ai.inspectModelCache(modelId, cfg.cacheDir);
                out[desc.cap] = {
                    modelId,
                    kind,
                    enabled: capCfg.enabled === true,
                    loaded: !!(m && m.loadedAt),
                    loading: !!(m && !m.loadedAt),
                    lastLoadedAt: m?.loadedAt || null,
                    startedAt: m?.startedAt || null,
                    lastProgress: m?.lastProgress || null,
                    error: err ? err.message : null,
                    cacheBytes: cache.bytes,
                    cacheFiles: cache.files,
                    cacheDir: cache.dir,
                };
            }
            res.json({
                ok: true,
                success: true,
                cacheRoot: ai.resolveCacheDir(cfg.cacheDir),
                models: out,
            });
        }),
    );

    router.delete(
        '/models/cache',
        safe(async (req, res) => {
            const modelId = String(req.query.model || req.body?.model || '').trim();
            if (!modelId) throw new HttpError(400, 'MODEL_ID_REQUIRED', 'model id required');
            const cfg = aiCfg();
            try {
                await ai.clearPipelineForModel(modelId);
            } catch {
                /* ignore */
            }
            const r = await ai.deleteModelCache(modelId, cfg.cacheDir);
            log({
                source: 'ai',
                level: 'info',
                msg: `model cache wiped: ${modelId} (${r.bytes} bytes)`,
            });
            res.json({ ok: true, success: true, ...r });
        }),
    );

    return router;
}
