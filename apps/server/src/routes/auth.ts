/**
 * Authentication endpoints — wires the legacy @tgdl/core/web-auth
 * helpers (loginVerify, issueSession, validateSession, revokeSession)
 * into Hono handlers that share the cookie shape with the original
 * Express server (data/web-sessions.json on-disk format unchanged).
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { zValidator } from "@hono/zod-validator";
import { LoginRequestSchema } from "@tgdl/shared";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config as cfg, webAuth } from "../lib/legacy.js";

const ChangePasswordSchema = z.object({
    current: z.string(),
    next: z.string().min(8),
});
const GuestPasswordSchema = z.object({
    password: z.string().min(8).nullable(),
});

const COOKIE = "tgdl_session";
const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: "Strict" as const,
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
};

async function loadWebConfig(): Promise<unknown> {
    const c = (await cfg.loadConfig()) ?? {};
    return (c as { web?: unknown }).web ?? {};
}

export const authRoutes = new Hono()
    .post("/login", zValidator("json", LoginRequestSchema), async (c) => {
        const { password } = c.req.valid("json");
        try {
            const web = await loadWebConfig();
            const result = webAuth.loginVerify(password, web);
            if (!result?.ok) return c.json({ error: result?.error ?? "Login failed" }, 401);
            const session = webAuth.issueSession({ role: result.role ?? "admin" });
            setCookie(c, COOKIE, String(session.token), COOKIE_OPTS);
            return c.json({ role: result.role ?? "admin" });
        } catch (err) {
            return c.json({ error: (err as Error).message ?? "Login failed" }, 500);
        }
    })
    .post("/logout", (c) => {
        try {
            const token = getCookie(c, COOKIE);
            if (token) webAuth.revokeSession(token);
        } catch {
            // ignore
        }
        deleteCookie(c, COOKIE, { path: "/" });
        return c.json({ ok: true });
    })
    .get("/me", async (c) => {
        try {
            const token = getCookie(c, COOKIE);
            const session = token ? webAuth.validateSession(token) : null;
            if (!session) return c.json({ error: "Unauthorized" }, 401);
            const web = await loadWebConfig();
            const setupRequired = !webAuth.isAuthConfigured(web);
            return c.json({ role: session.role ?? "admin", setupRequired });
        } catch (err) {
            return c.json({ error: (err as Error).message ?? "Failed" }, 500);
        }
    })
    .post("/auth/change-password", zValidator("json", ChangePasswordSchema), async (c) => {
        const { current, next } = c.req.valid("json");
        try {
            const web = await loadWebConfig();
            const verify = webAuth.loginVerify(current, web);
            if (!verify?.ok) return c.json({ error: "Current password is wrong" }, 400);
            const newHash = webAuth.hashPassword(next);
            const conf = await cfg.loadConfig();
            if (!conf.web) conf.web = {};
            conf.web.passwordHash = newHash;
            await cfg.saveConfig(conf);
            webAuth.revokeAllSessions();
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/auth/guest-password", zValidator("json", GuestPasswordSchema), async (c) => {
        const { password } = c.req.valid("json");
        try {
            const conf = await cfg.loadConfig();
            if (!conf.web) conf.web = {};
            if (password) {
                conf.web.guestPasswordHash = webAuth.hashPassword(password);
            } else {
                delete conf.web.guestPasswordHash;
            }
            await cfg.saveConfig(conf);
            webAuth.revokeAllGuestSessions();
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
