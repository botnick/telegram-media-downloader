import { Hono } from "hono";

export const statsRoutes = new Hono().get("/stats", (c) => {
    // TODO(server): port from src/web/server.js — disk usage + per-type
    // counters for the footer chip.
    return c.json(
        {
            totalFiles: 0,
            totalBytes: 0,
            totalBytesFormatted: "0 B",
            diskBudgetBytes: null,
            photoCount: 0,
            videoCount: 0,
            audioCount: 0,
            documentCount: 0,
        },
        501
    );
});
