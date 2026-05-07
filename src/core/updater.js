/**
 * One-click in-dashboard auto-update.
 *
 * The dashboard never touches `/var/run/docker.sock` — that would make
 * an RCE in the web UI equivalent to root on the host. Instead, the
 * official `containrrr/watchtower` image runs as a sidecar container
 * with the socket and an authenticated HTTP API; this module is a thin
 * client that runs the following ordered pre-flight + handoff:
 *
 *   1. Watchtower reachability ping (5 s HEAD). Surfaces a misconfigured
 *      `WATCHTOWER_URL` or sidecar-down condition before we burn disk on
 *      a snapshot.
 *   2. Quick integrity check (`PRAGMA quick_check`) on the live SQLite
 *      DB. Refuse to proceed if corrupt — the snapshot would just save
 *      a corrupt copy.
 *   3. Snapshot the DB into `data/backups/`. WAL checkpoint + better-
 *      sqlite3's online `db.backup()` so concurrent writes during the
 *      copy don't tear pages.
 *   4. Verify the freshly-written snapshot (open read-only, schema
 *      sanity, `PRAGMA quick_check`). If it's torn or unopenable, delete
 *      it so a bad backup can't masquerade as a recovery point.
 *   5. POST watchtower's `/v1/update` over the internal docker network
 *      with a bearer token shared via `.env`. 15 s timeout — we already
 *      verified reachability in step 1.
 *   6. Return. Watchtower then stops the main container, re-creates it
 *      with the freshly-pulled image, and Docker's `restart: unless-
 *      stopped` policy brings it up.
 *   7. The browser sees its WebSocket drop; the existing reconnect logic
 *      lands on the new container as soon as the healthcheck passes.
 *      The new container's boot path closes the loop by stamping the
 *      pending `update_history` row with the new version + status.
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
 * Both URL and token come from environment variables — never written to
 * the config kv row so they don't leak into the maintenance "view config"
 * surface or any backup snapshot.
 */

import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { getDb } from './db.js';

const _localRequire = createRequire(import.meta.url);

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

// ---- Pre-flight checks -----------------------------------------------------

const PING_TIMEOUT_MS = 5_000;
const TRIGGER_TIMEOUT_MS = 15_000;

/**
 * Confirm the watchtower sidecar is reachable BEFORE we touch the DB.
 * A bare HEAD against `/v1/update` is enough — watchtower has no health
 * endpoint, but any HTTP response (incl. 405 Method Not Allowed for HEAD
 * on a POST-only route) means the host is up. Connection refused / DNS
 * failure / timeout = sidecar down. 5 s cap so a hung gateway doesn't
 * stall the operator click.
 */
async function _pingWatchtower() {
    const ep = _watchtowerEndpoint();
    if (!ep) return { ok: false, msg: 'endpoint not configured' };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    try {
        const res = await fetch(`${ep.url}/v1/update`, {
            method: 'HEAD',
            headers: { Authorization: `Bearer ${ep.token}` },
            signal: ctrl.signal,
        });
        // A 5xx means the sidecar is up but unhealthy — still a fail
        // because the subsequent POST will likely 5xx too.
        if (res.status >= 500) {
            return { ok: false, msg: `watchtower returned HTTP ${res.status}` };
        }
        return { ok: true, status: res.status };
    } catch (e) {
        if (e?.name === 'AbortError') {
            return { ok: false, msg: `ping timed out after ${PING_TIMEOUT_MS}ms` };
        }
        return { ok: false, msg: `unreachable: ${e?.message || String(e)}` };
    } finally {
        clearTimeout(t);
    }
}

/**
 * Run `PRAGMA quick_check` against the live DB. Faster than full
 * integrity_check; still catches the failure modes we care about (page
 * checksum mismatches, corrupted indexes). Bail before snapshotting if
 * corrupt — snapshotting a bad DB just preserves the corruption as our
 * "recovery point."
 */
function _verifyDbIntegrity() {
    try {
        const db = getDb();
        const rows = db.prepare('PRAGMA quick_check').all();
        // SQLite returns one row `{ quick_check: 'ok' }` on a healthy DB,
        // or one row per defect on a corrupt one.
        const ok = rows.length === 1 && rows[0]?.quick_check === 'ok';
        if (!ok) {
            const detail = rows
                .slice(0, 5)
                .map((r) => r.quick_check)
                .join('; ');
            return { ok: false, msg: `quick_check failed — ${detail}` };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, msg: e?.message || String(e) };
    }
}

/**
 * Open the freshly-written snapshot read-only and confirm it's a usable
 * recovery point: schema present, `PRAGMA quick_check` clean. Catches
 * the case where the source DB was rotated mid-`db.backup()` and we
 * ended up with a torn copy. We delete the bad snapshot ourselves so a
 * corrupt file can't sit in `data/backups/` pretending to be a viable
 * rollback target.
 */
async function _verifySnapshot(snapshotPath) {
    if (!snapshotPath || !existsSync(snapshotPath)) {
        return { ok: false, msg: 'snapshot file missing' };
    }
    let probe;
    try {
        const Database = _localRequire('better-sqlite3');
        probe = new Database(snapshotPath, { readonly: true, fileMustExist: true });
        const tbl = probe
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'")
            .get();
        if (!tbl) {
            return { ok: false, msg: 'snapshot missing downloads table' };
        }
        const rows = probe.prepare('PRAGMA quick_check').all();
        const ok = rows.length === 1 && rows[0]?.quick_check === 'ok';
        if (!ok) {
            const detail = rows
                .slice(0, 5)
                .map((r) => r.quick_check)
                .join('; ');
            return { ok: false, msg: `snapshot quick_check failed — ${detail}` };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, msg: e?.message || String(e) };
    } finally {
        try {
            probe?.close();
        } catch {}
    }
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
    return (
        `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
    );
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
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
        /* non-fatal */
    }

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
        const files = (await fs.readdir(BACKUPS_DIR)).filter(
            (n) => n.startsWith('db-pre-update-') && n.endsWith('.sqlite'),
        );
        const stats = await Promise.all(
            files.map(async (n) => {
                const full = path.join(BACKUPS_DIR, n);
                const s = await fs.stat(full).catch(() => null);
                return s ? { full, mtime: s.mtimeMs } : null;
            }),
        );
        const sorted = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
        for (const old of sorted.slice(KEEP_BACKUPS)) {
            try {
                await fs.unlink(old.full);
            } catch {
                /* best-effort */
            }
        }
    } catch {
        /* prune is best-effort */
    }

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
    const t = setTimeout(() => ctrl.abort(), TRIGGER_TIMEOUT_MS);
    try {
        const res = await fetch(`${ep.url}/v1/update`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ep.token}` },
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
 * Kick off the full update flow: ping watchtower, integrity-check the
 * live DB, snapshot it, verify the snapshot, then signal watchtower.
 * Returns once watchtower acknowledges; the actual container swap
 * happens out-of-band moments later.
 *
 * The caller (a route handler) is expected to broadcast `update_started`
 * over WebSocket immediately after this resolves so every open tab can
 * render an "Updating, will reconnect…" overlay.
 *
 * Each error carries a stable `code` field the route handler surfaces
 * to the SPA so the operator gets actionable text, not a generic
 * "update failed":
 *
 *   AUTO_UPDATE_UNAVAILABLE  — not in Docker / sidecar not configured
 *   WATCHTOWER_UNREACHABLE   — pre-flight ping failed (sidecar down)
 *   DB_CORRUPT               — quick_check on the live DB failed
 *   BACKUP_FAILED            — snapshot copy threw
 *   BACKUP_VERIFY_FAILED     — snapshot wrote but is unreadable / torn
 *   TRIGGER_FAILED           — watchtower POST returned non-2xx
 *
 * @returns {Promise<{ success: true, backup: { path: string|null, sizeBytes: number },
 *                     ping: object, integrity: object, verify: object }>}
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

    // 1. Pre-flight ping — fail fast on a misconfigured WATCHTOWER_URL or
    //    a sidecar that crashed. Cheaper than a wasted DB snapshot.
    const ping = await _pingWatchtower();
    if (!ping.ok) {
        const err = new Error(
            `Watchtower preflight failed — ${ping.msg}. The sidecar may be down or the WATCHTOWER_URL / token is wrong.`,
        );
        err.code = 'WATCHTOWER_UNREACHABLE';
        throw err;
    }

    // 2. Live-DB integrity check — refuse to back up corruption.
    const integrity = _verifyDbIntegrity();
    if (!integrity.ok) {
        const err = new Error(
            `Live DB integrity check failed — ${integrity.msg}. Refusing to snapshot a corrupt DB; run "Maintenance → DB integrity" and recover before retrying.`,
        );
        err.code = 'DB_CORRUPT';
        throw err;
    }

    // 3. Snapshot.
    let backup = { path: null, sizeBytes: 0 };
    try {
        backup = await _snapshotDb();
    } catch (e) {
        const err = new Error(`Pre-update DB snapshot failed: ${e.message}`);
        err.code = 'BACKUP_FAILED';
        throw err;
    }

    // 4. Verify the snapshot is openable + clean. If verification fails,
    //    nuke the bad file ourselves — we don't want a torn snapshot
    //    sitting in `data/backups/` that could be mistaken for a viable
    //    recovery point during a panic restore.
    const verify = await _verifySnapshot(backup.path);
    if (!verify.ok) {
        if (backup.path) {
            try {
                await fs.unlink(backup.path);
            } catch {
                /* leave it — operator can clean up manually */
            }
        }
        const err = new Error(
            `Pre-update snapshot verification failed: ${verify.msg}. The bad snapshot has been deleted; please retry once you've inspected disk health.`,
        );
        err.code = 'BACKUP_VERIFY_FAILED';
        throw err;
    }

    // 5. Hand off to watchtower.
    try {
        await _triggerWatchtower();
    } catch (e) {
        const err = new Error(`Watchtower trigger failed: ${e.message}`);
        err.code = 'TRIGGER_FAILED';
        throw err;
    }
    return { success: true, backup, ping, integrity, verify };
}

export const _internals = {
    _snapshotDb,
    _watchtowerEndpoint,
    _pingWatchtower,
    _verifyDbIntegrity,
    _verifySnapshot,
};
