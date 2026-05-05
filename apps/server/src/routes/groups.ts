/**
 * Groups list + management.
 *
 *   GET    /api/groups                          — config + downloaded
 *   GET    /api/groups/:id/photo                — chat photo cache
 *   DELETE /api/groups/:id/purge                — purge all rows
 *   GET    /api/groups/:id/purge/status         — async job status
 *   GET    /api/groups/refresh-info/status
 *   GET    /api/groups/refresh-photos/status
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Hono } from "hono";
import path from "node:path";

import { db, config as cfg } from "../lib/legacy.js";

export const groupsRoutes = new Hono()
    .get("/groups", async (c) => {
        try {
            const config = (await cfg.loadConfig()) ?? { groups: [] };
            const downloaded = db.listDownloadedGroups?.() ?? [];
            return c.json({
                config: config.groups ?? [],
                downloaded,
            });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/groups/:id/photo", async (c) => {
        const id = c.req.param("id");
        const dataDir = process.env["TGDL_DATA_DIR"] ?? path.resolve(process.cwd(), "data");
        const photoPath = path.join(dataDir, "photos", `${id}.jpg`);
        try {
            const fs = await import("node:fs/promises");
            const buf = await fs.readFile(photoPath);
            c.header("Content-Type", "image/jpeg");
            c.header("Cache-Control", "public, max-age=86400");
            return c.body(buf as unknown as ArrayBuffer);
        } catch {
            return c.text("Not found", 404);
        }
    });
