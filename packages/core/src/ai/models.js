/**
 * AI model registry + lazy loader.
 *
 * Every AI capability (embeddings / faces / tags / phash) goes through this
 * module to obtain its model handle. Two reasons:
 *
 *   1. **Cross-platform**. The classifier path inherits NSFW's hard-won
 *      Transformers.js / WASM tuning: env.cacheDir override (so weights
 *      land in the project's data/ tree and survive `docker compose down`),
 *      single-thread WASM (works without SharedArrayBuffer), and a defensive
 *      `import('@huggingface/transformers').catch(...)` guard so a Linux/musl
 *      install that lacks the optional native ORT prebuilt fails CLEAN at
 *      scan-time instead of crashing the web process at module-eval.
 *
 *   2. **Cache discipline**. Each model is loaded ONCE per process —
 *      subsequent requests reuse the same pipeline handle. Pulling a 90 MB
 *      CLIP weight every search would obviously be silly; less obviously,
 *      Transformers.js initialises a WASM heap on first use and a second
 *      `pipeline()` call leaks the first heap until the process exits.
 *
 * Default install pulls ZERO model weights — every model is requested on
 * first use of its capability. A fresh container that never touches the AI
 * subsystem boots and serves traffic without downloading anything.
 */

import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `src/core/ai/` -> repo root is three levels up.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// Operators can override the on-disk model location through env. Path is
// resolved relative to the repo root if it isn't absolute, so the same value
// works on Windows / macOS / Linux / Docker without quoting headaches.
function _defaultModelsDir() {
    const env = process.env.AI_MODELS_DIR;
    if (env && env.trim()) {
        return path.isAbsolute(env) ? env : path.resolve(PROJECT_ROOT, env);
    }
    return path.resolve(PROJECT_ROOT, 'data', 'models');
}

// `kind` ∈ { 'image-classification', 'image-feature-extraction',
//            'zero-shot-image-classification', 'object-detection', ... }.
// Keyed on `kind:modelId` so two capabilities asking for the same model id
// with different pipeline kinds (e.g. CLIP for image vs text) each get
// their own cached handle.
const _pipelinePromises = new Map();

// Per-pipeline metadata: when each handle resolved + the most recent
// download progress callback payload. Feeds the `/api/ai/models/status`
// endpoint so the dashboard can show "Ready · loaded N min ago" without
// forcing a load.
const _pipelineMeta = new Map();
// Most recent error per (kind, modelId) — preserved after a failed load
// so the dashboard can render a "Retry" affordance with the failure cause
// instead of a blank slate.
const _pipelineErrors = new Map();

// Optional broadcast hook — the web server registers a callback here so
// every Transformers.js progress event during a model download bubbles
// out to connected dashboard clients as a `ai_model_progress` WS event.
// Keep the hook optional so models.js stays usable in CLI / tests.
let _progressHook = null;
export function setModelProgressHook(fn) {
    _progressHook = (typeof fn === 'function') ? fn : null;
}

/**
 * Resolve the absolute models cache directory for a capability config.
 * Honors per-capability `cacheDir` overrides; otherwise falls back to the
 * `AI_MODELS_DIR` env var or `data/models`.
 */
export function resolveCacheDir(cacheDirCfg) {
    if (cacheDirCfg && String(cacheDirCfg).trim()) {
        const raw = String(cacheDirCfg);
        return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
    }
    return _defaultModelsDir();
}

async function _ensureCacheDir(absDir) {
    if (!existsSync(absDir)) {
        await fs.mkdir(absDir, { recursive: true });
    }
}

async function _importTransformers() {
    try {
        return await import('@huggingface/transformers');
    } catch (e) {
        const err = new Error(
            `Failed to load @huggingface/transformers: ${e?.message || e}. `
            + 'Install with `npm install @huggingface/transformers` to enable AI features.'
        );
        err.code = 'AI_LIB_MISSING';
        throw err;
    }
}

/**
 * Configure the Transformers.js env once per import. Idempotent — reads /
 * sets fields that are safe to overwrite repeatedly.
 */
async function _configureEnv(env, cacheDirAbs) {
    try { env.cacheDir = cacheDirAbs; } catch { /* noop */ }
    // Force WASM execution on Node — see nsfw.js for the full rationale
    // (musl/glibc + onnxruntime-node prebuilt mess).
    try {
        if (env?.backends?.onnx?.wasm) {
            env.backends.onnx.wasm.numThreads = 1;
        }
    } catch { /* noop */ }
    // Optional HuggingFace token. Two precedence layers: (1) env var,
    // (2) `config.advanced.ai.hfToken` set via the dashboard. Either lets
    // the loader pull gated repos + dodge anonymous rate limits that show
    // up as 401 in the realtime log.
    try {
        let token = process.env.HF_TOKEN
            || process.env.HUGGINGFACE_TOKEN
            || process.env.HUGGINGFACEHUB_API_TOKEN
            || null;
        // Pull from live config when env didn't set one. Dynamic require
        // keeps models.js usable in CLI / tests where config doesn't
        // exist yet.
        if (!token) {
            try {
                const { loadConfig } = await import('../../config/manager.js');
                const cfg = loadConfig();
                const cfgToken = cfg?.advanced?.ai?.hfToken;
                if (typeof cfgToken === 'string' && cfgToken.trim()) {
                    token = cfgToken.trim();
                }
            } catch { /* noop — config not ready */ }
        }
        if (token && env) {
            // transformers.js v3 honours `env.useCustomCache`/`env.token`
            // shapes inconsistently across patch versions — set every
            // form we've seen documented so at least one wins.
            try { env.token = token; } catch { /* noop */ }
            try {
                if (!env.customHeaders) env.customHeaders = {};
                env.customHeaders.Authorization = `Bearer ${token}`;
            } catch { /* noop */ }
        }
    } catch { /* noop */ }
}

/**
 * Lazy-load a Transformers.js pipeline. Cached per (kind, modelId).
 *
 * @param {object} opts
 * @param {string} opts.kind                 Pipeline kind ('image-classification', etc.)
 * @param {string} opts.modelId              HF model id ('Xenova/clip-vit-base-patch32')
 * @param {string} [opts.cacheDir]           Override AI_MODELS_DIR for this load.
 * @param {(p:object) => void} [opts.onProgress]  Progress callback for download.
 * @param {(entry:object) => void} [opts.onLog]   Structured log sink.
 * @returns {Promise<Function>}              The pipeline handle.
 */
export async function getPipeline({ kind, modelId, cacheDir, onProgress, onLog } = {}) {
    if (!kind) throw new Error('getPipeline: kind is required');
    if (!modelId) throw new Error('getPipeline: modelId is required');
    const _log = (level, msg) => {
        try { if (typeof onLog === 'function') onLog({ source: 'ai', level, msg }); }
        catch { /* swallow */ }
    };

    const key = `${kind}::${modelId}`;
    let promise = _pipelinePromises.get(key);
    if (promise) return promise;

    promise = (async () => {
        const cacheDirAbs = resolveCacheDir(cacheDir);
        await _ensureCacheDir(cacheDirAbs);
        _log('info', `loading ${kind} pipeline — model=${modelId} cacheDir=${cacheDirAbs}`);

        // Mark the entry so the status endpoint can render "Loading…"
        // before the first progress event lands.
        _pipelineMeta.set(key, {
            kind, modelId,
            startedAt: Date.now(),
            loadedAt: null,
            lastProgress: null,
        });

        const mod = await _importTransformers();
        const { pipeline, env } = mod;
        await _configureEnv(env, cacheDirAbs);

        const handle = await pipeline(kind, modelId, {
            progress_callback: (p) => {
                try { if (typeof onProgress === 'function') onProgress(p); }
                catch { /* progress callbacks must never crash the loader */ }
                try {
                    const meta = _pipelineMeta.get(key);
                    if (meta) meta.lastProgress = { ...p, ts: Date.now() };
                } catch { /* swallow */ }
                try {
                    if (_progressHook) _progressHook({ kind, modelId, progress: p });
                } catch { /* never crash the loader */ }
            },
        });

        const meta = _pipelineMeta.get(key);
        if (meta) {
            meta.loadedAt = Date.now();
            meta.lastProgress = null;
        }
        _pipelineErrors.delete(key);
        try {
            if (_progressHook) _progressHook({ kind, modelId, progress: { status: 'ready' } });
        } catch { /* swallow */ }
        return handle;
    })().catch((e) => {
        // Reset so the next caller retries the load instead of inheriting
        // the rejected promise forever.
        _pipelinePromises.delete(key);
        _pipelineMeta.delete(key);
        _pipelineErrors.set(key, { message: e?.message || String(e), ts: Date.now() });
        try {
            if (_progressHook) _progressHook({
                kind, modelId,
                progress: { status: 'error', error: e?.message || String(e) },
            });
        } catch { /* swallow */ }
        throw e;
    });

    _pipelinePromises.set(key, promise);
    return promise;
}

/**
 * Drop the cached pipeline for a model so the next request triggers a
 * fresh load. Used by the model-swap UI: changing config.advanced.ai.<cap>.model
 * has no effect until the in-process handle is dropped.
 *
 * Best-effort dispose of the underlying handle if it has already resolved;
 * a still-in-flight load is left to settle (its promise is removed from
 * the cache so future callers won't await the old handle).
 */
export async function clearPipelineForModel(modelId) {
    const target = String(modelId || '').trim();
    if (!target) return 0;
    const keys = [..._pipelinePromises.keys()].filter((k) => k.endsWith(`::${target}`));
    let cleared = 0;
    for (const key of keys) {
        const p = _pipelinePromises.get(key);
        _pipelinePromises.delete(key);
        _pipelineMeta.delete(key);
        try {
            const cls = await p;
            if (cls && typeof cls.dispose === 'function') await cls.dispose();
        } catch { /* swallow */ }
        cleared += 1;
    }
    return cleared;
}

/**
 * Public snapshot of the per-model metadata. Returns one entry per
 * `(kind, modelId)` cache key — keys mirror `loadedPipelines()`. Each
 * entry: `{ kind, modelId, startedAt, loadedAt, lastProgress }`.
 */
export function pipelineMetaSnapshot() {
    return [..._pipelineMeta.entries()].map(([key, v]) => ({ key, ...v }));
}

export function pipelineErrorsSnapshot() {
    return [..._pipelineErrors.entries()].map(([key, v]) => ({ key, ...v }));
}

/**
 * Walk the on-disk cache for a given model id and sum the byte size.
 * Transformers.js stores per-model files under
 *   `<cacheDir>/<owner>/<repo>/...` (the `/` from the HF id becomes a
 * sub-directory). Returns `{ bytes, files, dir }` — bytes=0 + files=0 when
 * the model has never been downloaded. Errors swallow to `{ bytes: 0 }`.
 */
export async function inspectModelCache(modelId, cacheDirCfg) {
    const id = String(modelId || '').trim();
    if (!id) return { bytes: 0, files: 0, dir: null };
    const root = resolveCacheDir(cacheDirCfg);
    // Transformers.js mirrors the HF id structure verbatim — Xenova/foo
    // becomes <cache>/Xenova/foo. Resolve both styles defensively because
    // some older versions flattened the slash to '_'.
    const candidates = [
        path.join(root, id),
        path.join(root, id.replace(/\//g, path.sep)),
        path.join(root, id.replace(/\//g, '_')),
    ];
    for (const dir of candidates) {
        try {
            const stat = await fs.stat(dir).catch(() => null);
            if (!stat || !stat.isDirectory()) continue;
            let bytes = 0;
            let files = 0;
            const stack = [dir];
            while (stack.length) {
                const cur = stack.pop();
                let ents;
                try { ents = await fs.readdir(cur, { withFileTypes: true }); }
                catch { continue; }
                for (const e of ents) {
                    const p = path.join(cur, e.name);
                    if (e.isDirectory()) { stack.push(p); continue; }
                    if (e.isFile()) {
                        try {
                            const s = await fs.stat(p);
                            bytes += s.size;
                            files += 1;
                        } catch { /* skip racy unlinks */ }
                    }
                }
            }
            return { bytes, files, dir };
        } catch { /* try next candidate */ }
    }
    return { bytes: 0, files: 0, dir: null };
}

/**
 * Delete the on-disk cache for a model so the next load redownloads. Returns
 * `{ removed: boolean, bytes: number }`. Refuses paths that escape the
 * configured cache root — defence-in-depth against an admin who hand-edits
 * a config file with a `..`-laden model id.
 */
export async function deleteModelCache(modelId, cacheDirCfg) {
    const insp = await inspectModelCache(modelId, cacheDirCfg);
    if (!insp.dir) return { removed: false, bytes: 0 };
    const root = resolveCacheDir(cacheDirCfg);
    const rootResolved = path.resolve(root) + path.sep;
    const targetResolved = path.resolve(insp.dir);
    if (!targetResolved.startsWith(rootResolved)) {
        // Refuse anything outside the cache dir — an `id` containing `..`
        // could otherwise resolve to a system directory.
        return { removed: false, bytes: 0 };
    }
    try {
        await fs.rm(insp.dir, { recursive: true, force: true });
        return { removed: true, bytes: insp.bytes };
    } catch {
        return { removed: false, bytes: 0 };
    }
}

/**
 * Best-effort dispose of every cached pipeline. Wired into the graceful-
 * shutdown path so the process can release WASM heap before exit.
 */
export async function disposeAll() {
    const handles = [..._pipelinePromises.values()];
    _pipelinePromises.clear();
    for (const p of handles) {
        try {
            const cls = await p;
            if (cls && typeof cls.dispose === 'function') await cls.dispose();
        } catch { /* best-effort */ }
    }
}

/**
 * Snapshot of which pipelines are currently loaded — feeds the /api/ai/status
 * endpoint so the UI can show "model ready" badges without forcing a load.
 */
export function loadedPipelines() {
    return [..._pipelinePromises.keys()];
}

export const AI_MODEL_DEFAULTS = Object.freeze({
    embeddings: {
        kind: 'image-feature-extraction',
        modelId: 'Xenova/clip-vit-base-patch32',
        textKind: 'feature-extraction',  // text encoder uses the text head
        dim: 512,
    },
    faces: {
        kind: 'object-detection',
        // `Xenova/yolov5n-face` + `Xenova/yolov8n-face` are gated/restricted
        // (return 401 even with a valid HF token). Default to the public
        // YOLOS-tiny — it's a general detector, the "person" class still
        // gives the people-clustering pipeline usable bboxes. Operators
        // who want a dedicated face model can swap to a self-hosted one.
        modelId: 'Xenova/yolos-tiny',  // ~31 MB
    },
    tags: {
        kind: 'image-classification',
        // `Xenova/mobilenet_v2` is restricted (401). `Xenova/vit-base-
        // patch16-224` is public, similar size after quantization, same
        // 1000-class ImageNet head — drop-in replacement for the tag
        // cloud feature.
        modelId: 'Xenova/vit-base-patch16-224',
        topK: 5,
    },
});
