/**
 * Gallery + library endpoints.
 *
 *   GET  /api/downloads             — config-side groups list
 *   GET  /api/downloads/all         — paginated, all groups
 *   GET  /api/downloads/search      — full-text search
 *   GET  /api/downloads/:groupId    — paginated, one group
 *   POST /api/downloads/:id/pin     — toggle pin
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { zValidator } from "@hono/zod-validator";
import { DownloadsListQuerySchema, PinRequestSchema } from "@tgdl/shared";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../lib/legacy.js";

const SearchQuerySchema = z.object({
    q: z.string().min(1),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(50),
});

export const downloadsRoutes = new Hono()
    .get("/downloads", async (c) => {
        try {
            const groups = db.listConfigGroups?.() ?? [];
            return c.json({ groups });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/downloads/all", zValidator("query", DownloadsListQuerySchema), async (c) => {
        const { page, limit, type } = c.req.valid("query");
        try {
            const r = db.getDownloadsAll
                ? await db.getDownloadsAll({ page, limit, type })
                : { files: [], total: 0 };
            return c.json({
                files: r.files ?? [],
                total: r.total ?? 0,
                page,
                limit,
                hasMore: (r.files?.length ?? 0) === limit && page * limit < (r.total ?? 0),
            });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/downloads/search", zValidator("query", SearchQuerySchema), async (c) => {
        const { q, page, limit } = c.req.valid("query");
        try {
            const r = db.searchDownloads
                ? await db.searchDownloads({ q, page, limit })
                : { files: [], total: 0 };
            return c.json({
                files: r.files ?? [],
                total: r.total ?? 0,
                page,
                limit,
                hasMore: (r.files?.length ?? 0) === limit && page * limit < (r.total ?? 0),
            });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/downloads/:groupId", zValidator("query", DownloadsListQuerySchema), async (c) => {
        const groupId = c.req.param("groupId");
        const { page, limit, type } = c.req.valid("query");
        try {
            const r = db.getDownloadsByGroup
                ? await db.getDownloadsByGroup({ groupId, page, limit, type })
                : { files: [], total: 0 };
            return c.json({
                files: r.files ?? [],
                total: r.total ?? 0,
                page,
                limit,
                hasMore: (r.files?.length ?? 0) === limit && page * limit < (r.total ?? 0),
            });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/downloads/:id/pin", zValidator("json", PinRequestSchema), async (c) => {
        const id = Number(c.req.param("id"));
        const { pinned } = c.req.valid("json");
        try {
            if (db.setPinned) await db.setPinned(id, pinned);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
