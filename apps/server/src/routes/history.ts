/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Hono } from "hono";
import { history } from "../lib/legacy.js";

export const historyRoutes = new Hono()
    .get("/history", (c) => {
        try {
            const r = history.listJobs ? history.listJobs() : { jobs: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/history/jobs", async (c) => {
        try {
            const r = history.listJobs ? await history.listJobs() : { jobs: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/history/:jobId", (c) => {
        const id = c.req.param("jobId");
        try {
            const r = history.getJob ? history.getJob(id) : null;
            if (!r) return c.json({ error: "Not found" }, 404);
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/history/:jobId", async (c) => {
        const id = c.req.param("jobId");
        try {
            if (history.deleteJob) await history.deleteJob(id);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/history", async (c) => {
        try {
            if (history.clearJobs) await history.clearJobs();
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
