import { Hono } from "hono";

export const groupsRoutes = new Hono().get("/groups", (c) => {
    // TODO(server): port from src/web/server.js — config-side groups +
    // downloaded folder groups.
    return c.json({ config: [], downloaded: [] }, 501);
});
