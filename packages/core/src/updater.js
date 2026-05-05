/**
 * One-click in-dashboard auto-update.
 *
 * The dashboard never touches `/var/run/docker.sock` — that would make
 * an RCE in the web UI equivalent to root on the host. Instead, the
 * official `containrrr/watchtower` image runs as a sidecar container
 * with the socket and an authenticated HTTP API; this module is a thin
 * client that:
 *
 *   1. Snapshots the SQLite DB before the swap (WAL checkpoint + atomic
 *      copy into `data/backups/`). The downloads volume is preserved by
 *      Docker's standard volume semantics on container recreation, so
 *      we only need to defend against partial writes mid-checkpoint.
 *   2. Calls watchtower's `/v1/update` endpoint over the internal docker
 *      network with a bearer token shared via `.env`.
 *   3. Returns immediately. Watchtower then stops the main container,
 *      re-creates it with the freshly-pulled image, and Docker's
 *      `restart: unless-stopped` policy brings it up.
 *   4. The browser sees its WebSocket drop, the existing reconnect
 *      logic backs off + retries, and lands on the new container as
 *      soon as the healthcheck passes.
 *
 * What watchtower CAN do (scoped by docker-compose env):
 *   - Pull a new image for any container with the
 *     `com.centurylinklabs.watchtower.enable=true` label, then recreate.
 *   - That's it.
 *
 * What watchtower CANNOT do:
 *   - Launch new containers, mount volumes, exec, or read other
 *     containers' filesystems. The label allowlist + read-only socket
 *     mount + `WATCHTOWER_LABEL_ENABLE=true` reduce the blast radius
 *     to "recreate one container with a new tag".
 *
 * Both URL and token come from environment variables — never written
 * to config.json so they don't leak into the maintenance "view config"
 * surface or any backup snapshot.
 */

import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
const DB_PATH = path.resolve(DATA_DIR, 'db.sqlite');
const BACKUPS_DIR = path.resolve(DATA_DIR, 'backups');

// Number of pre-update DB snapshots to keep. The N+1th oldest is pruned
// after each successful checkpoint. Each snapshot is the full DB so on
// a 100 MB SQLite the cap means ~500 MB ceiling for backups — fine.
const KEEP_BACKUPS = 5;

// Watchtower endpoint defaults match docker-compose.yml's service name.
function _watchtowerEndpoint() {
    const url = process.env.WATCHTOWER_URL;
    const token = process.env.WATCHTOWER_HTTP_API_TOKEN;
    if (!url || !token) return null;
    // Strip trailing slash so we can string-concat the path.
    return { url: url.replace(/\/+$/, ''), token };
}

/**
 * Quick capability probe — true when the dashboard is configured to
 * trigger updates AND we're running inside a container (the only place
 * the watchtower handoff makes sense).
 */
export function isAutoUpdateAvailable() {
    if (!_watchtowerEndpoint()) return false;
    // Standard heuristic: every Docker image has /.dockerenv at the root.
    // This avoids spurious "configure auto-update" UI on a dev laptop
    // that happens to have WATCHTOWER_URL set in shell env.
    if (!existsSync('/.dockerenv')) return false;
    return true;
}

/**
 * Reasons the auto-update endpoint can decline to run, surfaced to the
 * UI so the operator gets actionable text instead of a silent failure.
 */
export function autoUpdateStatus() {
    const inDocker = existsSync('/.dockerenv');
    const ep = _watchtowerEndpoint();
    return {
        available: !!(inDocker && ep),
        inDocker,
        watchtowerConfigured: !!ep,
        watchtowerUrl: ep ? ep.url : null,
    };
}

// ---- DB snapshot helpers ---------------------------------------------------

async function _ensureBackupsDir() {
    if (!existsSync(BACKUPS_DIR)) {
        await fs.mkdir(BACKUPS_DIR, { recursive: true });
    }
}

function _timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
        + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Atomic, reader-safe DB snapshot.
 *
 * `PRAGMA wal_checkpoint(TRUNCATE)` flushes the WAL into the main file
 * + truncates the WAL, so the bytes-on-disk are a complete, consistent
 * snapshot. Then we use SQLite's online backup API via better-sqlite3's
 * `db.backup()` so concurrent writes during the copy don't tear pages.
 * Falls back to plain `fs.copyFile` if backup() fails (older SQLite).
 *
 * Returns `{ path, sizeBytes }` on success, throws on failure.
 */
async function _snapshotDb() {
    if (!existsSync(DB_PATH)) {
        return { path: null, sizeBytes: 0, skipped: 'no-db' };
    }
    await _ensureBackupsDir();

    const db = getDb();
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* non-fatal */ }

    const dst = path.join(BACKUPS_DIR, `db-pre-update-${_timestampSlug()}.sqlite`);
    try {
        // better-sqlite3's backup() is the safe online backup — it copies
        // the DB at page granularity and never trips on a concurrent
        // writer. Newer versions return a Promise; older ones a sync API.
        if (typeof db.backup === 'function') {
            await db.backup(dst);
        } else {
            await fs.copyFile(DB_PATH, dst);
        }
    } catch (e) {
        // Fall back to a plain copy if the online backup is unavailable.
        // The wal_checkpoint above + WAL mode means this is still a
        // consistent snapshot for our single-writer workload.
        await fs.copyFile(DB_PATH, dst);
    }
    const stat = await fs.stat(dst);

    // Prune older backups, keep the most-recent KEEP_BACKUPS files.
    try {
        const files = (await fs.readdir(BACKUPS_DIR))
            .filter((n) => n.startsWith('db-pre-update-') && n.endsWith('.sqlite'));
        const stats = await Promise.all(files.map(async (n) => {
            const full = path.join(BACKUPS_DIR, n);
            const s = await fs.stat(full).catch(() => null);
            return s ? { full, mtime: s.mtimeMs } : null;
        }));
        const sorted = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
        for (const old of sorted.slice(KEEP_BACKUPS)) {
            try { await fs.unlink(old.full); } catch { /* best-effort */ }
        }
    } catch { /* prune is best-effort */ }

    return { path: dst, sizeBytes: stat.size };
}

// ---- Watchtower client -----------------------------------------------------

/**
 * POST watchtower's `/v1/update` with bearer auth. Watchtower returns
 * 200 immediately and does the work asynchronously, so we don't await
 * the actual swap — the browser detects it via the WS disconnect.
 *
 * Wrap the fetch in a 30 s AbortController so a misconfigured
 * WATCHTOWER_URL doesn't hang the request indefinitely.
 */
async function _triggerWatchtower() {
    const ep = _watchtowerEndpoint();
    if (!ep) throw new Error('Watchtower endpoint not configured');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
        const res = await fetch(`${ep.url}/v1/update`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${ep.token}` },
            signal: ctrl.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`watchtower /v1/update returned ${res.status} ${body.slice(0, 200)}`);
        }
        // Watchtower's response body is empty / "Updates triggered." —
        // return what we know.
        return { triggered: true };
    } finally {
        clearTimeout(t);
    }
}

// ---- Public entry ----------------------------------------------------------

/**
 * Kick off the full update flow: pre-snapshot the DB, then signal
 * watchtower. Returns once watchtower acknowledges; the actual
 * container swap happens out-of-band moments later.
 *
 * The caller (a route handler) is expected to broadcast
 * `update_started` over WebSocket immediately after this resolves so
 * every open tab can render an "Updating, will reconnect…" overlay.
 *
 * @returns {Promise<{ success: true, backup: { path: string|null, sizeBytes: number } }>}
 */
export async function runAutoUpdate() {
    const status = autoUpdateStatus();
    if (!status.available) {
        const why = !status.inDocker
            ? 'Auto-update only works inside Docker (the dashboard process is not running in a container).'
            : 'Watchtower sidecar is not configured. Enable the `auto-update` profile in docker-compose.yml and set WATCHTOWER_HTTP_API_TOKEN in .env.';
        const err = new Error(why);
        err.code = 'AUTO_UPDATE_UNAVAILABLE';
        throw err;
    }

    let backup = { path: null, sizeBytes: 0 };
    try {
        backup = await _snapshotDb();
    } catch (e) {
        // Snapshot is defence-in-depth; refuse to proceed if it failed
        // — the operator may want to retry from a clean state.
        const err = new Error(`Pre-update DB snapshot failed: ${e.message}`);
        err.code = 'BACKUP_FAILED';
        throw err;
    }

    await _triggerWatchtower();
    return { success: true, backup };
}

export const _internals = { _snapshotDb, _watchtowerEndpoint };
