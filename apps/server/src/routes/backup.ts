/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Hono } from "hono";
// @ts-expect-error — js source
import * as backup from "@tgdl/core/backup/index.js";

export const backupRoutes = new Hono()
    .get("/backup/providers", async (c) => {
        try {
            const r = backup.listProviders ? await backup.listProviders() : { providers: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/backup/destinations", async (c) => {
        try {
            const r = backup.listDestinations ? await backup.listDestinations() : { destinations: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/backup/destinations", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
            const r = backup.addDestination ? await backup.addDestination(body) : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/backup/destinations/:id", async (c) => {
        const id = c.req.param("id");
        try {
            if (backup.removeDestination) await backup.removeDestination(id);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/backup/destinations/:id/jobs", async (c) => {
        const id = c.req.param("id");
        try {
            const r = backup.listDestinationJobs ? await backup.listDestinationJobs(id) : { jobs: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/backup/destinations/:id/status", async (c) => {
        const id = c.req.param("id");
        try {
            const r = backup.getDestinationStatus ? await backup.getDestinationStatus(id) : { status: "idle" };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/backup/jobs/recent", async (c) => {
        try {
            const r = backup.listRecentJobs ? await backup.listRecentJobs() : { jobs: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
