// Tests for the in-SPA reauth path.
//
// Covers the api.js half of the contract — the half that's most prone to
// regression because every admin route mounts through it. The modal's
// rendering itself is DOM-bound and best smoke-tested in a real browser;
// we verify the wiring (event-only, no hard redirect on retry) here.
//
// Pattern: stub `globalThis.fetch` and `globalThis.window` with vi.stubGlobal,
// then exercise `api.get`/`api.post` and observe what the handler / redirect
// path did.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let api;

// Capture redirects + handler invocations across tests.
let _hardRedirectTo = null;
let _handlerCalls = [];
let _handlerOutcome = 'cancel';

function _stubWindow(opts = {}) {
    const win = {
        __tgdlReauth: opts.handlerInstalled
            ? async (detail) => {
                  _handlerCalls.push(detail);
                  return _handlerOutcome;
              }
            : undefined,
        location: {
            _href: '/',
            get href() {
                return this._href;
            },
            set href(v) {
                _hardRedirectTo = v;
                this._href = v;
            },
        },
    };
    vi.stubGlobal('window', win);
    return win;
}

beforeEach(async () => {
    _hardRedirectTo = null;
    _handlerCalls = [];
    _handlerOutcome = 'cancel';
    vi.resetModules();
    api = (await import('../src/web/public/js/api.js')).api;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function _resp(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => JSON.stringify(body),
    };
}

// ---- 401 with no handler installed → legacy hard redirect ---------------

describe('api.js 401 — no reauth handler', () => {
    it('falls back to /login.html when window.__tgdlReauth is undefined', async () => {
        _stubWindow({ handlerInstalled: false });
        globalThis.fetch = vi.fn(async () => _resp(401, { error: 'expired' }));
        await expect(api.get('/api/groups')).rejects.toMatchObject({ status: 401 });
        expect(_hardRedirectTo).toBe('/login.html');
    });

    it('does NOT redirect on a 401 from /api/auth_check (loop guard)', async () => {
        _stubWindow({ handlerInstalled: false });
        globalThis.fetch = vi.fn(async () => _resp(401));
        await expect(api.get('/api/auth_check')).rejects.toMatchObject({ status: 401 });
        expect(_hardRedirectTo).toBeNull();
    });

    it('does NOT redirect on a 401 from /api/login (loop guard)', async () => {
        _stubWindow({ handlerInstalled: false });
        globalThis.fetch = vi.fn(async () => _resp(401, { error: 'wrong password' }));
        await expect(api.post('/api/login', { password: 'x' })).rejects.toMatchObject({
            status: 401,
        });
        expect(_hardRedirectTo).toBeNull();
    });
});

// ---- 401 with handler installed -----------------------------------------

describe('api.js 401 — reauth handler installed', () => {
    it('invokes the handler with method + url and skips redirect on retry', async () => {
        _stubWindow({ handlerInstalled: true });
        _handlerOutcome = 'retry';
        // First call → 401, retry → 200.
        let n = 0;
        globalThis.fetch = vi.fn(async () => {
            n += 1;
            if (n === 1) return _resp(401, { error: 'expired' });
            return _resp(200, { ok: true });
        });
        const r = await api.get('/api/groups');
        expect(r).toEqual({ ok: true });
        expect(_handlerCalls.length).toBe(1);
        expect(_handlerCalls[0]).toEqual({ method: 'GET', url: '/api/groups' });
        expect(_hardRedirectTo).toBeNull();
    });

    it('falls back to /login.html when the handler resolves to cancel', async () => {
        _stubWindow({ handlerInstalled: true });
        _handlerOutcome = 'cancel';
        globalThis.fetch = vi.fn(async () => _resp(401));
        await expect(api.get('/api/groups')).rejects.toMatchObject({ status: 401 });
        expect(_handlerCalls.length).toBe(1);
        expect(_hardRedirectTo).toBe('/login.html');
    });

    it('does NOT recurse if the retried request itself 401s', async () => {
        _stubWindow({ handlerInstalled: true });
        _handlerOutcome = 'retry';
        // Both the original AND the retry return 401 — the retry must
        // run with `_skipReauth: true` so the handler is not invoked
        // again.
        globalThis.fetch = vi.fn(async () => _resp(401));
        await expect(api.get('/api/groups')).rejects.toMatchObject({ status: 401 });
        // Handler should only have been called ONCE (the first 401).
        expect(_handlerCalls.length).toBe(1);
    });

    it('does NOT call the handler for /api/auth_check itself', async () => {
        _stubWindow({ handlerInstalled: true });
        _handlerOutcome = 'retry';
        globalThis.fetch = vi.fn(async () => _resp(401));
        await expect(api.get('/api/auth_check')).rejects.toMatchObject({ status: 401 });
        expect(_handlerCalls.length).toBe(0);
        expect(_hardRedirectTo).toBeNull();
    });
});

// ---- 200 + non-401 paths unchanged --------------------------------------

describe('api.js other status codes', () => {
    it('returns the body on 200', async () => {
        _stubWindow({ handlerInstalled: true });
        globalThis.fetch = vi.fn(async () => _resp(200, { hello: 'world' }));
        await expect(api.get('/api/stats')).resolves.toEqual({ hello: 'world' });
        expect(_handlerCalls.length).toBe(0);
    });

    it('throws for 5xx without invoking the reauth handler', async () => {
        _stubWindow({ handlerInstalled: true });
        globalThis.fetch = vi.fn(async () => _resp(503, { error: 'down' }));
        await expect(api.get('/api/stats')).rejects.toMatchObject({ status: 503 });
        expect(_handlerCalls.length).toBe(0);
    });
});
