/**
 * Serve the SPA bundle plus a few legacy public paths the dashboard
 * still relies on:
 *
 *   /css/*                 — main.css
 *   /js/*                  — vanilla ES modules (legacy frontend)
 *   /icons/*               — PWA icons
 *   /locales/*             — i18n bundles
 *   /manifest.webmanifest  — PWA manifest
 *   /sw.js                 — service worker
 *   /                      — index.html with SPA fallback
 *
 * `apps/web/` lays everything out flat:
 *
 *   apps/web/index.html        ← dashboard entry
 *   apps/web/login.html        ← auth surface
 *   apps/web/setup-needed.html
 *   apps/web/add-account.html
 *   apps/web/share-error.html
 *   apps/web/public/{js,css,icons,locales,manifest.webmanifest,sw.js}
 *
 * The previous Express server applied a runtime cache-bust rewriter
 * (?v=<version> on every <script src>). With React/Vite eventually
 * emitting hashed filenames into the built HTML, we don't need the
 * rewriter for the new frontend; while the legacy SPA still serves
 * its hand-written index.html the bust query strings stay in the
 * source HTML themselves.
 */

import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the `apps/web/` directory at runtime. After the build the
// running file lives at `apps/server/dist/lib/static.js`; walk up
// three dirs to the repo root then descend into apps/web.
const WEB_ROOT = path.resolve(__dirname, "..", "..", "..", "web");

const HTML_ENTRIES = [
    "/index.html",
    "/login.html",
    "/setup-needed.html",
    "/add-account.html",
    "/share-error.html",
];

const cacheImmutable = (c: { header: (k: string, v: string) => void }) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
};
const cacheShort = (c: { header: (k: string, v: string) => void }) => {
    c.header("Cache-Control", "public, max-age=300");
};

export function mountStatic(app: Hono) {
    // Hashed assets (Vite output, when the React frontend lands).
    // Long-cache because the URL changes whenever bytes change.
    app.use(
        "/assets/*",
        serveStatic({
            root: path.relative(process.cwd(), path.join(WEB_ROOT, "dist")),
            onFound: (_p, c) => cacheImmutable(c),
        })
    );

    // Vanilla ES modules under /js — legacy frontend. Cache-Control
    // can't be aggressive because the HTML still references them with
    // `?v=` bust query strings, but the SW already caches them, so
    // the network hit is rare.
    app.use(
        "/js/*",
        serveStatic({
            root: path.relative(process.cwd(), path.join(WEB_ROOT, "public")),
            onFound: (_p, c) => cacheShort(c),
        })
    );

    for (const prefix of ["/css", "/icons", "/locales"]) {
        app.use(
            `${prefix}/*`,
            serveStatic({
                root: path.relative(process.cwd(), path.join(WEB_ROOT, "public")),
                onFound: (_p, c) => cacheShort(c),
            })
        );
    }

    for (const file of ["/manifest.webmanifest", "/sw.js"]) {
        app.get(
            file,
            serveStatic({
                path: path.join(WEB_ROOT, "public", file.slice(1)),
            })
        );
    }

    // HTML entries (login.html etc.) at their literal paths.
    for (const file of HTML_ENTRIES) {
        app.get(file, async (c) => {
            const html = await readFile(path.join(WEB_ROOT, file.slice(1)), "utf8");
            c.header("Cache-Control", "no-cache");
            return c.html(html);
        });
    }

    // SPA fallback — anything that isn't /api, /ws, /files, /photos,
    // a static asset, or one of the explicit HTML entries goes back
    // to index.html so client-side routing can pick it up.
    app.get("*", async (c) => {
        const html = await readFile(path.join(WEB_ROOT, "index.html"), "utf8");
        c.header("Cache-Control", "no-cache");
        return c.html(html);
    });
}
