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
 *   3. installSendAccel / markAccel — for a response a route marks,
 *      `send` (res.sendFile, express.static) runs as always — conditional
 *      requests, Range, 416, every header — but instead of piping the file
 *      it answers with X-Tgdl-Accel (path) + X-Tgdl-Accel-Range
 *      ("<start>-<length>") and no body; tgdl-core streams those bytes.
 */

import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** req[VIA_FRONT] = the client's address, for requests proxied by tgdl-core. */
export const VIA_FRONT = Symbol.for('tgdl.front.clientAddr');
const ACCEL = Symbol.for('tgdl.front.accel');

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

let _accelInstalled = false;

/**
 * Patch `send`'s stream step (the copy Express and serve-static use) so a
 * marked response is handed to tgdl-core instead of piped.
 */
export function installSendAccel() {
    if (_accelInstalled) return;
    _accelInstalled = true;
    const expressMain = require.resolve('express');
    const reqExpress = createRequire(expressMain);
    const protos = new Set();
    for (const load of [
        () => reqExpress('send'),
        () => createRequire(reqExpress.resolve('serve-static'))('send'),
    ]) {
        try {
            const send = load();
            protos.add(Object.getPrototypeOf(send({ headers: {} }, '/')));
        } catch {
            /* not installed separately */
        }
    }
    for (const proto of protos) {
        const orig = proto.stream;
        proto.stream = function stream(filePath, opts) {
            const res = this.res;
            if (!res?.[ACCEL] || res.headersSent) return orig.call(this, filePath, opts);
            const length = Number(res.getHeader('Content-Length')) || 0;
            res.removeHeader('Content-Length');
            res.setHeader('X-Tgdl-Accel', encodeURIComponent(filePath));
            res.setHeader('X-Tgdl-Accel-Range', `${Number(opts?.start) || 0}-${length}`);
            res.end();
            this.emit('end');
        };
    }
}

/**
 * Hand the body of this response to tgdl-core when the request came
 * through it. Call right before res.sendFile / express.static.
 */
export function markAccel(req, res) {
    if (req[VIA_FRONT] !== undefined) res[ACCEL] = true;
}

/**
 * The headers a helmet middleware sets, in order: [[name, value], …].
 * Pushed to tgdl-core so its own responses carry exactly the same set.
 */
export function captureHelmetHeaders(mw) {
    const list = [];
    const find = (n) => list.findIndex(([k]) => k.toLowerCase() === String(n).toLowerCase());
    const res = {
        setHeader(n, v) {
            const i = find(n);
            if (i >= 0) list[i][1] = String(v);
            else list.push([String(n), String(v)]);
        },
        removeHeader(n) {
            const i = find(n);
            if (i >= 0) list.splice(i, 1);
        },
        getHeader(n) {
            const i = find(n);
            return i >= 0 ? list[i][1] : undefined;
        },
        locals: {},
    };
    let called = false;
    mw({ headers: {}, method: 'GET', url: '/', originalUrl: '/' }, res, () => {
        called = true;
    });
    if (!called) throw new Error('helmet did not call next() synchronously');
    return list;
}
