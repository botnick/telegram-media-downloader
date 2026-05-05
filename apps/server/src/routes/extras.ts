/**
 * Catch-all routes the legacy server exposes that don't fit a
 * dedicated module: dialogs, rescue stats, auto-update probe,
 * monitor restart, dialog resync, file verify, reindex, log readers,
 * dedup-delete, purge-all, group photo refresh, thumb hwaccel probe.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Hono } from "hono";

import {
    accounts as am,
    db,
    dedup,
    integrity,
    logger as log,
    rescue,
    thumbs,
    updater,
} from "../lib/legacy.js";

export const extrasRoutes = new Hono()
    // ---- Dialogs (Telegram chats list) -----------------------------------
    .get("/dialogs", async (c) => {
        try {
            const r = am.listDialogs ? await am.listDialogs() : { dialogs: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- Rescue mode -----------------------------------------------------
    .get("/rescue/stats", async (c) => {
        try {
            const r = rescue.getStats ? await rescue.getStats() : { count: 0 };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- Updater ---------------------------------------------------------
    .get("/auto-update/status", async (c) => {
        try {
            const r = updater.getAutoUpdateStatus
                ? await updater.getAutoUpdateStatus()
                : { available: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/update/status", async (c) => {
        try {
            const r = updater.getUpdateStatus
                ? await updater.getUpdateStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- Monitor / dialogs maintenance -----------------------------------
    .post("/maintenance/restart-monitor", async (c) => {
        try {
            const r = am.restartMonitor ? await am.restartMonitor() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/restart-monitor/status", async (c) => {
        try {
            const r = am.getRestartMonitorStatus
                ? await am.getRestartMonitorStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/resync-dialogs", async (c) => {
        try {
            const r = am.resyncDialogs ? await am.resyncDialogs() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/resync-dialogs/status", async (c) => {
        try {
            const r = am.getResyncDialogsStatus
                ? await am.getResyncDialogsStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- Files verify / reindex / dedup-delete ---------------------------
    .post("/maintenance/files/verify", async (c) => {
        try {
            const r = integrity.verifyFiles ? await integrity.verifyFiles() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/files/verify/status", async (c) => {
        try {
            const r = integrity.getVerifyStatus
                ? await integrity.getVerifyStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/reindex", async (c) => {
        try {
            const r = integrity.reindex ? await integrity.reindex() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/reindex/status", async (c) => {
        try {
            const r = integrity.getReindexStatus
                ? await integrity.getReindexStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/dedup/status", async (c) => {
        try {
            const r = dedup.getStatus ? await dedup.getStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/maintenance/dedup/delete", async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const r = dedup.deleteDuplicates ? await dedup.deleteDuplicates(body) : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/dedup/delete/status", async (c) => {
        try {
            const r = dedup.getDeleteStatus ? await dedup.getDeleteStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- Thumbs status / hwaccel probe -----------------------------------
    .get("/maintenance/thumbs/build/status", async (c) => {
        try {
            const r = thumbs.getBuildStatus ? await thumbs.getBuildStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/thumbs/rebuild/status", async (c) => {
        try {
            const r = thumbs.getRebuildStatus
                ? await thumbs.getRebuildStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/thumbs/hwaccel-probe", async (c) => {
        try {
            const r = thumbs.probeHwaccel
                ? await thumbs.probeHwaccel()
                : { backend: null, available: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- DB integrity / vacuum status ------------------------------------
    .get("/maintenance/db/integrity/status", async (c) => {
        try {
            const r = integrity.getIntegrityStatus
                ? await integrity.getIntegrityStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/db/vacuum/status", async (c) => {
        try {
            const r = integrity.getVacuumStatus
                ? await integrity.getVacuumStatus()
                : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })

    // ---- Logs ------------------------------------------------------------
    .get("/maintenance/logs", async (c) => {
        try {
            const r = log.listLogs ? await log.listLogs() : { logs: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/logs/recent", async (c) => {
        try {
            const r = log.recentLogs ? await log.recentLogs() : { lines: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/maintenance/logs/download", async (c) => {
        try {
            const r = log.exportLogs ? await log.exportLogs() : "";
            c.header("Content-Type", "text/plain");
            c.header("Content-Disposition", "attachment; filename=logs.txt");
            return c.body(String(r));
        } catch (err) {
            return c.text((err as Error).message, 500);
        }
    })

    // ---- Maintenance config raw ------------------------------------------
    .get("/maintenance/config/raw", async (c) => {
        try {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const dataDir = process.env["TGDL_DATA_DIR"] ?? path.resolve(process.cwd(), "data");
            const raw = await fs.readFile(path.join(dataDir, "config.json"), "utf8");
            return c.text(raw);
        } catch (err) {
            return c.text((err as Error).message, 500);
        }
    })

    // ---- Groups: photos refresh + group purge ---------------------------
    .delete("/groups/:id/purge", async (c) => {
        const id = c.req.param("id");
        try {
            if (db.deleteGroupDownloads) await db.deleteGroupDownloads(id);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/groups/:id/purge/status", async (c) => {
        return c.json({ running: false });
    })
    .get("/groups/refresh-info/status", async (c) => {
        return c.json({ running: false });
    })
    .get("/groups/refresh-photos/status", async (c) => {
        return c.json({ running: false });
    })

    // ---- Purge all -------------------------------------------------------
    .delete("/purge/all", async (c) => {
        try {
            if (db.deleteAllDownloads) await db.deleteAllDownloads();
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/purge/all/status", async (c) => {
        return c.json({ running: false });
    });
