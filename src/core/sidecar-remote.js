/**
 * Shared helpers for sidecars (faces / NSFW / seekbar) that may run on
 * another machine — a GPU box, a separate container, or behind a reverse
 * proxy / Cloudflare Tunnel.
 *
 *   - normalizeSidecarUrl: keeps a proxy path prefix (`https://host/nsfw`),
 *     drops trailing slashes / query / hash, adds `http://` when the scheme
 *     is missing.
 *   - authHeaders: the `X-API-Token` header every sidecar accepts.
 *   - parsePathMap / toSidecarPath / fromSidecarPath: "the app sees
 *     /app/data/downloads, the sidecar sees /mnt/media" prefix rewriting,
 *     so a shared mount at a different path keeps the fast path mode.
 *   - probeSidecar: /health + an authenticated no-op, for the dashboard's
 *     Test buttons (reachable? version? features? token accepted?).
 */

export const TOKEN_HEADER = 'X-API-Token';

/**
 * Canonical base URL for a sidecar, or '' when unset. Unparseable input is
 * returned trimmed (minus trailing slashes) so the error surfaces at the
 * first health probe instead of silently switching the sidecar off.
 */
export function normalizeSidecarUrl(raw) {
    let s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return '';
    if (s.length > 2048) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
    let u;
    try {
        u = new URL(s);
    } catch {
        return _trimSlashes(s);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return _trimSlashes(s);
    return `${u.protocol}//${u.host}${_trimSlashes(u.pathname)}`;
}

function _trimSlashes(s) {
    let end = s.length;
    while (end > 0 && s[end - 1] === '/') end--;
    return s.slice(0, end);
}

/** Request headers carrying the shared sidecar token (none when unset). */
export function authHeaders(token) {
    const t = typeof token === 'string' ? token.trim() : '';
    return t ? { [TOKEN_HEADER]: t } : {};
}

// ---- Path mapping ---------------------------------------------------------

function _isWinPath(s) {
    return /^[A-Za-z]:([\\/]|$)/.test(s) || s.startsWith('\\\\');
}

// Forward slashes, no trailing separator (except a bare root).
function _canon(s) {
    let c = String(s).replace(/\\/g, '/');
    while (c.length > 1 && c.endsWith('/') && !/^[A-Za-z]:\/$/.test(c)) c = c.slice(0, -1);
    return c;
}

/**
 * Parse path-mapping rules. Accepts a string of `appPath=sidecarPath`
 * rules separated by newlines or `;` (`=>` also works as the separator),
 * or an array of such strings / `{ from, to }` / `[from, to]`.
 * Longest `from` first so nested mounts map correctly.
 *
 * @returns {Array<{ from: string, to: string }>}
 */
export function parsePathMap(raw) {
    const items = [];
    const push = (from, to) => {
        const f = typeof from === 'string' ? from.trim() : '';
        const t = typeof to === 'string' ? to.trim() : '';
        if (f && t) items.push({ from: f, to: t });
    };
    const pushRule = (line) => {
        const s = String(line || '').trim();
        if (!s || s.startsWith('#')) return;
        const arrow = s.indexOf('=>');
        const idx = arrow >= 0 ? arrow : s.indexOf('=');
        if (idx <= 0) return;
        push(s.slice(0, idx), s.slice(idx + (arrow >= 0 ? 2 : 1)));
    };
    if (Array.isArray(raw)) {
        for (const r of raw) {
            if (typeof r === 'string') pushRule(r);
            else if (Array.isArray(r)) push(r[0], r[1]);
            else if (r && typeof r === 'object') push(r.from, r.to);
        }
    } else if (typeof raw === 'string') {
        for (const line of raw.split(/[\r\n;]+/)) pushRule(line);
    }
    return items.sort((a, b) => _canon(b.from).length - _canon(a.from).length);
}

function _rewrite(p, from, to) {
    const src = _canon(p);
    const base = _canon(from);
    const ci = _isWinPath(from) || _isWinPath(p);
    const a = ci ? src.toLowerCase() : src;
    const b = ci ? base.toLowerCase() : base;
    let rest;
    if (a === b) rest = '';
    else if (a.startsWith(b.endsWith('/') ? b : `${b}/`)) rest = src.slice(base.length);
    else return null;
    rest = rest.replace(/^\/+/, '');
    const target = _canon(to);
    const win = _isWinPath(to);
    let out = rest ? `${target.endsWith('/') ? target : `${target}/`}${rest}` : target;
    if (win) out = out.replace(/\//g, '\\');
    return out;
}

/** App path → the path the sidecar sees (unchanged when no rule matches). */
export function toSidecarPath(p, rules) {
    if (typeof p !== 'string' || !p || !rules?.length) return p;
    for (const r of rules) {
        const out = _rewrite(p, r.from, r.to);
        if (out !== null) return out;
    }
    return p;
}

/** Sidecar path → the app's path (unchanged when no rule matches). */
export function fromSidecarPath(p, rules) {
    if (typeof p !== 'string' || !p || !rules?.length) return p;
    const reversed = rules
        .map((r) => ({ from: r.to, to: r.from }))
        .sort((a, b) => _canon(b.from).length - _canon(a.from).length);
    for (const r of reversed) {
        const out = _rewrite(p, r.from, r.to);
        if (out !== null) return out;
    }
    return p;
}

/** Serialise rules back to the one-rule-per-line form the UI edits. */
export function formatPathMap(rules) {
    return (rules || []).map((r) => `${r.from}=${r.to}`).join('\n');
}

// ---- Upload sizing --------------------------------------------------------

/**
 * Timeout for a request carrying `bytes` of body over a possibly slow link:
 * never below `minMs`, and at least long enough for the body at
 * `minBytesPerSec` (default 128 KB/s).
 */
export function uploadTimeoutMs(bytes, minMs = 30_000, minBytesPerSec = 128 * 1024) {
    const n = Math.max(0, Number(bytes) || 0);
    return Math.max(minMs, Math.ceil((n / minBytesPerSec) * 1000) + 10_000);
}

// ---- Probe ----------------------------------------------------------------

async function _fetchJson(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await globalThis.fetch(url, { ...init, signal: ctrl.signal });
        const ct = r.headers.get('content-type') || '';
        let body = null;
        if (ct.includes('json')) {
            try {
                body = await r.json();
            } catch {
                body = null;
            }
        } else {
            try {
                await r.text();
            } catch {}
        }
        return { status: r.status, ok: r.ok, json: ct.includes('json'), body, ct };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Probe a sidecar for the dashboard's Test button. Never throws.
 *
 * @param {object} o
 * @param {string} o.url            base URL (may carry a path prefix)
 * @param {string} [o.token]        shared token sent as X-API-Token
 * @param {object} [o.authCheck]    `{ method, path, body? }` of a cheap
 *                                  token-gated request; 401 = bad token
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ ok, reachable, version, service, features, health,
 *   auth: 'ok'|'failed'|'open'|'unknown', authRequired, error }>}
 */
export async function probeSidecar({ url, token = '', authCheck = null, timeoutMs = 8000 }) {
    const base = normalizeSidecarUrl(url);
    const out = {
        ok: false,
        reachable: false,
        version: null,
        service: null,
        features: [],
        health: null,
        auth: 'unknown',
        authRequired: null,
        error: null,
    };
    if (!base) {
        out.error = 'url_required';
        return out;
    }
    const headers = authHeaders(token);
    let h;
    try {
        h = await _fetchJson(`${base}/health`, { method: 'GET', headers }, timeoutMs);
    } catch (e) {
        out.error =
            e?.name === 'AbortError' ? 'timeout' : e?.cause?.code || e?.message || String(e);
        return out;
    }
    out.reachable = true;
    if (!h.ok || !h.json || !h.body || typeof h.body !== 'object') {
        // A proxy / tunnel page instead of the sidecar — usually a wrong
        // path prefix or a tunnel pointing at the wrong port.
        out.error = h.ok ? `not a sidecar (${h.ct || 'no content-type'})` : `http_${h.status}`;
        return out;
    }
    const b = h.body;
    out.health = b;
    out.version = b.version ?? null;
    out.service = b.service ?? null;
    out.features = Array.isArray(b.features) ? b.features.map(String) : [];
    out.authRequired = typeof b.auth_required === 'boolean' ? b.auth_required : null;
    if (authCheck?.path) {
        try {
            const init = { method: authCheck.method || 'GET', headers: { ...headers } };
            if (authCheck.body !== undefined) {
                init.headers['content-type'] = 'application/json';
                init.body = JSON.stringify(authCheck.body);
            }
            const r = await _fetchJson(`${base}${authCheck.path}`, init, timeoutMs);
            if (r.status === 401) out.auth = 'failed';
            else out.auth = headers[TOKEN_HEADER] ? 'ok' : 'open';
            if (r.status === 401 && out.authRequired === null) out.authRequired = true;
        } catch {
            out.auth = 'unknown';
        }
    }
    if (out.auth === 'failed') {
        out.error = headers[TOKEN_HEADER] ? 'token_rejected' : 'token_required';
    }
    out.ok = b.ok === true && out.auth !== 'failed';
    if (!out.ok && !out.error) out.error = 'unhealthy';
    return out;
}
