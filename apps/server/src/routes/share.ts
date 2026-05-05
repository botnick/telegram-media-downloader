/**
 * Share-link endpoints.
 *
 * Admins create signed /share/<id> URLs that friends can open without
 * logging in. The signed URLs themselves are served from the root
 * /share/* path (public) — those are not part of /api.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Hono } from "hono";

import { share } from "../lib/legacy.js";

export const shareRoutes = new Hono()
    .get("/share/links", async (c) => {
        try {
            const links = share.listLinks ? await share.listLinks() : [];
            return c.json({ links });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/share/links", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
            const link = share.createLink ? await share.createLink(body) : null;
            return c.json(link);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/share/links/:id", async (c) => {
        const id = c.req.param("id");
        try {
            if (share.deleteLink) await share.deleteLink(id);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });

// Public share-link bytes — mounted at the root /share/:id, not /api.
export const sharePublicRoutes = new Hono().get("/share/:id", async (c) => {
    const id = c.req.param("id");
    try {
        const r = share.resolveLink ? await share.resolveLink(id) : null;
        if (!r?.path) return c.text("Not found", 404);
        const fs = await import("node:fs/promises");
        const buf = await fs.readFile(r.path);
        c.header("Content-Type", r.mime ?? "application/octet-stream");
        c.header("Content-Disposition", `attachment; filename="${r.filename ?? id}"`);
        return c.body(buf as unknown as ArrayBuffer);
    } catch (err) {
        return c.text((err as Error).message, 500);
    }
});
