/**
 * HTTP client for tgdl-core (the Go companion process).
 *
 * tgdl-core is the only implementation of file hashing, the integrity
 * stat sweep, directory walks and face-clustering DBSCAN. Callers get
 * either its answer or a GoCoreError — there is no second implementation
 * to fall back to:
 *
 *   unavailable  tgdl-core isn't running (binary missing, still starting
 *                past the wait, crashed and restarting) or is too old for
 *                the feature. `err.status` is 503 and `err.message` says
 *                how to fix it.
 *   file         the file itself can't be read (ENOENT, EACCES, …); `code`
 *                is the code Node would report.
 *   outside      the path isn't inside the directories tgdl-core may read
 *                (TGDL_CORE_ALLOW_ROOTS). The caller answers that path
 *                with plain fs itself — see hash.js / fs.js.
 *   timeout / transport / auth / server / protocol / busy / aborted
 *
 * Optional helpers (`hash-batch`, `tar-gz`, `remove-tree`, `db`, `thumb`, `seekbar` and `faststart`) keep a Node fallback for
 * older binaries; the required filesystem and clustering calls do not.
 *
 * Every call has a deadline; on expiry (or an AbortSignal) the socket is
 * destroyed, which cancels the work on the Go side too. Uses node:http
 * rather than fetch: undici's 300 s headers timeout would cut off a
 * legitimate multi-GB hash.
 */

import http from 'http';

import { metrics } from '../metrics.js';
import { authHeaders, normalizeSidecarUrl } from '../sidecar-remote.js';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
/** How long a feature call waits for a tgdl-core that is starting. */
export const DEFAULT_READY_WAIT_MS = 15_000;

export class GoCoreError extends Error {
    /**
     * @param {'unavailable'|'timeout'|'transport'|'auth'|'file'|'outside'|'busy'|'server'|'protocol'|'aborted'} kind
     * @param {string} message
     * @param {{ code?: string|null, status?: number|null, cause?: unknown }} [opts]
     */
    constructor(kind, message, { code = null, status = null, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = kind === 'aborted' ? 'AbortError' : 'GoCoreError';
        this.kind = kind;
        this.code = code ?? (kind === 'unavailable' ? 'TGDL_CORE_UNAVAILABLE' : null);
        this.status = status ?? (kind === 'unavailable' ? 503 : null);
    }
}

let _base = '';
let _host = '';
let _port = 0;
let _token = '';
let _version = null;
let _features = new Set();
let _healthy = false; // a /health probe succeeded since setEndpoint
let _agent = null;
/** () => { starting, idle, message } — installed by spawn.js. */
let _statusProvider = () => ({ starting: false, idle: false, message: 'tgdl-core is not running' });
/** Starts tgdl-core on first use (CLI runs, tests) — installed by spawn.js. */
let _autoStart = null;
let _readyWaiters = [];

/**
 * Point the client at a running tgdl-core. `features` comes from /health —
 * a call is only sent when the binary advertises its feature.
 */
export function setEndpoint(url, token, features = [], version = null) {
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
    _version = version;
    _healthy = false;
    _agent?.destroy();
    _agent = new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 10_000 });
}

/** Forget the endpoint (process exited / stopped). */
export function clearEndpoint() {
    _base = '';
    _host = '';
    _port = 0;
    _token = '';
    _version = null;
    _features = new Set();
    _healthy = false;
    _agent?.destroy();
    _agent = null;
}

export function getEndpoint() {
    return _base ? { url: _base, version: _version, features: [..._features] } : null;
}

/** A healthy /health probe: refresh version + features, wake waiters. */
export function markHealthy(health) {
    if (Array.isArray(health?.features)) _features = new Set(health.features.map(String));
    if (health?.version) _version = String(health.version);
    if (_base) {
        _healthy = true;
        const waiters = _readyWaiters;
        _readyWaiters = [];
        for (const w of waiters) w();
    }
}

/** spawn.js tells the client whether a start is in progress and why not. */
export function setStatusProvider(fn) {
    _statusProvider = typeof fn === 'function' ? fn : _statusProvider;
}

/** spawn.js: how to start tgdl-core when a feature is used before anyone did. */
export function setAutoStart(fn) {
    _autoStart = typeof fn === 'function' ? fn : null;
}

/** Wake callers waiting for readiness so they re-check (start failed). */
export function notifyStateChange() {
    const waiters = _readyWaiters;
    _readyWaiters = [];
    for (const w of waiters) w();
}

/** True when `feature` can be sent right now. */
export function isAvailable(feature) {
    return Boolean(_base) && _healthy && _features.has(feature);
}

function _unavailable(feature) {
    if (_base && _healthy && !_features.has(feature)) {
        return new GoCoreError(
            'unavailable',
            `tgdl-core ${_version || ''} does not support "${feature}". Update it: restart the app so it downloads the pinned tgdl-core, or run \`npm run build:core\`.`,
        );
    }
    return new GoCoreError('unavailable', _statusProvider().message || 'tgdl-core is not running');
}

/**
 * Resolve once `feature` can be sent, waiting up to `waitMs` while
 * tgdl-core is starting; reject with GoCoreError('unavailable') otherwise.
 */
export async function ensureReady(feature, { waitMs = DEFAULT_READY_WAIT_MS, signal } = {}) {
    const end = Date.now() + Math.max(0, waitMs);
    for (;;) {
        if (isAvailable(feature)) return;
        if (!_base && _autoStart && _statusProvider().idle) {
            try {
                _autoStart();
            } catch {}
        }
        if ((_base && _healthy) || !_statusProvider().starting) throw _unavailable(feature);
        const left = end - Date.now();
        if (left <= 0) throw _unavailable(feature);
        if (signal?.aborted) throw new GoCoreError('aborted', 'aborted');
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(t);
                signal?.removeEventListener?.('abort', finish);
                resolve();
            };
            const t = setTimeout(finish, Math.min(left, 1_000));
            t.unref?.();
            signal?.addEventListener?.('abort', finish, { once: true });
            _readyWaiters.push(finish);
        });
    }
}

function _count(feature, result) {
    metrics.inc('tgdl_gocore_calls_total', 1, { feature, result });
}

/**
 * One request. `body` is a Buffer (sent as-is) or a value (JSON). With
 * `onLine`, the response body is read as NDJSON and each parsed line is
 * passed to it; otherwise the whole body is parsed as JSON.
 * Resolves { status, body } (body is null in line mode for 200).
 */
function _requestOnce(method, pathname, body, { timeoutMs, onLine, signal, contentType }) {
    return new Promise((resolve, reject) => {
        if (!_base) {
            reject(new GoCoreError('unavailable', _statusProvider().message));
            return;
        }
        let data = null;
        if (Buffer.isBuffer(body)) data = body;
        else if (body !== undefined) data = Buffer.from(JSON.stringify(body));
        const headers = {
            accept: onLine ? 'application/x-ndjson' : 'application/json',
            ...authHeaders(_token),
        };
        if (data) {
            headers['content-type'] =
                contentType ||
                (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json');
            headers['content-length'] = String(data.length);
        }
        let settled = false;
        let req = null;
        const finish = (fn, v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            fn(v);
        };
        const fail = (err) => {
            finish(reject, err);
            req?.destroy(err);
        };
        const onAbort = () => fail(new GoCoreError('aborted', 'aborted'));
        const timer = setTimeout(
            () =>
                fail(new GoCoreError('timeout', `tgdl-core did not answer within ${timeoutMs} ms`)),
            timeoutMs,
        );
        timer.unref?.();
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        req = http.request(
            { host: _host, port: _port, method, path: pathname, headers, agent: _agent },
            (res) => {
                const lineMode = onLine && res.statusCode === 200;
                const chunks = [];
                let size = 0;
                let pending = '';
                if (lineMode) res.setEncoding('utf8');
                res.on('data', (c) => {
                    if (settled) return;
                    if (!lineMode) {
                        size += c.length;
                        if (size > MAX_JSON_BYTES) {
                            fail(new GoCoreError('protocol', 'response too large'));
                            return;
                        }
                        chunks.push(c);
                        return;
                    }
                    pending += c;
                    let start = 0;
                    let nl = pending.indexOf('\n');
                    while (nl >= 0) {
                        const line = pending.slice(start, nl);
                        start = nl + 1;
                        if (line.trim()) {
                            let obj;
                            try {
                                obj = JSON.parse(line);
                            } catch {
                                fail(new GoCoreError('protocol', 'malformed NDJSON line'));
                                return;
                            }
                            try {
                                onLine(obj);
                            } catch (e) {
                                fail(e);
                                return;
                            }
                        }
                        nl = pending.indexOf('\n', start);
                    }
                    pending = start ? pending.slice(start) : pending;
                    if (pending.length > MAX_LINE_BYTES) {
                        fail(new GoCoreError('protocol', 'response line too large'));
                    }
                });
                res.on('end', () => {
                    if (settled) return;
                    if (lineMode) {
                        if (pending.trim()) {
                            try {
                                onLine(JSON.parse(pending));
                            } catch (e) {
                                fail(
                                    e instanceof GoCoreError
                                        ? e
                                        : new GoCoreError('protocol', 'malformed NDJSON line'),
                                );
                                return;
                            }
                        }
                        finish(resolve, { status: res.statusCode, body: null });
                        return;
                    }
                    const text = Buffer.concat(chunks).toString('utf8');
                    let parsed = null;
                    try {
                        parsed = text ? JSON.parse(text) : null;
                    } catch {
                        finish(
                            reject,
                            new GoCoreError('protocol', `non-JSON response (${res.statusCode})`, {
                                status: res.statusCode,
                            }),
                        );
                        return;
                    }
                    finish(resolve, { status: res.statusCode, body: parsed });
                });
                res.on('error', (e) =>
                    finish(reject, new GoCoreError('transport', e.message, { cause: e })),
                );
                res.on('aborted', () =>
                    finish(reject, new GoCoreError('transport', 'response aborted')),
                );
            },
        );
        req.on('error', (e) => {
            if (e instanceof GoCoreError) return finish(reject, e);
            const err = new GoCoreError('transport', e?.message || String(e), {
                code: e?.code || null,
                cause: e,
            });
            // A kept-alive socket tgdl-core closed as idle just as we
            // reused it — safe to retry once (see _request).
            err.staleSocket = req.reusedSocket && (e?.code === 'ECONNRESET' || e?.code === 'EPIPE');
            finish(reject, err);
        });
        if (data) req.end(data);
        else req.end();
    });
}

async function _request(method, pathname, body, opts) {
    try {
        return await _requestOnce(method, pathname, body, opts);
    } catch (e) {
        if (!e?.staleSocket || !_base) throw e;
        return _requestOnce(method, pathname, body, opts);
    }
}

// Stream a large response without buffering it in Node. The caller owns the
// public response; this helper only keeps the local Go request alive and
// forwards the bytes. Non-200 answers are buffered as the small JSON error
// envelope so callers can still decide whether to fall back.
function _pipeOnce(out, pathname, body, { timeoutMs, signal, feature = 'zip' }) {
    return new Promise((resolve, reject) => {
        if (!_base) {
            reject(new GoCoreError('unavailable', _statusProvider().message));
            return;
        }
        const data = Buffer.from(JSON.stringify(body));
        let settled = false;
        let req = null;
        let upstream = null;
        let closeHandler = null;
        const timer = setTimeout(
            () =>
                fail(new GoCoreError('timeout', `tgdl-core did not answer within ${timeoutMs} ms`)),
            timeoutMs,
        );
        timer.unref?.();
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            if (closeHandler) out.removeListener('close', closeHandler);
        };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };
        const fail = (err) => {
            finish(reject, err);
            req?.destroy(err);
            upstream?.destroy(err);
        };
        const onAbort = () => fail(new GoCoreError('aborted', 'aborted'));
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        req = http.request(
            {
                host: _host,
                port: _port,
                method: 'POST',
                path: pathname,
                headers: {
                    accept: 'application/zip, application/gzip, application/json',
                    'content-type': 'application/json',
                    'content-length': String(data.length),
                    ...authHeaders(_token),
                },
                agent: _agent,
            },
            (incoming) => {
                upstream = incoming;
                if (incoming.statusCode !== 200) {
                    const chunks = [];
                    let size = 0;
                    incoming.setEncoding('utf8');
                    incoming.on('data', (chunk) => {
                        size += chunk.length;
                        if (size <= MAX_JSON_BYTES) chunks.push(chunk);
                        else fail(new GoCoreError('protocol', 'error response too large'));
                    });
                    incoming.on('error', (e) =>
                        fail(new GoCoreError('transport', e.message, { cause: e })),
                    );
                    incoming.on('end', () => {
                        if (settled) return;
                        let bodyObj = null;
                        try {
                            bodyObj = chunks.length ? JSON.parse(chunks.join('')) : null;
                        } catch {
                            fail(
                                new GoCoreError(
                                    'protocol',
                                    `non-JSON response (${incoming.statusCode})`,
                                    {
                                        status: incoming.statusCode,
                                    },
                                ),
                            );
                            return;
                        }
                        fail(_errorFor(feature, incoming.statusCode, bodyObj));
                    });
                    return;
                }
                for (const name of ['content-type', 'cache-control', 'transfer-encoding']) {
                    const value = incoming.headers[name];
                    if (
                        value !== undefined &&
                        !out.headersSent &&
                        typeof out.setHeader === 'function'
                    ) {
                        out.setHeader(name, value);
                    }
                }
                closeHandler = () => {
                    if (!out.writableFinished)
                        fail(new GoCoreError('transport', 'response closed'));
                };
                out.once('close', closeHandler);
                incoming.on('error', (e) =>
                    fail(new GoCoreError('transport', e.message, { cause: e })),
                );
                out.once('finish', () => finish(resolve));
                incoming.pipe(out);
            },
        );
        req.on('error', (e) => {
            if (e instanceof GoCoreError) return fail(e);
            const err = new GoCoreError('transport', e?.message || String(e), {
                code: e?.code || null,
                cause: e,
            });
            err.staleSocket = req.reusedSocket && (e?.code === 'ECONNRESET' || e?.code === 'EPIPE');
            fail(err);
        });
        req.end(data);
    });
}

/** Stream a STORE-mode ZIP from tgdl-core into an Express response. */
export async function pipeZip(out, entries, { timeoutMs = 30 * 60_000, signal, readyWaitMs } = {}) {
    const feature = 'zip';
    await ensureReady(feature, { waitMs: readyWaitMs, signal });
    try {
        await _pipeOnce(out, '/v1/zip', { entries }, { timeoutMs, signal, feature });
        _count(feature, 'ok');
    } catch (e) {
        // _errorFor already counted an HTTP error; transport/deadline errors
        // are counted here, matching _call's accounting for the JSON APIs.
        if (!['outside', 'file', 'server', 'busy', 'auth'].includes(e?.kind)) {
            _count(feature, e?.kind === 'timeout' ? 'timeout' : 'error');
        }
        throw e;
    }
}

/** Stream a tar.gz backup snapshot from tgdl-core into a local file. */
export async function pipeTarGz(out, root, { timeoutMs = 30 * 60_000, signal, readyWaitMs } = {}) {
    const feature = 'tar-gz';
    await ensureReady(feature, { waitMs: readyWaitMs, signal });
    try {
        await _pipeOnce(out, '/v1/tar-gz', { root }, { timeoutMs, signal, feature });
        _count(feature, 'ok');
    } catch (e) {
        if (!['outside', 'file', 'server', 'busy', 'auth'].includes(e?.kind)) {
            _count(feature, e?.kind === 'timeout' ? 'timeout' : 'error');
        }
        throw e;
    }
}

/** Move an MP4's moov atom to the front with the Go core's ffmpeg worker. */
export async function optimizeFaststart(
    absPath,
    { timeoutMs = 10 * 60_000, signal, readyWaitMs, ffmpegPath } = {},
) {
    const feature = 'faststart';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/faststart',
        { path: absPath, ...(ffmpegPath ? { ffmpeg: ffmpegPath } : {}) },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (!['already', 'optimized'].includes(body?.status)) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed faststart response', { status });
    }
    if (body.status === 'optimized' && (!Number.isSafeInteger(body.newSize) || body.newSize < 0)) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed faststart size', { status });
    }
    _count(feature, 'ok');
    return {
        status: body.status,
        newSize: body.status === 'optimized' ? body.newSize : undefined,
    };
}

/** Generate a WebP thumbnail directly into the Node cache temp path. */
async function _generateThumb(
    kind,
    absPath,
    outputPath,
    width,
    { timeoutMs = 120_000, signal, readyWaitMs, ffmpegPath, hwaccel } = {},
) {
    const feature = 'thumb';
    const { status, body } = await _call(
        feature,
        'POST',
        `/v1/thumb/${kind}`,
        {
            path: absPath,
            output: outputPath,
            width,
            ...(ffmpegPath ? { ffmpeg: ffmpegPath } : {}),
            ...(hwaccel ? { hwaccel } : {}),
        },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (body?.status !== 'ok' || !Number.isSafeInteger(body.size) || body.size <= 0) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed video thumbnail response', { status });
    }
    _count(feature, 'ok');
    return { status: 'ok', size: body.size };
}

export function generateVideoThumb(absPath, outputPath, width, opts) {
    return _generateThumb('video', absPath, outputPath, width, opts);
}

export function generateImageThumb(absPath, outputPath, width, opts) {
    return _generateThumb('image', absPath, outputPath, width, opts);
}

export function generateAudioThumb(absPath, outputPath, width, opts) {
    return _generateThumb('audio', absPath, outputPath, width, opts);
}

/** Generate a tiled seekbar sprite through the Go core. */
export async function generateSeekbarSprite(
    absPath,
    outputPath,
    {
        frames,
        intervalSec,
        cols,
        rows,
        tileWidth,
        format = 'webp',
        quality = 75,
        timeoutMs = 60 * 60_000,
        signal,
        readyWaitMs,
        ffmpegPath,
        hwaccel,
    } = {},
) {
    const feature = 'seekbar';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/seekbar',
        {
            path: absPath,
            output: outputPath,
            frames,
            intervalSec,
            cols,
            rows,
            tileWidth,
            format,
            quality,
            ...(ffmpegPath ? { ffmpeg: ffmpegPath } : {}),
            ...(hwaccel ? { hwaccel } : {}),
        },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (body?.status !== 'ok' || !Number.isSafeInteger(body.size) || body.size <= 0) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed seekbar response', { status });
    }
    _count(feature, 'ok');
    return { status: 'ok', size: body.size };
}

/** Read the cached dashboard group aggregate from tgdl-core's read-only DB pool. */
export async function groupAggregates({ timeoutMs = 10_000, readyWaitMs, signal } = {}) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/group-aggregates',
        {},
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    const rows = body?.rows;
    const valid =
        Array.isArray(rows) &&
        rows.every(
            (r) =>
                r &&
                typeof r.group_id === 'string' &&
                Number.isSafeInteger(r.count) &&
                r.count >= 0 &&
                (r.best_name == null || typeof r.best_name === 'string') &&
                (r.any_name == null || typeof r.any_name === 'string') &&
                (r.size == null || (Number.isSafeInteger(r.size) && r.size >= 0)),
        );
    if (!valid) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed group aggregate response', { status });
    }
    _count(feature, 'ok');
    return rows;
}

/** Read total download rows and bytes through tgdl-core's DB projection. */
export async function databaseStats({ timeoutMs = 10_000, readyWaitMs, signal } = {}) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/stats',
        {},
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !Number.isSafeInteger(body?.totalFiles) ||
        body.totalFiles < 0 ||
        !Number.isSafeInteger(body?.totalSize) ||
        body.totalSize < 0
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed database stats response', { status });
    }
    _count(feature, 'ok');
    return { totalFiles: body.totalFiles, totalSize: body.totalSize };
}

/** Read per-group counters and timestamps through tgdl-core's DB projection. */
export async function groupStats(groupId, { timeoutMs = 10_000, readyWaitMs, signal } = {}) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/group-stats',
        { groupId: String(groupId) },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    const byType = body?.byType;
    const valid =
        body &&
        Number.isSafeInteger(body.totalFiles) &&
        body.totalFiles >= 0 &&
        Number.isSafeInteger(body.totalBytes) &&
        body.totalBytes >= 0 &&
        byType &&
        typeof byType === 'object' &&
        !Array.isArray(byType) &&
        Object.values(byType).every((n) => Number.isSafeInteger(n) && n >= 0) &&
        (body.firstMessageId == null || Number.isSafeInteger(body.firstMessageId)) &&
        (body.lastMessageId == null || Number.isSafeInteger(body.lastMessageId)) &&
        (body.lastDownloadAt == null || typeof body.lastDownloadAt === 'string');
    if (!valid) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed group stats response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read a paginated group file projection through tgdl-core's DB pool. */
export async function groupFiles(
    { groupId, limit = 50, offset = 0, type = null },
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/group-files',
        { groupId: String(groupId), limit, offset, ...(type ? { type } : {}) },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    const valid =
        body &&
        Array.isArray(body.rows) &&
        Number.isSafeInteger(body.total) &&
        body.total >= 0 &&
        Number.isSafeInteger(body.limit) &&
        body.limit >= 1 &&
        Number.isSafeInteger(body.offset) &&
        body.offset >= 0 &&
        typeof body.hasMore === 'boolean';
    if (!valid) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed group files response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read a local all-media gallery page through tgdl-core's DB pool. */
export async function allDownloads(
    { limit = 50, offset = 0, type = 'all', pinnedOnly = false, pinnedFirst = false } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/downloads/all',
        { limit, offset, type, pinnedOnly: !!pinnedOnly, pinnedFirst: !!pinnedFirst },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !body ||
        !Array.isArray(body.files) ||
        !Number.isSafeInteger(body.total) ||
        body.total < 0
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed all-downloads response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read a local per-group gallery page through tgdl-core's DB pool. */
export async function downloadsGroup(
    { groupId, limit = 50, offset = 0, type = 'all', pinnedOnly = false, pinnedFirst = false },
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/downloads/group',
        {
            groupId: String(groupId),
            limit,
            offset,
            type,
            pinnedOnly: !!pinnedOnly,
            pinnedFirst: !!pinnedFirst,
        },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !body ||
        !Array.isArray(body.files) ||
        !Number.isSafeInteger(body.total) ||
        body.total < 0
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed group-downloads response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read a local FTS/LIKE gallery search page through tgdl-core's DB pool. */
export async function searchDownloads(
    {
        query,
        limit = 50,
        offset = 0,
        groupId,
        type = 'all',
        pinnedOnly = false,
        pinnedFirst = false,
        order = 'relevance',
    },
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/downloads/search',
        {
            query: String(query || ''),
            limit,
            offset,
            ...(groupId != null ? { groupId: String(groupId) } : {}),
            type,
            pinnedOnly: !!pinnedOnly,
            pinnedFirst: !!pinnedFirst,
            order,
        },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !body ||
        !Array.isArray(body.files) ||
        !Number.isSafeInteger(body.total) ||
        body.total < 0
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed search response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read the joined local share-link page through tgdl-core's DB pool. */
export async function shareLinks(
    { downloadId = null, includeRevoked = true, limit = 500, offset = 0, search = null } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/share-links',
        {
            ...(downloadId == null ? {} : { downloadId: Number(downloadId) }),
            includeRevoked: !!includeRevoked,
            limit,
            offset,
            ...(search != null ? { search: String(search) } : {}),
        },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (!body || !Array.isArray(body.rows) || !Number.isSafeInteger(body.total) || body.total < 0) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed share-links response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read the newest update audit rows through tgdl-core's DB pool. */
export async function updateHistory(
    { limit = 25 } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/update-history',
        { limit },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (!body || !Array.isArray(body.history)) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed update-history response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read NSFW tier counters through tgdl-core's DB pool. */
export async function nsfwTiers(
    { fileTypes = ['photo'] } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/nsfw-tiers',
        { fileTypes: Array.isArray(fileTypes) ? fileTypes : ['photo'] },
        { timeoutMs, readyWaitMs, signal },
    );
    const tiers = body?.tiers;
    const validTierCounts =
        tiers &&
        typeof tiers === 'object' &&
        !Array.isArray(tiers) &&
        Object.values(tiers).every((n) => Number.isSafeInteger(n) && n >= 0);
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !validTierCounts ||
        !Number.isSafeInteger(body.scanned) ||
        body.scanned < 0 ||
        !Number.isSafeInteger(body.unscanned) ||
        body.unscanned < 0 ||
        !Number.isSafeInteger(body.whitelisted) ||
        body.whitelisted < 0 ||
        !Number.isSafeInteger(body.totalEligible) ||
        body.totalEligible < 0
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed nsfw tiers response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read a dense NSFW score histogram through tgdl-core's DB pool. */
export async function nsfwHistogram(
    { fileTypes = ['photo'], bins = 20 } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/nsfw-histogram',
        { fileTypes: Array.isArray(fileTypes) ? fileTypes : ['photo'], bins },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !body ||
        !Number.isSafeInteger(body.bins) ||
        body.bins < 4 ||
        body.bins > 50 ||
        !Array.isArray(body.counts) ||
        body.counts.length !== body.bins ||
        !body.counts.every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed nsfw histogram response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read a paginated NSFW review list through tgdl-core's DB pool. */
export async function nsfwList(
    {
        tier = null,
        fileTypes = ['photo'],
        groupId = null,
        includeWhitelisted = false,
        page = 1,
        limit = 50,
        fileKind = null,
    } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/nsfw-list',
        {
            ...(tier ? { tier: String(tier) } : {}),
            fileTypes: Array.isArray(fileTypes) ? fileTypes : ['photo'],
            ...(groupId ? { groupId: String(groupId) } : {}),
            includeWhitelisted: !!includeWhitelisted,
            page,
            limit,
            ...(fileKind ? { fileKind: String(fileKind) } : {}),
        },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !body ||
        !Array.isArray(body.rows) ||
        !Number.isSafeInteger(body.total) ||
        body.total < 0 ||
        !Number.isSafeInteger(body.page) ||
        body.page < 1 ||
        !Number.isSafeInteger(body.totalPages) ||
        body.totalPages < 1
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed nsfw list response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read the local people page through tgdl-core's DB pool. */
export async function peopleList(
    { limit = 100, offset = 0, sort = 'face_count', dir = 'desc' } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/people',
        { limit, offset, sort, dir },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !body ||
        !Array.isArray(body.people) ||
        !Number.isSafeInteger(body.total) ||
        body.total < 0
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed people response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Read the paginated thumbnail maintenance catalog through tgdl-core. */
export async function thumbsList(
    { limit = 60, cursor = null, kind = 'all', cachedOnly = false, cacheRoot = '' } = {},
    { timeoutMs = 10_000, readyWaitMs, signal } = {},
) {
    const feature = 'db';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/db/thumbs-list',
        {
            limit,
            ...(Number.isInteger(cursor) && cursor > 0 ? { cursor } : {}),
            kind: String(kind || 'all'),
            cachedOnly: !!cachedOnly,
            ...(cacheRoot ? { cacheRoot: String(cacheRoot) } : {}),
        },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    const validRows =
        body &&
        Array.isArray(body.rows) &&
        body.rows.every(
            (row) =>
                row &&
                Number.isSafeInteger(row.id) &&
                row.id > 0 &&
                typeof row.cached === 'boolean' &&
                (row.file_name == null || typeof row.file_name === 'string') &&
                (row.file_type == null || typeof row.file_type === 'string') &&
                (row.file_size == null ||
                    (Number.isSafeInteger(row.file_size) && row.file_size >= 0)) &&
                (row.file_path == null || typeof row.file_path === 'string') &&
                (row.created_at == null || typeof row.created_at === 'string'),
        );
    if (
        !validRows ||
        (body.total != null && (!Number.isSafeInteger(body.total) || body.total < 0)) ||
        (body.nextCursor != null &&
            (!Number.isSafeInteger(body.nextCursor) || body.nextCursor <= 0)) ||
        typeof body.hasMore !== 'boolean'
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed thumbnail list response', { status });
    }
    _count(feature, 'ok');
    return body;
}

/** Map a non-200 JSON answer to a GoCoreError. */
function _errorFor(feature, status, body) {
    const code = body?.error?.code || null;
    const message = body?.error?.message || `tgdl-core answered ${status}`;
    if (status === 403 && code === 'EOUTSIDE') {
        _count(feature, 'outside');
        return new GoCoreError('outside', message, { code, status });
    }
    if (status === 422) {
        _count(feature, 'file_error');
        return new GoCoreError('file', message, { code, status });
    }
    _count(feature, 'error');
    if (status === 503) return new GoCoreError('busy', message, { code, status });
    if (status === 401) return new GoCoreError('auth', message, { code, status });
    return new GoCoreError('server', message, { code, status });
}

async function _call(feature, method, pathname, body, opts) {
    await ensureReady(feature, { waitMs: opts.readyWaitMs, signal: opts.signal });
    try {
        return await _request(method, pathname, body, opts);
    } catch (e) {
        _count(feature, e?.kind === 'timeout' ? 'timeout' : 'error');
        throw e;
    }
}

/**
 * SHA-256 of `absPath` (read until EOF).
 *
 * @returns {Promise<{ sha256: string, size: number, mtimeMs: number }>}
 */
export async function hashFile(absPath, { timeoutMs = 30_000, readyWaitMs, signal } = {}) {
    const feature = 'hash';
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/hash',
        { path: absPath },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    const sha = body?.sha256;
    if (typeof sha !== 'string' || !HEX64.test(sha) || !Number.isFinite(body?.size)) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed hash response', { status });
    }
    _count(feature, 'ok');
    return { sha256: sha, size: body.size, mtimeMs: Number(body.mtimeMs) };
}

export const HASH_BATCH_MAX = 256;

/**
 * Hash up to HASH_BATCH_MAX files in one request. Each result is either a
 * normal hash result or `{ code, message }` for that path, so one vanished
 * file cannot discard the rest of a maintenance batch.
 */
export async function hashBatch(paths, { timeoutMs = 5 * 60_000, readyWaitMs, signal } = {}) {
    const feature = 'hash-batch';
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > HASH_BATCH_MAX) {
        throw new RangeError(`hashBatch: 1-${HASH_BATCH_MAX} paths per call`);
    }
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/hash-batch',
        { paths },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    const results = body?.results;
    const valid =
        Array.isArray(results) &&
        results.length === paths.length &&
        results.every(
            (r) =>
                r &&
                ((typeof r.sha256 === 'string' &&
                    HEX64.test(r.sha256) &&
                    Number.isFinite(r.size)) ||
                    typeof r.code === 'string'),
        );
    if (!valid) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed hash-batch response', { status });
    }
    _count(feature, 'ok');
    return results.map((r) => ({
        ...(r.sha256
            ? { sha256: r.sha256, size: Number(r.size), mtimeMs: Number(r.mtimeMs) }
            : { code: r.code, message: String(r.message || r.code) }),
    }));
}

export const STAT_BATCH_MAX = 1000;

/**
 * fs.stat for every path (≤ STAT_BATCH_MAX), in order. Each result is
 * `{ ok: true, size, mtimeMs, isFile, isDir }` or `{ code }` with Node's
 * error code for the same stat (EOUTSIDE: not tgdl-core's to answer).
 */
export async function statBatch(paths, { timeoutMs = 60_000, readyWaitMs } = {}) {
    const feature = 'stat';
    if (paths.length > STAT_BATCH_MAX) {
        throw new RangeError(`statBatch: at most ${STAT_BATCH_MAX} paths per call`);
    }
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/fs/stat-batch',
        { paths },
        { timeoutMs, readyWaitMs },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    const results = body?.results;
    const valid =
        Array.isArray(results) &&
        results.length === paths.length &&
        results.every(
            (r) =>
                r &&
                ((r.ok === true && Number.isFinite(r.size) && typeof r.isFile === 'boolean') ||
                    (typeof r.code === 'string' && r.code)),
        );
    if (!valid) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed stat-batch response', { status });
    }
    _count(feature, 'ok');
    return results;
}

/**
 * Recursive readdir (+ stat) of `root`, streamed. `onEvent` gets each
 * `{t:'d'|'f'|'e', p, …}` line in walk order; resolves the `end` summary.
 *
 * @param {{ root: string, maxDepth?: number, stat?: 'none'|'files'|'nondir', entries?: boolean }} req
 */
export async function walk(req, { onEvent, timeoutMs = 30 * 60_000, signal, readyWaitMs } = {}) {
    const feature = 'walk';
    let summary = null;
    const { status, body } = await _call(feature, 'POST', '/v1/fs/walk', req, {
        timeoutMs,
        signal,
        readyWaitMs,
        onLine: (ev) => {
            if (ev?.t === 'end') {
                summary = ev;
                return;
            }
            onEvent?.(ev);
        },
    });
    if (status !== 200) throw _errorFor(feature, status, body);
    if (!summary) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'walk stream ended without a summary');
    }
    _count(feature, 'ok');
    return summary;
}

/** Remove a directory tree while preserving absolute paths in `keep`. */
export async function removeTree(
    root,
    keep = [],
    { timeoutMs = 30 * 60_000, readyWaitMs, signal } = {},
) {
    const feature = 'remove-tree';
    if (!Array.isArray(keep)) throw new TypeError('removeTree: keep must be an array');
    const { status, body } = await _call(
        feature,
        'POST',
        '/v1/fs/remove-tree',
        { root, keep },
        { timeoutMs, readyWaitMs, signal },
    );
    if (status !== 200) throw _errorFor(feature, status, body);
    if (
        !Number.isSafeInteger(body?.kept) ||
        body.kept < 0 ||
        !Number.isSafeInteger(body?.removed) ||
        body.removed < 0
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'malformed remove-tree response', { status });
    }
    _count(feature, 'ok');
    return { kept: body.kept, removed: body.removed };
}

function _b64(s, Type) {
    const buf = Buffer.from(String(s || ''), 'base64');
    if (buf.length % Type.BYTES_PER_ELEMENT)
        throw new GoCoreError('protocol', 'bad dbscan payload');
    // Copy into a fresh, aligned buffer (Buffer pools are not aligned).
    const out = new Type(buf.length / Type.BYTES_PER_ELEMENT);
    new Uint8Array(out.buffer).set(buf);
    return out;
}

/**
 * DBSCAN over n × dim float32 embeddings (+ optional float64 weights).
 * Resolves `{ count, noiseCount, starts: Int32Array, members: Int32Array,
 * centroids: Float32Array }` — the packing of the old cluster worker.
 */
export async function dbscan(
    { data, n, dim, weights = null, eps, minPts },
    { onProgress, signal, timeoutMs = 6 * 60 * 60_000, readyWaitMs } = {},
) {
    const feature = 'dbscan';
    const parts = [Buffer.from(data.buffer, data.byteOffset, n * dim * 4)];
    if (weights) parts.push(Buffer.from(weights.buffer, weights.byteOffset, n * 8));
    const payload = Buffer.concat(parts);
    const qs = new URLSearchParams({
        n: String(n),
        dim: String(dim),
        eps: String(eps),
        minPts: String(minPts),
        weights: weights ? '1' : '0',
    });
    let result = null;
    let failure = null;
    const { status, body } = await _call(feature, 'POST', `/v1/dbscan?${qs}`, payload, {
        timeoutMs,
        signal,
        readyWaitMs,
        onLine: (ev) => {
            if (ev?.t === 'progress') {
                try {
                    onProgress?.(ev.done, ev.n);
                } catch {}
            } else if (ev?.t === 'result') {
                result = ev;
            } else if (ev?.t === 'error') {
                failure = ev;
            }
        },
    });
    if (status !== 200) throw _errorFor(feature, status, body);
    if (failure) {
        _count(feature, 'error');
        throw new GoCoreError('server', failure.message || 'dbscan failed', { code: failure.code });
    }
    if (!result) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'dbscan stream ended without a result');
    }
    const starts = _b64(result.starts, Int32Array);
    const members = _b64(result.members, Int32Array);
    const centroids = _b64(result.centroids, Float32Array);
    const count = Number(result.count);
    if (
        !Number.isInteger(count) ||
        starts.length !== count + 1 ||
        centroids.length !== count * dim ||
        starts[count] !== members.length
    ) {
        _count(feature, 'error');
        throw new GoCoreError('protocol', 'inconsistent dbscan result');
    }
    _count(feature, 'ok');
    return { count, noiseCount: Number(result.noiseCount) || 0, starts, members, centroids };
}

/** GET /health. Resolves the body or rejects. */
export async function health({ timeoutMs = 3_000 } = {}) {
    const { status, body } = await _request('GET', '/health', undefined, { timeoutMs });
    if (status !== 200 || body?.ok !== true || body?.service !== 'tgdl-core') {
        throw new GoCoreError('server', `unhealthy (${status})`, { status });
    }
    return body;
}

/** GET /v1/stats — token-gated, so it also proves the token is right. */
export async function stats({ timeoutMs = 3_000 } = {}) {
    const { status, body } = await _request('GET', '/v1/stats', undefined, { timeoutMs });
    if (status !== 200) {
        throw new GoCoreError(status === 401 ? 'auth' : 'server', `stats answered ${status}`, {
            status,
        });
    }
    return body;
}

/** Test helper: forget the endpoint and any waiters. */
export function _resetForTests() {
    clearEndpoint();
    notifyStateChange();
}
