/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Hono } from "hono";
import { nsfw } from "../lib/legacy.js";

export const nsfwRoutes = new Hono()
    .get("/maintenance/nsfw/status", async (c) => {
        try {
            const r = nsfw.getStatus ? await nsfw.getStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/nsfw/results", async (c) => {
        try {
            const r = nsfw.getResults ? await nsfw.getResults() : { results: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/nsfw/model-status", async (c) => {
        try {
            const r = nsfw.getModelStatus ? await nsfw.getModelStatus() : {};
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/maintenance/nsfw/cache", async (c) => {
        try {
            if (nsfw.purgeCache) await nsfw.purgeCache();
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/nsfw/scan", async (c) => {
        try {
            const r = nsfw.startScan ? await nsfw.startScan() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/nsfw/v2/tiers", async (c) => {
        try {
            const r = nsfw.v2GetTiers ? await nsfw.v2GetTiers() : { tiers: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/nsfw/v2/tiers-meta", async (c) => {
        try {
            const r = nsfw.v2GetTiersMeta ? await nsfw.v2GetTiersMeta() : {};
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/nsfw/v2/histogram", async (c) => {
        try {
            const r = nsfw.v2Histogram ? await nsfw.v2Histogram() : { bins: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/nsfw/v2/list", async (c) => {
        try {
            const r = nsfw.v2List ? await nsfw.v2List({}) : { items: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/nsfw/v2/bulk/status", async (c) => {
        try {
            const r = nsfw.v2BulkStatus ? await nsfw.v2BulkStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
