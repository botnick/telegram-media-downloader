/**
 * Authentication endpoints.
 *
 *   POST /api/login              — submit password, mint session
 *   POST /api/logout             — drop session cookie + row
 *   GET  /api/me                 — current role + setup state
 *   POST /api/auth/change-password
 *   POST /api/auth/guest-password
 *   POST /api/auth/reset/confirm
 *
 * The legacy server stored sessions in data/web-sessions.json; the
 * Hono port keeps the same on-disk format so existing logged-in tabs
 * survive the upgrade.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { LoginRequestSchema } from "@tgdl/shared";

import { webAuth } from "../lib/legacy.js";

const ChangePasswordSchema = z.object({
    current: z.string(),
    next: z.string().min(8),
});
const GuestPasswordSchema = z.object({
    password: z.string().min(8).nullable(),
});
const ResetConfirmSchema = z.object({
    token: z.string(),
    password: z.string().min(8),
});

const COOKIE = "tgdl_session";
const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: "Strict" as const,
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
};

export const authRoutes = new Hono()
    .post("/login", zValidator("json", LoginRequestSchema), async (c) => {
        const { password } = c.req.valid("json");
        try {
            const result = await webAuth.login(password);
            if (!result?.ok) return c.json({ error: result?.error ?? "Login failed" }, 401);
            setCookie(c, COOKIE, String(result.token), COOKIE_OPTS);
            return c.json({ role: result.role });
        } catch (err) {
            return c.json({ error: (err as Error).message ?? "Login failed" }, 500);
        }
    })
    .post("/logout", async (c) => {
        try {
            const token = c.req.header("cookie")?.match(/tgdl_session=([^;]+)/)?.[1];
            if (token) await webAuth.dropSession(token);
        } catch {
            // ignore
        }
        deleteCookie(c, COOKIE, { path: "/" });
        return c.json({ ok: true });
    })
    .get("/me", async (c) => {
        try {
            const token = c.req.header("cookie")?.match(/tgdl_session=([^;]+)/)?.[1];
            const session = token ? await webAuth.lookupSession(token) : null;
            if (!session) return c.json({ error: "Unauthorized" }, 401);
            const setupRequired = !(await webAuth.isAuthConfigured());
            return c.json({ role: session.role ?? "admin", setupRequired });
        } catch (err) {
            return c.json({ error: (err as Error).message ?? "Failed" }, 500);
        }
    })
    .post(
        "/auth/change-password",
        zValidator("json", ChangePasswordSchema),
        async (c) => {
            const { current, next } = c.req.valid("json");
            try {
                const r = await webAuth.changePassword(current, next);
                if (!r?.ok) return c.json({ error: r?.error ?? "Failed" }, 400);
                return c.json({ ok: true });
            } catch (err) {
                return c.json({ error: (err as Error).message }, 500);
            }
        }
    )
    .post(
        "/auth/guest-password",
        zValidator("json", GuestPasswordSchema),
        async (c) => {
            const { password } = c.req.valid("json");
            try {
                await webAuth.setGuestPassword(password);
                return c.json({ ok: true });
            } catch (err) {
                return c.json({ error: (err as Error).message }, 500);
            }
        }
    )
    .post(
        "/auth/reset/confirm",
        zValidator("json", ResetConfirmSchema),
        async (c) => {
            const { token, password } = c.req.valid("json");
            try {
                const r = await webAuth.resetConfirm(token, password);
                if (!r?.ok) return c.json({ error: r?.error ?? "Failed" }, 400);
                return c.json({ ok: true });
            } catch (err) {
                return c.json({ error: (err as Error).message }, 500);
            }
        }
    );
