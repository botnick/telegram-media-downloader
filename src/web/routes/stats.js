import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fsSync, { existsSync } from 'fs';
import { getDb, getStats as getDbStats, getStatsFederated, kvSet } from '../../core/db.js';
import { loadConfig } from '../../config/manager.js';
import { runtime } from '../../core/runtime.js';
import { listPeers } from '../../core/cluster/peers.js';
import { formatBytes } from '../lib/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../../data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');

const STATS_CACHE_TTL_MS = 2000;
let _statsCache = { role: null, at: 0, body: null };

// Recursive directory size — used by /api/stats as the fallback when the DB
// catalogue is empty.
async function scanDirectorySize(dir) {
    let total = 0;
    async function walk(current) {
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            try {
                const st = await fs.stat(fullPath);
                if (st.isFile()) total += st.size;
            } catch {
                /* file disappeared mid-scan */
            }
        }
    }
    await walk(dir);
    return total;
}

function writeDiskUsageCache(size) {
    // The legacy `data/disk_usage.json` file was the cache before the
    // JSON→SQLite migration; after first boot it's renamed to
    // `disk_usage.json.migrated`, so writing to the old path silently
    // dropped the cache. The downloader hot path already uses
    // `kvSet('disk_usage', …)` (core/downloader.js); align this
    // fallback writer with the same canonical store.
    try {
        kvSet('disk_usage', { size, lastScan: Date.now() });
    } catch {
        /* best-effort cache */
    }
}

// Module-level deps set by factory — needed by broadcastStatsSoon which
// is exported for use by other routers/event handlers.
let _broadcast = null;
let _getAccountManager = null;
let _getIsConnected = null;

async function _computeStatsPayload(role) {
    const dbStats = getDbStats();
    const config = loadConfig();
    let diskUsage = Number(dbStats.totalSize) || 0;
    if (diskUsage <= 0) {
        diskUsage = await scanDirectorySize(DOWNLOADS_DIR);
        writeDiskUsageCache(diskUsage);
    }
    let accountCount = 0;
    try {
        const am = await _getAccountManager();
        accountCount = am.count;
    } catch {
        try {
            const dir = path.join(DATA_DIR, 'sessions');
            if (existsSync(dir)) {
                accountCount = fsSync.readdirSync(dir).filter((f) => f.endsWith('.enc')).length;
            }
        } catch {}
    }
    let peerStats = [];
    if (role !== 'guest') {
        try {
            const fed = getStatsFederated();
            const peerNameMap = new Map();
            try {
                for (const p of listPeers()) {
                    peerNameMap.set(String(p.peerId), {
                        name: p.name || p.peerId,
                        online: p.status === 'online',
                    });
                }
            } catch {}
            peerStats = (fed.peerStats || []).map((row) => ({
                peerId: row.peerId,
                peerName: peerNameMap.get(String(row.peerId))?.name || row.peerId,
                online: !!peerNameMap.get(String(row.peerId))?.online,
                totalFiles: row.totalFiles,
                totalSize: row.totalSize,
                totalSizeFormatted: formatBytes(row.totalSize),
            }));
        } catch {}
    }
    return {
        totalFiles: dbStats.totalFiles,
        totalSize: dbStats.totalSize,
        diskUsage,
        diskUsageFormatted: formatBytes(diskUsage),
        maxDiskSize: config.diskManagement?.maxTotalSize || '0',
        totalGroups: config.groups?.length || 0,
        enabledGroups: config.groups?.filter((g) => g.enabled).length || 0,
        accounts: accountCount,
        apiConfigured: !!(config.telegram?.apiId && config.telegram?.apiHash),
        telegramConnected: (_getIsConnected?.() ?? false) || runtime.state === 'running',
        peerStats,
    };
}

// Debounced WS push. Trigger events fire in bursts (50-row bulk delete
// emits one event per row); we coalesce to a single recompute + broadcast
// per ~400ms window so the WS channel doesn't get spammed.
let _statsBroadcastTimer = null;
export function broadcastStatsSoon() {
    if (_statsBroadcastTimer) return;
    _statsBroadcastTimer = setTimeout(async () => {
        _statsBroadcastTimer = null;
        try {
            const body = await _computeStatsPayload('admin');
            _statsCache = { role: 'admin', at: Date.now(), body };
            _broadcast?.({ type: 'stats_update', stats: body });
        } catch (e) {
            console.warn('[stats] broadcast failed:', e.message);
        }
    }, 400);
}

export function createStatsRouter({ broadcast, getAccountManager, getIsConnected }) {
    _broadcast = broadcast;
    _getAccountManager = getAccountManager;
    _getIsConnected = getIsConnected;
    const router = express.Router();

    // 1. Stats API (SQLite)
    //
    // HTTP endpoint AND WebSocket push (`stats_update`). The footer/statusbar
    // hits the HTTP path once on first paint, then switches to WS — every
    // trigger event (download_complete, bulk_delete, file_deleted, purge_all,
    // group_purged, config_updated) calls `broadcastStatsSoon()` which
    // debounces a recompute + push within 400ms. Cache TTL keeps repeat
    // hits to /api/stats cheap when the page reloads mid-burst.
    router.get('/stats', async (req, res) => {
        try {
            const now = Date.now();
            const role = req.role || 'admin';
            if (
                _statsCache.body &&
                _statsCache.role === role &&
                now - _statsCache.at < STATS_CACHE_TTL_MS
            ) {
                return res.json(_statsCache.body);
            }
            const body = await _computeStatsPayload(role);
            _statsCache = { role, at: now, body };
            return res.json(body);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    });

    // 1b. DB Stats — detailed table sizes, group breakdown, file types, AI indexing
    router.get('/db/stats', async (req, res) => {
        try {
            const db = getDb();

            const tables = [
                'downloads',
                'faces',
                'people',
                'image_embeddings',
                'image_tags',
                'queue',
            ];
            const tableCounts = {};
            for (const t of tables) {
                try {
                    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
                    tableCounts[t] = r?.n || 0;
                } catch {
                    tableCounts[t] = 0;
                }
            }

            const groups = db
                .prepare(
                    `
            SELECT group_name, COUNT(*) AS n,
                   SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photos,
                   SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videos,
                   SUM(file_size) AS bytes,
                   MAX(created_at) AS last_activity
              FROM downloads
             GROUP BY group_name
             ORDER BY last_activity DESC
        `,
                )
                .all();

            const totals = db
                .prepare(
                    `
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN file_type = 'photo' THEN 1 ELSE 0 END) AS photos,
                   SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) AS videos,
                   SUM(CASE WHEN file_type = 'audio' THEN 1 ELSE 0 END) AS audio,
                   SUM(CASE WHEN file_type = 'document' THEN 1 ELSE 0 END) AS documents,
                   SUM(CASE WHEN file_type = 'voice' THEN 1 ELSE 0 END) AS voice,
                   SUM(file_size) AS bytes
              FROM downloads
        `,
                )
                .get();

            const recent = db
                .prepare(
                    `
            SELECT group_name, COUNT(*) AS n, SUM(file_size) AS bytes
              FROM downloads
             WHERE created_at >= datetime('now', '-30 minutes')
             GROUP BY group_name
             ORDER BY n DESC
        `,
                )
                .all();

            const indexed =
                db
                    .prepare(`SELECT COUNT(*) AS n FROM downloads WHERE ai_indexed_at IS NOT NULL`)
                    .get()?.n || 0;
            const total = db.prepare(`SELECT COUNT(*) AS n FROM downloads`).get()?.n || 0;
            let aiFaces = 0,
                aiPeople = 0,
                aiTags = 0;
            try {
                aiFaces = db.prepare('SELECT COUNT(*) AS n FROM faces').get()?.n || 0;
            } catch {}
            try {
                aiPeople = db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n || 0;
            } catch {}
            try {
                aiTags = db.prepare('SELECT COUNT(*) AS n FROM image_tags').get()?.n || 0;
            } catch {}

            res.json({
                success: true,
                tableCounts,
                groups,
                totals,
                recent,
                ai: {
                    indexed,
                    total,
                    pct: total ? Math.round((indexed / total) * 100) : 0,
                    faces: aiFaces,
                    people: aiPeople,
                    tags: aiTags,
                },
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
