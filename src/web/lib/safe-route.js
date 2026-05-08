/**
 * Safe Express route wrapper.
 *
 * Wraps an `(req, res, next)` handler so that:
 *   - Synchronous `throw` inside the handler is caught.
 *   - Rejections from `async` handlers are caught.
 *   - Either path emits a structured JSON envelope `{ ok: false, code, message, where }`
 *     and logs the full stack via the injected logger.
 *
 * The whole point is `process.on('uncaughtException')` at server.js line ~225,
 * which hard-exits the dashboard 5 s after any uncaught error. Wrapping every
 * AI route here ensures a buggy AI handler can never kill the web service —
 * it can only return a 500 with a JSON envelope the dashboard renders cleanly.
 *
 * Usage:
 *
 *   import { makeSafe } from '../lib/safe-route.js';
 *   const safe = makeSafe({ log, prefix: 'ai' });
 *   router.get('/status', safe(async (req, res) => { ... }));
 */

function _stable(value) {
    if (value === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return undefined;
    }
}

/**
 * Build a `safe(handler)` factory bound to a specific logger and source label.
 *
 * @param {object} opts
 * @param {(entry: object) => void} [opts.log]   Structured logger (server.js's `log()`).
 * @param {string} [opts.prefix='route']         Source label for log entries + envelope `where`.
 * @returns {(handler: Function) => Function}    Wrapped Express handler.
 */
export function makeSafe({ log, prefix = 'route' } = {}) {
    const _log = (entry) => {
        try {
            if (typeof log === 'function') log(entry);
            else console.error('[safe-route]', entry);
        } catch {
            /* never throw from the logger */
        }
    };

    return function safe(handler) {
        if (typeof handler !== 'function') {
            throw new TypeError('safe-route: handler must be a function');
        }
        return async function safeHandler(req, res, next) {
            const where = `${req.method} ${req.originalUrl || req.url}`;
            try {
                const out = handler(req, res, next);
                if (out && typeof out.then === 'function') {
                    await out;
                }
            } catch (err) {
                _log({
                    source: prefix,
                    level: 'error',
                    msg: `route ${where} failed: ${err?.message || err}`,
                    stack: err?.stack || null,
                    code: err?.code || null,
                });
                if (res.headersSent) return; // can't recover the response cleanly
                const status = Number.isInteger(err?.status) ? err.status : 500;
                const body = {
                    ok: false,
                    success: false,
                    code: err?.code || `${prefix.toUpperCase()}_ROUTE_ERROR`,
                    message: err?.message || 'Internal error',
                    where,
                };
                const detail = _stable(err?.detail);
                if (detail) body.detail = detail;
                try {
                    res.status(status).json(body);
                } catch {
                    /* socket already closed — give up cleanly */
                }
            }
        };
    };
}

/**
 * Standalone helper: throw an `HttpError` from inside a safe handler and the
 * wrapper turns it into a clean 4xx/5xx response. Use for input validation
 * paths so the route still feels declarative.
 */
export class HttpError extends Error {
    constructor(status, code, message, detail) {
        super(message || code || 'HTTP error');
        this.name = 'HttpError';
        this.status = status;
        this.code = code;
        if (detail !== undefined) this.detail = detail;
    }
}
