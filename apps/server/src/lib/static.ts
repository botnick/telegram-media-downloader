/**
 * Serve the built React SPA (apps/web/dist) plus a few legacy public
 * paths the app still relies on:
 *
 *   /icons/*               — PWA icons
 *   /locales/*             — i18n bundles
 *   /manifest.webmanifest  — PWA manifest
 *   /sw.js                 — service worker (Vite copies this from
 *                            apps/web/public/sw.js into dist/)
 *   /                      — index.html with SPA fallback
 *
 * In production the host running this server is the same one that
 * runs the build, so `apps/web/dist/` is where Vite emits the bundle.
 * In dev nobody hits this path because the SPA is served by Vite at
 * :5173 and proxies /api + /ws back to this server.
 */

import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve relative to the running .js (post-build the file lives at
// apps/server/dist/lib/static.js, three dirs deep from the repo root).
const SPA_ROOT = path.resolve(__dirname, "..", "..", "..", "web", "dist");

export function mountStatic(app: Hono) {
    // Hashed assets (vite emits /assets/*.[hash].{js,css}). Long-cache
    // since the URL changes whenever bytes change.
    app.use(
        "/assets/*",
        serveStatic({
            root: path.relative(process.cwd(), SPA_ROOT),
            onFound: (_path, c) => {
                c.header("Cache-Control", "public, max-age=31536000, immutable");
            },
        })
    );

    // Service worker, manifest, locales, icons — short-cache so updates
    // reach users fast. The SW itself is content-versioned via its own
    // VERSION constant which we bump on every release.
    for (const prefix of ["/locales", "/icons"]) {
        app.use(
            `${prefix}/*`,
            serveStatic({
                root: path.relative(process.cwd(), SPA_ROOT),
                onFound: (_path, c) => {
                    c.header("Cache-Control", "public, max-age=300");
                },
            })
        );
    }
    for (const file of ["/manifest.webmanifest", "/sw.js"]) {
        app.get(file, serveStatic({ path: path.join(SPA_ROOT, file.slice(1)) }));
    }

    // SPA fallback — every other GET that isn't an /api or /ws or /files
    // path returns index.html so client-side routing can pick it up.
    app.get("*", async (c) => {
        const indexPath = path.join(SPA_ROOT, "index.html");
        const m = await import("node:fs/promises").then((fs) => fs.readFile(indexPath, "utf8"));
        c.header("Cache-Control", "no-cache");
        return c.html(m);
    });
}
