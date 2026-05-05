/**
 * Mount every API route. The /api prefix is shared; non-/api roots
 * (files, share/:id, metrics, /CHANGELOG.md) mount at the bottom.
 */

import type { Hono } from "hono";
import { accountsRoutes } from "./accounts.js";
import { aiRoutes } from "./ai.js";
import { authRoutes } from "./auth.js";
import { authCheckRoute } from "./auth_check.js";
import { backupRoutes } from "./backup.js";
import { configRoutes } from "./config.js";
import { downloadsRoutes } from "./downloads.js";
import { engineRoutes } from "./engine.js";
import { extrasRoutes } from "./extras.js";
import { filesRoutes } from "./files.js";
import { groupsRoutes } from "./groups.js";
import { historyRoutes } from "./history.js";
import { maintenanceRoutes, metricsRoute } from "./maintenance.js";
import { nsfwRoutes } from "./nsfw.js";
import { shareRoutes, sharePublicRoutes } from "./share.js";
import { statsRoutes } from "./stats.js";
import { thumbsRoutes } from "./thumbs.js";
import { versionRoutes } from "./version.js";

export function mountRoutes(app: Hono) {
    app.route("/api", accountsRoutes);
    app.route("/api", aiRoutes);
    app.route("/api", authRoutes);
    app.route("/api", authCheckRoute);
    app.route("/api", backupRoutes);
    app.route("/api", configRoutes);
    app.route("/api", downloadsRoutes);
    app.route("/api", engineRoutes);
    app.route("/api", extrasRoutes);
    app.route("/api", groupsRoutes);
    app.route("/api", historyRoutes);
    app.route("/api", maintenanceRoutes);
    app.route("/api", nsfwRoutes);
    app.route("/api", shareRoutes);
    app.route("/api", statsRoutes);
    app.route("/api", thumbsRoutes);
    app.route("/api", versionRoutes);

    // Non-/api roots
    app.route("/", filesRoutes);
    app.route("/", sharePublicRoutes);
    app.route("/", metricsRoute);
}
