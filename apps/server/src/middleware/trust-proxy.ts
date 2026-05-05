/**
 * Resolve the real client IP from request headers.
 *
 * Priority order:
 *
 *   1. CF-Connecting-IP    ← Cloudflare (always set when behind CF)
 *   2. True-Client-IP      ← Cloudflare Enterprise / Akamai
 *   3. X-Real-IP           ← nginx default
 *   4. X-Forwarded-For     ← Caddy / Traefik / generic, leftmost entry
 *   5. socket address      ← fallback
 *
 * The deployment is expected to put the app behind a trusted upstream
 * (Cloudflare Tunnel, Caddy on a private network, nginx). If port
 * 3000 is exposed directly to the internet, attackers can spoof these
 * headers — operators who need that case must deploy the upstream
 * properly instead of asking the app to second-guess every request.
 *
 * The resolved IP is exposed on the Hono context as c.var.clientIp
 * and c.var.clientCountry (from CF-IPCountry when present).
 */

import type { MiddlewareHandler } from "hono";

declare module "hono" {
    interface ContextVariableMap {
        clientIp: string;
        clientCountry: string | null;
    }
}

function getPeerIp(c: { env: unknown }): string {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? "127.0.0.1";
}

function firstHop(headerVal: string | undefined): string | null {
    if (!headerVal) return null;
    const first = headerVal.split(",")[0]?.trim();
    return first || null;
}

export const trustProxy: MiddlewareHandler = async (c, next) => {
    const cf = c.req.header("cf-connecting-ip")?.trim();
    const trueClient = c.req.header("true-client-ip")?.trim();
    const realIp = c.req.header("x-real-ip")?.trim();
    const xff = firstHop(c.req.header("x-forwarded-for"));

    const resolved = cf || trueClient || realIp || xff || getPeerIp(c);
    const country = c.req.header("cf-ipcountry")?.trim() ?? null;

    c.set("clientIp", resolved);
    c.set("clientCountry", country);
    await next();
};
