/**
 * Version endpoints — read-only, public.
 *
 *   GET /api/version       → { version, commit, builtAt }
 *   GET /api/version/check → { current, latest, updateAvailable, ... }
 *
 * The legacy server fetched GitHub Releases once per restart and
 * cached the result; we keep the same lazy-cache shape here so the
 * status-bar chip behaves identically.
 */

import type { VersionCheckResponse, VersionResponse } from "@tgdl/shared";
import { Hono } from "hono";

const BUILT_AT = process.env["BUILT_AT"] ?? null;
const COMMIT = (process.env["GIT_SHA"] ?? "dev").slice(0, 7);

function readVersion(): string {
    return process.env["npm_package_version"] ?? "?";
}

let cache: { fetchedAt: number; data: Omit<VersionCheckResponse, "current"> } | null = null;
const CACHE_TTL_MS = 60 * 60_000;

async function fetchLatestRelease(): Promise<Omit<VersionCheckResponse, "current">> {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data;
    try {
        const r = await fetch(
            "https://api.github.com/repos/botnick/telegram-media-downloader/releases/latest",
            { headers: { "User-Agent": "telegram-media-downloader" } }
        );
        if (!r.ok) throw new Error(`gh ${r.status}`);
        const json = (await r.json()) as {
            tag_name?: string;
            html_url?: string;
            published_at?: string;
        };
        const latest = (json.tag_name ?? "").replace(/^v/, "");
        const data: Omit<VersionCheckResponse, "current"> = {
            latest: latest || null,
            updateAvailable: latest ? latest !== readVersion() : false,
            releaseUrl: json.html_url ?? null,
            publishedAt: json.published_at ?? null,
        };
        cache = { fetchedAt: now, data };
        return data;
    } catch {
        const data = {
            latest: null,
            updateAvailable: false,
            releaseUrl: null,
            publishedAt: null,
        };
        cache = { fetchedAt: now, data };
        return data;
    }
}

export const versionRoutes = new Hono()
    .get("/version", (c) => {
        const body: VersionResponse = {
            version: readVersion(),
            commit: COMMIT,
            builtAt: BUILT_AT,
        };
        return c.json(body);
    })
    .get("/version/check", async (c) => {
        const rest = await fetchLatestRelease();
        const body: VersionCheckResponse = {
            current: readVersion(),
            ...rest,
        };
        return c.json(body);
    });
