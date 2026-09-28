/**
 * HTTP client for the seekbar-service Go sidecar.
 *
 * Mirrors the shape of `src/core/ai/faces-client.js`: a module-scoped
 * URL + bearer token, set once by the spawn module at boot, consumed
 * by the per-row generator and the maintenance routes.
 *
 * External sidecars (another host / container, possibly behind a reverse
 * proxy with a path prefix) additionally use:
 *   - a path map, so a shared mount at a different path still reads the
 *     video in place (`toSidecarPath` / `fromSidecarPath`);
 *   - upload mode (seekbar-service 0.4.0+, `features` on /health): the
 *     video is PUT in chunks below proxy body limits, and the finished
 *     sprite is downloaded back with `downloadSprite`.
 */

import crypto from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';

import {
    authHeaders,
    fromSidecarPath as _fromSidecarPath,
    normalizeSidecarUrl,
    parsePathMap,
    toSidecarPath as _toSidecarPath,
    uploadTimeoutMs,
} from '../sidecar-remote.js';

// Chunk size when the sidecar doesn't suggest one. Well under the 100 MB
// request cap of Cloudflare Tunnel and most reverse proxies.
const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
// Parallel uploads to a remote sidecar. The scan runs several videos at
// once; letting all of them push multi-GB files over one uplink just
// makes every upload slower.
const UPLOAD_SLOTS = Math.max(1, Number.parseInt(process.env.SEEKBAR_UPLOAD_CONCURRENCY, 10) || 2);
const CHUNK_ATTEMPTS = 3;

let _baseUrl = '';
let _token = '';
let _pathMap = [];
let _caps = { features: [], chunkBytes: DEFAULT_CHUNK_BYTES, version: null };

export function setSidecarUrl(url, token = '') {
    _baseUrl = normalizeSidecarUrl(String(url || ''));
    _token = String(token || '').trim();
}

export function getSidecarUrl() {
    return _baseUrl;
}

/** App-path → sidecar-path rules; only meaningful for an external sidecar. */
export function setPathMap(raw) {
    _pathMap = parsePathMap(raw);
}

export function toSidecarPath(p) {
    return _toSidecarPath(p, _pathMap);
}

export function fromSidecarPath(p) {
    return _fromSidecarPath(p, _pathMap);
}

/** Remember what the connected sidecar supports (from its /health body). */
export function setCapabilities(h) {
    const chunk = Number(h?.upload_chunk_bytes);
    _caps = {
        features: Array.isArray(h?.features) ? h.features.map(String) : [],
        chunkBytes:
            Number.isFinite(chunk) && chunk > 0
                ? Math.min(MAX_CHUNK_BYTES, chunk)
                : DEFAULT_CHUNK_BYTES,
        version: h?.version ?? null,
    };
}

export function hasFeature(name) {
    return _caps.features.includes(name);
}

function _headers(extra = {}) {
    return { 'Content-Type': 'application/json', ...authHeaders(_token), ...extra };
}

async function _fetch(path, opts = {}) {
    if (!_baseUrl) throw new Error('seekbar sidecar URL not configured');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 120_000);
    // Forward external abort signal so JobTracker cancellation kills
    // in-flight HTTP requests immediately instead of waiting for the
    // sidecar's 10-minute processing timeout. The listener is removed
    // again below — one scan signal outlives thousands of requests.
    const onAbort = () => ctrl.abort();
    if (opts.signal) {
        if (opts.signal.aborted) {
            ctrl.abort();
        } else {
            opts.signal.addEventListener('abort', onAbort, { once: true });
        }
    }
    try {
        const r = await fetch(_baseUrl + path, {
            ...opts,
            signal: ctrl.signal,
            headers: _headers(opts.headers || {}),
        });
        const ct = r.headers.get('content-type') || '';
        const text = await r.text();
        let body = text;
        if (ct.includes('json') || /^\s*[{[]/.test(text)) {
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
        }
        if (!r.ok) {
            const msg =
                typeof body === 'string'
                    ? body.trim() || `HTTP ${r.status}`
                    : body?.error || `HTTP ${r.status}`;
            const err = new Error(msg);
            err.status = r.status;
            err.body = body;
            throw err;
        }
        return body;
    } finally {
        clearTimeout(t);
        opts.signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * Probe the sidecar's `/health` endpoint with a 5 s timeout.
 * Retries up to 3 times on network errors / 5xx before returning
 * a failure so a single transient blip doesn't flip the status card
 * red on the maintenance page.
 *
 * NEVER throws — returns `{ ok: false, error }` on failure.
 */
export async function health() {
    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const result = await _fetch('/health', { method: 'GET', timeoutMs: 5_000 });
            if (!result || typeof result !== 'object') {
                // A proxy page instead of the sidecar (wrong path prefix?).
                return { ok: false, error: 'not a seekbar sidecar response' };
            }
            return result;
        } catch (e) {
            lastErr = e;
            if (e?.status && e.status < 500) break;
        }
    }
    return { ok: false, error: lastErr?.message || String(lastErr) };
}

/**
 * Submit one video. The Go service returns the metadata row (or a
 * pending stub when `async:true`).
 *
 * Pass `srcPath` (a path the sidecar can read — run it through
 * `toSidecarPath` first) or `uploadId` (from `uploadSource`).
 *
 * `cfg` is an optional config overlay forwarded as per-job params —
 * allows runtime config changes to take effect without restarting the
 * sidecar (0.4.0+ merges job-level overrides on top of its env
 * defaults). Unknown fields are silently ignored by older sidecars so
 * callers can always forward the full cfg snapshot.
 */
export async function submitOne({
    videoId,
    srcPath = null,
    uploadId = null,
    priority = 1,
    async = false,
    cfg = null,
    overwrite = null,
    signal = null,
}) {
    const body = {
        video_id: String(videoId),
        priority: Number(priority) || 0,
        async: !!async,
    };
    // 0.4.0+ honours a per-job cache policy (older sidecars ignore it).
    if (overwrite) body.overwrite = String(overwrite);
    if (uploadId) body.upload_id = String(uploadId);
    else body.path = String(srcPath);
    if (cfg && typeof cfg === 'object') {
        if (Number.isFinite(cfg.intervalSec) && cfg.intervalSec > 0) {
            body.interval_sec = cfg.intervalSec;
        }
        if (Number.isFinite(cfg.tileWidth) && cfg.tileWidth > 0) {
            body.tile_w = cfg.tileWidth;
        }
        if (Number.isFinite(cfg.columns) && cfg.columns > 0) {
            body.cols = cfg.columns;
        }
        if (Number.isFinite(cfg.maxTiles) && cfg.maxTiles > 0) {
            body.max_tiles = cfg.maxTiles;
        }
        if (cfg.format) {
            body.format = String(cfg.format);
        }
        if (Number.isFinite(cfg.quality) && cfg.quality > 0) {
            body.quality = cfg.quality;
        }
    }
    return _fetch('/v1/sprite', {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: 10 * 60_000,
        signal,
    });
}

/** True when a submit failed because the sidecar can't see the file. */
export function isSourceNotFound(err) {
    return err?.status === 400 && /source not found/i.test(String(err?.message || ''));
}

// ---- Upload mode (0.4.0+) --------------------------------------------------

let _uploadsActive = 0;
const _uploadWaiters = [];

async function _acquireUploadSlot(signal) {
    while (_uploadsActive >= UPLOAD_SLOTS) {
        await new Promise((resolve) => _uploadWaiters.push(resolve));
        if (signal?.aborted) {
            _uploadWaiters.shift()?.(); // pass the wake-up on
            throw new Error('aborted');
        }
    }
    _uploadsActive++;
}

function _releaseUploadSlot() {
    _uploadsActive = Math.max(0, _uploadsActive - 1);
    const next = _uploadWaiters.shift();
    if (next) next();
}

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a local video to the sidecar in chunks (`PUT /v1/uploads/:id`) and
 * return the upload id to submit. A lost response is recovered from the
 * sidecar's 409 `{ size }`; transient failures retry the same chunk.
 */
export async function uploadSource(absPath, { signal = null } = {}) {
    const st = await fsp.stat(absPath);
    if (!st.size) throw new Error(`cannot upload an empty file: ${path.basename(absPath)}`);
    await _acquireUploadSlot(signal);
    const id = `u-${crypto.randomBytes(8).toString('hex')}`;
    let fh = null;
    try {
        fh = await fsp.open(absPath, 'r');
        const chunkBytes = _caps.chunkBytes || DEFAULT_CHUNK_BYTES;
        let offset = 0;
        while (offset < st.size) {
            if (signal?.aborted) throw new Error('aborted');
            const len = Math.min(chunkBytes, st.size - offset);
            const buf = Buffer.allocUnsafe(len);
            const { bytesRead } = await fh.read(buf, 0, len, offset);
            if (bytesRead <= 0) throw new Error(`short read at ${offset} of ${absPath}`);
            const chunk = bytesRead === len ? buf : buf.subarray(0, bytesRead);
            for (let attempt = 1; ; attempt++) {
                try {
                    const r = await _fetch(`/v1/uploads/${id}`, {
                        method: 'PUT',
                        body: chunk,
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'X-Upload-Offset': String(offset),
                        },
                        timeoutMs: uploadTimeoutMs(chunk.length, 60_000),
                        signal,
                    });
                    offset = Number(r?.size);
                    if (!Number.isFinite(offset)) throw new Error('bad upload response');
                    break;
                } catch (e) {
                    if (signal?.aborted) throw e;
                    if (e?.status === 409 && Number.isFinite(Number(e.body?.size))) {
                        offset = Number(e.body.size); // resume where the sidecar is
                        break;
                    }
                    const retryable =
                        !e?.status || e.status >= 500 || [408, 429].includes(e.status);
                    if (!retryable || attempt >= CHUNK_ATTEMPTS) throw e;
                    await _sleep(1000 * attempt);
                }
            }
        }
        return id;
    } catch (e) {
        deleteUpload(id).catch(() => {});
        throw e;
    } finally {
        await fh?.close().catch(() => {});
        _releaseUploadSlot();
    }
}

export async function deleteUpload(uploadId) {
    return _fetch(`/v1/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
        timeoutMs: 15_000,
    });
}

/**
 * Download a finished sprite from the sidecar (`GET /sprite/:id`) into
 * `dstAbs` atomically. Works with every sidecar version.
 * @returns {Promise<{ bytes: number, format: 'webp'|'jpeg' }>}
 */
export async function downloadSprite(videoId, dstAbs, { signal = null } = {}) {
    if (!_baseUrl) throw new Error('seekbar sidecar URL not configured');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5 * 60_000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const r = await fetch(`${_baseUrl}/sprite/${encodeURIComponent(videoId)}`, {
            headers: authHeaders(_token),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            const err = new Error(`sprite download failed: HTTP ${r.status}`);
            err.status = r.status;
            throw err;
        }
        const ct = r.headers.get('content-type') || '';
        if (!/^image\//i.test(ct))
            throw new Error(`sprite download: unexpected ${ct || 'content'}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) throw new Error('sprite download: empty body');
        const tmp = `${dstAbs}.dl.${crypto.randomBytes(4).toString('hex')}`;
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, dstAbs);
        return { bytes: buf.length, format: /webp/i.test(ct) ? 'webp' : 'jpeg' };
    } finally {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * One job's current state (`GET /v1/jobs/:id`). Throws with
 * `err.status === 404` once the sidecar has dropped the job — it keeps
 * only its most recent 1000.
 */
export async function getJob(jobId, signal = null) {
    return _fetch(`/v1/jobs/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        timeoutMs: 15_000,
        signal,
    });
}

/** Best-effort cancel — the sidecar can only cancel a job still queued. */
export async function cancelJob(jobId) {
    return _fetch(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        timeoutMs: 5_000,
    });
}

export async function submitBatch(items) {
    return _fetch('/v1/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
        timeoutMs: 60_000,
    });
}

export async function deleteSprite(videoId) {
    return _fetch(`/v1/sprite/${encodeURIComponent(videoId)}`, {
        method: 'DELETE',
        timeoutMs: 15_000,
    });
}

export async function probeHwaccel() {
    return _fetch('/v1/hwaccel', { method: 'GET', timeoutMs: 30_000 });
}

export async function stats() {
    return _fetch('/v1/stats', { method: 'GET', timeoutMs: 5_000 });
}

export function _resetForTests() {
    _baseUrl = '';
    _token = '';
    _pathMap = [];
    _caps = { features: [], chunkBytes: DEFAULT_CHUNK_BYTES, version: null };
    _uploadsActive = 0;
    _uploadWaiters.length = 0;
}
