/**
 * Rescue Mode sweeper.
 *
 * Per-group "keep only what gets deleted from source" mode. Every monitored
 * download in a Rescue group lands in the DB with `pending_until = now + retentionMs`.
 * If Telegram fires a delete event for that message_id inside the window
 * (handled in src/core/monitor.js), the row is rescued — pending_until is
 * cleared, rescued_at is set, file lives forever. Otherwise this sweeper
 * runs on a periodic tick and deletes both file + DB row.
 *
 * Lifecycle is controlled by server.js (start/stop/restart) — same shape as
 * src/core/disk-rotator.js so the boot block can register both side-by-side.
 */
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import {
    getExpiredPending,
    deleteDownloadsBy,
    setRescueLastSweep,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, '../../data/downloads');

const DEFAULT_SWEEP_MIN = 10;
const MIN_SWEEP_MIN = 1;
const MAX_SWEEP_MIN = 1440;

/**
 * Best-effort delete of the on-disk file. ENOENT is fine — the file may have
 * been removed manually; we still drop the DB row to keep state consistent.
 * Refuses paths that try to escape the downloads root.
 */
async function tryUnlink(row) {
    if (!row.file_path) return;
    const normalized = path.normalize(String(row.file_path));
    if (path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) return;
    const target = path.join(DOWNLOADS_DIR, normalized);
    try {
        await fs.unlink(target);
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            console.warn(`[rescue] unlink failed for ${normalized}: ${e.message}`);
        }
    }
}

export class RescueSweeper {
    /**
     * @param {object} opts
     * @param {() => object} opts.loadConfig fresh config getter (called per tick)
     * @param {(msg: object) => void} [opts.broadcast] WS broadcast (rescue_swept)
     */
    constructor({ loadConfig, broadcast } = {}) {
        if (typeof loadConfig !== 'function') {
            throw new Error('RescueSweeper requires loadConfig');
        }
        this._loadConfig = loadConfig;
        this._broadcast = typeof broadcast === 'function' ? broadcast : () => {};
        this._timer = null;
        this._sweeping = false;
        this._intervalMs = 0;
    }

    /**
     * Start the periodic sweeper. Always safe to call — running even when
     * rescue.enabled is false because per-group rescueMode='on' should still
     * be swept. Returns true once the timer is armed.
     */
    start() {
        this.stop();
        let cfg;
        try { cfg = this._loadConfig(); } catch { return false; }
        const rescue = cfg?.rescue || {};
        const minutes = Math.max(MIN_SWEEP_MIN, Math.min(MAX_SWEEP_MIN, parseInt(rescue.sweepIntervalMin, 10) || DEFAULT_SWEEP_MIN));
        this._intervalMs = minutes * 60 * 1000;

        // First sweep shortly after start so a freshly-restarted sweeper
        // catches anything that expired while we were down.
        const initial = setTimeout(() => {
            this.sweep().catch((e) => console.warn('[rescue] initial sweep failed:', e.message));
        }, 5_000);
        initial.unref?.();

        this._timer = setInterval(() => {
            this.sweep().catch((e) => console.warn('[rescue] sweep failed:', e.message));
        }, this._intervalMs);
        this._timer.unref?.();
        console.log(`[rescue] sweeper started (every ${minutes} min)`);
        return true;
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            console.log('[rescue] sweeper stopped');
        }
    }

    restart() {
        this.stop();
        return this.start();
    }

    /**
     * One sweep pass. Returns { swept, scanned } or null when re-entered.
     * The DB does the time filter — we just unlink + delete row + broadcast.
     */
    async sweep() {
        if (this._sweeping) return null;
        this._sweeping = true;
        try {
            const now = Date.now();
            const rows = getExpiredPending(now);
            if (!rows.length) {
                setRescueLastSweep(0);
                return { swept: 0, scanned: 0 };
            }

            let swept = 0;
            for (const row of rows) {
                await tryUnlink(row);
                const removed = deleteDownloadsBy({ ids: [row.id] });
                if (removed > 0) {
                    swept += 1;
                    try {
                        this._broadcast({
                            type: 'rescue_swept',
                            id: row.id,
                            groupId: row.group_id,
                            path: row.file_path || null,
                        });
                    } catch {}
                }
            }

            setRescueLastSweep(swept);
            // One structured log line per sweep — matches the disk-rotator
            // shape so the two side-by-side modules feel consistent.
            console.log(`[rescue] sweep ${JSON.stringify({ swept, scanned: rows.length })}`);
            // Aggregate broadcast so the SPA can refresh stats once instead of
            // per-row. Per-row events still fire (above) for granular UI.
            try { this._broadcast({ type: 'rescue_sweep_done', count: swept }); } catch {}
            return { swept, scanned: rows.length };
        } finally {
            this._sweeping = false;
        }
    }
}

let _singleton = null;

/** Lazily-created singleton wired to loadConfig + broadcast. */
export function getRescueSweeper(opts) {
    if (!_singleton && opts) _singleton = new RescueSweeper(opts);
    return _singleton;
}

/**
 * Compute the effective rescue retention for a group. Returns either the
 * retention in milliseconds (Rescue is on for this group) or null (off).
 *
 * Per-group `rescueMode` values:
 *   - 'on'   : Always on for this group (uses group.rescueRetentionHours
 *              or falls back to cfg.rescue.retentionHours).
 *   - 'off'  : Always off for this group.
 *   - 'auto' (or unset): follow cfg.rescue.enabled.
 */
export function effectiveRescueMs(group, cfg) {
    const rescueCfg = (cfg && cfg.rescue) || {};
    const groupMode = group?.rescueMode;
    let on;
    if (groupMode === 'on') on = true;
    else if (groupMode === 'off') on = false;
    else on = rescueCfg.enabled === true;
    if (!on) return null;
    const hours = Number(group?.rescueRetentionHours) > 0
        ? Number(group.rescueRetentionHours)
        : Number(rescueCfg.retentionHours) > 0
            ? Number(rescueCfg.retentionHours)
            : 48;
    const clamped = Math.max(1, Math.min(720, hours));
    return clamped * 60 * 60 * 1000;
}
