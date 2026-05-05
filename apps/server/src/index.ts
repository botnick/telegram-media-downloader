/**
 * Hono backend — entry point.
 *
 * Bootstraps the HTTP server, registers global middleware, mounts the
 * route modules under /api, attaches the WebSocket upgrade handler, and
 * serves the built React SPA from apps/web/dist in production (in dev
 * the SPA runs under Vite's own server on :5173 and proxies API + WS
 * traffic back here).
 *
 * Structurally:
 *   index.ts                — this file
 *   middleware/secure-headers.ts
 *   middleware/auth.ts      — session + role gating
 *   middleware/rate-limit.ts
 *   middleware/trust-proxy.ts
 *   routes/auth.ts          — /api/login, /api/logout, /api/me
 *   routes/version.ts       — /api/version, /api/version/check
 *   routes/auth_check.ts    — /api/auth_check (public)
 *   routes/downloads.ts     — /api/downloads, /api/downloads/all, etc.
 *   routes/groups.ts        — /api/groups
 *   routes/stats.ts         — /api/stats
 *   routes/thumbs.ts        — /api/thumbs/:id
 *   routes/files.ts         — /files/:path (range-aware media bytes)
 *   routes/ws.ts            — /ws upgrade handler
 *   lib/sessions.ts         — encrypted session store
 *   lib/static.ts           — serve apps/web/dist + index.html SPA
 *                             fallback in production
 */

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";

import { mountRoutes } from "./routes/index.js";
import { trustProxy } from "./middleware/trust-proxy.js";
import { errorHandler } from "./middleware/errors.js";
import { mountStatic } from "./lib/static.js";
import { mountWebSocket } from "./routes/ws.js";
import { wirePublishers } from "./lib/publishers.js";

const PORT = Number(process.env["PORT"] ?? 3000);

const app = new Hono();

// ---------------------------------------------------------------------------
// Global middleware (request → response order matters)
// ---------------------------------------------------------------------------

// Trust X-Forwarded-* from one hop (Caddy / Traefik / nginx).
app.use("*", trustProxy);

// CSP, COOP, etc. The legacy server passed an explicit `script-src`
// allowlist for cdn.tailwindcss.com + cdn.jsdelivr.net + Google Fonts;
// recreate that here so the SPA's existing inline handlers + CDN
// references keep working.
app.use(
    "*",
    secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.tailwindcss.com",
                "https://cdn.jsdelivr.net",
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://fonts.googleapis.com",
            ],
            styleSrcAttr: ["'unsafe-inline'"],
            fontSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:"],
            connectSrc: ["'self'", "ws:", "wss:"],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: [],
        },
    })
);

// gzip / brotli responses where it makes sense.
app.use("*", compress());

// One-line per request (method, path, status, ms). Skip noisy assets.
app.use("*", logger());

// ---------------------------------------------------------------------------
// WebSocket upgrade (must be set up before the SPA static fallback)
// ---------------------------------------------------------------------------

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
mountWebSocket(app, upgradeWebSocket);

// ---------------------------------------------------------------------------
// API routes — every /api/* endpoint
// ---------------------------------------------------------------------------

mountRoutes(app);

// ---------------------------------------------------------------------------
// Static SPA + media files
// ---------------------------------------------------------------------------

mountStatic(app);

// ---------------------------------------------------------------------------
// Error handling — last, catches anything thrown above.
// ---------------------------------------------------------------------------

app.onError(errorHandler);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const server = serve(
    {
        fetch: app.fetch,
        port: PORT,
    },
    (info) => {
        // eslint-disable-next-line no-console
        console.log(
            `🌐  Telegram Downloader   v${process.env["npm_package_version"] ?? "?"}`
        );
        // eslint-disable-next-line no-console
        console.log(`    Dashboard: http://localhost:${info.port}`);
    }
);

injectWebSocket(server);

// Subscribe @tgdl/core publishers (runtime EventEmitter, queue events,
// monitor) → push every emit through the WebSocket broadcaster so the
// SPA's reactive panels stay in sync.
wirePublishers();
