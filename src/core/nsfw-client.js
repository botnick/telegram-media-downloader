/**
 * HTTP client for an external NSFW classification sidecar.
 *
 * Mirrors the faces-client.js pattern: path mode first, byte upload as the
 * fallback, retry with backoff, cached health probe.
 *
 * Wire format (matches nsfw-service/main.py):
 *   GET  /health          → 200 { ok, model, ready, version, features?, auth_required? }
 *   POST /classify        { path | image_b64, threshold? }
 *                         → 200 { score, label } | 200 { error: 'file_not_found' }
 *                         → 403 { code: 'path_not_allowed' }
 *   POST /classify/upload raw image bytes → 200 { score, label }   (1.2.0+)
 *   POST /classify/batch  { files[], threshold? }
 *                         → 200 { results: [{ file, score, label, error? }] }
 *   401 on every route but /health when the sidecar has TGDL_NSFW_API_TOKEN
 *   set and our `X-API-Token` doesn't match.
 *
 * External mode (sidecar on another host / container):
 *   - Paths are rewritten through the configured path map before being
 *     sent, so a shared mount at a different path keeps path mode.
 *   - A path the sidecar rejects (403) or can't find (file_not_found) is
 *     sent as bytes instead: a raw upload when the sidecar advertises the
 *     `upload` feature, base64 JSON for older sidecars. Large images are
 *     downscaled first — the model looks at 224–384 px anyway, and it keeps
 *     requests far below proxy body limits (Cloudflare: 100 MB).
 */

import { promises as fs } from 'fs';
import { Buffer } from 'buffer';
import sharp from 'sharp';

import {
    authHeaders,
    normalizeSidecarUrl,
    parsePathMap,
    toSidecarPath,
    uploadTimeoutMs,
} from './sidecar-remote.js';

const HEALTH_CACHE_TTL_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [300, 600, 1200];
const HEALTH_PROBE_TIMEOUT_MS = 5000;
const HEALTH_PROBE_RETRIES = 3;
// Uploads above this are re-encoded to at most DOWNSCALE_MAX_EDGE px.
const DOWNSCALE_OVER_BYTES = 1.5 * 1024 * 1024;
const DOWNSCALE_MAX_EDGE = 1024;
// Older sidecars don't report a cap; stay under typical proxy limits.
const MAX_UPLOAD_BYTES_DEFAULT = 50 * 1024 * 1024;

let _sidecarUrl = '';
let _token = '';
let _pathMap = [];
let _healthCache = null;
let _features = null; // null = not probed yet
let _maxUploadBytes = MAX_UPLOAD_BYTES_DEFAULT;
let _pathRejectedLogged = false;
let _notFoundLogged = false;
let _authLogged = false;
let _requestTimeoutMs = REQUEST_TIMEOUT_MS;
let _maxRetries = MAX_RETRIES;
let _retryBackoffMs = RETRY_BACKOFF_MS.slice();

function _resetSession() {
    _healthCache = null;
    _features = null;
    _maxUploadBytes = MAX_UPLOAD_BYTES_DEFAULT;
    _pathRejectedLogged = false;
    _notFoundLogged = false;
    _authLogged = false;
}

export function setSidecarUrl(url) {
    const next = normalizeSidecarUrl(url);
    if (next === _sidecarUrl) return;
    _sidecarUrl = next;
    _resetSession();
}

export function getSidecarUrl() {
    return _sidecarUrl || null;
}

/** Shared token sent as `X-API-Token` (empty = none). */
export function setSidecarAuth(token) {
    const next = typeof token === 'string' ? token.trim() : '';
    if (next === _token) return;
    _token = next;
    _healthCache = null;
    _authLogged = false;
}

/** App-path → sidecar-path rules (see sidecar-remote.js parsePathMap). */
export function setPathMap(raw) {
    _pathMap = parsePathMap(raw);
    // A new mapping may make path mode work again.
    _pathRejectedLogged = false;
    _notFoundLogged = false;
}

/** Snapshot for the dashboard — never includes the token itself. */
export function getSidecarInfo() {
    return {
        url: getSidecarUrl(),
        tokenSet: !!_token,
        pathMapRules: _pathMap.length,
        features: _features,
        transfer: !_sidecarUrl ? null : _pathRejectedLogged ? 'upload' : 'path',
    };
}

export function applyNsfwSidecarCfg(cfg = {}) {
    if (!cfg || typeof cfg !== 'object') return;
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
}

export async function health() {
    const url = getSidecarUrl();
    if (!url) return { ok: false, error: 'sidecar_url_unset' };
    const now = Date.now();
    if (_healthCache && _healthCache.expiresAt > now) return _healthCache.value;

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
                    headers: authHeaders(_token),
                    signal: ctrl.signal,
                });
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                lastErr = new Error(`http_${res.status}`);
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
                ready: body?.ready === true,
                device: body?.device ?? null,
                features: Array.isArray(body?.features) ? body.features.map(String) : [],
                authRequired: typeof body?.auth_required === 'boolean' ? body.auth_required : null,
                pathMode: typeof body?.path_mode === 'boolean' ? body.path_mode : null,
            };
            _features = value.features;
            if (Number.isFinite(body?.max_upload_bytes) && body.max_upload_bytes > 0) {
                _maxUploadBytes = body.max_upload_bytes;
            }
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
        }
    }
    if (value === undefined) {
        value = { ok: false, error: lastErr?.message || String(lastErr) };
    }
    _healthCache = { value, expiresAt: now + HEALTH_CACHE_TTL_MS };
    return value;
}

async function _ensureFeatures() {
    if (_features === null) await health();
    return _features || [];
}

function _logAuthFailure(onLog) {
    if (_authLogged) return;
    _authLogged = true;
    _log(
        onLog,
        'error',
        `sidecar at ${_sidecarUrl} rejected the API token (401) — set the same token in Maintenance → NSFW → External and in the sidecar's TGDL_NSFW_API_TOKEN`,
    );
}

// Parse a /classify-style response. `{ notFound: true }` = the sidecar
// accepted the path but has no such file (not shared / wrong mapping).
async function _readResult(res, what, onLog) {
    if (!res) return { result: null };
    if (res.status === 401) {
        _logAuthFailure(onLog);
        return { result: null };
    }
    if (!res.ok) {
        _log(onLog, 'warn', `classify ${what}: sidecar returned ${res.status}`);
        return { result: null };
    }
    let body;
    try {
        body = await res.json();
    } catch (e) {
        _log(onLog, 'warn', `classify ${what}: invalid JSON — ${e?.message || e}`);
        return { result: null };
    }
    if (body?.error === 'file_not_found') return { notFound: true, result: null };
    if (body?.error) {
        _log(onLog, 'warn', `classify ${what}: sidecar error="${body.error}"`);
        return { result: null };
    }
    const score = Number.isFinite(body?.score) ? body.score : 0;
    return { result: { score, label: body?.label || (score >= 0.5 ? 'nsfw' : 'normal') } };
}

// Downscale large images before they cross the network. Anything sharp
// can't decode is sent as-is and left to the sidecar.
async function _prepareUpload(bytes) {
    if (bytes.length <= DOWNSCALE_OVER_BYTES) return bytes;
    try {
        return await sharp(bytes, { failOn: 'none' })
            .resize({
                width: DOWNSCALE_MAX_EDGE,
                height: DOWNSCALE_MAX_EDGE,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .jpeg({ quality: 90 })
            .toBuffer();
    } catch {
        return bytes;
    }
}

async function _sendBytes(bytes, threshold, what, onLog) {
    const features = await _ensureFeatures();
    const useRaw = features.includes('upload');
    const bodyBytes = useRaw ? bytes.length : Math.ceil(bytes.length / 3) * 4;
    if (bodyBytes > _maxUploadBytes) {
        _log(
            onLog,
            'warn',
            `classify ${what}: ${Math.round(bodyBytes / 1e6)} MB is over the sidecar's upload limit — skipped`,
        );
        return null;
    }
    let res;
    try {
        if (useRaw) {
            // The sidecar only scores; the threshold is applied app-side.
            res = await _postWithRetry('/classify/upload', { raw: bytes }, onLog);
        } else {
            const body = { image_b64: Buffer.from(bytes).toString('base64') };
            if (threshold !== undefined) body.threshold = threshold;
            res = await _postWithRetry('/classify', { json: body }, onLog);
        }
    } catch (e) {
        _log(onLog, 'warn', `classify ${what} (upload) failed: ${e?.message || e}`);
        return null;
    }
    return (await _readResult(res, what, onLog)).result;
}

async function _sendFileBytes(absPath, threshold, onLog) {
    let bytes;
    try {
        bytes = await fs.readFile(absPath);
    } catch (e) {
        _log(onLog, 'warn', `upload read failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
    return _sendBytes(await _prepareUpload(bytes), threshold, absPath, onLog);
}

function _noteNotFound(absPath, sidecarPath, onLog) {
    if (_notFoundLogged) return;
    _notFoundLogged = true;
    _log(
        onLog,
        'info',
        `sidecar can't find ${sidecarPath} (not shared with it, or the path mapping is wrong) — sending file bytes instead`,
    );
}

/**
 * Classify a single image via the external sidecar.
 * Path mode first (through the path map); a 403 switches the session to
 * byte uploads, a file_not_found uploads just this file.
 * @returns {Promise<{ score: number, label: string } | null>}
 */
export async function classifyFile(absPath, opts = {}, onLog = null) {
    const url = getSidecarUrl();
    if (!url) return null;
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : undefined;

    if (!_pathRejectedLogged) {
        const sidecarPath = toSidecarPath(absPath, _pathMap);
        const pathBody = { path: sidecarPath };
        if (threshold !== undefined) pathBody.threshold = threshold;
        let res;
        try {
            res = await _postWithRetry('/classify', { json: pathBody }, onLog);
        } catch (e) {
            _log(onLog, 'warn', `classify path-mode failed for ${absPath}: ${e?.message || e}`);
            return null;
        }
        let rejected = false;
        if (res.status === 403) {
            let code = null;
            try {
                code = (await res.clone().json())?.code || null;
            } catch {}
            if (code === 'path_not_allowed') rejected = true;
        }
        if (rejected) {
            _log(onLog, 'info', 'path mode rejected by sidecar; sending file bytes from now on');
            _pathRejectedLogged = true;
        } else {
            const r = await _readResult(res, absPath, onLog);
            if (!r.notFound) return r.result;
            _noteNotFound(absPath, sidecarPath, onLog);
        }
    }
    return _sendFileBytes(absPath, threshold, onLog);
}

/**
 * Classify in-memory image bytes (e.g. a tile cut from a video sprite).
 * Never uses path mode, so a temp file can't make the sidecar reject
 * path mode for the real library files.
 */
export async function classifyBuffer(bytes, opts = {}, onLog = null) {
    if (!getSidecarUrl() || !bytes?.length) return null;
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : undefined;
    return _sendBytes(await _prepareUpload(bytes), threshold, 'buffer', onLog);
}

/**
 * Classify a batch of images.
 * @returns {Promise<Array<{ score, label } | null>>}
 */
export async function classifyBatch(absPaths, opts = {}, onLog = null) {
    const url = getSidecarUrl();
    if (!url) return absPaths.map(() => null);
    if (!absPaths.length) return [];

    // Path mode already known to fail — classify individually via upload.
    if (_pathRejectedLogged) {
        const out = [];
        for (const p of absPaths) {
            out.push(await classifyFile(p, opts, onLog));
        }
        return out;
    }

    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : undefined;
    const mapped = absPaths.map((p) => toSidecarPath(p, _pathMap));
    const body = { files: mapped };
    if (threshold !== undefined) body.threshold = threshold;

    const batchTimeoutMs = Math.max(absPaths.length * _requestTimeoutMs, 60_000);
    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), batchTimeoutMs);
        try {
            res = await globalThis.fetch(`${url}/classify/batch`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...authHeaders(_token) },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        _log(onLog, 'warn', `classifyBatch: network error — ${e?.message || e}`);
        return absPaths.map(() => null);
    }

    if (res.status === 401) {
        _logAuthFailure(onLog);
        return absPaths.map(() => null);
    }
    if (!res.ok) {
        _log(onLog, 'warn', `classifyBatch: sidecar returned ${res.status}`);
        return absPaths.map(() => null);
    }

    let resBody;
    try {
        resBody = await res.json();
    } catch (e) {
        _log(onLog, 'warn', `classifyBatch: invalid JSON — ${e?.message || e}`);
        return absPaths.map(() => null);
    }

    // Results are keyed by the (mapped) string we sent.
    const resultMap = new Map();
    for (const item of resBody?.results ?? []) {
        resultMap.set(item.file, item);
    }

    const output = new Array(absPaths.length).fill(null);
    const uploads = [];
    for (let i = 0; i < absPaths.length; i++) {
        const item = resultMap.get(mapped[i]);
        if (!item) continue;
        if (item.error === 'path_not_allowed') {
            if (!_pathRejectedLogged) {
                _log(
                    onLog,
                    'info',
                    'path mode rejected by sidecar; sending file bytes from now on',
                );
            }
            _pathRejectedLogged = true;
            uploads.push(i);
            continue;
        }
        if (item.error === 'file_not_found') {
            _noteNotFound(absPaths[i], mapped[i], onLog);
            uploads.push(i);
            continue;
        }
        if (item.error) {
            _log(onLog, 'info', `batch classify ${absPaths[i]}: error="${item.error}"`);
            continue;
        }
        const score = Number.isFinite(item.score) ? item.score : 0;
        output[i] = { score, label: item.label || (score >= 0.5 ? 'nsfw' : 'normal') };
    }

    for (const idx of uploads) {
        output[idx] = await _sendFileBytes(absPaths[idx], threshold, onLog);
    }

    return output;
}

async function _postWithRetry(pathname, { json, raw }, onLog) {
    const url = `${_sidecarUrl}${pathname}`;
    const maxRetries = Math.max(1, _maxRetries);
    const headers = {
        'content-type': raw ? 'application/octet-stream' : 'application/json',
        ...authHeaders(_token),
    };
    const payload = raw ?? JSON.stringify(json);
    const timeoutMs = raw ? uploadTimeoutMs(raw.length, _requestTimeoutMs) : _requestTimeoutMs;
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let bail = false;
        let bailReason = '';
        try {
            const res = await _fetchWithTimeout(
                url,
                { method: 'POST', headers, body: payload },
                timeoutMs,
            );
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                lastErr = new Error(`sidecar http ${res.status}`);
            } else {
                return res;
            }
        } catch (e) {
            lastErr = e;
            if (attempt < maxRetries - 1) {
                if (e?.name === 'AbortError') {
                    bail = true;
                    bailReason = `— timed out after ${timeoutMs}ms`;
                } else {
                    const alive = await _quickHealthProbe();
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
        const suffix = bail ? bailReason : hasMore ? `— retrying in ${backoff}ms` : '— giving up';
        _log(
            onLog,
            'warn',
            `nsfw POST ${url} attempt ${attempt + 1}/${maxRetries}: ${lastErr?.message || lastErr} ${suffix}`,
        );
        if (bail) break;
        if (hasMore) await _sleep(backoff);
    }
    throw lastErr || new Error('nsfw POST: retries exhausted');
}

// Probe the configured base URL — not the bare origin, which would miss a
// reverse-proxy prefix like https://host/nsfw.
async function _quickHealthProbe() {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1000);
        try {
            const r = await globalThis.fetch(`${_sidecarUrl}/health`, {
                headers: authHeaders(_token),
                signal: ctrl.signal,
            });
            return r.ok;
        } finally {
            clearTimeout(t);
        }
    } catch {
        return false;
    }
}

async function _fetchWithTimeout(url, init = {}, timeoutMs = _requestTimeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await globalThis.fetch(url, { ...init, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function _log(onLog, level, msg) {
    if (typeof onLog !== 'function') return;
    try {
        onLog({ source: 'nsfw-client', level, msg });
    } catch {}
}

export function _resetForTests() {
    _sidecarUrl = '';
    _token = '';
    _pathMap = [];
    _resetSession();
    _requestTimeoutMs = REQUEST_TIMEOUT_MS;
    _maxRetries = MAX_RETRIES;
    _retryBackoffMs = RETRY_BACKOFF_MS.slice();
}
