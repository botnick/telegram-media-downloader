import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { DownloadsListQuerySchema } from "@tgdl/shared";

export const downloadsRoutes = new Hono()
    .get("/downloads", (c) => {
        // TODO(server): config groups list (different from the gallery
        // list under /downloads/all + /downloads/:groupId).
        return c.json({ groups: [] }, 501);
    })
    .get(
        "/downloads/all",
        zValidator("query", DownloadsListQuerySchema),
        async (c) => {
            // TODO(server): port query from src/web/server.js
            // (db.getDownloadsAll with type filter + pagination).
            return c.json({ files: [], total: 0, page: 1, limit: 50, hasMore: false }, 501);
        }
    )
    .get(
        "/downloads/:groupId",
        zValidator("query", DownloadsListQuerySchema),
        async (c) => {
            // TODO(server): port db.getDownloadsByGroup
            return c.json({ files: [], total: 0, page: 1, limit: 50, hasMore: false }, 501);
        }
    );
