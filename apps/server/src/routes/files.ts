/**
 * GET /files/:path — serve downloaded media bytes with HTTP Range
 * support.
 *
 * The viewer needs Range so videos can seek without buffering the
 * whole file. Hono's serveStatic does not handle ranges itself, so
 * we crack the request open by hand here.
 *
 *   GET /files/<group>/<type>/<filename>?inline=1
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";

import { db } from "../lib/legacy.js";

const DATA_DIR = process.env["TGDL_DATA_DIR"] ?? path.resolve(process.cwd(), "data");
const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");

function safeResolve(rel: string): string | null {
    const target = path.resolve(DOWNLOADS_DIR, rel);
    if (!target.startsWith(DOWNLOADS_DIR + path.sep) && target !== DOWNLOADS_DIR) return null;
    return target;
}

const MIME: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
};

export const filesRoutes = new Hono()
    .get("/files/*", async (c) => {
        const url = new URL(c.req.url);
        const rel = decodeURIComponent(url.pathname.replace(/^\/files\//, ""));
        const abs = safeResolve(rel);
        if (!abs) return c.text("Bad path", 400);
        let st;
        try {
            st = await fs.stat(abs);
        } catch {
            return c.text("Not found", 404);
        }
        if (!st.isFile()) return c.text("Not a file", 404);

        const ext = path.extname(abs).toLowerCase();
        const mime = MIME[ext] ?? "application/octet-stream";

        const range = c.req.header("range");
        if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (m) {
                const start = m[1] ? Number(m[1]) : 0;
                const end = m[2] ? Number(m[2]) : st.size - 1;
                if (start > end || end >= st.size) {
                    c.header("Content-Range", `bytes */${st.size}`);
                    return c.body(null, 416);
                }
                const length = end - start + 1;
                c.header("Content-Type", mime);
                c.header("Accept-Ranges", "bytes");
                c.header("Content-Range", `bytes ${start}-${end}/${st.size}`);
                c.header("Content-Length", String(length));
                const reader = createReadStream(abs, { start, end });
                return c.body(reader as unknown as ReadableStream, 206);
            }
        }

        c.header("Content-Type", mime);
        c.header("Accept-Ranges", "bytes");
        c.header("Content-Length", String(st.size));
        const reader = createReadStream(abs);
        return c.body(reader as unknown as ReadableStream);
    })
    .delete("/file", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { path?: string; id?: number };
        try {
            if (body.id != null) {
                if (db.deleteDownloadById) await db.deleteDownloadById(body.id);
            } else if (body.path) {
                if (db.deleteDownloadByPath) await db.deleteDownloadByPath(body.path);
            } else {
                return c.json({ error: "id or path required" }, 400);
            }
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
