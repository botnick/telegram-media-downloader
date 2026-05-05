/**
 * NSFW classifier — single-process, in-Node, cross-platform.
 *
 * Phase 1: photos only. Maintenance triggers a one-shot batch scan
 * that classifies every previously-unscanned photo, persists the
 * `nsfw_score` to the DB, and broadcasts progress over WebSocket. The
 * UI then shows a review sheet listing flagged rows so the admin can
 * eye-check + delete.
 *
 * Backend: `@huggingface/transformers` running through its WASM
 * execution provider. This is intentional — the native onnxruntime
 * binary doesn't ship a musl build, so on Alpine/Docker the native
 * path 500s on load. WASM works identically across Win / macOS /
 * glibc-Linux / musl-Linux / ARM, with a ~2-3× perf hit that's fine
 * for an opt-in background batch.
 *
 * Every knob is config-driven — model id, threshold, concurrency,
 * cache directory, eligible file types — so operators can tune
 * without touching code.
 */

import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { getDb, getUnscannedNsfwBatch, setNsfwResult, getNsfwStats } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Public defaults. Live values are pulled from `config.advanced.nsfw`
// at every entry point so a `config_updated` save takes effect on the
// next scan without a restart.
//
// `dtype` controls which ONNX variant transformers.js downloads:
//   q8  → onnx/model_quantized.onnx  (~85 MB, default — int8 quantized)
//   fp16→ onnx/model_fp16.onnx       (~165 MB, half precision)
//   fp32→ onnx/model.onnx            (~330 MB, full precision)
// q8 is the default because (a) every well-maintained transformers.js
// classifier ships a quantized variant; (b) the accuracy hit on a binary
// safe/unsafe classifier is negligible; (c) the smaller download is
// friendlier to first-run installs on metered connections.
//
// Default model: AdamCodd/vit-base-nsfw-detector. It's the de-facto
// transformers.js NSFW classifier with full ONNX coverage (model.onnx,
// model_quantized.onnx, model_fp16.onnx, model_q4.onnx, model_int8.onnx,
// …). The popular `Falconsai/nsfw_image_detection` repo is PyTorch-only
// — its `onnx/` directory 404s, so transformers.js can't load it. We
// surface Falconsai as a suggestion still, but operators who want it
// have to host their own ONNX export.
export const NSFW_DEFAULTS = Object.freeze({
    model: 'AdamCodd/vit-base-nsfw-detector',
    dtype: 'q8',
    threshold: 0.6,
    concurrency: 1,
    fileTypes: ['photo'],
    cacheDir: 'data/models',
    batchSize: 50,
});

// Suggestions surfaced as a `<datalist>` in the UI — operators can pick
// or just type any HuggingFace `owner/model` id. Not a closed enum: any
// model that exposes the transformers.js `image-classification` pipeline
// will work, and the dtype-fallback chain in `_loadClassifier` smooths
// over models that ship only a subset of ONNX variants.
//
// Order matters: AdamCodd first since it's the working default. Marqo
// is a heavier 384-px alternative for libraries where accuracy beats
// download size.
export const NSFW_MODEL_SUGGESTIONS = Object.freeze([
    'AdamCodd/vit-base-nsfw-detector',
    'Marqo/nsfw-image-detection-384',
]);

const VALID_DTYPES = new Set(['q8', 'fp16', 'fp32', 'q4']);

// Lazy classifier singleton. The transformers module is heavy
// (~10 MB of JS + WASM glue) so we only require() it when the operator
// actually triggers a scan — fresh installs that never touch the
// feature pay nothing at boot.
let _pipelinePromise = null;
let _activeModelId = null;

function _resolveCacheDirAbs(cacheDirCfg) {
    const raw = cacheDirCfg || NSFW_DEFAULTS.cacheDir;
    return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

async function _loadClassifier(cfg, onProgress, onLog) {
    const _log = (level, msg) => { try { if (typeof onLog === 'function') onLog({ source: 'nsfw', level, msg }); } catch {} };
    const modelId = cfg.model || NSFW_DEFAULTS.model;
    const dtypeWanted = VALID_DTYPES.has(String(cfg.dtype || '').toLowerCase())
        ? String(cfg.dtype).toLowerCase()
        : NSFW_DEFAULTS.dtype;
    const cacheKey = `${modelId}::${dtypeWanted}`;
    if (_pipelinePromise && _activeModelId === cacheKey) {
        _log('info', `model already loaded — reusing pipeline for ${modelId} (${dtypeWanted})`);
        return _pipelinePromise;
    }

    _activeModelId = cacheKey;
    _pipelinePromise = (async () => {
        const cacheDirAbs = _resolveCacheDirAbs(cfg.cacheDir);
        if (!existsSync(cacheDirAbs)) {
            await fs.mkdir(cacheDirAbs, { recursive: true });
            _log('info', `created model cache dir at ${cacheDirAbs}`);
        }
        _log('info', `loading classifier — model=${modelId} dtype=${dtypeWanted} cacheDir=${cacheDirAbs}`);

        // Dynamic import keeps a fresh install from paying the WASM-load
        // cost on every boot. Wrapped in try/catch so a missing or
        // platform-incompatible install fails CLEANLY at scan time
        // instead of crashing the web process at module-load.
        let mod;
        try {
            mod = await import('@huggingface/transformers');
        } catch (e) {
            _log('error', `@huggingface/transformers import failed: ${e?.message || e}`);
            const err = new Error(
                `Failed to load @huggingface/transformers: ${e.message}. `
                + 'Install with `npm install @huggingface/transformers`.'
            );
            err.code = 'NSFW_LIB_MISSING';
            throw err;
        }
        const { pipeline, env } = mod;

        // Steer model + asset downloads into our project-local cache so
        // they survive container recreates (data/ is bind-mounted) and
        // operators can pre-seed by copying the directory.
        try { env.cacheDir = cacheDirAbs; } catch {}
        // Force WASM execution everywhere. Native onnxruntime-node is a
        // glibc-only prebuilt — on Alpine it 500s at load. WASM works
        // 1:1 across every platform with a small perf trade-off that we
        // gladly pay for the install-anywhere story.
        try {
            if (env?.backends?.onnx?.wasm) {
                // Single thread — most hosts don't have SharedArrayBuffer
                // wired up, and multi-thread WASM only helps when they do.
                env.backends.onnx.wasm.numThreads = 1;
            }
        } catch {}
        // HuggingFace token (env var or `config.advanced.ai.hfToken` set
        // via the dashboard) — same treatment as ai/models.js so the
        // NSFW classifier also benefits from gated-repo access + rate-
        // limit bypass.
        try {
            let token = process.env.HF_TOKEN
                || process.env.HUGGINGFACE_TOKEN
                || process.env.HUGGINGFACEHUB_API_TOKEN
                || null;
            if (!token) {
                try {
                    const { loadConfig } = await import('../config/manager.js');
                    const live = loadConfig();
                    const cfgToken = live?.advanced?.ai?.hfToken;
                    if (typeof cfgToken === 'string' && cfgToken.trim()) {
                        token = cfgToken.trim();
                    }
                } catch { /* config not ready */ }
            }
            if (token) {
                try { env.token = token; } catch {}
                try {
                    if (!env.customHeaders) env.customHeaders = {};
                    env.customHeaders.Authorization = `Bearer ${token}`;
                } catch {}
            }
        } catch {}

        // Try the requested dtype first. If the model doesn't ship that
        // variant on the HF CDN (the unquantized model.onnx is the most
        // common offender), fall back through the chain so the operator
        // doesn't have to know which precision a given model bundles.
        const fallbackOrder = [dtypeWanted, ...['q8', 'fp16', 'fp32', 'q4'].filter(d => d !== dtypeWanted)];
        let lastErr = null;
        for (const dtype of fallbackOrder) {
            try {
                const cls = await pipeline('image-classification', modelId, {
                    dtype,
                    progress_callback: (p) => {
                        try {
                            if (typeof onProgress === 'function') onProgress(p);
                        } catch { /* swallow — UI hint, not load-critical */ }
                    },
                });
                if (dtype !== dtypeWanted) {
                    _log('warn', `${dtypeWanted} variant unavailable for ${modelId} — fell back to ${dtype}`);
                }
                return cls;
            } catch (e) {
                lastErr = e;
                const msg = String(e?.message || e);
                // Only fall through on "file not found" style errors.
                // Other failures (auth, permissions, OOM) shouldn't trigger
                // a brute-force cycle through every variant.
                if (!/locate file|ENOENT|HTTP error|404|not found/i.test(msg)) throw e;
                _log('warn', `dtype=${dtype} unavailable: ${msg}`);
            }
        }
        throw lastErr || new Error(`No usable ONNX variant found for ${modelId}`);
    })().catch((e) => {
        // Reset the cached promise so the next call retries instead of
        // returning the rejected promise forever.
        _pipelinePromise = null;
        _activeModelId = null;
        throw e;
    });
    return _pipelinePromise;
}

/**
 * Classify a single image file by absolute path.
 * @returns {Promise<{ score: number, label: string } | null>}
 *   score = probability that the image is NSFW (0-1).
 *   null when the file can't be opened (caller persists `nsfw_checked_at`
 *   so the loop doesn't keep retrying).
 */
async function _classifyFile(classifier, absPath) {
    if (!existsSync(absPath)) return null;
    let out;
    try {
        out = await classifier(absPath);
    } catch {
        return null;
    }
    // pipeline('image-classification') returns
    //   [{ label: 'nsfw', score: 0.94 }, { label: 'normal', score: 0.06 }]
    // for the Falconsai model. Be tolerant of label spelling — different
    // models use 'porn' / 'sexy' / 'hentai' / etc.
    const arr = Array.isArray(out) ? out : [];
    let nsfwScore = 0;
    for (const r of arr) {
        const lbl = String(r?.label || '').toLowerCase();
        const s = Number(r?.score) || 0;
        if (/(nsfw|porn|hentai|sexy|explicit|adult)/.test(lbl)) {
            if (s > nsfwScore) nsfwScore = s;
        }
    }
    return { score: nsfwScore, label: nsfwScore >= 0.5 ? 'nsfw' : 'normal' };
}

// ---- Scan loop ------------------------------------------------------------
//
// "candidates" = photos the classifier thinks are NOT 18+ → the rows the
// review sheet surfaces for admin deletion. The library is curated 18+
// content; anything the classifier flags as low-score is what slipped
// through and needs manual purge.

let _scanRunning = false;
let _scanAbort = null;
let _scanState = {
    running: false,
    scanned: 0,
    total: 0,
    candidates: 0,    // low-score rows surfaced for deletion
    keep: 0,          // high-score rows the classifier confirmed as 18+
    startedAt: null,
    finishedAt: null,
    error: null,
};

export function getScanState(cfg) {
    const stats = getNsfwStats(cfg.fileTypes || NSFW_DEFAULTS.fileTypes,
        cfg.threshold ?? NSFW_DEFAULTS.threshold);
    return {
        ..._scanState,
        ...stats,
        model: cfg.model || NSFW_DEFAULTS.model,
        threshold: cfg.threshold ?? NSFW_DEFAULTS.threshold,
    };
}

/**
 * Start a background scan. Returns immediately — caller polls
 * `getScanState` or listens for `nsfw_progress` / `nsfw_done` over WS.
 *
 * Multiple concurrent calls are guarded — second call returns a
 * `{ alreadyRunning: true }` payload instead of starting a duplicate
 * loop.
 *
 * @param {object} cfg                config.advanced.nsfw
 * @param {(p:object) => void} onProgress  fires every batch with progress
 * @param {(p:object) => void} onDone      fires once when the loop ends
 * @param {(p:object) => void} [onModel]   fires while the model is downloading
 * @param {(p:object) => void} [onLog]     structured log sink ({source,level,msg}) — server.js wires this to the realtime log channel
 */
export async function startScan(cfg, onProgress, onDone, onModel, onLog) {
    const _log = (level, msg) => { try { if (typeof onLog === 'function') onLog({ source: 'nsfw', level, msg }); } catch {} };
    if (_scanRunning) {
        _log('warn', 'startScan called while a previous scan is in flight — returning {alreadyRunning:true}');
        return { alreadyRunning: true };
    }
    _scanRunning = true;
    const ctrl = new AbortController();
    _scanAbort = ctrl;
    const fileTypes = (cfg.fileTypes && cfg.fileTypes.length) ? cfg.fileTypes : NSFW_DEFAULTS.fileTypes;
    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : NSFW_DEFAULTS.threshold;
    const concurrency = Math.max(1, Math.min(4, Number(cfg.concurrency) || NSFW_DEFAULTS.concurrency));
    const batchSize = Math.max(1, Math.min(500, Number(cfg.batchSize) || NSFW_DEFAULTS.batchSize));

    _scanState = {
        running: true, scanned: 0, total: 0, candidates: 0, keep: 0,
        startedAt: Date.now(), finishedAt: null, error: null,
    };

    // Total = remaining unscanned eligible photos. Done in advance so the
    // progress UI can show a determinate percentage.
    const baseStats = getNsfwStats(fileTypes, threshold);
    _scanState.total = Math.max(0, baseStats.totalEligible - baseStats.scanned);
    _scanState.candidates = baseStats.candidates;
    _scanState.keep = baseStats.keep;
    if (typeof onProgress === 'function') onProgress({ ..._scanState });

    if (_scanState.total === 0) {
        _log('info', `nothing to scan — totalEligible=${baseStats.totalEligible} alreadyScanned=${baseStats.scanned}. Library may be empty (DB rows=0) — try Maintenance → Re-index from disk if files exist.`);
    } else {
        _log('info', `starting scan — ${_scanState.total} unscanned ${fileTypes.join('/')} rows, batch=${batchSize}, concurrency=${concurrency}, threshold=${threshold}`);
    }

    // Background driver — fire-and-forget, errors funnel into onDone.
    (async () => {
        let classifier;
        try {
            classifier = await _loadClassifier(cfg, (p) => {
                try { if (typeof onModel === 'function') onModel(p); } catch {}
            }, onLog);
        } catch (e) {
            _log('error', `classifier load failed: ${e?.message || e}`);
            _scanState.error = e.message;
            _scanState.running = false;
            _scanState.finishedAt = Date.now();
            _scanRunning = false;
            _scanAbort = null;
            try { if (typeof onDone === 'function') onDone({ ..._scanState }); } catch {}
            return;
        }

        const resolveAbs = (storedPath) => {
            if (!storedPath) return null;
            if (path.isAbsolute(storedPath) && existsSync(storedPath)) return storedPath;
            let s = String(storedPath).replace(/\\/g, '/');
            while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
            const candidate = path.join(DATA_DIR, 'downloads', s);
            if (existsSync(candidate)) return candidate;
            if (existsSync(storedPath)) return storedPath;
            return null;
        };

        let lastBroadcast = 0;
        const maybeBroadcast = (force = false) => {
            const now = Date.now();
            if (!force && (now - lastBroadcast) < 500) return;
            lastBroadcast = now;
            try { if (typeof onProgress === 'function') onProgress({ ..._scanState }); } catch {}
        };

        try {
            while (!ctrl.signal.aborted) {
                const batch = getUnscannedNsfwBatch(fileTypes, batchSize);
                if (!batch.length) break;

                if (concurrency <= 1) {
                    for (const row of batch) {
                        if (ctrl.signal.aborted) break;
                        const abs = resolveAbs(row.file_path);
                        let res = null;
                        try { res = await _classifyFile(classifier, abs); }
                        catch { res = null; }
                        const score = res ? res.score : null;
                        setNsfwResult(row.id, score);
                        _scanState.scanned += 1;
                        if (score != null) {
                            if (score >= threshold) _scanState.keep += 1;
                            else _scanState.candidates += 1;
                        }
                        maybeBroadcast();
                    }
                } else {
                    // Chunked parallelism — preserves the in-process
                    // singleton classifier (which is single-thread anyway)
                    // by splitting on chunks of `concurrency` instead of
                    // firing the whole batch.
                    for (let i = 0; i < batch.length; i += concurrency) {
                        if (ctrl.signal.aborted) break;
                        const chunk = batch.slice(i, i + concurrency);
                        await Promise.all(chunk.map(async (row) => {
                            if (ctrl.signal.aborted) return;
                            const abs = resolveAbs(row.file_path);
                            let res = null;
                            try { res = await _classifyFile(classifier, abs); }
                            catch { res = null; }
                            const score = res ? res.score : null;
                            setNsfwResult(row.id, score);
                            _scanState.scanned += 1;
                            if (score != null) {
                            if (score >= threshold) _scanState.keep += 1;
                            else _scanState.candidates += 1;
                        }
                        }));
                        maybeBroadcast();
                    }
                }
            }
        } catch (e) {
            _scanState.error = e.message;
        } finally {
            _scanState.running = false;
            _scanState.finishedAt = Date.now();
            _scanRunning = false;
            _scanAbort = null;
            // Refresh counts from DB — locally-bumped counters above can
            // drift if a row got whitelisted mid-scan.
            try {
                const fresh = getNsfwStats(fileTypes, threshold);
                _scanState.candidates = fresh.candidates;
                _scanState.keep = fresh.keep;
            } catch {}
            maybeBroadcast(true);
            try { if (typeof onDone === 'function') onDone({ ..._scanState }); } catch {}
        }
    })().catch(() => { /* never throw out of the async IIFE */ });

    return { started: true };
}

export function cancelScan() {
    if (!_scanAbort) return false;
    try { _scanAbort.abort(); } catch {}
    return true;
}

export function isScanRunning() {
    return _scanRunning;
}

// Background single-row classifier — fired by the downloader's post-
// download hook so newly-arrived files are scored without waiting for
// the next batch scan. Best-effort:
//   - Returns immediately when NSFW review is disabled in config.
//   - Skips the row if the file_type isn't on the configured allowlist.
//   - Honors the same per-kind concurrency cap as the batch scan via
//     a shared semaphore (single classifier instance, single thread).
//   - Failures are silent — the next manual scan will pick up unscored
//     rows since `nsfw_checked_at` only gets set on success.
const _bgQueue = [];
let _bgRunning = false;

export function pregenerateNsfw(downloadId) {
    queueMicrotask(() => {
        // Defer the actual work + cap queue depth so a 1000-file backfill
        // doesn't pile up 1000 in-memory entries. The post-download hook
        // is fire-and-forget; if we can't accept the work right now we
        // simply skip — the next batch scan covers the row instead.
        if (_bgQueue.length > 200) return;
        _bgQueue.push(downloadId);
        _drainBg();
    });
}

async function _drainBg() {
    if (_bgRunning) return;
    _bgRunning = true;
    try {
        const { loadConfig } = await import('../config/manager.js');
        // Re-resolve config every drain — picks up live changes without
        // a server restart, same pattern as the WASM classifier itself.
        let cfg;
        try {
            const live = loadConfig();
            cfg = {
                ...NSFW_DEFAULTS,
                ...(live.advanced?.nsfw || {}),
                enabled: live.advanced?.nsfw?.enabled === true,
            };
        } catch { cfg = { ...NSFW_DEFAULTS, enabled: false }; }
        if (!cfg.enabled) { _bgQueue.length = 0; return; }

        let classifier;
        try { classifier = await _loadClassifier(cfg); }
        catch { _bgQueue.length = 0; return; }

        const db = getDb();
        const lookupRow = db.prepare(`
            SELECT id, file_path, file_type, nsfw_checked_at
              FROM downloads
             WHERE id = ?
        `);
        const fileTypeOk = new Set((cfg.fileTypes || NSFW_DEFAULTS.fileTypes).map(s => String(s).toLowerCase()));

        while (_bgQueue.length) {
            const id = _bgQueue.shift();
            const row = lookupRow.get(Number(id));
            if (!row) continue;
            // Skip already-scored rows so a re-trigger (e.g. file_hash
            // dedup that re-uses an existing row) never re-spends CPU.
            if (row.nsfw_checked_at != null) continue;
            if (!fileTypeOk.has(String(row.file_type || '').toLowerCase())) continue;

            // Resolve absolute path the same way the batch scan does.
            let abs = null;
            if (row.file_path) {
                if (path.isAbsolute(row.file_path) && existsSync(row.file_path)) {
                    abs = row.file_path;
                } else {
                    let s = String(row.file_path).replace(/\\/g, '/');
                    while (s.startsWith('data/downloads/')) s = s.slice('data/downloads/'.length);
                    const candidate = path.join(DATA_DIR, 'downloads', s);
                    if (existsSync(candidate)) abs = candidate;
                    else if (existsSync(row.file_path)) abs = row.file_path;
                }
            }

            let score = null;
            if (abs) {
                try {
                    const r = await _classifyFile(classifier, abs);
                    if (r) score = r.score;
                } catch { /* per-file failure: leave score NULL but mark scanned */ }
            }
            try { setNsfwResult(id, score); } catch { /* best-effort */ }
        }
    } finally {
        _bgRunning = false;
    }
}

// Module-level cleanup on graceful shutdown — lets the host release
// classifier memory if the process is asked to exit nicely.
export async function disposeClassifier() {
    if (!_pipelinePromise) return;
    try {
        const cls = await _pipelinePromise;
        if (cls && typeof cls.dispose === 'function') await cls.dispose();
    } catch { /* best-effort */ }
    _pipelinePromise = null;
    _activeModelId = null;
}

// Last-known load state. Updated by the progress callback inside
// _loadClassifier wrappers — the UI polls this so it can render a
// progress bar even between WS messages.
let _loadState = {
    state: 'idle',          // 'idle' | 'loading' | 'ready' | 'error'
    model: null,
    dtype: null,
    progress: null,         // { file, loaded, total, progress }
    error: null,
    startedAt: null,
    finishedAt: null,
};

export function classifierReady() {
    return {
        ..._loadState,
        ready: _loadState.state === 'ready',
    };
}

/**
 * Pre-fetch the classifier without starting a scan. Returns immediately;
 * the actual download runs in the background and emits progress through
 * `onProgress` and `onLog` (server.js wires both into the realtime log
 * channel + the `nsfw_model_downloading` WS event).
 *
 *   { started: true }            — preload kicked off (or already ready)
 *   { alreadyLoading: true }     — a previous preload/scan is mid-download
 */
export async function preloadClassifier(cfg, onProgress, onLog) {
    const _log = (level, msg) => { try { if (typeof onLog === 'function') onLog({ source: 'nsfw', level, msg }); } catch {} };
    const modelId = cfg.model || NSFW_DEFAULTS.model;
    const dtype = VALID_DTYPES.has(String(cfg.dtype || '').toLowerCase())
        ? String(cfg.dtype).toLowerCase()
        : NSFW_DEFAULTS.dtype;
    if (_loadState.state === 'loading' && _loadState.model === modelId && _loadState.dtype === dtype) {
        _log('info', `preload skipped — already loading ${modelId} (${dtype})`);
        return { alreadyLoading: true };
    }
    if (_loadState.state === 'ready' && _activeModelId === `${modelId}::${dtype}`) {
        _log('info', `preload skipped — ${modelId} (${dtype}) already loaded`);
        return { started: true, alreadyReady: true };
    }
    _loadState = {
        state: 'loading',
        model: modelId,
        dtype,
        progress: null,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
    };
    _log('info', `preload starting — ${modelId} (${dtype})`);
    // Fire-and-forget — caller doesn't await the actual download.
    (async () => {
        try {
            await _loadClassifier({ ...cfg, model: modelId, dtype }, (p) => {
                try {
                    _loadState.progress = p;
                    if (typeof onProgress === 'function') onProgress(p);
                } catch {}
            }, onLog);
            _loadState.state = 'ready';
            _loadState.finishedAt = Date.now();
            _log('info', `preload complete — ${modelId} (${dtype}) ready`);
        } catch (e) {
            _loadState.state = 'error';
            _loadState.error = e?.message || String(e);
            _loadState.finishedAt = Date.now();
            _log('error', `preload failed: ${_loadState.error}`);
        }
    })();
    return { started: true };
}

/**
 * Wipe the on-disk model cache + drop any in-process pipeline so the next
 * load re-downloads a clean copy. Returns the bytes freed so the UI can
 * show a confirmation toast.
 */
export async function clearClassifierCache(cfg) {
    await disposeClassifier();
    _loadState = { state: 'idle', model: null, dtype: null, progress: null, error: null, startedAt: null, finishedAt: null };
    const cacheDirAbs = _resolveCacheDirAbs(cfg.cacheDir);
    if (!existsSync(cacheDirAbs)) return { bytes: 0, files: 0 };
    let bytes = 0;
    let files = 0;
    const walk = async (dir) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) { await walk(p); continue; }
            try {
                const st = await fs.stat(p);
                bytes += st.size;
                files += 1;
                await fs.unlink(p);
            } catch { /* best-effort per file */ }
        }
        try { await fs.rmdir(dir); } catch { /* parent walk drains the rest */ }
    };
    await walk(cacheDirAbs);
    try { await fs.mkdir(cacheDirAbs, { recursive: true }); } catch {}
    return { bytes, files };
}

// Make the DB getter accessible to callers that just want the stats
// without spinning up the classifier (e.g. status polling).
export { getNsfwStats };

// Expose the underlying DB module via re-export so server.js doesn't
// have to import from db.js separately just to wire NSFW endpoints.
export { whitelistNsfw, getNsfwDeleteCandidates } from './db.js';
