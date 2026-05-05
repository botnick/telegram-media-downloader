/**
 * GET /api/thumbs/:id?w=240 — server-generated WebP thumbnail.
 *
 * Mirrors the legacy server's behaviour: cache hit serves the file
 * directly, miss kicks a sharp/ffmpeg generation job (rate-limited
 * by @tgdl/core/thumbs internal semaphores), missing source returns
 * 404 so the SPA's onerror falls back gracefully.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { zValidator } from "@hono/zod-validator";
import { ThumbsQuerySchema } from "@tgdl/shared";
import { Hono } from "hono";

import { thumbs } from "../lib/legacy.js";

export const thumbsRoutes = new Hono().get(
    "/thumbs/:id",
    zValidator("query", ThumbsQuerySchema),
    async (c) => {
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id) || id <= 0) return c.text("Bad id", 400);
        const { w } = c.req.valid("query");

        try {
            const result = await thumbs.getOrCreateThumb(id, w);
            if (!result) return c.text("No thumb", 404);

            const lastMod = new Date(result.mtime).toUTCString();
            if (c.req.header("if-modified-since") === lastMod) {
                return c.body(null, 304);
            }

            c.header("Content-Type", "image/webp");
            c.header("Cache-Control", "public, max-age=86400, immutable");
            c.header("Last-Modified", lastMod);

            const fs = await import("node:fs/promises");
            const buf = await fs.readFile(result.path);
            return c.body(buf as unknown as ArrayBuffer);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[thumbs]", err);
            return c.text("No thumb", 404);
        }
    }
);
