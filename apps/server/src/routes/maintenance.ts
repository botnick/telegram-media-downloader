/**
 * Maintenance / Operational endpoints.
 *
 * The legacy server has dozens of /api/maintenance/* routes; this
 * module ports the most-used ones. Routes that drive long-running
 * jobs all share the same shape: POST kicks off the job, GET polls
 * status, the WS layer pushes progress events as well.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Hono } from "hono";

import { dedup, integrity, metrics, thumbs } from "../lib/legacy.js";

export const maintenanceRoutes = new Hono()
    // ---- Thumbnails -------------------------------------------------------
    .get("/maintenance/thumbs/stats", async (c) => {
        try {
            const stats = thumbs.getThumbsCacheStats
                ? await thumbs.getThumbsCacheStats()
                : { count: 0, bytes: 0 };
            return c.json(stats);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/thumbs/build", async (c) => {
        try {
            const r = thumbs.buildAllThumbnails ? await thumbs.buildAllThumbnails({}) : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/thumbs/rebuild", async (c) => {
        try {
            const removed = thumbs.purgeAllThumbs ? await thumbs.purgeAllThumbs() : 0;
            return c.json({ removed });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- DB integrity / vacuum / dedup ------------------------------------
    .post("/maintenance/db/integrity", async (c) => {
        try {
            const r = integrity.runIntegrityCheck ? await integrity.runIntegrityCheck() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/db/vacuum", async (c) => {
        try {
            const r = integrity.runVacuum ? await integrity.runVacuum() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/dedup", async (c) => {
        try {
            const r = dedup.runDedup ? await dedup.runDedup() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });

// metrics is mounted at the root /metrics path, not /api.
export const metricsRoute = new Hono().get("/metrics", async (c) => {
    try {
        const text = metrics.renderOpenMetrics ? await metrics.renderOpenMetrics() : "";
        c.header("Content-Type", "text/plain; version=0.0.4");
        return c.body(text);
    } catch (err) {
        return c.text((err as Error).message, 500);
    }
});
