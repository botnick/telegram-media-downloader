import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { ThumbsQuerySchema } from "@tgdl/shared";

export const thumbsRoutes = new Hono().get(
    "/thumbs/:id",
    zValidator("query", ThumbsQuerySchema),
    async (c) => {
        // TODO(server): port from src/web/server.js — call
        // @tgdl/core/thumbs::getOrCreateThumb(id, w), 304-aware
        // Last-Modified handling, Content-Type: image/webp,
        // immutable cache headers, batched-miss warnings.
        return c.text("No thumb", 501);
    }
);
