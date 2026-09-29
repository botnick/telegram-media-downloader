/**
 * Node's half of the tgdl-core front server (src/core/gocore/front.js,
 * core-service/internal/front).
 *
 * With tgdl-core on PORT, every request Node sees arrives from 127.0.0.1.
 * Three pieces keep Node's behaviour exactly what it was:
 *
 *   1. frontRequestMiddleware — a request carrying the per-spawn
 *      X-Tgdl-Front token came through tgdl-core; its X-Tgdl-Client-Addr is
 *      the client's socket address. Both headers are removed before any
 *      other code sees the request (they never reach a route, a log, or a
 *      proxied peer). Without the right token the address is ignored.
 *
 *   2. installClientAddressView — Express's req.ip / req.ips /
 *      req.protocol / req.hostname (and so req.secure) are computed with
 *      the app's own `trust proxy` setting as if that address were the
 *      socket peer. The client's X-Forwarded-* headers are passed through
 *      untouched, so the result — and isLocalRequest(), forceHttps, the
 *      rate-limit keys, /api/auth/setup's localhost rule — is the same as
 *      when the client connected to Node directly.
 *
 *   3. frontNotifyHandler — tgdl-core answers some requests itself and tells
 *      Node afterwards, because Node alone writes the database (a session
 *      due for renewal, a file that is gone). The post carries the same
 *      per-spawn token, in a header a client cannot send.
 */

import crypto from 'crypto';

/** req[VIA_FRONT] = the client's address, for requests proxied by tgdl-core. */
export const VIA_FRONT = Symbol.for('tgdl.front.clientAddr');

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * First middleware of the app. `getToken()` returns the token tgdl-core
 * sends (empty when the front server isn't in use).
 */
export function frontRequestMiddleware(getToken) {
    return (req, _res, next) => {
        const h = req.headers;
        const tok = h['x-tgdl-front'];
        const addr = h['x-tgdl-client-addr'];
        if (tok !== undefined) delete h['x-tgdl-front'];
        if (addr !== undefined) delete h['x-tgdl-client-addr'];
        const want = getToken();
        if (
            want &&
            typeof tok === 'string' &&
            typeof addr === 'string' &&
            addr.length > 0 &&
            addr.length <= 64 &&
            safeEqual(tok, want)
        ) {
            req[VIA_FRONT] = addr;
        }
        next();
    };
}

/** Same for the 'upgrade' path (WebSocket), which bypasses Express. */
export function stripFrontHeaders(req) {
    delete req.headers['x-tgdl-front'];
    delete req.headers['x-tgdl-client-addr'];
}

/**
 * Override Express's address-derived getters on `app.request` so that for
 * a request proxied by tgdl-core they read the client's address instead of
 * the loopback socket.
 */
export function installClientAddressView(app) {
    const base = Object.getPrototypeOf(app.request);
    for (const name of ['ip', 'ips', 'protocol', 'hostname']) {
        const desc = Object.getOwnPropertyDescriptor(base, name);
        if (!desc?.get) continue;
        const orig = desc.get;
        Object.defineProperty(app.request, name, {
            configurable: true,
            enumerable: true,
            get() {
                const addr = this[VIA_FRONT];
                if (addr === undefined) return orig.call(this);
                const sock = { remoteAddress: addr, encrypted: false };
                return orig.call(
                    Object.create(this, { socket: { value: sock }, connection: { value: sock } }),
                );
            },
        });
    }
}

/** Where tgdl-core posts its events, and the header that authenticates them. */
export const NOTIFY_PATH = '/__tgdl/notify';
const NOTIFY_HEADER = 'x-tgdl-notify';
const NOTIFY_MAX_BYTES = 16 * 1024;

/**
 * Express middleware for POST NOTIFY_PATH: accepts an event only with the
 * per-spawn token, then hands `{ kind, value }` to `handlers[kind]`.
 * Without the token it does nothing (the request continues as any other,
 * i.e. is refused by the auth middleware): the front server drops every
 * X-Tgdl-* header a client sends.
 */
export function frontNotifyHandler(getToken, handlers) {
    return (req, res, next) => {
        if (req.method !== 'POST' || req.path !== NOTIFY_PATH) return next();
        const tok = req.headers[NOTIFY_HEADER];
        const want = getToken();
        if (!want || typeof tok !== 'string' || !safeEqual(tok, want)) return next();
        delete req.headers[NOTIFY_HEADER];
        // Tiny JSON body; read here, before any body parser or rate limit.
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (c) => {
            data += c;
            if (data.length > NOTIFY_MAX_BYTES) req.destroy();
        });
        req.on('end', () => {
            let ev = null;
            try {
                ev = JSON.parse(data);
            } catch {}
            const fn = typeof ev?.kind === 'string' ? handlers[ev.kind] : null;
            if (typeof fn === 'function' && typeof ev.value === 'string') {
                Promise.resolve()
                    .then(() => fn(ev.value))
                    .catch((e) =>
                        console.warn('[go-front] notify', ev.kind, 'failed:', e?.message || e),
                    );
            }
            res.status(204).end();
        });
    };
}

/**
 * The headers a chain of middlewares puts on the response to a GET of
 * `path` from a non-local client, in order: [[name, value], …]; `route`
 * may add what the route sets. Pushed to tgdl-core so the responses it
 * builds itself carry exactly the set Node would send.
 */
export async function captureHeaders(chain, { path, secure, ip = '192.0.2.1' }, route) {
    const list = [];
    const find = (n) => list.findIndex(([k]) => k.toLowerCase() === String(n).toLowerCase());
    const res = {
        setHeader(n, v) {
            const i = find(n);
            if (i >= 0) list[i][1] = String(v);
            else list.push([String(n), String(v)]);
            return res;
        },
        removeHeader(n) {
            const i = find(n);
            if (i >= 0) list.splice(i, 1);
        },
        getHeader(n) {
            const i = find(n);
            return i >= 0 ? list[i][1] : undefined;
        },
        vary(field) {
            const cur = res.getHeader('Vary');
            res.setHeader('Vary', cur ? `${cur}, ${field}` : field);
            return res;
        },
        locals: {},
    };
    const req = {
        method: 'GET',
        url: path,
        originalUrl: path,
        path,
        query: {},
        headers: { host: 'tgdl-core' },
        secure,
        protocol: secure ? 'https' : 'http',
        ip,
        socket: { remoteAddress: ip },
    };
    for (const mw of chain) {
        let called = false;
        await mw(req, res, () => {
            called = true;
        });
        if (!called) throw new Error(`header middleware ${mw.name || '?'} ended the request`);
    }
    route?.(res);
    return list;
}
