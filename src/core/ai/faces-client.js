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
 *
 * Callers that persist "this file has been scanned" (the scan runner, the
 * pregenerate hook) pass `{ throwOnUnavailable: true }`: a sidecar that is
 * down, restarting, still loading its model or timing out then throws a
 * `SidecarUnavailableError` instead of returning `null`, so a transient
 * outage can't be recorded as "no faces in this photo".
 */

import { promises as fs } from 'fs';
import { Buffer } from 'buffer';
import { spawn } from 'child_process';

import { Agent, fetch as undiciFetch } from 'undici';

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

// Every sidecar request carries its own AbortController deadline (up to
// ~2 h for a long video on a slow CPU). The built-in fetch additionally
// enforces undici's default 300 s headers / body timeouts, which cut
// those requests off early — the video then failed on every retry. All
// sidecar calls go through this npm-undici fetch + Agent pair (never the
// built-in fetch with a foreign dispatcher), with socket timeouts above
// any deadline set here.
const SIDECAR_SOCKET_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const _sidecarAgent = new Agent({
    headersTimeout: SIDECAR_SOCKET_TIMEOUT_MS,
    bodyTimeout: SIDECAR_SOCKET_TIMEOUT_MS,
    connect: { timeout: 10_000 },
});
let _fetchImpl = (url, init) => undiciFetch(url, { ...init, dispatcher: _sidecarAgent });
// Optional shared secret for a sidecar reachable over the network
// (`faces.sidecarToken` / TGDL_FACES_SIDECAR_TOKEN <-> the sidecar's
// TGDL_FACES_API_TOKEN). Sent on every call; sidecars without a token
// configured — including every release before 0.5.0 — ignore it.
let _sidecarToken = '';
const _fetch = (url, init = {}) => {
    if (!_sidecarToken) return _fetchImpl(url, init);
    return _fetchImpl(url, {
        ...init,
        headers: { ...(init.headers || {}), ...sidecarAuthHeaders() },
    });
};

const _UNAUTHORIZED =
    'sidecar rejected the API token (401) — set faces.sidecarToken / TGDL_FACES_SIDECAR_TOKEN to the sidecar TGDL_FACES_API_TOKEN';

/** Auth headers for callers outside this module that talk to the sidecar. */
export function sidecarAuthHeaders() {
    return _sidecarToken ? { authorization: `Bearer ${_sidecarToken}` } : {};
}

/**
 * The sidecar could not produce an answer for reasons unrelated to the
 * input file (connection refused, DNS, timeout, 5xx / 503 model_loading,
 * truncated JSON). Retrying later can succeed; stamping the row cannot
 * be undone. `code` is checked instead of `instanceof` so mocked client
 * modules in tests can throw a plain object-compatible error.
 */
export class SidecarUnavailableError extends Error {
    constructor(message, cause, { timedOut = false, fatal = false } = {}) {
        super(message);
        this.name = 'SidecarUnavailableError';
        this.code = 'SIDECAR_UNAVAILABLE';
        // The sidecar was reachable but our own deadline expired — retrying
        // the same request with the same deadline won't go differently.
        this.timedOut = timedOut;
        // Retrying can't help (e.g. the sidecar rejects our API token):
        // the scan should stop and say so.
        this.fatal = fatal;
        if (cause) this.cause = cause;
    }
}

export function isSidecarUnavailable(e) {
    return e?.code === 'SIDECAR_UNAVAILABLE';
}

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
    if (typeof cfg.sidecarToken === 'string') _sidecarToken = cfg.sidecarToken.trim();
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
    const tok = probe('sidecarToken');
    if (typeof tok === 'string') _sidecarToken = tok.trim();
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
    // A different sidecar may well have the downloads tree mounted — give
    // path mode another chance instead of staying on base64 for good.
    _pathRejectedLogged = false;
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
                res = await _fetch(`${url}/health`, {
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
 * Block until the sidecar answers `/health` with `ok` and a loaded model,
 * or until `timeoutMs` elapses / `signal` aborts. Polls with backoff
 * (1 s → 15 s), bypassing the health cache. Returns true when ready.
 *
 * Used before a scan starts (the auto-resume after a container restart
 * fires long before an auto-spawned sidecar has downloaded + loaded
 * buffalo_l) and after a batch hit a dead sidecar. A URL that is not set
 * yet counts as "not ready" — faces-spawn sets it once the child is up.
 *
 * Works with every sidecar release: `ready` predates this client, and a
 * body without the field is treated as ready.
 */
export async function waitForSidecarReady({
    signal = null,
    timeoutMs = 300_000,
    onLog = null,
} = {}) {
    _bootstrapFromEnv();
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let delay = 1000;
    let announced = false;
    let lastReason = 'sidecar_url_unset';
    while (!signal?.aborted) {
        const url = getSidecarUrl();
        if (url) {
            const probe = await _probeReady(url);
            if (probe.ok) {
                if (announced) _log(onLog, 'info', `face sidecar ready at ${url}`);
                return true;
            }
            lastReason = probe.reason;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        if (!announced) {
            announced = true;
            _log(
                onLog,
                'info',
                `waiting for the face sidecar (${lastReason}) — up to ${Math.round(remaining / 1000)} s`,
            );
        }
        await _sleep(Math.min(delay, remaining), signal);
        delay = Math.min(delay * 2, 15_000);
    }
    if (!signal?.aborted) {
        _log(onLog, 'warn', `face sidecar still not ready (${lastReason})`);
    }
    return false;
}

async function _probeReady(url) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS);
        let res;
        try {
            res = await _fetch(`${url}/health`, { signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) return { ok: false, reason: `http_${res.status}` };
        const body = await res.json();
        if (body?.ok !== true) return { ok: false, reason: body?.error || 'sidecar_not_ok' };
        if (body?.ready === false) return { ok: false, reason: 'model_loading' };
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e?.cause?.code || e?.code || e?.message || String(e) };
    }
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
export async function detectFaces(absPath, cfg = {}, onLog = null, opts = {}) {
    _bootstrapFromEnv();
    const strict = opts?.throwOnUnavailable === true;
    const url = getSidecarUrl();
    if (!url) {
        if (strict) throw new SidecarUnavailableError('sidecar URL unset');
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
        return await _detectInner(absPath, pathBody, baseBody, url, onLog, strict);
    } finally {
        _inflight = Math.max(0, _inflight - 1);
    }
}

/**
 * Detect faces in an in-memory image (e.g. a video frame grabbed for a
 * face crop) via `/detect` in base64 mode. Returns the parsed faces, `[]`
 * for a per-image soft error, or `null` when the sidecar is unset /
 * unreachable / failing — callers treat null as "try again later".
 */
export async function detectFacesInImage(imageBuf, cfg = {}, onLog = null) {
    _bootstrapFromEnv();
    const url = getSidecarUrl();
    if (!url || !imageBuf?.length) return null;
    const facesCfg = cfg?.faces || cfg || {};
    const body = {
        image_b64: Buffer.from(imageBuf).toString('base64'),
        min_score: _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5),
        min_box_px: _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60),
        ar_range:
            Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
                ? facesCfg.arRange
                : [0.5, 2.0],
    };
    try {
        const res = await _postWithRetry(`${url}/detect`, body, onLog);
        if (!res?.ok) return res && res.status < 500 ? [] : null;
        const parsed = await res.json();
        return _parseFacesList(Array.isArray(parsed?.faces) ? parsed.faces : []);
    } catch {
        return null;
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
 *
 * `opts.throwOnUnavailable` — throw `SidecarUnavailableError` for
 *   transport-level failures instead of returning all-null (see header).
 * `opts.timeoutMs` — override the request timeout (the scan runner sizes
 *   it for everything it has in flight, not just this chunk).
 */
export async function detectFacesBatch(absPaths, cfg = {}, onLog = null, signal = null, opts = {}) {
    _bootstrapFromEnv();
    if (!absPaths.length) return [];
    const strict = opts?.throwOnUnavailable === true;
    const unavailable = (msg, cause, extra) => {
        if (strict) throw new SidecarUnavailableError(msg, cause, extra);
        _log(onLog, 'warn', `detectFacesBatch: ${msg}`);
        return absPaths.map(() => null);
    };
    const url = getSidecarUrl();
    if (!url) return unavailable('sidecar URL unset');

    // Path mode already known to fail — detect individually via b64.
    if (_pathRejectedLogged) {
        const out = [];
        for (const p of absPaths) {
            if (signal?.aborted) {
                out.push(null);
                continue;
            }
            out.push(await detectFaces(p, cfg, onLog, { throwOnUnavailable: strict }));
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
    const batchTimeoutMs =
        Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0
            ? opts.timeoutMs
            : Math.max(absPaths.length * _requestTimeoutMs, 120_000);
    const body = { files: absPaths, min_score: minScore, min_box_px: minBoxPx, ar_range: arRange };

    let batchRes;
    let batchBody;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), batchTimeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        batchRes = await _fetch(`${url}/detect/batch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        // Read the body under the same timeout / abort as the request.
        if (batchRes.ok) batchBody = await batchRes.json();
    } catch (e) {
        // A cancelled scan is not an outage — the caller checks its own signal.
        if (signal?.aborted) return absPaths.map(() => null);
        const what =
            e?.name === 'AbortError'
                ? `timed out after ${batchTimeoutMs} ms`
                : e instanceof SyntaxError
                  ? `invalid JSON — ${e.message}`
                  : `network error — ${e?.cause?.code || e?.message || e}`;
        return unavailable(what, e, { timedOut: e?.name === 'AbortError' });
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (!batchRes.ok) {
        if (batchRes.status === 401) {
            return unavailable(_UNAUTHORIZED, null, { fatal: true });
        }
        // 5xx (incl. 503 model_loading), 408 and 429 are the sidecar's
        // state, not the files'. Other 4xx is a request bug: keep the old
        // "all null" answer.
        if (batchRes.status >= 500 || batchRes.status === 408 || batchRes.status === 429) {
            return unavailable(`sidecar returned ${batchRes.status}`);
        }
        _log(onLog, 'warn', `detectFacesBatch: sidecar returned ${batchRes.status}`);
        return absPaths.map(() => null);
    }

    const resultMap = new Map();
    for (const item of batchBody?.results ?? []) {
        resultMap.set(item.file, item);
    }

    const output = new Array(absPaths.length).fill(null);
    const pathFallbacks = [];
    // The caller resolved every path on this machine, so "file_not_found"
    // means the sidecar can't see our filesystem — an external sidecar
    // (another host, or a container without the downloads mount) whose
    // allow-list happens to accept the path. It used to be stored as
    // "no faces"; send those files as bytes instead.
    const unseen = [];

    for (let i = 0; i < absPaths.length; i++) {
        const item = resultMap.get(absPaths[i]);
        if (!item) continue; // path missing from response → null
        if (item.error === 'path_not_allowed') {
            pathFallbacks.push(i);
            continue;
        }
        if (item.error === 'file_not_found') {
            unseen.push(i);
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
        output[i] = _parseFacesList(item.faces, item.exif_oriented === true);
    }

    if (pathFallbacks.length) {
        _log(onLog, 'info', 'path mode rejected by sidecar; switching to b64 for all files');
        _pathRejectedLogged = true;
    }
    for (const idx of pathFallbacks) {
        output[idx] = await detectFaces(absPaths[idx], cfg, onLog, { throwOnUnavailable: strict });
    }
    for (const idx of unseen) {
        output[idx] = await _detectB64(absPaths[idx], cfg, onLog, strict);
        if (output[idx] !== null && !_pathRejectedLogged) {
            // Bytes worked where the path didn't: stop sending paths.
            _log(
                onLog,
                'info',
                'sidecar cannot see files at their local paths (external sidecar?); switching to b64 for all files',
            );
            _pathRejectedLogged = true;
        }
    }

    return output;
}

// Detect one local file by POSTing its bytes (skips path mode).
function _detectB64(absPath, cfg, onLog, strict) {
    const facesCfg = cfg?.faces || cfg || {};
    const baseBody = {
        min_score: _pickNumber([cfg?.minDetectionScore, facesCfg.minDetectionScore], 0.5),
        min_box_px: _pickNumber([cfg?.minFaceSizePx, facesCfg.minFaceSizePx], 60),
        ar_range:
            Array.isArray(facesCfg.arRange) && facesCfg.arRange.length === 2
                ? facesCfg.arRange
                : [0.5, 2.0],
    };
    const url = getSidecarUrl();
    if (!url) {
        if (strict) throw new SidecarUnavailableError('sidecar URL unset');
        return null;
    }
    return _detectInner(absPath, null, baseBody, url, onLog, strict, true);
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
export async function detectFacesInVideo(
    absPath,
    cfg = {},
    onLog = null,
    signal = null,
    opts = {},
) {
    _bootstrapFromEnv();
    const strict = opts?.throwOnUnavailable === true;
    const unavailable = (msg, cause, extra) => {
        if (strict) throw new SidecarUnavailableError(msg, cause, extra);
        _log(onLog, 'warn', `detectFacesInVideo: ${msg} for ${absPath}`);
        return null;
    };
    const url = getSidecarUrl();
    if (!url) return unavailable('sidecar URL unset');

    // Path mode already known to fail — skip straight to b64 fallback.
    if (_pathRejectedLogged) {
        return _detectVideoB64Fallback(absPath, cfg, url, onLog, signal, strict);
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
    let resBody;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), videoTimeoutMs);
    const onAbort = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        res = await _fetch(`${url}/detect/video`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (res.ok) resBody = await res.json();
    } catch (e) {
        if (signal?.aborted) return null;
        const what =
            e?.name === 'AbortError'
                ? `timed out after ${videoTimeoutMs} ms`
                : e instanceof SyntaxError
                  ? `invalid JSON — ${e.message}`
                  : `network error — ${e?.cause?.code || e?.message || e}`;
        return unavailable(what, e, { timedOut: e?.name === 'AbortError' });
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
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
            return _detectVideoB64Fallback(absPath, cfg, url, onLog, signal, strict);
        }
        _log(onLog, 'warn', `detectFacesInVideo: sidecar returned 403 for ${absPath}`);
        return null;
    }

    if (!res.ok) {
        if (res.status === 401) return unavailable(_UNAUTHORIZED, null, { fatal: true });
        if (res.status >= 500 || res.status === 408 || res.status === 429) {
            return unavailable(`sidecar returned ${res.status}`);
        }
        _log(onLog, 'warn', `detectFacesInVideo: sidecar returned ${res.status} for ${absPath}`);
        return null;
    }

    // The sidecar can't open the file at this path: a remote sidecar
    // without our filesystem, or a container OpenCV can't decode. The
    // caller verified the file exists here, so extract frames locally.
    if (resBody?.error === 'file_not_found') {
        _log(
            onLog,
            'info',
            `detectFacesInVideo: sidecar could not open ${absPath}; sending frames instead`,
        );
        return _detectVideoB64Fallback(absPath, cfg, url, onLog, signal, strict);
    }

    if (resBody?.error) {
        const lvl = resBody.error === 'file_not_found' ? 'warn' : 'info';
        _log(onLog, lvl, `detectFacesInVideo ${absPath}: sidecar soft-error="${resBody.error}"`);
        return [];
    }

    return _parseFacesList(Array.isArray(resBody?.faces) ? resBody.faces : []);
}

async function _sendB64(absPath, baseBody, url, onLog, strict = false) {
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
        if (strict)
            throw new SidecarUnavailableError(`detect b64-mode failed: ${e?.message || e}`, e);
        _log(onLog, 'warn', `detect b64-mode failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
}

async function _detectInner(
    absPath,
    pathBody,
    baseBody,
    url,
    onLog,
    strict = false,
    forceB64 = false,
) {
    let res;
    let sentBytes = forceB64 || _pathRejectedLogged;

    if (sentBytes) {
        res = await _sendB64(absPath, baseBody, url, onLog, strict);
        if (res === null) return null;
    } else {
        try {
            res = await _postWithRetry(`${url}/detect`, pathBody, onLog);
        } catch (e) {
            if (strict) {
                throw new SidecarUnavailableError(`detect path-mode failed: ${e?.message || e}`, e);
            }
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
                sentBytes = true;
                res = await _sendB64(absPath, baseBody, url, onLog, strict);
                if (res === null) return null;
            }
        }
    }

    if (!res || !res.ok) {
        const status = res?.status ?? 'no_response';
        if (status === 401 && strict) {
            throw new SidecarUnavailableError(_UNAUTHORIZED, null, { fatal: true });
        }
        _log(onLog, 'warn', `detect ${absPath}: sidecar returned ${status}`);
        return null;
    }

    let body;
    try {
        body = await res.json();
    } catch (e) {
        if (strict)
            throw new SidecarUnavailableError(`invalid JSON from sidecar: ${e?.message || e}`, e);
        _log(onLog, 'warn', `detect ${absPath}: invalid JSON from sidecar: ${e?.message || e}`);
        return null;
    }

    // Path mode against a sidecar that can't see our filesystem (see the
    // batch path): retry this file as bytes.
    if (body?.error === 'file_not_found' && !sentBytes) {
        return _detectInner(absPath, pathBody, baseBody, url, onLog, strict, true);
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
    return _parseFacesList(
        Array.isArray(body?.faces) ? body.faces : [],
        body?.exif_oriented === true,
    );
}

// Parse a raw faces array from the sidecar into typed Face objects.
// Shared by both single-detect and batch paths. `exifOriented` marks
// coordinates as being in the EXIF-oriented frame (sidecars that report
// it); rows without the mark keep the legacy crop behaviour.
function _parseFacesList(faces, exifOriented = false) {
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
            if (exifOriented) out.exifOriented = true;
            // Video faces: when in the clip the face was seen (newer sidecars).
            if (Number.isFinite(f.frame_time_sec)) out.frameTimeSec = Number(f.frame_time_sec);
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
    // The configured sidecar URL, not the endpoint's origin: an external
    // sidecar behind a reverse proxy can live under a path prefix.
    const base = getSidecarUrl() || _baseUrl(url);
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
            const r = await _fetch(`${baseUrl}/health`, { signal: ctrl.signal });
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
        return await _fetch(url, { ...init, signal: ctrl.signal });
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

function _sleep(ms, signal = null) {
    return new Promise((r) => {
        if (signal?.aborted) return r();
        const done = () => {
            clearTimeout(t);
            signal?.removeEventListener('abort', done);
            r();
        };
        const t = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
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

    // Step 3: extract frames in parallel (batches of 6 to avoid fd exhaustion)
    function _extractOne(pos) {
        return new Promise((resolve) => {
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
    }

    const EXTRACT_PARALLEL = 6;
    const frames = []; // { buf, t } — t = seek position, kept for face crops
    for (let i = 0; i < positions.length; i += EXTRACT_PARALLEL) {
        const batch = positions.slice(i, i + EXTRACT_PARALLEL);
        const results = await Promise.all(batch.map(_extractOne));
        results.forEach((buf, k) => {
            if (buf) frames.push({ buf, t: batch[k] });
        });
    }
    return frames;
}

// Faces found in one extracted frame, tagged with the frame's time.
function _facesAt(rawFaces, t) {
    const parsed = _parseFacesList(Array.isArray(rawFaces) ? rawFaces : []);
    if (Number.isFinite(t)) for (const f of parsed) f.frameTimeSec = Math.round(t * 1000) / 1000;
    return parsed;
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
async function _detectVideoB64Fallback(absPath, cfg, url, onLog, signal, strict = false) {
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
        strict,
    );
    return _dedupeVideoFaces(allFaces);
}

const BATCH_B64_CHUNK = 30;
const BATCH_B64_PARALLEL = 3;

async function _sendBatchB64(
    frames,
    { minScore, minBoxPx, arRange },
    url,
    onLog,
    signal,
    strict = false,
) {
    // Split into chunks and send multiple chunks in parallel to keep GPU saturated
    const chunks = [];
    for (let start = 0; start < frames.length; start += BATCH_B64_CHUNK) {
        chunks.push(frames.slice(start, start + BATCH_B64_CHUNK));
    }

    const allFaces = [];

    async function _sendChunk(chunk) {
        if (signal?.aborted) return [];
        const body = {
            images: chunk.map((f) => f.buf.toString('base64')),
            min_score: minScore,
            min_box_px: minBoxPx,
            ar_range: arRange,
        };
        const timeoutMs = Math.max(chunk.length * _requestTimeoutMs, 180_000);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const onAbort = () => ctrl.abort();
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        let res;
        try {
            res = await _fetch(`${url}/detect/batch-b64`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } catch (e) {
            if (strict && !signal?.aborted) {
                throw new SidecarUnavailableError(`batch-b64 failed: ${e?.message || e}`, e);
            }
            return null; // signal: endpoint not available
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
        if (res.status === 404 || res.status === 405) return null;
        if (strict && (res.status >= 500 || res.status === 408 || res.status === 429)) {
            throw new SidecarUnavailableError(`batch-b64 returned ${res.status}`);
        }
        if (!res.ok) return [];
        let resBody;
        try {
            resBody = await res.json();
        } catch {
            return [];
        }
        const faces = [];
        (resBody?.results ?? []).forEach((item, k) => {
            if (item?.error) return;
            faces.push(..._facesAt(item?.faces, chunk[k]?.t));
        });
        return faces;
    }

    // Try first chunk to detect if batch-b64 is available
    const firstResult = await _sendChunk(chunks[0]);
    if (firstResult === null) {
        _log(onLog, 'info', 'batch-b64 unavailable, falling back to sequential detect');
        return _sendFramesSequential(
            frames,
            { minScore, minBoxPx, arRange },
            url,
            onLog,
            signal,
            strict,
        );
    }
    allFaces.push(...firstResult);

    // Send remaining chunks in parallel (pipeline: GPU processes chunk N while
    // network transfers chunk N+1, keeping the GPU saturated)
    const remaining = chunks.slice(1);
    for (let i = 0; i < remaining.length; i += BATCH_B64_PARALLEL) {
        if (signal?.aborted) break;
        const batch = remaining.slice(i, i + BATCH_B64_PARALLEL);
        const results = await Promise.all(batch.map((c) => _sendChunk(c)));
        for (const r of results) {
            if (r) allFaces.push(...r);
        }
    }
    return allFaces;
}

async function _sendFramesSequential(
    frames,
    { minScore, minBoxPx, arRange },
    url,
    onLog,
    signal,
    strict = false,
) {
    const allFaces = [];
    for (const frame of frames) {
        if (signal?.aborted) break;
        const b64Body = {
            image_b64: frame.buf.toString('base64'),
            min_score: minScore,
            min_box_px: minBoxPx,
            ar_range: arRange,
        };
        let res;
        try {
            res = await _postWithRetry(`${url}/detect`, b64Body, onLog);
        } catch (e) {
            if (strict)
                throw new SidecarUnavailableError(`frame detect failed: ${e?.message || e}`, e);
            continue;
        }
        if (!res || !res.ok) continue;
        let resBody;
        try {
            resBody = await res.json();
        } catch {
            continue;
        }
        allFaces.push(..._facesAt(resBody?.faces, frame.t));
    }
    return allFaces;
}

/**
 * Test-only: route sidecar HTTP through `fn` (e.g. a wrapper around a
 * mocked `globalThis.fetch`). Pass nothing to restore the undici client.
 */
export function _setFetchForTests(fn) {
    _fetchImpl =
        typeof fn === 'function'
            ? fn
            : (url, init) => undiciFetch(url, { ...init, dispatcher: _sidecarAgent });
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
    _sidecarToken = '';
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
