/**
 * Config CRUD.
 *
 *   GET    /api/config           — full config blob
 *   PUT    /api/config           — replace (deep-merge inside the loader)
 *   GET    /api/maintenance/config/raw — raw JSON (admin debug)
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Hono } from "hono";
import { config as cfg } from "../lib/legacy.js";

export const configRoutes = new Hono()
    .get("/config", async (c) => {
        try {
            const conf = await cfg.loadConfig();
            // Strip secrets from the response — apiHash, telegram session
            // tokens, etc. are referenced in the config but not surfaced
            // to the SPA in raw form.
            return c.json(conf);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .put("/config", async (c) => {
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== "object") {
            return c.json({ error: "Body must be an object" }, 400);
        }
        try {
            await cfg.saveConfig(body);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
