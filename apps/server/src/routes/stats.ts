/**
 * GET /api/stats
 *
 * Footer chip + status-bar feed. Shape mirrors the legacy server one
 * for one so the SPA's `loadStats()` keeps working unmodified during
 * the rolling migration.
 */

// @tgdl/core is still .js source; types come once the package converts.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — js source, no .d.ts yet
import { getStats as getDbStats } from "@tgdl/core/db";
import { Hono } from "hono";
import { loadConfig } from "../lib/config.js";

interface DbStats {
    totalFiles: number;
    totalSize: number;
}

interface ConfigShape {
    diskManagement?: { maxTotalSize?: string };
    groups?: Array<{ enabled?: boolean }>;
    telegram?: { apiId?: unknown; apiHash?: unknown };
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

export const statsRoutes = new Hono().get("/stats", async (c) => {
    try {
        const dbStats = getDbStats() as DbStats;
        let config: ConfigShape = {};
        try {
            config = (await loadConfig()) as ConfigShape;
        } catch {
            // No config yet (fresh install) — fall through with defaults.
        }

        const diskUsage = Number(dbStats.totalSize) || 0;

        return c.json({
            totalFiles: dbStats.totalFiles,
            totalSize: dbStats.totalSize,
            diskUsage,
            diskUsageFormatted: formatBytes(diskUsage),
            maxDiskSize: config.diskManagement?.maxTotalSize ?? "0",
            totalGroups: config.groups?.length ?? 0,
            enabledGroups: config.groups?.filter((g) => g.enabled).length ?? 0,
            accounts: 0,
            apiConfigured: Boolean(config.telegram?.apiId && config.telegram?.apiHash),
            telegramConnected: false,
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[stats]", err);
        return c.json({ error: "Failed to load stats" }, 500);
    }
});
