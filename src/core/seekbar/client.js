/**
 * HTTP client for the seekbar-service Go sidecar.
 *
 * Mirrors the shape of `src/core/ai/faces-client.js`: a module-scoped
 * URL + bearer token, set once by the spawn module at boot, consumed
 * by the per-row generator and the maintenance routes.
 */

let _baseUrl = '';
let _token = '';

export function setSidecarUrl(url, token = '') {
    _baseUrl = String(url || '').replace(/\/+$/, '');
    _token = String(token || '');
}

export function getSidecarUrl() {
    return _baseUrl;
}

function _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (_token) h['X-API-Token'] = _token;
    return h;
}

async function _fetch(path, opts = {}) {
    if (!_baseUrl) throw new Error('seekbar sidecar URL not configured');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 120_000);
    try {
        const r = await fetch(_baseUrl + path, {
            ...opts,
            signal: ctrl.signal,
            headers: _headers(opts.headers || {}),
        });
        const ct = r.headers.get('content-type') || '';
        const body = ct.includes('json') ? await r.json() : await r.text();
        if (!r.ok) {
            const msg = typeof body === 'string' ? body : body?.error || `HTTP ${r.status}`;
            const err = new Error(msg);
            err.status = r.status;
            err.body = body;
            throw err;
        }
        return body;
    } finally {
        clearTimeout(t);
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
            return result;
        } catch (e) {
            lastErr = e;
        }
    }
    return { ok: false, error: lastErr?.message || String(lastErr) };
}

/**
 * Submit one video. The Go service returns the metadata row (or a
 * pending stub when `async:true`).
 *
 * `cfg` is an optional config overlay forwarded as per-job params —
 * allows runtime config changes to take effect without restarting the
 * sidecar (the sidecar merges job-level overrides on top of its env
 * defaults). Unknown fields are silently ignored by older sidecars so
 * callers can always forward the full cfg snapshot.
 */
export async function submitOne({ videoId, srcPath, priority = 1, async = false, cfg = null }) {
    const body = {
        video_id: String(videoId),
        path: String(srcPath),
        priority: Number(priority) || 0,
        async: !!async,
    };
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
        // Long timeout for sync mode — a 30-min clip can take a while
        // on a Pi class device even with hwaccel.
        timeoutMs: 10 * 60_000,
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
