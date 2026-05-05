import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { LoginRequestSchema, type LoginResponse, type MeResponse } from "@tgdl/shared";

export const authRoutes = new Hono()
    .post("/login", zValidator("json", LoginRequestSchema), async (c) => {
        // TODO(server): port from src/web/server.js login handler
        // (read config.web.passwordHash, scrypt-verify against the
        // submitted password, mint a session cookie, persist to
        // data/web-sessions.json).
        const body: LoginResponse = { role: "admin" };
        return c.json(body, 501);
    })
    .post("/logout", (c) => {
        // TODO(server): clear cookie + drop session row
        return c.json({ ok: true }, 501);
    })
    .get("/me", (c) => {
        // TODO(server): read session, return MeResponse
        const body: MeResponse = { role: "admin", setupRequired: false };
        return c.json(body, 501);
    });
