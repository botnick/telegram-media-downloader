/**
 * HTTP client for the Python face-detection sidecar.
 *
 * Owns nothing persistent: the URL is set by `faces-spawn.js` (Track C)
 * on boot — empty string disables, a non-empty URL switches the client
 * to that sidecar. Docker installs override via the `FACES_SERVICE_URL`
 * env so they talk to the bundled `tgdl-faces` container directly.
 *
 * Wire format (matches faces-service/tgdl_faces/app.py):
 *   POST /detect  { path, min_score, min_box_px, ar_range }
 *                 → 200 { faces: [{ x, y, w, h, score, embedding[], landmarks? }] }
 *                 → 403 { code: 'path_not_allowed' }  (sandbox; fall back to b64)
 *                 → 5xx { error }                     (retry with backoff)
 *
 * Output contract for callers (faces.js / scan-runner.js / index.js):
 *   - `null` on total failure (network gone, retries exhausted, decode died).
 *   - `[]` when the sidecar replied but found no faces.
 *   - `[{x, y, w, h, score, embedding: Float32Array, landmarks?}, …]` on success.
 *     The `embedding` MUST be a `Float32Array` — scan-runner.js's `_f32ToBlob`
 *     reads `.buffer`/`.byteLength` so a plain array breaks the DB write.
 */

import { promises as fs } from 'fs';
import { Buffer } from 'buffer';
import { spawn } from 'child_process';

import { resolveFacesValue } from './faces-config.js';

// Defaults used when the operator hasn't tuned `advanced.ai.faces.*` and
// hasn't set any of the matching `TGDL_FACES_*` env vars. `applyFacesCfg`
// pushes operator values on top, so this is the bare-install behaviour.
const HEALTH_CACHE_TTL_MS_DEFAULT = 5000;
// CPU-only buffalo_l inference can take 5-30 s per image on slow hardware;
// 60 s gives headroom without hanging the scan loop forever on a dead sidecar.
const REQUEST_TIMEOUT_MS_DEFAULT = 60000;
const MAX_RETRIES_DEFAULT = 3;
const RETRY_BACKOFF_MS_DEFAULT = [300, 600, 1200];

// Mutable runtime knobs. Initialised from defaults; overridden by either:
//   - `applyFacesCfg(resolvedCfg)` — called by faces-spawn at boot.
//   - Env vars on first access — for code paths that import the client
//     before spawn has run (e.g. AI maintenance card during cold boot).
let _healthCacheTtlMs = HEALTH_CACHE_TTL_MS_DEFAULT;
let _requestTimeoutMs = REQUEST_TIMEOUT_MS_DEFAULT;
let _maxRetries = MAX_RETRIES_DEFAULT;
let _retryBackoffMs = RETRY_BACKOFF_MS_DEFAULT.slice();
let _maxConcurrency = 0; // 0 = unlimited
let _inflight = 0;
let _envBootstrapped = false;
let _pathRejectedLogged = false;

let _sidecarUrl = '';
let _healthCache = null; // { value, expiresAt }

/**
 * Apply a resolved faces config snapshot to the client's runtime knobs.
 * Called by `faces-spawn._doStart()` once it's read `loadConfig()` + env.
 * Safe to call multiple times — later calls overwrite earlier values.
 *
 * Treats every key as optional: a partial snapshot only updates the
 * supplied knobs and leaves the rest untouched. Invalid values fall back
 * to the previous setting so a broken env var doesn't disable retries.
 */
export function applyFacesCfg(cfg = {}) {
    if (!cfg || typeof cfg !== 'object') return;
    if (Number.isFinite(cfg.healthCacheTtlMs) && cfg.healthCacheTtlMs >= 0) {
        _healthCacheTtlMs = cfg.healthCacheTtlMs | 0;
    }
    if (Number.isFinite(cfg.requestTimeoutMs) && cfg.requestTimeoutMs > 0) {
        _requestTimeoutMs = cfg.requestTimeoutMs | 0;
    }
    if (Number.isFinite(cfg.maxRetries) && cfg.maxRetries >= 0) {
        _maxRetries = cfg.maxRetries | 0;
    }
    if (Array.isArray(cfg.retryBackoffMs) && cfg.retryBackoffMs.length) {
        const cleaned = cfg.retryBackoffMs
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n >= 0);
        if (cleaned.length) _retryBackoffMs = cleaned;
    }
    if (Number.isFinite(cfg.sidecarMaxConcurrency) && cfg.sidecarMaxConcurrency >= 0) {
        _maxConcurrency = cfg.sidecarMaxConcurrency | 0;
    }
    _envBootstrapped = true;
}

// Lazy env bootstrap for code paths that import the client before spawn —
// e.g. the AI maintenance card hitting `/api/ai/status` during cold boot.
// Once `applyFacesCfg` has run we trust the snapshot it pushed.
function _bootstrapFromEnv() {
    if (_envBootstrapped) return;
    _envBootstrapped = true;
    const probe = (key) => resolveFacesValue(key, {});
    const ttl = probe('healthCacheTtlMs');
    if (Number.isFinite(ttl) && ttl >= 0) _healthCacheTtlMs = ttl | 0;
    const to = probe('requestTimeoutMs');
    if (Number.isFinite(to) && to > 0) _requestTimeoutMs = to | 0;
    const mr = probe('maxRetries');
    if (Number.isFinite(mr) && mr >= 0) _maxRetries = mr | 0;
    const bo = probe('retryBackoffMs');
    if (Array.isArray(bo) && bo.length) _retryBackoffMs = bo;
    const mc = probe('sidecarMaxConcurrency');
    if (Number.isFinite(mc) && mc >= 0) _maxConcurrency = mc | 0;
}

/**
 * Set the sidecar base URL. Empty string disables the client entirely
 * (callers see `getSidecarUrl()` return null). Called by `faces-spawn.js`
 * once the child process is healthy, and by Docker boot when
 * `FACES_SERVICE_URL` env is present.
 *
 * Mutating the URL invalidates the cached health probe so the next caller
 * doesn't see a stale "down" / "up" answer from the previous sidecar.
 */
export function setSidecarUrl(url) {
    const next = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (next === _sidecarUrl) return;
    _sidecarUrl = next;
    _healthCache = null;
}

/** Current sidecar URL or null when none is configured. */
export function getSidecarUrl() {
    return _sidecarUrl || null;
}

const HEALTH_PROBE_TIMEOUT_MS = 5000;
const HEALTH_PROBE_RETRIES = 3;

/**
 * Probe the sidecar's `/health` endpoint. Result is cached for 5 s — the
 * AI maintenance card polls this on every redraw and the sidecar's
 * `/health` is otherwise hit several times per second during a scan.
 *
 * Retries up to `HEALTH_PROBE_RETRIES` times on network / 5xx errors
 * before caching a failure so a single transient blip doesn't flip the
 * status card red. Uses a dedicated 5 s timeout (not `_requestTimeoutMs`)
 * so a hung sidecar never blocks the maintenance page.
 *
 * NEVER throws — a thrown error here would cascade into a broken card
 * (the AI panel is the only thing that reports sidecar status, so it
 * must always render). On failure returns `{ ok: false, error }`.
 */
export async function health() {
    _bootstrapFromEnv();
    const url = getSidecarUrl();
    if (!url) return { ok: false, error: 'sidecar_url_unset' };
    const now = Date.now();
    if (_healthCache && _healthCache.expiresAt > now) {
        return _healthCache.value;
    }
    let value;
    let lastErr = null;
    for (let attempt = 0; attempt < HEALTH_PROBE_RETRIES; attempt++) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
            let res;
            try {
                res = await globalThis.fetch(`${url}/health`, {
                    method: 'GET',
                    signal: ctrl.signal,
                });
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                lastErr = new Error(`http_${res.status}`);
                // 5xx is retryable; 4xx is a final answer.
                if (res.status < 500) {
                    value = { ok: false, error: `http_${res.status}` };
                    break;
                }
                continue;
            }
            const body = await res.json();
            value = {
                ok: body?.ok === true,
                version: body?.version ?? null,
                model: body?.model ?? null,
                dim: body?.dim ?? null,
                ready: body?.ready === true,
                // Forward the new diagnostic fields (Phase 6) so the AI
                // maintenance card can render real state instead of just
                // a green dot. Older sidecars (pre-Track-I) don't ship
                // these — leave them null so the UI knows to fall back.
                providersResolved: Array.isArray(body?.providers_resolved)
                    ? body.providers_resolved.slice()
                    : null,
                providersRequested: body?.providers_requested ?? null,
                detSize: Number.isFinite(body?.det_size) ? body.det_size : null,
                platform: typeof body?.platform === 'string' ? body.platform : null,
                python: typeof body?.python === 'string' ? body.python : null,
            };
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
        }
    }
    if (value === undefined) {
        value = { ok: false, error: lastErr?.message || String(lastErr) };
    }
    _healthCache = { value, expiresAt: now + _healthCacheTtlMs };
    return value;
}

/**
 * Detect faces in one image via the sidecar. Path mode first; on
 * `403 path_not_allowed` falls back to b64 mode (POSTs the bytes
 * directly — needed for Docker installs where the sidecar container
 * cannot see host-side paths).
 *
 * @param {string} absPath absolute path to the source image
 * @param {object} cfg     `advanced.ai` config slice
 * @param {function?} onLog optional `({source, level, msg}) => void`
 * @returns {Promise<Array | null>}
 */
export async function detectFaces(absPath, cfg = {}, onLog = null) {
    _bootstrapFromEnv();
    const url = getSidecarUrl();
    if (!url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFaces returning null');
        return null;
    }
    // Resolve detection thresholds with the same precedence as the rest of
    // the stack: explicit `cfg.faces.*` > legacy flat alias > env override >
    // hardcoded default. The caller passes `cfg.advanced.ai` (or the
    // already-flattened `cfg`), so we probe both shapes.
    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];

    const baseBody = { min_score: minScore, min_box_px: minBoxPx, ar_range: arRange };
    const pathBody = { ...baseBody, path: absPath };

    // Concurrency gate — operator can cap inflight detects on shared NAS
    // hardware where running 16 simultaneous detections OOMs the box.
    // 0 = unlimited (default).
    if (_maxConcurrency > 0) {
        while (_inflight >= _maxConcurrency) {
            await _sleep(25);
        }
    }
    _inflight++;
    try {
        return await _detectInner(absPath, pathBody, baseBody, url, onLog);
    } finally {
        _inflight = Math.max(0, _inflight - 1);
    }
}

/**
 * Detect faces in a batch of images via the sidecar's `/detect/batch`
 * endpoint — one HTTP round-trip for up to `batchSize` files.
 *
 * @param {string[]}  absPaths absolute paths to source images
 * @param {object}    cfg      `advanced.ai` config slice
 * @param {function?} onLog    optional `({source, level, msg}) => void`
 * @returns {Promise<Array<Array|null>>} same order as input;
 *   `null`  = sidecar error / path unresolvable
 *   `[]`    = processed but no faces found
 *   `[…]`  = detected faces
 *   Items rejected with `path_not_allowed` (Docker sandbox) are retried
 *   individually via the single-detect b64 fallback path.
 */
export async function detectFacesBatch(absPaths, cfg = {}, onLog = null, signal = null) {
    _bootstrapFromEnv();
    if (!absPaths.length) return [];
    const url = getSidecarUrl();
    if (!url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFacesBatch returning nulls');
        return absPaths.map(() => null);
    }

    // Path mode already known to fail — detect individually via b64.
    if (_pathRejectedLogged) {
        const out = [];
        for (const p of absPaths) {
            if (signal?.aborted) {
                out.push(null);
                continue;
            }
            out.push(await detectFaces(p, cfg, onLog));
        }
        return out;
    }

    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];

    // Sidecar processes the batch sequentially — scale timeout with count.
    const batchTimeoutMs = Math.max(absPaths.length * _requestTimeoutMs, 120_000);
    const body = { files: absPaths, min_score: minScore, min_box_px: minBoxPx, ar_range: arRange };

    let batchRes;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), batchTimeoutMs);
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        }
        try {
            batchRes = await globalThis.fetch(`${url}/detect/batch`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        _log(onLog, 'warn', `detectFacesBatch: network error — ${e?.message || e}`);
        return absPaths.map(() => null);
    }

    if (!batchRes.ok) {
        _log(onLog, 'warn', `detectFacesBatch: sidecar returned ${batchRes.status}`);
        return absPaths.map(() => null);
    }

    let batchBody;
    try {
        batchBody = await batchRes.json();
    } catch (e) {
        _log(onLog, 'warn', `detectFacesBatch: invalid JSON — ${e?.message || e}`);
        return absPaths.map(() => null);
    }

    const resultMap = new Map();
    for (const item of batchBody?.results ?? []) {
        resultMap.set(item.file, item);
    }

    const output = new Array(absPaths.length).fill(null);
    const pathFallbacks = [];

    for (let i = 0; i < absPaths.length; i++) {
        const item = resultMap.get(absPaths[i]);
        if (!item) continue; // path missing from response → null
        if (item.error === 'path_not_allowed') {
            pathFallbacks.push(i);
            continue;
        }
        if (item.error) {
            // decode_failed is expected for animated/compressed non-image files
            // (e.g. gzip-wrapped Telegram sticker documents with a .webp extension).
            // Log at info to keep the log feed clean; other soft errors stay at warn.
            const lvl = item.error === 'decode_failed' ? 'info' : 'warn';
            _log(onLog, lvl, `batch detect ${absPaths[i]}: sidecar soft-error="${item.error}"`);
            output[i] = []; // soft error → empty (sidecar reached the file)
            continue;
        }
        output[i] = _parseFacesList(item.faces);
    }

    if (pathFallbacks.length) {
        _log(onLog, 'info', 'path mode rejected by sidecar; switching to b64 for all files');
        _pathRejectedLogged = true;
    }
    for (const idx of pathFallbacks) {
        output[idx] = await detectFaces(absPaths[idx], cfg, onLog);
    }

    return output;
}

/**
 * Detect faces in a video file via the sidecar's `/detect/video` endpoint.
 * Frames are extracted and deduplicated server-side — no temp files on disk.
 * The returned faces land in the same `faces` table as photo-source faces,
 * so DBSCAN Phase B clusters them together automatically.
 *
 * @param {string}    absPath absolute path to the video file
 * @param {object}    cfg     `advanced.ai` config slice
 * @param {function?} onLog   optional `({source, level, msg}) => void`
 * @returns {Promise<Array | null>}
 *   `null` = sidecar error / file unresolvable
 *   `[]`   = processed but no faces found
 *   `[…]` = detected unique faces (one embedding per person per video)
 */
export async function detectFacesInVideo(absPath, cfg = {}, onLog = null, signal = null) {
    _bootstrapFromEnv();
    const url = getSidecarUrl();
    if (!url) {
        _log(onLog, 'warn', 'sidecar URL unset — detectFacesInVideo returning null');
        return null;
    }

    // Path mode already known to fail — skip straight to b64 fallback.
    if (_pathRejectedLogged) {
        return _detectVideoB64Fallback(absPath, cfg, url, onLog, signal);
    }

    const facesCfg = cfg?.faces || cfg || {};
    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];
    const maxFrames = _pickNumber([facesCfg.videoMaxFrames, cfg?.videoMaxFrames], 120);

    const body = {
        path: absPath,
        min_score: minScore,
        min_box_px: minBoxPx,
        ar_range: arRange,
        max_frames: Math.max(1, Math.min(500, maxFrames)),
    };

    // Video detection is much slower than a single image — scale timeout
    // by max_frames so a 2-hour video (120 frames) doesn't time out on
    // slow CPU-only hardware.
    const videoTimeoutMs = Math.max(body.max_frames * _requestTimeoutMs, 300_000);

    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), videoTimeoutMs);
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        }
        try {
            res = await globalThis.fetch(`${url}/detect/video`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        _log(
            onLog,
            'warn',
            `detectFacesInVideo: network error for ${absPath} — ${e?.message || e}`,
        );
        return null;
    }

    if (res.status === 403) {
        let code = null;
        try {
            const body = await res.clone().json();
            code = body?.code || null;
        } catch {}
        if (code === 'path_not_allowed') {
            if (!_pathRejectedLogged) {
                _log(
                    onLog,
                    'info',
                    'video path mode rejected by sidecar; switching to b64 fallback for all files',
                );
                _pathRejectedLogged = true;
            }
            return _detectVideoB64Fallback(absPath, cfg, url, onLog, signal);
        }
        _log(onLog, 'warn', `detectFacesInVideo: sidecar returned 403 for ${absPath}`);
        return null;
    }

    if (!res.ok) {
        _log(onLog, 'warn', `detectFacesInVideo: sidecar returned ${res.status} for ${absPath}`);
        return null;
    }

    let resBody;
    try {
        resBody = await res.json();
    } catch (e) {
        _log(onLog, 'warn', `detectFacesInVideo: invalid JSON from sidecar: ${e?.message || e}`);
        return null;
    }

    if (resBody?.error) {
        const lvl = resBody.error === 'file_not_found' ? 'warn' : 'info';
        _log(onLog, lvl, `detectFacesInVideo ${absPath}: sidecar soft-error="${resBody.error}"`);
        return [];
    }

    return _parseFacesList(Array.isArray(resBody?.faces) ? resBody.faces : []);
}

async function _sendB64(absPath, baseBody, url, onLog) {
    let bytes;
    try {
        bytes = await fs.readFile(absPath);
    } catch (e) {
        _log(onLog, 'warn', `b64 read failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
    const b64Body = { ...baseBody, image_b64: Buffer.from(bytes).toString('base64') };
    try {
        return await _postWithRetry(`${url}/detect`, b64Body, onLog);
    } catch (e) {
        _log(onLog, 'warn', `detect b64-mode failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
}

async function _detectInner(absPath, pathBody, baseBody, url, onLog) {
    let res;

    if (_pathRejectedLogged) {
        res = await _sendB64(absPath, baseBody, url, onLog);
        if (res === null) return null;
    } else {
        try {
            res = await _postWithRetry(`${url}/detect`, pathBody, onLog);
        } catch (e) {
            _log(onLog, 'warn', `detect path-mode failed for ${absPath}: ${e?.message || e}`);
            return null;
        }

        if (res && res.status === 403) {
            let code = null;
            try {
                const body = await res.clone().json();
                code = body?.code || null;
            } catch {}
            if (code === 'path_not_allowed') {
                _log(
                    onLog,
                    'info',
                    'path mode rejected by sidecar; switching to b64 for all files',
                );
                _pathRejectedLogged = true;
                res = await _sendB64(absPath, baseBody, url, onLog);
                if (res === null) return null;
            }
        }
    }

    if (!res || !res.ok) {
        const status = res?.status ?? 'no_response';
        _log(onLog, 'warn', `detect ${absPath}: sidecar returned ${status}`);
        return null;
    }

    let body;
    try {
        body = await res.json();
    } catch (e) {
        _log(onLog, 'warn', `detect ${absPath}: invalid JSON from sidecar: ${e?.message || e}`);
        return null;
    }

    // The sidecar returns 200 + an `error` field for soft failures
    // (file_not_found, decode_failed). Log them so the scan summary
    // shows *why* a photo yielded 0 faces instead of silently moving on.
    if (body?.error) {
        _log(
            onLog,
            'warn',
            `detect ${absPath}: sidecar soft-error="${body.error}" — 0 faces stored`,
        );
    }
    return _parseFacesList(Array.isArray(body?.faces) ? body.faces : []);
}

// Parse a raw faces array from the sidecar into typed Face objects.
// Shared by both single-detect and batch paths.
function _parseFacesList(faces) {
    if (!Array.isArray(faces)) return [];
    return faces
        .map((f) => {
            // Embedding must be Float32Array — downstream (`_f32ToBlob`)
            // reads `.buffer` / `.byteLength`. A plain JS array breaks the
            // DB write silently (writes [object Array] as text).
            const emb = Array.isArray(f?.embedding) ? Float32Array.from(f.embedding) : null;
            if (!emb || !emb.length) return null;
            const out = {
                x: Number(f.x) || 0,
                y: Number(f.y) || 0,
                w: Number(f.w) || 0,
                h: Number(f.h) || 0,
                score: Number.isFinite(f.score) ? Number(f.score) : 0,
                qualityScore: Number.isFinite(f.quality_score) ? Number(f.quality_score) : null,
                embedding: emb,
            };
            if (f.landmarks != null) out.landmarks = f.landmarks;
            return out;
        })
        .filter(Boolean);
}

/**
 * POST with linear-backoff retry on 5xx / network errors. 403 / 4xx
 * (except 408 / 429) return the response immediately so the caller can
 * inspect the body — those are not retryable.
 */
async function _postWithRetry(url, body, onLog) {
    const maxRetries = Math.max(1, _maxRetries);
    const base = _baseUrl(url);
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let bail = false;
        let bailReason = '';
        try {
            const res = await _fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            // Retry only on 5xx, 408, 429 — everything else (200/4xx) is
            // a final answer the caller needs to see.
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                lastErr = new Error(`sidecar http ${res.status}`);
            } else {
                return res;
            }
        } catch (e) {
            lastErr = e;
            if (attempt < maxRetries - 1) {
                if (e?.name === 'AbortError') {
                    // Client-side timeout: sidecar is alive but slow — don't retry
                    // (piling up requests against a slow CPU just makes it worse).
                    bail = true;
                    bailReason = `— timed out after ${_requestTimeoutMs}ms, skipping image`;
                } else {
                    // Network error: quick health probe to detect a crashed sidecar.
                    const alive = await _quickHealthProbe(base);
                    if (!alive) {
                        bail = true;
                        bailReason = '— sidecar unreachable, aborting';
                        _healthCache = null;
                    }
                }
            }
        }
        const hasMore = attempt < maxRetries - 1 && !bail;
        const backoff =
            _retryBackoffMs[attempt] ?? _retryBackoffMs[_retryBackoffMs.length - 1] ?? 300;
        const suffix = bail ? bailReason : hasMore ? `— retrying in ${backoff} ms` : '— giving up';
        _log(
            onLog,
            'warn',
            `sidecar POST ${url} attempt ${attempt + 1}/${maxRetries} failed: ${
                lastErr?.message || lastErr
            } ${suffix}`,
        );
        if (bail) break;
        if (hasMore) await _sleep(backoff);
    }
    throw lastErr || new Error('sidecar POST: retries exhausted');
}

/** Strip the endpoint path to get the sidecar base URL for health probing. */
function _baseUrl(endpointUrl) {
    try {
        const u = new URL(endpointUrl);
        return `${u.protocol}//${u.host}`;
    } catch {
        return endpointUrl.replace(/\/[^/]*$/, '');
    }
}

/**
 * Single-attempt health probe with a 1 s timeout. Used inside the retry
 * loop to detect a crashed sidecar without waiting for the full
 * `health()` cache TTL or its 3-retry budget.
 */
async function _quickHealthProbe(baseUrl) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1000);
        try {
            const r = await globalThis.fetch(`${baseUrl}/health`, { signal: ctrl.signal });
            return r.ok;
        } finally {
            clearTimeout(t);
        }
    } catch {
        return false;
    }
}

/** fetch() with a hard timeout via AbortController. */
async function _fetchWithTimeout(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
        try {
            ctrl.abort();
        } catch {
            /* AbortController.abort() never throws but defend anyway */
        }
    }, _requestTimeoutMs);
    try {
        return await globalThis.fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

function _pickNumber(candidates, fallback) {
    for (const c of candidates) {
        if (Number.isFinite(c)) return c;
    }
    return fallback;
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function _log(onLog, level, msg) {
    if (typeof onLog !== 'function') return;
    try {
        onLog({ source: 'ai-faces-client', level, msg });
    } catch {
        /* logging must never throw out of the client */
    }
}

// ---- Video b64 fallback (external sidecar without shared filesystem) ----

let _ffmpegBin = null;

async function _resolveFfmpegForFaces() {
    if (_ffmpegBin !== null) return _ffmpegBin;
    try {
        const mod = await import('../thumbs.js');
        _ffmpegBin = mod.resolveFfmpegBin();
    } catch {
        _ffmpegBin = 'ffmpeg';
    }
    return _ffmpegBin;
}

/**
 * Extract evenly-spaced JPEG frames from a video using ffmpeg.
 * Returns an array of Buffer (raw JPEG bytes) for each frame.
 * Mirrors the Python sidecar's `extract_video_frames` logic.
 */
async function _extractVideoFrames(absPath, maxFrames, onLog) {
    const bin = await _resolveFfmpegForFaces();

    // Step 1: get video duration via ffprobe-style ffmpeg output
    const duration = await new Promise((resolve) => {
        const args = ['-hide_banner', '-i', absPath, '-f', 'null', '-'];
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        proc.on('close', () => {
            const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (m) {
                resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
            } else {
                resolve(0);
            }
        });
        proc.on('error', () => resolve(0));
    });

    if (duration <= 0) {
        _log(onLog, 'warn', `video b64 fallback: could not determine duration for ${absPath}`);
        return [];
    }

    // Step 2: compute seek positions (evenly spaced, skip first/last 0.5s)
    const start = Math.min(0.5, duration * 0.05);
    const end = Math.max(duration - 0.5, duration * 0.95);
    const span = end - start;
    const nFrames = Math.min(maxFrames, Math.max(1, Math.floor(duration)));
    const positions = [];
    if (nFrames === 1) {
        positions.push(start + span / 2);
    } else {
        for (let i = 0; i < nFrames; i++) {
            positions.push(start + (span * i) / (nFrames - 1));
        }
    }

    // Step 3: extract each frame as JPEG bytes piped to stdout
    const frames = [];
    for (const pos of positions) {
        const buf = await new Promise((resolve) => {
            const args = [
                '-hide_banner',
                '-loglevel',
                'error',
                '-ss',
                String(pos),
                '-i',
                absPath,
                '-frames:v',
                '1',
                '-f',
                'image2',
                '-c:v',
                'mjpeg',
                '-q:v',
                '3',
                'pipe:1',
            ];
            const proc = spawn(bin, args, {
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
            const chunks = [];
            proc.stdout.on('data', (d) => chunks.push(d));
            proc.on('close', (code) => {
                if (code === 0 && chunks.length) {
                    resolve(Buffer.concat(chunks));
                } else {
                    resolve(null);
                }
            });
            proc.on('error', () => resolve(null));
        });
        if (buf) frames.push(buf);
    }
    return frames;
}

/**
 * Deduplicate faces across video frames. Keeps the highest-score face
 * per identity (cosine similarity >= 0.50 threshold on L2-normalised
 * embeddings). Mirrors Python's `_dedupe_video_faces`.
 */
function _dedupeVideoFaces(allFaces) {
    const THRESHOLD = 0.5;
    const uniqueEmbs = [];
    const uniqueFaces = [];
    for (const face of allFaces) {
        const emb = face.embedding;
        let matched = false;
        for (let i = 0; i < uniqueEmbs.length; i++) {
            const dot = _dotProduct(emb, uniqueEmbs[i]);
            if (dot >= THRESHOLD) {
                if (face.score > uniqueFaces[i].score) {
                    uniqueEmbs[i] = emb;
                    uniqueFaces[i] = face;
                }
                matched = true;
                break;
            }
        }
        if (!matched) {
            uniqueEmbs.push(emb);
            uniqueFaces.push(face);
        }
    }
    return uniqueFaces;
}

function _dotProduct(a, b) {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) sum += a[i] * b[i];
    return sum;
}

/**
 * Video b64 fallback: extract frames locally with ffmpeg, send as a
 * batch to the sidecar's /detect/batch-b64 endpoint (GPU-pipelined),
 * then deduplicate. Falls back to one-by-one /detect if batch-b64 is
 * unavailable (older sidecar).
 */
async function _detectVideoB64Fallback(absPath, cfg, url, onLog, signal) {
    const facesCfg = cfg?.faces || cfg || {};
    const maxFrames = _pickNumber([facesCfg.videoMaxFrames, cfg?.videoMaxFrames], 120);
    const capped = Math.max(1, Math.min(500, maxFrames));

    _log(onLog, 'info', `video b64 fallback: extracting up to ${capped} frames from ${absPath}`);
    const frames = await _extractVideoFrames(absPath, capped, onLog);
    if (!frames.length) {
        _log(onLog, 'warn', `video b64 fallback: no frames extracted for ${absPath}`);
        return [];
    }
    _log(
        onLog,
        'info',
        `video b64 fallback: extracted ${frames.length} frames, sending to sidecar`,
    );

    const minScore = _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5);
    const minBoxPx = _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60);
    const arRange =
        Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
            ? facesCfg.arRange
            : [0.5, 2.0];

    // Try batch-b64 endpoint (GPU-pipelined, much faster)
    const allFaces = await _sendBatchB64(
        frames,
        { minScore, minBoxPx, arRange },
        url,
        onLog,
        signal,
    );
    return _dedupeVideoFaces(allFaces);
}

const BATCH_B64_CHUNK = 20;

async function _sendBatchB64(frames, { minScore, minBoxPx, arRange }, url, onLog, signal) {
    const allFaces = [];

    // Send frames in chunks to avoid huge payloads
    for (let start = 0; start < frames.length; start += BATCH_B64_CHUNK) {
        if (signal?.aborted) break;
        const chunk = frames.slice(start, start + BATCH_B64_CHUNK);
        const body = {
            images: chunk.map((buf) => buf.toString('base64')),
            min_score: minScore,
            min_box_px: minBoxPx,
            ar_range: arRange,
        };
        const timeoutMs = Math.max(chunk.length * _requestTimeoutMs, 120_000);
        let res;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            if (signal) {
                if (signal.aborted) ctrl.abort();
                else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
            }
            try {
                res = await globalThis.fetch(`${url}/detect/batch-b64`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: ctrl.signal,
                });
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            // batch-b64 not available — fall back to one-by-one
            if (start === 0) {
                _log(onLog, 'info', 'batch-b64 unavailable, falling back to sequential detect');
                return _sendFramesSequential(
                    frames,
                    { minScore, minBoxPx, arRange },
                    url,
                    onLog,
                    signal,
                );
            }
            continue;
        }
        if (res.status === 404 || res.status === 405) {
            // Older sidecar without batch-b64 endpoint
            _log(onLog, 'info', 'batch-b64 not supported, falling back to sequential detect');
            return _sendFramesSequential(
                frames,
                { minScore, minBoxPx, arRange },
                url,
                onLog,
                signal,
            );
        }
        if (!res.ok) continue;
        let resBody;
        try {
            resBody = await res.json();
        } catch {
            continue;
        }
        for (const item of resBody?.results ?? []) {
            if (item.error) continue;
            const parsed = _parseFacesList(Array.isArray(item.faces) ? item.faces : []);
            allFaces.push(...parsed);
        }
    }
    return allFaces;
}

async function _sendFramesSequential(frames, { minScore, minBoxPx, arRange }, url, onLog, signal) {
    const allFaces = [];
    for (const frameBuf of frames) {
        if (signal?.aborted) break;
        const b64Body = {
            image_b64: frameBuf.toString('base64'),
            min_score: minScore,
            min_box_px: minBoxPx,
            ar_range: arRange,
        };
        let res;
        try {
            res = await _postWithRetry(`${url}/detect`, b64Body, onLog);
        } catch {
            continue;
        }
        if (!res || !res.ok) continue;
        let resBody;
        try {
            resBody = await res.json();
        } catch {
            continue;
        }
        const parsed = _parseFacesList(Array.isArray(resBody?.faces) ? resBody.faces : []);
        allFaces.push(...parsed);
    }
    return allFaces;
}

/** Test-only: clear cached URL + health probe so each spec starts fresh. */
export function _resetForTests() {
    _sidecarUrl = '';
    _healthCache = null;
    _healthCacheTtlMs = HEALTH_CACHE_TTL_MS_DEFAULT;
    _requestTimeoutMs = REQUEST_TIMEOUT_MS_DEFAULT;
    _maxRetries = MAX_RETRIES_DEFAULT;
    _retryBackoffMs = RETRY_BACKOFF_MS_DEFAULT.slice();
    _maxConcurrency = 0;
    _inflight = 0;
    _envBootstrapped = false;
    _pathRejectedLogged = false;
    _ffmpegBin = null;
}

/** Test-only: snapshot the resolved runtime knobs. */
export function _runtimeKnobs() {
    return {
        healthCacheTtlMs: _healthCacheTtlMs,
        requestTimeoutMs: _requestTimeoutMs,
        maxRetries: _maxRetries,
        retryBackoffMs: _retryBackoffMs.slice(),
        sidecarMaxConcurrency: _maxConcurrency,
    };
}
