/**
 * HTTP client for an external NSFW classification sidecar.
 *
 * Mirrors the faces-client.js pattern: path mode first, b64 fallback on
 * 403, retry with backoff, cached health probe, concurrency gate.
 *
 * Wire format (matches nsfw-service/main.py):
 *   POST /classify  { path | image_b64, threshold? }
 *                  → 200 { score, label }
 *                  → 403 { code: 'path_not_allowed' }
 *   POST /classify/batch  { files[], threshold? }
 *                        → 200 { results: [{ file, score, label, error? }] }
 *   GET  /health  → 200 { ok, model, ready, version }
 */

import { promises as fs } from 'fs';
import { Buffer } from 'buffer';

const HEALTH_CACHE_TTL_MS = 5000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [300, 600, 1200];
const HEALTH_PROBE_TIMEOUT_MS = 5000;
const HEALTH_PROBE_RETRIES = 3;

let _sidecarUrl = '';
let _healthCache = null;
let _pathRejectedLogged = false;
let _requestTimeoutMs = REQUEST_TIMEOUT_MS;
let _maxRetries = MAX_RETRIES;
let _retryBackoffMs = RETRY_BACKOFF_MS.slice();

export function setSidecarUrl(url) {
    const next = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (next === _sidecarUrl) return;
    _sidecarUrl = next;
    _healthCache = null;
}

export function getSidecarUrl() {
    return _sidecarUrl || null;
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
    _healthCache = { value, expiresAt: now + HEALTH_CACHE_TTL_MS };
    return value;
}

async function _sendB64Classify(absPath, url, threshold, onLog) {
    let bytes;
    try {
        bytes = await fs.readFile(absPath);
    } catch (e) {
        _log(onLog, 'warn', `b64 read failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
    const b64Body = { image_b64: Buffer.from(bytes).toString('base64') };
    if (threshold !== undefined) b64Body.threshold = threshold;
    try {
        return await _postWithRetry(`${url}/classify`, b64Body, onLog);
    } catch (e) {
        _log(onLog, 'warn', `classify b64-mode failed for ${absPath}: ${e?.message || e}`);
        return null;
    }
}

/**
 * Classify a single image via the external sidecar.
 * Path mode first; 403 falls back to b64 (and remembers for the session).
 * @returns {Promise<{ score: number, label: string } | null>}
 */
export async function classifyFile(absPath, opts = {}, onLog = null) {
    const url = getSidecarUrl();
    if (!url) return null;
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : undefined;

    let res;

    if (_pathRejectedLogged) {
        res = await _sendB64Classify(absPath, url, threshold, onLog);
        if (res === null) return null;
    } else {
        const pathBody = { path: absPath };
        if (threshold !== undefined) pathBody.threshold = threshold;
        try {
            res = await _postWithRetry(`${url}/classify`, pathBody, onLog);
        } catch (e) {
            _log(onLog, 'warn', `classify path-mode failed for ${absPath}: ${e?.message || e}`);
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
                res = await _sendB64Classify(absPath, url, threshold, onLog);
                if (res === null) return null;
            }
        }
    }

    if (!res || !res.ok) {
        const status = res?.status ?? 'no_response';
        _log(onLog, 'warn', `classify ${absPath}: sidecar returned ${status}`);
        return null;
    }

    let body;
    try {
        body = await res.json();
    } catch (e) {
        _log(onLog, 'warn', `classify ${absPath}: invalid JSON — ${e?.message || e}`);
        return null;
    }

    if (body?.error) {
        _log(onLog, 'warn', `classify ${absPath}: sidecar error="${body.error}"`);
        return null;
    }

    const score = Number.isFinite(body?.score) ? body.score : 0;
    return { score, label: body?.label || (score >= 0.5 ? 'nsfw' : 'normal') };
}

/**
 * Classify a batch of images.
 * @returns {Promise<Array<{ score, label } | null>>}
 */
export async function classifyBatch(absPaths, opts = {}, onLog = null) {
    const url = getSidecarUrl();
    if (!url) return absPaths.map(() => null);
    if (!absPaths.length) return [];

    // Path mode already known to fail — classify individually via b64.
    if (_pathRejectedLogged) {
        const out = [];
        for (const p of absPaths) {
            out.push(await classifyFile(p, opts, onLog));
        }
        return out;
    }

    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : undefined;
    const body = { files: absPaths };
    if (threshold !== undefined) body.threshold = threshold;

    const batchTimeoutMs = Math.max(absPaths.length * _requestTimeoutMs, 60_000);
    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), batchTimeoutMs);
        try {
            res = await globalThis.fetch(`${url}/classify/batch`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
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

    const resultMap = new Map();
    for (const item of resBody?.results ?? []) {
        resultMap.set(item.file, item);
    }

    const output = new Array(absPaths.length).fill(null);
    const pathFallbacks = [];
    for (let i = 0; i < absPaths.length; i++) {
        const item = resultMap.get(absPaths[i]);
        if (!item) continue;
        if (item.error === 'path_not_allowed') {
            pathFallbacks.push(i);
            continue;
        }
        if (item.error) {
            _log(onLog, 'info', `batch classify ${absPaths[i]}: error="${item.error}"`);
            output[i] = null;
            continue;
        }
        const score = Number.isFinite(item.score) ? item.score : 0;
        output[i] = { score, label: item.label || (score >= 0.5 ? 'nsfw' : 'normal') };
    }

    if (pathFallbacks.length) {
        _log(onLog, 'info', 'path mode rejected by sidecar; switching to b64 for all files');
        _pathRejectedLogged = true;
    }
    for (const idx of pathFallbacks) {
        output[idx] = await classifyFile(absPaths[idx], opts, onLog);
    }

    return output;
}

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
                    bailReason = `— timed out after ${_requestTimeoutMs}ms`;
                } else {
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

function _baseUrl(endpointUrl) {
    try {
        const u = new URL(endpointUrl);
        return `${u.protocol}//${u.host}`;
    } catch {
        return endpointUrl.replace(/\/[^/]*$/, '');
    }
}

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

async function _fetchWithTimeout(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), _requestTimeoutMs);
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
    _healthCache = null;
    _requestTimeoutMs = REQUEST_TIMEOUT_MS;
    _maxRetries = MAX_RETRIES;
    _retryBackoffMs = RETRY_BACKOFF_MS.slice();
}
