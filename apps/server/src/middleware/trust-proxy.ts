/**
 * Honour `X-Forwarded-For` from one hop of upstream proxy. The legacy
 * Express server used `app.set('trust proxy', '1')` to do this; in Hono
 * we read the header ourselves and stash the resolved client IP on the
 * context for downstream middleware (rate limit, audit log).
 *
 * Configurable via env: TRUST_PROXY=<count>|loopback|uniquelocal|<ip>...
 *   - "1" / number  → trust the rightmost N forwarded entries
 *   - empty string  → no proxy in front; use the socket address
 *   - everything else falls back to socket address (no special parsing)
 */

import type { MiddlewareHandler } from "hono";

declare module "hono" {
    interface ContextVariableMap {
        clientIp: string;
    }
}

const TRUST_PROXY = process.env["TRUST_PROXY"] ?? "1";
const TRUSTED_HOPS = (() => {
    const n = Number(TRUST_PROXY);
    if (Number.isFinite(n) && n >= 0) return n;
    return 0;
})();

export const trustProxy: MiddlewareHandler = async (c, next) => {
    const xff = c.req.header("x-forwarded-for") ?? "";
    let resolved: string | undefined;
    if (TRUSTED_HOPS > 0 && xff) {
        // X-Forwarded-For: client, proxy1, proxy2, …
        // We trust TRUSTED_HOPS entries from the right-hand side.
        const parts = xff
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
        const idx = Math.max(0, parts.length - TRUSTED_HOPS);
        resolved = parts[idx];
    }
    if (!resolved) {
        // Hono's request object exposes the underlying socket via the
        // adapter; fall back to it when we don't trust the header.
        // @hono/node-server stashes the address on c.env.
        const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
        resolved = env?.incoming?.socket?.remoteAddress ?? "127.0.0.1";
    }
    c.set("clientIp", resolved);
    await next();
};
