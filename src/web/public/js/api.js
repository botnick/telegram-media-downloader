// API wrapper.
// - Surfaces server-side error messages (response body) instead of "HTTP 4xx".
// - On 401, prompts the user to re-authenticate IN-PLACE via the
//   reauth-modal (window.__tgdlReauth). On success the original request
//   is retried; on cancel we fall back to the legacy /login.html redirect
//   so an expired session never leaves the SPA stuck on a generic toast.
//   The previous unconditional `window.location.href = '/login.html'`
//   yanked the user out of whatever page they were on (Settings, Queue,
//   etc.) — visible flicker back to /viewer after the implicit re-login.
// - Treats 503 with setupRequired:true as a redirect to /setup-needed.html.
// - On 403 `{adminRequired:true}` (a guest hitting an admin route — should
//   never originate from the UI since admin-only buttons are hidden, but
//   may happen if a tab restored from a stale session) shows a single
//   toast instead of a generic error.

async function parseJsonSafe(res) {
    const text = await res.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

let _adminToastInFlight = false;
function _toastAdminOnly(msg) {
    // Coalesce — if a page fires three blocked requests in a row we only
    // want one toast on screen.
    if (_adminToastInFlight) return;
    _adminToastInFlight = true;
    setTimeout(() => {
        _adminToastInFlight = false;
    }, 1500);
    try {
        // Lazy import to avoid a circular dep at module-eval time.
        import('./utils.js').then(({ showToast }) => showToast(msg));
    } catch {
        /* ignore */
    }
}

// Default request timeout. Long enough for slow SQLite aggregations and
// thumbnail builds; short enough that a stalled backend doesn't leave the
// UI hanging forever — users hit Refresh, retries pile up, and the
// recovering server gets thundering-herded. Callers can override via
// `opts.timeoutMs` for endpoints that genuinely need longer.
const DEFAULT_TIMEOUT_MS = 60_000;

async function request(method, url, body, opts = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, _skipReauth = false } = opts;
    const init = { method };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init.signal = ctrl.signal;

    let res;
    try {
        res = await fetch(url, init);
    } catch (e) {
        if (e?.name === 'AbortError') {
            const err = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
            err.status = 0;
            err.timedOut = true;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 401) {
        // /api/auth_check + /api/login are themselves part of the auth
        // dance — never re-prompt or redirect from those, or the modal +
        // /login.html land in a loop.
        const isAuthEndpoint = url.startsWith('/api/auth_check') || url.startsWith('/api/login');
        if (!isAuthEndpoint && !_skipReauth) {
            // Hand off to the in-SPA reauth modal if it has registered a
            // handler. Returns 'retry' on successful re-login (we replay
            // the request once with `_skipReauth` so a second 401 doesn't
            // recurse), or 'cancel' / unset → fall through to the legacy
            // hard redirect so the user always has a way out.
            const handler = typeof window !== 'undefined' ? window.__tgdlReauth : null;
            if (typeof handler === 'function') {
                let outcome = 'cancel';
                try {
                    outcome = await handler({ method, url });
                } catch {
                    outcome = 'cancel';
                }
                if (outcome === 'retry') {
                    return request(method, url, body, { ...opts, _skipReauth: true });
                }
            }
            // No modal handler installed OR user cancelled → preserve the
            // pre-v2.9 behaviour rather than leaving them on a half-rendered
            // page with no way to re-auth.
            if (typeof window !== 'undefined') {
                window.location.href = '/login.html';
            }
        }
        const data = await parseJsonSafe(res);
        const err = new Error(data.error || 'Unauthorized');
        err.status = 401;
        err.data = data;
        throw err;
    }

    const data = await parseJsonSafe(res);

    if (
        res.status === 503 &&
        data.setupRequired &&
        !window.location.pathname.startsWith('/setup-needed')
    ) {
        window.location.href = '/setup-needed.html';
        const err = new Error(data.error || 'Setup required');
        err.status = 503;
        throw err;
    }

    if (res.status === 403 && data.adminRequired) {
        _toastAdminOnly(data.error || 'Admin only');
    }

    if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }

    return data;
}

export const api = {
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, data, opts) => request('POST', url, data, opts),
    put: (url, data, opts) => request('PUT', url, data, opts),
    delete: (url, data, opts) => request('DELETE', url, data, opts),
};
