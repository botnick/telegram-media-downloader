import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthCheckResponse } from "@tgdl/shared";

export const authCheckRoute = new Hono().get("/auth_check", (c) => {
    const sessionToken = getCookie(c, "tgdl_session");
    // TODO(server): wire up to lib/sessions.ts once the legacy session
    // store is ported. For now treat the absence of a cookie as
    // "unauthenticated" and the presence as "admin" (placeholder).
    const body: AuthCheckResponse = {
        authenticated: Boolean(sessionToken),
        role: sessionToken ? "admin" : null,
        setupRequired: false,
    };
    return c.json(body);
});
