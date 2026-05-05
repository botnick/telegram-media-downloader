/**
 * GET /api/auth_check — public liveness + auth state probe.
 *
 * Returns { authenticated, role, setupRequired }. The Docker
 * healthcheck hits this so it doubles as a 200-on-up signal.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Hono } from "hono";
import type { AuthCheckResponse } from "@tgdl/shared";

import { webAuth } from "../lib/legacy.js";

export const authCheckRoute = new Hono().get("/auth_check", async (c) => {
    let setupRequired = false;
    let role: AuthCheckResponse["role"] = null;
    let authenticated = false;
    try {
        setupRequired = !(await webAuth.isAuthConfigured());
    } catch {
        setupRequired = true;
    }
    try {
        const token = c.req.header("cookie")?.match(/tgdl_session=([^;]+)/)?.[1];
        if (token) {
            const session = await webAuth.lookupSession(token);
            if (session) {
                authenticated = true;
                role = (session.role as AuthCheckResponse["role"]) ?? "admin";
            }
        }
    } catch {
        // ignore
    }
    const body: AuthCheckResponse = { authenticated, role, setupRequired };
    return c.json(body);
});
