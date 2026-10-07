/**
 * NSFW classifier — single-process, in-Node, cross-platform.
 *
 * Phase 1: photos only. Maintenance triggers a one-shot batch scan
 * that classifies every previously-unscanned photo, persists the
 * `nsfw_score` to the DB, and broadcasts progress over WebSocket. The
 * UI then shows a review sheet listing flagged rows so the admin can
 * eye-check + delete.
 *
 * Backend: `@huggingface/transformers` on onnxruntime-node (CPU),
 * running in a worker thread (nsfw-worker.js) so inference and image
 * decoding never block the web server's event loop. An external GPU
 * sidecar (nsfw-client.js) can replace the local model entirely.
 *
 * Every knob is config-driven — model id, threshold, concurrency,
 * cache directory, eligible file types — so operators can tune
 * without touching code.
 */

import path from 'path';
import os from 'os';
import { existsSync, promises as fs } from 'fs';
import { Worker } from 'worker_threads';
import sharp from 'sharp';
import {
    getDb,
    getUnscannedNsfwBatch,
    setNsfwResult,
    getNsfwStats,
    checkNsfwBlocklistHashes,
} from './db.js';
import { sha256OfFile } from './checksum.js';
import { getSpritePath, getMetaFilePath } from './seekbar/generator.js';
import { getDataDir, getRepoRoot } from './paths.js';
import * as gocoreClient from './gocore/client.js';
import {
    setSidecarUrl as _setNsfwSidecarUrl,
    setSidecarAuth as _setNsfwSidecarAuth,
    setPathMap as _setNsfwPathMap,
    getSidecarUrl as getNsfwSidecarUrl,
    getSidecarInfo as getNsfwSidecarInfo,
    applyNsfwSidecarCfg,
    health as nsfwSidecarHealth,
    classifyFile as remoteClassifyFile,
    classifyBuffer as remoteClassifyBuffer,
} from './nsfw-client.js';

const DATA_DIR = getDataDir();

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
    concurrency: 2,
    fileTypes: ['photo'],
    cacheDir: 'data/models',
    batchSize: 50,
    videoMaxTiles: 48,
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

// Env wins over the dashboard config for each value, so a compose file
// stays the source of truth when it sets one.
function _envOr(name, fallback) {
    const v = process.env[name];
    return typeof v === 'string' && v.trim() ? v : fallback;
}

export function initNsfwSidecar(cfg) {
    const nsfwCfg = cfg?.advanced?.nsfw || {};
    _setNsfwSidecarUrl(_envOr('TGDL_NSFW_SIDECAR_URL', nsfwCfg.sidecarUrl || ''));
    _setNsfwSidecarAuth(_envOr('TGDL_NSFW_API_TOKEN', nsfwCfg.apiToken || ''));
    _setNsfwPathMap(_envOr('TGDL_NSFW_PATH_MAP', nsfwCfg.pathMap || ''));
    if (nsfwCfg) applyNsfwSidecarCfg(nsfwCfg);
}

/** Where each sidecar setting comes from — the dashboard greys env-set fields out. */
export function getNsfwSidecarSources() {
    const src = (name) => (process.env[name]?.trim() ? 'env' : 'config');
    return {
        url: src('TGDL_NSFW_SIDECAR_URL'),
        token: src('TGDL_NSFW_API_TOKEN'),
        pathMap: src('TGDL_NSFW_PATH_MAP'),
    };
}

export { getNsfwSidecarUrl, getNsfwSidecarInfo };

// Classifier worker singleton. The model, onnxruntime and sharp decodes
// all live in a worker thread (see nsfw-worker.js for why), spawned
// lazily when the operator actually triggers a scan — fresh installs that
// never touch the feature pay nothing at boot — and terminated after
// WORKER_IDLE_MS without work so the model's memory is handed back.
let _worker = null;
let _workerReady = null; // Promise<handle> for the current worker
let _activeModelId = null;
let _workerCallbacks = { onProgress: null, onLog: null };
let _reqSeq = 0;
const _pending = new Map(); // id -> { resolve, reject }
let _idleTimer = null;
const WORKER_IDLE_MS = 5 * 60 * 1000;
const WORKER_BATCH_SIZE = 4;
// Rows per worker round trip in a local batch scan.
const LOCAL_CHUNK = 8;

function _resolveCacheDirAbs(cacheDirCfg) {
    const raw = cacheDirCfg || NSFW_DEFAULTS.cacheDir;
    return path.isAbsolute(raw) ? raw : path.resolve(getRepoRoot(), raw);
}

// intra-op threads for inference. onnxruntime defaults to every logical
// core, which oversubscribes the CPU (hyper-threads, the web server,
// downloads and the faces sidecar all compete) — measured 2.4× slower per
// image than 8 threads on a 32-thread host. Half the cores, capped at 8,
// leaves room for everything else. TGDL_NSFW_THREADS overrides.
function _inferenceThreads() {
    const env = Number.parseInt(process.env.TGDL_NSFW_THREADS, 10);
    if (Number.isFinite(env) && env > 0) return env;
    return Math.max(1, Math.min(8, Math.floor(os.availableParallelism() / 2)));
}

async function _hfToken() {
    // HuggingFace token (env var or `config.advanced.ai.hfToken` set via
    // the dashboard) — same treatment as ai/models.js so the NSFW
    // classifier also benefits from gated-repo access + rate-limit bypass.
    const token =
        process.env.HF_TOKEN ||
        process.env.HUGGINGFACE_TOKEN ||
        process.env.HUGGINGFACEHUB_API_TOKEN ||
        null;
    if (token) return token;
    try {
        const { loadConfig } = await import('../config/manager.js');
        const cfgToken = loadConfig()?.advanced?.ai?.hfToken;
        if (typeof cfgToken === 'string' && cfgToken.trim()) return cfgToken.trim();
    } catch {
        /* config not ready */
    }
    return null;
}

function _terminateWorker() {
    clearTimeout(_idleTimer);
    _idleTimer = null;
    const w = _worker;
    _worker = null;
    _workerReady = null;
    _activeModelId = null;
    for (const { reject } of _pending.values()) reject(new Error('NSFW worker stopped'));
    _pending.clear();
    if (w) w.terminate().catch(() => {});
}

function _armIdleTimer() {
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
        if (_pending.size === 0) _terminateWorker();
        else _armIdleTimer();
    }, WORKER_IDLE_MS);
    _idleTimer.unref?.();
}

function _classifyViaWorker(items) {
    return new Promise((resolve, reject) => {
        if (!_worker) {
            reject(new Error('NSFW worker not running'));
            return;
        }
        const id = ++_reqSeq;
        _pending.set(id, { resolve, reject });
        clearTimeout(_idleTimer);
        _worker.postMessage({ type: 'classify', id, items });
    });
}

async function _loadClassifier(cfg, onProgress, onLog) {
    const _log = (level, msg) => {
        try {
            if (typeof onLog === 'function') onLog({ source: 'nsfw', level, msg });
        } catch {}
    };
    const modelId = cfg.model || NSFW_DEFAULTS.model;
    const dtypeWanted = VALID_DTYPES.has(String(cfg.dtype || '').toLowerCase())
        ? String(cfg.dtype).toLowerCase()
        : NSFW_DEFAULTS.dtype;
    const cacheKey = `${modelId}::${dtypeWanted}`;
    _workerCallbacks = { onProgress, onLog };
    if (_workerReady && _activeModelId === cacheKey) {
        _log('info', `model already loaded — reusing worker for ${modelId} (${dtypeWanted})`);
        return _workerReady;
    }
    _terminateWorker();
    _activeModelId = cacheKey;

    const cacheDirAbs = _resolveCacheDirAbs(cfg.cacheDir);
    if (!existsSync(cacheDirAbs)) {
        await fs.mkdir(cacheDirAbs, { recursive: true });
        _log('info', `created model cache dir at ${cacheDirAbs}`);
    }
    const threads = _inferenceThreads();
    _log(
        'info',
        `loading classifier — model=${modelId} dtype=${dtypeWanted} threads=${threads} cacheDir=${cacheDirAbs}`,
    );
    const token = await _hfToken();

    const worker = new Worker(new URL('./nsfw-worker.js', import.meta.url));
    // Never keep the process alive just for an idle classifier.
    worker.unref();
    _worker = worker;
    const ready = new Promise((resolve, reject) => {
        worker.on('message', (msg) => {
            if (msg.type === 'progress') {
                try {
                    _workerCallbacks.onProgress?.(msg.p);
                } catch {
                    /* swallow — UI hint, not load-critical */
                }
            } else if (msg.type === 'log') {
                try {
                    _workerCallbacks.onLog?.({ source: 'nsfw', level: msg.level, msg: msg.msg });
                } catch {}
            } else if (msg.type === 'ready') {
                resolve({ model: msg.model, dtype: msg.dtype, classify: _classifyViaWorker });
                _armIdleTimer();
            } else if (msg.type === 'init-error') {
                const err = new Error(msg.message);
                if (msg.code) err.code = msg.code;
                reject(err);
            } else if (msg.type === 'result') {
                const p = _pending.get(msg.id);
                if (!p) return;
                _pending.delete(msg.id);
                if (_pending.size === 0) _armIdleTimer();
                p.resolve(msg.results);
            }
        });
        const onDeath = (e) => {
            if (_worker !== worker) return;
            _log('error', `classifier worker died: ${e?.message || e}`);
            reject(e instanceof Error ? e : new Error(String(e)));
            _terminateWorker();
        };
        worker.on('error', onDeath);
        worker.on('exit', (code) => {
            if (_worker === worker) onDeath(new Error(`exited with code ${code}`));
        });
    });
    worker.postMessage({
        type: 'init',
        modelId,
        dtype: dtypeWanted,
        cacheDir: cacheDirAbs,
        token,
        threads,
        batchSize: WORKER_BATCH_SIZE,
    });
    _workerReady = ready.catch((e) => {
        // Reset so the next call retries instead of returning the
        // rejected promise forever.
        if (_worker === worker) _terminateWorker();
        throw e;
    });
    return _workerReady;
}

/**
 * Classify a single image file by absolute path.
 * @returns {Promise<{ score: number, label: string } | null>}
 *   score = probability that the image is NSFW (0-1).
 *   null when the file can't be opened (caller persists `nsfw_checked_at`
 *   so the loop doesn't keep retrying).
 */
async function _classifyFile(classifier, absPath, onLog = null) {
    if (!absPath) return null;
    if (getNsfwSidecarUrl()) {
        return remoteClassifyFile(absPath, {}, onLog);
    }
    if (!classifier || !existsSync(absPath)) return null;
    try {
        return (await classifier.classify([{ kind: 'file', path: absPath }]))[0];
    } catch {
        return null;
    }
}

// ---- Video sprite classifier ----------------------------------------------

/**
 * Sprite geometry + sampled tile indices for a video's seekbar sprite, or
 * null when no sprite exists (caller stores a null score so the row isn't
 * re-fetched endlessly) or the sprite metadata is malformed.
 *
 * @param {number} downloadId   downloads.id
 * @param {number} [maxTiles]   sample budget; falls back to NSFW_DEFAULTS.videoMaxTiles
 */
async function _videoTileItem(downloadId, maxTiles) {
    const limit = Math.max(1, Number(maxTiles) || NSFW_DEFAULTS.videoMaxTiles);
    const spritePath = getSpritePath(downloadId);
    const metaPath = getMetaFilePath(downloadId);
    if (!existsSync(spritePath) || !existsSync(metaPath)) return null;

    let meta;
    try {
        meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
        return null;
    }

    const cols = Number(meta.cols) || 1;
    const rows = Number(meta.rows) || 1;
    const tileW = Number(meta.tile_w) || 0;
    const totalFrames = Number(meta.frames) || cols * rows;
    if (tileW <= 0 || totalFrames <= 0) return null;

    const sampleCount = Math.min(limit, totalFrames);
    const step = totalFrames / sampleCount;
    const indices = Array.from({ length: sampleCount }, (_, k) => Math.floor(k * step));
    // tile_h may be 0 in the sidecar — the worker derives it from the
    // decoded sprite height.
    const tileH = Number(meta.tile_h) || 0;
    return { kind: 'tiles', spritePath, cols, rows, tileW, tileH, indices };
}

/**
 * Classify a video by sampling tiles from its seekbar sprite sheet.
 *
 * Aggregation: top-3 average — requires consensus from multiple tiles rather
 * than flagging on any single tile, which dramatically reduces false positives
 * from brief on-screen graphics / thumbnails.
 *
 * @param {object} classifier   worker handle from _loadClassifier (null in sidecar mode)
 * @param {number} downloadId   downloads.id
 * @param {number} [maxTiles]   sample budget; falls back to NSFW_DEFAULTS.videoMaxTiles
 * @param {function} [onLog]    structured log sink for sidecar errors
 */
async function _classifyVideoSprite(classifier, downloadId, maxTiles, onLog = null) {
    const item = await _videoTileItem(downloadId, maxTiles);
    if (!item) return null;
    if (!getNsfwSidecarUrl()) {
        // Local: the worker decodes the sprite once and batches the tiles.
        if (!classifier) return null;
        return (await classifier.classify([item]))[0];
    }

    // The sidecar gets each tile as JPEG bytes. Never a temp-file path: the
    // sidecar can't read the app's temp dir, and a rejected path would
    // switch the whole session away from path mode.
    let tileH = item.tileH;
    if (tileH <= 0) {
        try {
            const m = await sharp(item.spritePath, { failOn: 'none' }).metadata();
            if ((m.height || 0) > 0) tileH = Math.floor(m.height / item.rows);
        } catch {
            return null;
        }
    }
    if (tileH <= 0) return null;

    const scores = [];
    for (const i of item.indices) {
        const left = (i % item.cols) * item.tileW;
        const top = Math.floor(i / item.cols) * tileH;
        let tile;
        try {
            tile = await sharp(item.spritePath, { failOn: 'none' })
                .extract({ left, top, width: item.tileW, height: tileH })
                .jpeg({ quality: 85 })
                .toBuffer();
        } catch {
            continue;
        }
        try {
            const res = await remoteClassifyBuffer(tile, {}, onLog);
            if (res) scores.push(res.score);
        } catch {}
    }
    if (scores.length === 0) return { score: 0, label: 'normal' };
    // Top-3 average — consensus required to avoid flagging on a single tile.
    scores.sort((a, b) => b - a);
    const topK = Math.min(3, scores.length);
    const aggregated = scores.slice(0, topK).reduce((s, v) => s + v, 0) / topK;
    return { score: aggregated, label: aggregated >= 0.5 ? 'nsfw' : 'normal' };
}

/**
 * Local-model classification of a chunk of downloads rows in one worker
 * round trip, so photos share a batched inference call.
 * @returns {Promise<Array<{ score: number, label: string } | null>>} per row
 */
async function _classifyRowsLocal(classifier, rows, resolveAbs, videoMaxTiles) {
    const out = new Array(rows.length).fill(null);
    const items = [];
    const slots = [];
    for (let k = 0; k < rows.length; k++) {
        const row = rows[k];
        let item = null;
        if (row.file_type === 'video') {
            item = await _videoTileItem(row.id, videoMaxTiles).catch(() => null);
        } else {
            const abs = resolveAbs(row.file_path);
            if (abs) item = { kind: 'file', path: abs };
        }
        if (item) {
            slots.push(k);
            items.push(item);
        }
    }
    if (!items.length) return out;
    // Throws if the worker dies — the scan stops with an error instead of
    // marking the whole chunk as checked with no score.
    const results = await classifier.classify(items);
    slots.forEach((k, j) => {
        out[k] = results[j];
    });
    return out;
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
    candidates: 0, // low-score rows surfaced for deletion
    keep: 0, // high-score rows the classifier confirmed as 18+
    startedAt: null,
    finishedAt: null,
    error: null,
};

/**
 * Keep the progress counters from one scan together. `getNsfwStats()` is a
 * library-wide snapshot, while `_scanState.total` is the denominator for
 * the current run; mixing its global `scanned` count with that denominator
 * makes a completed 14k-row scan look like 399k/14k (over 100%).
 *
 * Exported for the small state-contract test; callers should use
 * `getScanState()` for the public snapshot.
 */
export function _mergeScanState(state, stats) {
    const hasRun = state?.startedAt != null;
    const running = state?.running === true;
    const usableRunCounter = hasRun && !state?.error;
    return {
        ...state,
        ...stats,
        // Keep the idle shape (`total: 0`) and preserve the global scanned
        // count when a run failed before it processed a row. A successful or
        // cancelled run owns its denominator and scanned counter.
        total: state.total,
        scanned: usableRunCounter ? state.scanned : stats.scanned,
        // Once a run is over, reflect the current threshold/whitelist in the
        // DB. During a run, keep the counters from that run in lockstep with
        // its denominator.
        candidates: running ? state.candidates : stats.candidates,
        keep: running ? state.keep : stats.keep,
    };
}

export function getScanState(cfg) {
    const stats = getNsfwStats(
        cfg.fileTypes || NSFW_DEFAULTS.fileTypes,
        cfg.threshold ?? NSFW_DEFAULTS.threshold,
    );
    return {
        ..._mergeScanState(_scanState, stats),
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
    const _log = (level, msg) => {
        try {
            if (typeof onLog === 'function') onLog({ source: 'nsfw', level, msg });
        } catch {}
    };
    if (_scanRunning) {
        _log(
            'warn',
            'startScan called while a previous scan is in flight — returning {alreadyRunning:true}',
        );
        return { alreadyRunning: true };
    }
    _scanRunning = true;
    const ctrl = new AbortController();
    _scanAbort = ctrl;
    const fileTypes =
        cfg.fileTypes && cfg.fileTypes.length ? cfg.fileTypes : NSFW_DEFAULTS.fileTypes;
    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : NSFW_DEFAULTS.threshold;
    const concurrency = Math.max(
        1,
        Math.min(4, Number(cfg.concurrency) || NSFW_DEFAULTS.concurrency),
    );
    const batchSize = Math.max(1, Math.min(500, Number(cfg.batchSize) || NSFW_DEFAULTS.batchSize));
    const videoMaxTiles = Math.max(1, Number(cfg.videoMaxTiles) || NSFW_DEFAULTS.videoMaxTiles);

    _scanState = {
        running: true,
        scanned: 0,
        total: 0,
        candidates: 0,
        keep: 0,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
    };

    // Total = remaining unscanned eligible photos. Done in advance so the
    // progress UI can show a determinate percentage.
    const baseStats = getNsfwStats(fileTypes, threshold);
    _scanState.total = Math.max(0, baseStats.totalEligible - baseStats.scanned);
    _scanState.candidates = baseStats.candidates;
    _scanState.keep = baseStats.keep;
    if (typeof onProgress === 'function') onProgress({ ..._scanState });

    if (_scanState.total === 0) {
        _log(
            'info',
            `nothing to scan — totalEligible=${baseStats.totalEligible} alreadyScanned=${baseStats.scanned}. Library may be empty (DB rows=0) — try Maintenance → Re-index from disk if files exist.`,
        );
    } else {
        _log(
            'info',
            `starting scan — ${_scanState.total} unscanned ${fileTypes.join('/')} rows, batch=${batchSize}, concurrency=${concurrency}, threshold=${threshold}`,
        );
    }

    // Background driver — fire-and-forget, errors funnel into onDone.
    (async () => {
        const useRemote = !!getNsfwSidecarUrl();
        let classifier = null;
        if (useRemote) {
            _log('info', `using external NSFW sidecar at ${getNsfwSidecarUrl()}`);
            const h = await nsfwSidecarHealth();
            if (!h.ok) {
                _log('error', `NSFW sidecar unreachable: ${h.error}`);
                _scanState.error = `sidecar unreachable: ${h.error}`;
                _scanState.running = false;
                _scanState.finishedAt = Date.now();
                _scanRunning = false;
                _scanAbort = null;
                try {
                    if (typeof onDone === 'function') onDone({ ..._scanState });
                } catch {}
                return;
            }
        } else {
            try {
                classifier = await _loadClassifier(
                    cfg,
                    (p) => {
                        try {
                            if (typeof onModel === 'function') onModel(p);
                        } catch {}
                    },
                    onLog,
                );
            } catch (e) {
                _log('error', `classifier load failed: ${e?.message || e}`);
                _scanState.error = e.message;
                _scanState.running = false;
                _scanState.finishedAt = Date.now();
                _scanRunning = false;
                _scanAbort = null;
                try {
                    if (typeof onDone === 'function') onDone({ ..._scanState });
                } catch {}
                return;
            }
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
            if (!force && now - lastBroadcast < 500) return;
            lastBroadcast = now;
            try {
                if (typeof onProgress === 'function') onProgress({ ..._scanState });
            } catch {}
        };

        const record = (row, res) => {
            const score = res ? res.score : null;
            setNsfwResult(row.id, score);
            _scanState.scanned += 1;
            if (score != null) {
                if (score >= threshold) _scanState.keep += 1;
                else _scanState.candidates += 1;
            }
        };

        try {
            while (!ctrl.signal.aborted) {
                let batch;
                if (gocoreClient.isAvailable('db')) {
                    try {
                        batch = (
                            await gocoreClient.nsfwCandidates(
                                { fileTypes, limit: batchSize },
                                { timeoutMs: 5_000, signal: ctrl.signal },
                            )
                        ).rows;
                    } catch {
                        // Older cores and transient restarts use the local
                        // query; the scan remains resumable either way.
                    }
                }
                batch ||= getUnscannedNsfwBatch(fileTypes, batchSize);
                if (!batch.length) break;

                if (!useRemote) {
                    // Local model: one worker round trip per chunk so photos
                    // share a batched inference call. `concurrency` only
                    // applies to the remote sidecar.
                    for (let i = 0; i < batch.length; i += LOCAL_CHUNK) {
                        if (ctrl.signal.aborted) break;
                        const chunk = batch.slice(i, i + LOCAL_CHUNK);
                        const results = await _classifyRowsLocal(
                            classifier,
                            chunk,
                            resolveAbs,
                            videoMaxTiles,
                        );
                        chunk.forEach((row, k) => record(row, results[k]));
                        maybeBroadcast();
                    }
                } else if (concurrency <= 1) {
                    for (const row of batch) {
                        if (ctrl.signal.aborted) break;
                        const abs = resolveAbs(row.file_path);
                        let res = null;
                        try {
                            res =
                                row.file_type === 'video'
                                    ? await _classifyVideoSprite(
                                          classifier,
                                          row.id,
                                          videoMaxTiles,
                                          onLog,
                                      )
                                    : await _classifyFile(classifier, abs, onLog);
                        } catch {
                            res = null;
                        }
                        record(row, res);
                        maybeBroadcast();
                    }
                } else {
                    // Chunked parallelism against the sidecar — chunks of
                    // `concurrency` instead of firing the whole batch.
                    for (let i = 0; i < batch.length; i += concurrency) {
                        if (ctrl.signal.aborted) break;
                        const chunk = batch.slice(i, i + concurrency);
                        await Promise.all(
                            chunk.map(async (row) => {
                                if (ctrl.signal.aborted) return;
                                const abs = resolveAbs(row.file_path);
                                let res = null;
                                try {
                                    res =
                                        row.file_type === 'video'
                                            ? await _classifyVideoSprite(
                                                  classifier,
                                                  row.id,
                                                  videoMaxTiles,
                                                  onLog,
                                              )
                                            : await _classifyFile(classifier, abs, onLog);
                                } catch {
                                    res = null;
                                }
                                record(row, res);
                            }),
                        );
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
            try {
                if (typeof onDone === 'function') onDone({ ..._scanState });
            } catch {}
        }
    })().catch(() => {
        /* never throw out of the async IIFE */
    });

    return { started: true };
}

export function cancelScan() {
    if (!_scanAbort) return false;
    try {
        _scanAbort.abort();
    } catch {}
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

// Optional callback registered by server.js so auto-deletes are visible
// in the realtime log + cause the queue/downloads UI to remove the row.
let _onBlocklistDelete = null;
export function setBlocklistDeleteCallback(fn) {
    _onBlocklistDelete = typeof fn === 'function' ? fn : null;
}

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
        // a server restart, same pattern as the batch scan.
        let cfg;
        try {
            const live = loadConfig();
            const ns = live.advanced?.nsfw || {};
            cfg = {
                ...NSFW_DEFAULTS,
                ...ns,
                enabled: ns.enabled === true,
                blocklistEnabled: ns.blocklistEnabled === true,
            };
        } catch {
            cfg = { ...NSFW_DEFAULTS, enabled: false, blocklistEnabled: false };
        }
        if (!cfg.enabled && !cfg.blocklistEnabled) {
            _bgQueue.length = 0;
            return;
        }

        // Only load classifier when scan is enabled; blocklist check can run
        // without it. Skip local classifier load when a remote sidecar is configured.
        const useRemote = !!getNsfwSidecarUrl();
        let classifier = null;
        if (cfg.enabled && !useRemote) {
            try {
                classifier = await _loadClassifier(cfg);
            } catch {
                if (!cfg.blocklistEnabled) {
                    _bgQueue.length = 0;
                    return;
                }
            }
        }

        const db = getDb();
        const lookupRow = db.prepare(`
            SELECT id, file_path, file_type, file_hash, nsfw_checked_at
              FROM downloads
             WHERE id = ?
        `);
        const fileTypeOk = new Set(
            (cfg.fileTypes || NSFW_DEFAULTS.fileTypes).map((s) => String(s).toLowerCase()),
        );

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

            // Hash-blocklist check — runs even when the classifier is off.
            // If the file's SHA-256 matches a previously-deleted NSFW file,
            // auto-delete it without re-scoring.
            if (cfg.blocklistEnabled) {
                let hash = row.file_hash;
                if (!hash && abs) {
                    try {
                        // Same path as download-time hashing (tgdl-core).
                        hash = await sha256OfFile(abs);
                        // Persist so future checks skip the file I/O.
                        try {
                            db.prepare(
                                'UPDATE downloads SET file_hash = ? WHERE id = ? AND file_hash IS NULL',
                            ).run(hash, Number(id));
                        } catch {}
                    } catch {
                        hash = null;
                    }
                }
                if (hash) {
                    const blocked = checkNsfwBlocklistHashes([hash]);
                    if (blocked.has(hash)) {
                        if (abs) {
                            try {
                                await fs.unlink(abs);
                            } catch {}
                        }
                        let seekbarRow;
                        try {
                            seekbarRow = db
                                .prepare(
                                    'SELECT sprite_path, meta_path FROM seekbar_sprites WHERE download_id = ?',
                                )
                                .get(Number(id));
                        } catch {}
                        let dlRow;
                        try {
                            dlRow = db
                                .prepare(
                                    'SELECT group_id, message_id, media_type FROM downloads WHERE id = ?',
                                )
                                .get(Number(id));
                        } catch {}
                        try {
                            db.prepare('DELETE FROM downloads WHERE id = ?').run(Number(id));
                        } catch {}
                        try {
                            _onBlocklistDelete?.(Number(id), seekbarRow, dlRow);
                        } catch {}
                        continue;
                    }
                }
            }

            if (!cfg.enabled || (!classifier && !useRemote)) continue;

            let score = null;
            try {
                const bgMaxTiles = Math.max(
                    1,
                    Number(cfg.videoMaxTiles) || NSFW_DEFAULTS.videoMaxTiles,
                );
                const r =
                    row.file_type === 'video'
                        ? await _classifyVideoSprite(classifier, Number(row.id), bgMaxTiles)
                        : abs
                          ? await _classifyFile(classifier, abs)
                          : null;
                if (r) score = r.score;
            } catch {
                /* per-file failure: leave score NULL but mark scanned */
            }
            try {
                setNsfwResult(id, score);
            } catch {
                /* best-effort */
            }
        }
    } finally {
        _bgRunning = false;
    }
}

// Module-level cleanup on graceful shutdown — lets the host release
// classifier memory if the process is asked to exit nicely.
export async function disposeClassifier() {
    _terminateWorker();
}

// Last-known load state. Updated by the progress callback inside
// _loadClassifier wrappers — the UI polls this so it can render a
// progress bar even between WS messages.
let _loadState = {
    state: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
    model: null,
    dtype: null,
    progress: null, // { file, loaded, total, progress }
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
    const _log = (level, msg) => {
        try {
            if (typeof onLog === 'function') onLog({ source: 'nsfw', level, msg });
        } catch {}
    };
    if (getNsfwSidecarUrl()) {
        _log('info', `using external NSFW sidecar — skipping local model preload`);
        const h = await nsfwSidecarHealth();
        _loadState = {
            state: h.ok ? 'ready' : 'error',
            model: h.model || 'remote',
            dtype: null,
            progress: null,
            error: h.ok ? null : h.error || 'unreachable',
            startedAt: Date.now(),
            finishedAt: Date.now(),
        };
        return { started: true, remote: true, sidecarHealth: h };
    }
    const modelId = cfg.model || NSFW_DEFAULTS.model;
    const dtype = VALID_DTYPES.has(String(cfg.dtype || '').toLowerCase())
        ? String(cfg.dtype).toLowerCase()
        : NSFW_DEFAULTS.dtype;
    if (
        _loadState.state === 'loading' &&
        _loadState.model === modelId &&
        _loadState.dtype === dtype
    ) {
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
            await _loadClassifier(
                { ...cfg, model: modelId, dtype },
                (p) => {
                    try {
                        _loadState.progress = p;
                        if (typeof onProgress === 'function') onProgress(p);
                    } catch {}
                },
                onLog,
            );
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
 * Awaitable counterpart to preloadClassifier() for
 * `scripts/pre-download-models.js`: loads the configured classifier —
 * downloading it into the cache dir on a cold cache — and resolves once
 * it's ready. Throws on failure instead of recording it in _loadState.
 */
export async function downloadClassifier(cfg, onProgress, onLog) {
    await _loadClassifier(cfg, onProgress, onLog);
    return {
        model: cfg.model || NSFW_DEFAULTS.model,
        cacheDir: _resolveCacheDirAbs(cfg.cacheDir),
    };
}

/**
 * Wipe the on-disk model cache + drop any in-process pipeline so the next
 * load re-downloads a clean copy. Returns the bytes freed so the UI can
 * show a confirmation toast.
 */
export async function clearClassifierCache(cfg) {
    await disposeClassifier();
    _loadState = {
        state: 'idle',
        model: null,
        dtype: null,
        progress: null,
        error: null,
        startedAt: null,
        finishedAt: null,
    };
    const cacheDirAbs = _resolveCacheDirAbs(cfg.cacheDir);
    if (!existsSync(cacheDirAbs)) return { bytes: 0, files: 0 };
    let bytes = 0;
    let files = 0;
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(p);
                continue;
            }
            try {
                const st = await fs.stat(p);
                bytes += st.size;
                files += 1;
                await fs.unlink(p);
            } catch {
                /* best-effort per file */
            }
        }
        try {
            await fs.rmdir(dir);
        } catch {
            /* parent walk drains the rest */
        }
    };
    await walk(cacheDirAbs);
    try {
        await fs.mkdir(cacheDirAbs, { recursive: true });
    } catch {}
    return { bytes, files };
}

// Make the DB getter accessible to callers that just want the stats
// without spinning up the classifier (e.g. status polling).
export { getNsfwStats };

// Expose the underlying DB module via re-export so server.js doesn't
// have to import from db.js separately just to wire NSFW endpoints.
export { whitelistNsfw, getNsfwDeleteCandidates } from './db.js';
