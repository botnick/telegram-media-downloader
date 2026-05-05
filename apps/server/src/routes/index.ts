/**
 * Mount every API route under /api. Order is irrelevant for matching
 * (Hono uses radix tree) but kept alphabetical for sanity.
 *
 * Auth gating happens inside each module — most endpoints require an
 * admin session, a small allowlist (auth_check, login, version) is
 * public. The two-tier model (admin / guest) is enforced by the
 * `requireAuth(role)` middleware imported per-route.
 */

import type { Hono } from "hono";
import { authRoutes } from "./auth.js";
import { authCheckRoute } from "./auth_check.js";
import { downloadsRoutes } from "./downloads.js";
import { groupsRoutes } from "./groups.js";
import { statsRoutes } from "./stats.js";
import { thumbsRoutes } from "./thumbs.js";
import { versionRoutes } from "./version.js";

export function mountRoutes(app: Hono) {
    app.route("/api", authRoutes);
    app.route("/api", authCheckRoute);
    app.route("/api", downloadsRoutes);
    app.route("/api", groupsRoutes);
    app.route("/api", statsRoutes);
    app.route("/api", thumbsRoutes);
    app.route("/api", versionRoutes);
}
