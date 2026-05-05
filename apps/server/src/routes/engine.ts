/**
 * Engine + monitor + queue endpoints.
 *
 *   GET  /api/monitor/status     — running state, account info
 *   GET  /api/queue/snapshot     — queued/active/completed counters
 *   POST /api/engine             — start/stop/restart action
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { zValidator } from "@hono/zod-validator";
import { EngineActionRequestSchema } from "@tgdl/shared";
import { Hono } from "hono";

import { monitor, runtime } from "../lib/legacy.js";

export const engineRoutes = new Hono()
    .get("/monitor/status", async (c) => {
        try {
            const status = monitor.getStatus ? await monitor.getStatus() : { state: "idle" };
            return c.json(status);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/queue/snapshot", async (c) => {
        try {
            const snap = runtime.getQueueSnapshot
                ? runtime.getQueueSnapshot()
                : { queued: 0, active: 0, completed: 0, downloads: [] };
            return c.json(snap);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/engine", zValidator("json", EngineActionRequestSchema), async (c) => {
        const { action } = c.req.valid("json");
        try {
            if (action === "start") await runtime.start?.();
            else if (action === "stop") await runtime.stop?.();
            else if (action === "restart") {
                await runtime.stop?.();
                await runtime.start?.();
            }
            return c.json({ ok: true, action });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
