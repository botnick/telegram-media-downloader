/**
 * HTTP client for tgdl-core (the Go companion process).
 *
 * - Every call has a deadline; on expiry the socket is destroyed, which
 *   also cancels the work on the Go side (it checks the request context
 *   between reads).
 * - Per-feature circuit breaker: BREAKER_THRESHOLD service failures inside
 *   BREAKER_WINDOW_MS switch the feature off until the next healthy
 *   /health probe (`markHealthy`). File-level errors (ENOENT, EACCES, …)
 *   are the file's fault, not the service's, and don't count.
 * - Uses node:http rather than fetch: undici's default 300 s headers
 *   timeout would cut off a legitimate multi-GB hash.
 *
 * Callers never see these errors directly — src/core/gocore/hash.js
 * falls back to the Node implementation on any of them.
 */

import http from 'http';

import { metrics } from '../metrics.js';
import { authHeaders, normalizeSidecarUrl } from '../sidecar-remote.js';

export const BREAKER_THRESHOLD = 5;
export const BREAKER_WINDOW_MS = 60_000;
const MAX_RESPONSE_BYTES = 1 << 20;
const HEX64 = /^[0-9a-f]{64}$/;

export class GoCoreError extends Error {
    /**
     * @param {'unavailable'|'timeout'|'transport'|'auth'|'file'|'busy'|'server'|'protocol'} kind
     * @param {string} [code]   Node-style code from tgdl-core (ENOENT, …)
     */
    constructor(kind, message, { code = null, status = null, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GoCoreError';
        this.kind = kind;
        this.code = code;
        this.status = status;
    }
}

let _base = '';
let _host = '';
let _port = 0;
let _token = '';
let _features = new Set();
let _agent = null;
/** feature → { failures: number[], open: boolean, openedAt: number, trips: number } */
const _breakers = new Map();

function _breaker(feature) {
    let b = _breakers.get(feature);
    if (!b) {
        b = { failures: [], open: false, openedAt: 0, trips: 0 };
        _breakers.set(feature, b);
    }
    return b;
}

/**
 * Point the client at a running tgdl-core. `features` comes from /health —
 * a feature is only routed to Go when the binary advertises it.
 */
export function setEndpoint(url, token, features = []) {
    const base = normalizeSidecarUrl(String(url || ''));
    let parsed = null;
    try {
        parsed = base ? new URL(base) : null;
    } catch {
        parsed = null;
    }
    if (!parsed || parsed.protocol !== 'http:') {
        clearEndpoint();
        return;
    }
    _base = base;
    _host = parsed.hostname;
    _port = Number(parsed.port) || 80;
    _token = String(token || '');
    _features = new Set((features || []).map(String));
    _agent?.destroy();
    _agent = new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 10_000 });
}

/** Forget the endpoint (process exited / stopped). Calls go to Node. */
export function clearEndpoint() {
    _base = '';
    _host = '';
    _port = 0;
    _token = '';
    _features = new Set();
    _agent?.destroy();
    _agent = null;
}

export function getEndpoint() {
    return _base ? { url: _base, features: [..._features] } : null;
}

/** A healthy /health probe: refresh features and close every breaker. */
export function markHealthy(health) {
    if (Array.isArray(health?.features)) _features = new Set(health.features.map(String));
    for (const b of _breakers.values()) {
        b.failures = [];
        b.open = false;
        b.openedAt = 0;
    }
}

export function breakerState(feature) {
    const b = _breaker(feature);
    const now = Date.now();
    const recent = b.failures.filter((t) => now - t < BREAKER_WINDOW_MS).length;
    return {
        state: b.open ? 'open' : 'closed',
        openedAt: b.openedAt || null,
        recentFailures: recent,
        trips: b.trips,
    };
}

function _recordFailure(feature) {
    const b = _breaker(feature);
    const now = Date.now();
    b.failures = b.failures.filter((t) => now - t < BREAKER_WINDOW_MS);
    b.failures.push(now);
    if (!b.open && b.failures.length >= BREAKER_THRESHOLD) {
        b.open = true;
        b.openedAt = now;
        b.trips++;
        console.warn(
            `[go-core] ${feature}: ${b.failures.length} failures in ${BREAKER_WINDOW_MS / 1000}s — using Node until tgdl-core answers a health check`,
        );
    }
}

/** True when `feature` can be sent to Go right now. */
export function isAvailable(feature) {
    return Boolean(_base) && _features.has(feature) && !_breaker(feature).open;
}

/**
 * One JSON request. Resolves { status, body } for any HTTP answer;
 * rejects with GoCoreError('timeout' | 'transport' | 'protocol').
 */
function _requestOnce(method, pathname, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
        const headers = { accept: 'application/json', ...authHeaders(_token) };
        if (data) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(data.length);
        }
        let settled = false;
        const finish = (fn, v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(v);
        };
        const req = http.request(
            { host: _host, port: _port, method, path: pathname, headers, agent: _agent },
            (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', (c) => {
                    size += c.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        req.destroy(new GoCoreError('protocol', 'response too large'));
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let body = null;
                    try {
                        body = text ? JSON.parse(text) : null;
                    } catch {
                        return finish(
                            reject,
                            new GoCoreError('protocol', `non-JSON response (${res.statusCode})`, {
                                status: res.statusCode,
                            }),
                        );
                    }
                    finish(resolve, { status: res.statusCode, body });
                });
                res.on('error', (e) =>
                    finish(reject, new GoCoreError('transport', e.message, { cause: e })),
                );
            },
        );
        const timer = setTimeout(() => {
            const err = new GoCoreError(
                'timeout',
                `tgdl-core did not answer within ${timeoutMs} ms`,
            );
            finish(reject, err);
            req.destroy(err);
        }, timeoutMs);
        timer.unref?.();
        req.on('error', (e) => {
            if (e instanceof GoCoreError) return finish(reject, e);
            const err = new GoCoreError('transport', e?.message || String(e), {
                code: e?.code || null,
                cause: e,
            });
            // A kept-alive socket the server closed as idle just as we
            // reused it — safe to retry (see _request).
            err.staleSocket = req.reusedSocket && (e?.code === 'ECONNRESET' || e?.code === 'EPIPE');
            finish(reject, err);
        });
        if (data) req.end(data);
        else req.end();
    });
}

/**
 * `_requestOnce`, retried once when it failed on a reused keep-alive
 * socket that tgdl-core had just closed as idle (Node's documented
 * pattern for idempotent requests). A dead process fails the retry too.
 */
async function _request(method, pathname, payload, timeoutMs) {
    try {
        return await _requestOnce(method, pathname, payload, timeoutMs);
    } catch (e) {
        if (!e?.staleSocket || !_base) throw e;
        return _requestOnce(method, pathname, payload, timeoutMs);
    }
}

function _count(feature, result) {
    metrics.inc('tgdl_gocore_calls_total', 1, { feature, result });
}

/**
 * Hash `absPath` in tgdl-core.
 *
 * @returns {Promise<{ sha256: string, size: number, mtimeMs: number }>}
 * @throws {GoCoreError}
 */
export async function hashFile(absPath, { timeoutMs = 30_000 } = {}) {
    const feature = 'hash';
    if (!_base) throw new GoCoreError('unavailable', 'tgdl-core is not running');
    let res;
    try {
        res = await _request('POST', '/v1/hash', { path: absPath }, timeoutMs);
    } catch (e) {
        _count(feature, e.kind === 'timeout' ? 'timeout' : 'error');
        _recordFailure(feature);
        throw e;
    }
    const { status, body } = res;
    if (status === 200) {
        const sha = body?.sha256;
        if (typeof sha !== 'string' || !HEX64.test(sha) || !Number.isFinite(body?.size)) {
            _count(feature, 'error');
            _recordFailure(feature);
            throw new GoCoreError('protocol', 'malformed hash response', { status });
        }
        _count(feature, 'ok');
        return { sha256: sha, size: body.size, mtimeMs: Number(body.mtimeMs) };
    }
    const code = body?.error?.code || null;
    const message = body?.error?.message || `tgdl-core answered ${status}`;
    if (status === 422) {
        // The file can't be read — Node will report the same thing.
        _count(feature, 'file_error');
        throw new GoCoreError('file', message, { code, status });
    }
    _count(feature, 'error');
    if (status === 503) throw new GoCoreError('busy', message, { code, status });
    _recordFailure(feature);
    throw new GoCoreError(status === 401 ? 'auth' : 'server', message, { code, status });
}

/** GET /health. Resolves the body or rejects (any kind of failure). */
export async function health({ timeoutMs = 3_000 } = {}) {
    if (!_base) throw new GoCoreError('unavailable', 'tgdl-core is not running');
    const { status, body } = await _request('GET', '/health', undefined, timeoutMs);
    if (status !== 200 || body?.ok !== true || body?.service !== 'tgdl-core') {
        throw new GoCoreError('server', `unhealthy (${status})`, { status });
    }
    return body;
}

/** GET /v1/stats — token-gated, so it also proves the token is right. */
export async function stats({ timeoutMs = 3_000 } = {}) {
    if (!_base) throw new GoCoreError('unavailable', 'tgdl-core is not running');
    const { status, body } = await _request('GET', '/v1/stats', undefined, timeoutMs);
    if (status !== 200) {
        throw new GoCoreError(status === 401 ? 'auth' : 'server', `stats answered ${status}`, {
            status,
        });
    }
    return body;
}

/** Test helper: reset breakers and endpoint. */
export function _resetForTests() {
    clearEndpoint();
    _breakers.clear();
}
