/**
 * Disk Rotator — periodic sweep that enforces config.diskManagement.maxTotalSize.
 *
 * When enabled, every `sweepIntervalMin` minutes:
 *   1. Compute total bytes (SUM(file_size) across the downloads table).
 *   2. If total > cap, delete the oldest unpinned rows one-by-one (file + DB
 *      row), broadcasting `{ type: 'file_deleted', id }` per deletion so the
 *      SPA refreshes, until total is back under cap.
 *   3. Emit a single structured log line per sweep:
 *        [disk-rotator] sweep { before, deleted, after, capBytes }
 *
 * Best-effort: missing files on disk are treated as already-rotated (the DB
 * row is removed, no crash). Caller controls the lifecycle via start()/stop().
 *
 * The rotator pulls fresh config every sweep via the supplied loadConfig fn,
 * so toggling enabled / changing maxTotalSize takes effect on the next tick
 * (and immediately when server.js calls restart() inside POST /api/config).
 */

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import {
    getTotalSizeBytes,
    getOldestDownloads,
    deleteDownloadsBy,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, '../../data/downloads');

const DEFAULT_SWEEP_MIN = 10;
const SWEEP_BATCH = 50;          // candidate rows fetched per pass
const MAX_DELETES_PER_SWEEP = 5000; // hard ceiling to avoid runaway loops

/**
 * Parse a human-readable size string into bytes.
 *
 *   "10 GB"  → 10 * 1024^3
 *   "500MB"  → 500 * 1024^2
 *   "1.5 TB" → 1.5 * 1024^4
 *
 * Returns 0 for falsy / unparsable input — the caller treats 0 as "no cap"
 * (i.e. never rotate). Mirrors the parser on DownloadManager.parseSize so the
 * settings UI accepts the same strings everywhere.
 */
export function parseSize(input) {
    if (input == null) return 0;
    if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, Math.floor(input));
    const str = String(input).trim();
    if (!str) return 0;
    const m = str.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B?)$/i);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    if (!Number.isFinite(val) || val < 0) return 0;
    const unit = (m[2] || 'B').toUpperCase().replace(/B$/, '') || '';
    const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit];
    if (mult == null) return 0;
    return Math.floor(val * mult);
}

/**
 * Best-effort delete of the on-disk file for a download row. Tolerates ENOENT
 * (user already removed the file manually) and any other unlink error — the
 * DB row gets removed regardless so the SQLite view stays consistent.
 */
async function tryUnlink(row) {
    if (!row.file_path) return;
    const normalized = path.normalize(String(row.file_path));
    if (path.isAbsolute(normalized) || normalized.includes('..')) return; // refuse to escape
    const target = path.join(DOWNLOADS_DIR, normalized);
    try {
        await fs.unlink(target);
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            // Log but don't throw — the rotator is best-effort.
            console.warn(`[disk-rotator] unlink failed for ${normalized}: ${e.message}`);
        }
    }
}

export class DiskRotator {
    /**
     * @param {object} opts
     * @param {() => object} opts.loadConfig  reads current config (called per sweep)
     * @param {(msg: object) => void} [opts.broadcast]  WS broadcast (file_deleted events)
     */
    constructor({ loadConfig, broadcast } = {}) {
        if (typeof loadConfig !== 'function') {
            throw new Error('DiskRotator requires loadConfig');
        }
        this._loadConfig = loadConfig;
        this._broadcast = typeof broadcast === 'function' ? broadcast : () => {};
        this._timer = null;
        this._sweeping = false;
        this._intervalMs = 0;
    }

    /**
     * Start the periodic sweeper. Idempotent — calling start() while already
     * running stops the previous timer and re-applies the latest interval.
     * Returns true if started, false if disabled in config.
     */
    start() {
        this.stop();
        let cfg;
        try { cfg = this._loadConfig(); } catch { return false; }
        const dm = cfg?.diskManagement || {};
        if (!dm.enabled) return false;

        const minutes = Math.max(1, Math.min(1440, parseInt(dm.sweepIntervalMin, 10) || DEFAULT_SWEEP_MIN));
        this._intervalMs = minutes * 60 * 1000;

        // Kick off one sweep shortly after start so a freshly-enabled rotator
        // doesn't make the user wait `sweepIntervalMin` for the first pass.
        // Don't await — start() must stay non-blocking for callers.
        setTimeout(() => { this.sweep().catch((e) => console.warn('[disk-rotator] initial sweep failed:', e.message)); }, 5_000).unref?.();

        this._timer = setInterval(() => {
            this.sweep().catch((e) => console.warn('[disk-rotator] sweep failed:', e.message));
        }, this._intervalMs);
        this._timer.unref?.();
        console.log(`[disk-rotator] started (every ${minutes} min)`);
        return true;
    }

    /** Stop the periodic sweeper. Safe to call multiple times. */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            console.log('[disk-rotator] stopped');
        }
    }

    /** Convenience for server.js POST /api/config. */
    restart() {
        this.stop();
        return this.start();
    }

    /**
     * Run a single sweep. Returns { before, deleted, after, capBytes } or
     * null if disabled / no cap configured. Re-entrancy guarded — concurrent
     * calls return null.
     */
    async sweep() {
        if (this._sweeping) return null;
        this._sweeping = true;
        try {
            let cfg;
            try { cfg = this._loadConfig(); } catch { return null; }
            const dm = cfg?.diskManagement || {};
            if (!dm.enabled) return null;
            const capBytes = parseSize(dm.maxTotalSize);
            if (capBytes <= 0) return null; // no cap → never rotate

            const before = getTotalSizeBytes();
            if (before <= capBytes) {
                // Quiet success path — log only when something changes to keep
                // logs scannable. Uncomment for verbose tracing.
                return { before, deleted: 0, after: before, capBytes };
            }

            // Per-sweep tunables. Pulled from config.advanced.diskRotator.*
            // with the original constants preserved as fallbacks so an old
            // config behaves identically.
            const adv = cfg?.advanced?.diskRotator || {};
            const batch = Math.max(1, parseInt(adv.sweepBatch, 10) || SWEEP_BATCH);
            const maxDeletes = Math.max(1, parseInt(adv.maxDeletesPerSweep, 10) || MAX_DELETES_PER_SWEEP);

            let total = before;
            let deleted = 0;
            let safety = maxDeletes;

            outer: while (total > capBytes && safety > 0) {
                const candidates = getOldestDownloads(batch);
                if (!candidates.length) break;
                for (const row of candidates) {
                    if (total <= capBytes || safety <= 0) break outer;
                    await tryUnlink(row);
                    const removed = deleteDownloadsBy({ ids: [row.id] });
                    if (removed > 0) {
                        const sz = Number(row.file_size || 0);
                        total -= sz;
                        deleted += 1;
                        safety -= 1;
                        try { this._broadcast({ type: 'file_deleted', id: row.id, path: row.file_path || null }); } catch {}
                    } else {
                        // Row vanished between fetch and delete — skip and
                        // requery so we don't loop on the same id.
                        break;
                    }
                }
            }

            const after = getTotalSizeBytes();
            console.log(`[disk-rotator] sweep ${JSON.stringify({ before, deleted, after, capBytes })}`);
            return { before, deleted, after, capBytes };
        } finally {
            this._sweeping = false;
        }
    }
}

let _singleton = null;

/** Lazily-created singleton wired to loadConfig + broadcast. */
export function getDiskRotator(opts) {
    if (!_singleton && opts) _singleton = new DiskRotator(opts);
    return _singleton;
}
