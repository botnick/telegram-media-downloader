/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Hono } from "hono";
import { accounts as am } from "../lib/legacy.js";

export const accountsRoutes = new Hono()
    .get("/accounts", async (c) => {
        try {
            const list = am.listAccounts ? await am.listAccounts() : [];
            return c.json({ accounts: list });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/accounts/:id", async (c) => {
        const id = c.req.param("id");
        try {
            if (am.removeAccount) await am.removeAccount(id);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/accounts/auth/begin", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
            const r = am.authBegin ? await am.authBegin(body) : { sessionId: null };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/accounts/auth/phone", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
            const r = am.authPhone ? await am.authPhone(body) : { ok: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/accounts/auth/code", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
            const r = am.authCode ? await am.authCode(body) : { ok: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/accounts/auth/2fa", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
            const r = am.auth2fa ? await am.auth2fa(body) : { ok: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/accounts/auth/cancel", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
            if (am.authCancel) await am.authCancel(body);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
