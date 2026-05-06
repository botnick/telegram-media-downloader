// API wrapper.
// - Surfaces server-side error messages (response body) instead of "HTTP 4xx".
// - Redirects to /login.html on 401 so an expired session never leaves the
//   SPA stuck on a generic error toast.
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

async function request(method, url, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
        // Skip the redirect for the auth-check itself so login.html doesn't loop.
        if (!url.startsWith('/api/auth_check') && !url.startsWith('/api/login')) {
            window.location.href = '/login.html';
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
