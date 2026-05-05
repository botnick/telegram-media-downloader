// Backup manager — owns destinations, queue workers, snapshot cron,
// passphrase cache, and the WS broadcast surface.
//
// The architecture is deliberately one in-process worker per
// destination — keeps the hot path simple (no global pool / locking),
// and per-destination concurrency is achieved by the worker firing N
// uploads in parallel on its own. Restarting the server flips any
// `uploading` row back to `pending` (queue.recoverInflight) so a crash
// mid-upload re-enters the queue safely.

import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { EventEmitter } from 'events';
import os from 'os';
import { fileURLToPath } from 'url';

import { getDb } from '../db.js';
import { encryptConfig, decryptConfig } from './credentials.js';
import { deriveKey, generateSalt } from './encryption.js';
import * as queue from './queue.js';

import { LocalProvider } from './providers/local.js';
import { S3Provider } from './providers/s3.js';
import { SftpProvider } from './providers/sftp.js';
import { FtpProvider } from './providers/ftp.js';
import { GoogleDriveProvider } from './providers/gdrive.js';
import { DropboxProvider } from './providers/dropbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DATA_DIR = process.env.TGDL_DATA_DIR
    ? path.resolve(process.env.TGDL_DATA_DIR)
    : path.join(REPO_ROOT, 'data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'backups');

const PROVIDER_CLASSES = {
    local: LocalProvider,
    s3: S3Provider,
    sftp: SftpProvider,
    ftp: FtpProvider,
    gdrive: GoogleDriveProvider,
    dropbox: DropboxProvider,
};

const DEFAULT_WORKERS_PER_DEST = Number(process.env.BACKUP_WORKERS_PER_DEST) > 0
    ? Math.min(20, Math.floor(Number(process.env.BACKUP_WORKERS_PER_DEST)))
    : 3;

// ---- Public API surface ----------------------------------------------------

const events = new EventEmitter();

let _broadcast = () => {};
let _log = () => {};
let _getShareSecret = () => null;

const _workers = new Map();             // destinationId → Worker
const _passphraseCache = new Map();     // destinationId → Buffer (32-byte key)
const _snapshotTimers = new Map();      // destinationId → setInterval handle
const _snapshotInflight = new Set();    // destinationIds with a snapshot job in progress

/**
 * Wire the manager into the server. Must be called once at boot,
 * before any other API on this module.
 *
 * @param {object} deps
 * @param {Function} deps.broadcast       broadcast({type,...})
 * @param {Function} deps.log             log({source,level,msg})
 * @param {Function} deps.getShareSecret  () => shareSecret hex string
 * @param {EventEmitter} [deps.runtime]   if provided, we hook
 *                                         download_complete onto its
 *                                         `event` channel for mirror mode
 */
export function init(deps = {}) {
    if (typeof deps.broadcast === 'function') _broadcast = deps.broadcast;
    if (typeof deps.log === 'function') _log = deps.log;
    if (typeof deps.getShareSecret === 'function') _getShareSecret = deps.getShareSecret;
    if (deps.runtime?.on) {
        deps.runtime.on('event', (e) => {
            try { _onDownloadComplete(e); } catch (err) {
                _log({ source: 'backup', level: 'warn', msg: `mirror hook error: ${err.message}` });
            }
        });
    }
    // Boot every enabled destination's worker. Recovery (uploading →
    // pending) happens inside the worker constructor.
    for (const dest of listDestinations({ scrubbed: false })) {
        if (dest.enabled) {
            try { _ensureWorker(dest.id); } catch (e) {
                _log({ source: 'backup', level: 'error', msg: `worker boot failed for #${dest.id}: ${e.message}` });
            }
            _scheduleSnapshot(dest);
        }
    }
}

/** Subscribe to internal events. */
export function on(type, fn) { events.on(type, fn); }

// ---- Provider registry -----------------------------------------------------

/** All providers + their config schemas — used by the wizard endpoint. */
export function listProviders() {
    return Object.values(PROVIDER_CLASSES).map((C) => ({
        name: C.name,
        displayName: C.displayName,
        configSchema: C.configSchema,
    }));
}

// ---- Destinations ----------------------------------------------------------

/**
 * Add a destination. The config is encrypted at rest before insert.
 * Boots a worker if `enabled`. If `passphrase` is supplied, the
 * encryption salt + AES key are stored / cached for the new destination.
 */
export function addDestination(input) {
    const cfg = _validateInput(input);
    const shareSecret = _getShareSecret();
    if (!shareSecret) throw new Error('share secret not initialised — cannot encrypt credentials');
    const blob = encryptConfig(cfg.config, shareSecret);
    const now = Date.now();
    const r = getDb().prepare(`
        INSERT INTO backup_destinations (
            name, provider, config_blob, enabled, encryption, encryption_salt,
            mode, cron, retain_count, created_at,
            total_bytes, total_files
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run(
        cfg.name,
        cfg.provider,
        blob,
        cfg.enabled ? 1 : 0,
        cfg.encryption ? 1 : 0,
        cfg.encryption ? generateSalt() : null,
        cfg.mode,
        cfg.cron || null,
        Number(cfg.retainCount) > 0 ? Number(cfg.retainCount) : 7,
        now,
    );
    const id = Number(r.lastInsertRowid);

    if (cfg.encryption && cfg.passphrase) {
        const row = _loadDestRowOrThrow(id);
        _passphraseCache.set(id, deriveKey(cfg.passphrase, row.encryption_salt));
    }

    const dest = _loadDestRowOrThrow(id);
    _broadcast({ type: 'backup_destination_added', destination: _scrubDest(dest) });
    _log({ source: 'backup', level: 'info', msg: `destination added — ${cfg.provider}/${cfg.name} (#${id})` });

    if (cfg.enabled) {
        _ensureWorker(id);
        _scheduleSnapshot(dest);
    }
    return id;
}

/**
 * Partial update of a destination. The `config` field, if present,
 * is fully replaced (not merged) and re-encrypted. Boots / kills the
 * worker as the `enabled` flag flips.
 */
export function updateDestination(id, patch = {}) {
    const dest = _loadDestRowOrThrow(id);
    const next = { ...dest };
    if (patch.name != null) next.name = String(patch.name).slice(0, 200);
    if (patch.mode != null) {
        if (!['mirror', 'snapshot', 'manual'].includes(patch.mode)) {
            throw new Error(`invalid mode "${patch.mode}"`);
        }
        next.mode = patch.mode;
    }
    if (patch.cron !== undefined) next.cron = patch.cron || null;
    if (patch.retainCount != null) next.retain_count = Math.max(1, Math.min(365, Number(patch.retainCount) || 7));
    if (patch.enabled != null) next.enabled = patch.enabled ? 1 : 0;

    const updates = ['name = ?', 'mode = ?', 'cron = ?', 'retain_count = ?', 'enabled = ?'];
    const params = [next.name, next.mode, next.cron, next.retain_count, next.enabled];

    if (patch.config) {
        const shareSecret = _getShareSecret();
        if (!shareSecret) throw new Error('share secret not initialised');
        const blob = encryptConfig(patch.config, shareSecret);
        updates.push('config_blob = ?');
        params.push(blob);
    }

    params.push(Number(id));
    getDb().prepare(`UPDATE backup_destinations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Worker / snapshot lifecycle.
    _killWorker(id);
    _clearSnapshot(id);
    const updated = _loadDestRowOrThrow(id);
    if (updated.enabled) {
        _ensureWorker(id);
        _scheduleSnapshot(updated);
    }

    _broadcast({ type: 'backup_destination_updated', destination: _scrubDest(updated) });
    _log({ source: 'backup', level: 'info', msg: `destination updated — #${id}` });
    return _scrubDest(updated);
}

export function removeDestination(id) {
    _killWorker(id);
    _clearSnapshot(id);
    _passphraseCache.delete(Number(id));
    const r = getDb().prepare('DELETE FROM backup_destinations WHERE id = ?').run(Number(id));
    _broadcast({ type: 'backup_destination_removed', destinationId: Number(id) });
    _log({ source: 'backup', level: 'info', msg: `destination removed — #${id}` });
    return r.changes > 0;
}

/**
 * List destinations. `scrubbed` (default true) strips the
 * encrypted blob + every secret-shaped field so the response is safe to
 * ship to the dashboard.
 */
export function listDestinations({ scrubbed = true } = {}) {
    const rows = getDb().prepare(`
        SELECT * FROM backup_destinations ORDER BY id DESC
    `).all();
    return scrubbed ? rows.map(_scrubDest) : rows;
}

export function getDestinationStatus(id, now = Date.now()) {
    const dest = _loadDestRowOrThrow(id);
    const counts = queue.statusCounts(id, now);
    const worker = _workers.get(Number(id));
    return {
        id: dest.id,
        name: dest.name,
        provider: dest.provider,
        enabled: !!dest.enabled,
        mode: dest.mode,
        running: !!worker?.running,
        paused: !!worker?.paused,
        lastSuccessAt: dest.last_success_at || null,
        lastFailureAt: dest.last_failure_at || null,
        lastError: dest.last_error || null,
        totalBytes: Number(dest.total_bytes || 0),
        totalFiles: Number(dest.total_files || 0),
        encryption: !!dest.encryption,
        encryptionUnlocked: dest.encryption ? _passphraseCache.has(Number(id)) : true,
        ...counts,
    };
}

/**
 * Run a one-shot backup. For `manual` and `snapshot` modes this enqueues
 * a fresh archive job; for `mirror` mode it sweeps every download row
 * that doesn't have a job yet.
 */
export async function runBackup(id) {
    const dest = _loadDestRowOrThrow(id);
    if (!dest.enabled) throw new Error('destination is disabled');

    if (dest.mode === 'snapshot' || dest.mode === 'manual') {
        await _kickSnapshotRun(dest);
        return { started: true, mode: dest.mode };
    }
    // Mirror catch-up: enqueue every DB download whose backup hasn't
    // been done yet.
    let enqueued = 0;
    const rows = getDb().prepare(`
        SELECT id, file_name, file_path, file_size FROM downloads
         WHERE file_path IS NOT NULL
         ORDER BY id ASC
    `).all();
    for (const row of rows) {
        if (queue.hasJobForDownload(id, row.id)) continue;
        queue.enqueue({
            destinationId: id,
            downloadId: row.id,
            remotePath: _mirrorRemotePath(row),
        });
        enqueued += 1;
    }
    _wakeWorker(id);
    _log({ source: 'backup', level: 'info', msg: `mirror catch-up enqueued ${enqueued} jobs for #${id}` });
    return { started: true, mode: 'mirror', enqueued };
}

/** Pause / resume the worker. Existing pending jobs sit in the DB
 *  untouched and resume after `resume()`. */
export function pause(id) {
    const w = _workers.get(Number(id));
    if (w) w.paused = true;
    _broadcast({ type: 'backup_destination_updated', destination: _scrubDest(_loadDestRowOrThrow(id)) });
    return true;
}
export function resume(id) {
    const w = _workers.get(Number(id));
    if (w) { w.paused = false; w.tick(); }
    _broadcast({ type: 'backup_destination_updated', destination: _scrubDest(_loadDestRowOrThrow(id)) });
    return true;
}

/**
 * Probe a destination's connection. Builds a fresh Provider, calls
 * init() + testConnection(), and returns `{ok, detail}`.
 */
export async function testConnection(id) {
    const dest = _loadDestRowOrThrow(id);
    const ProviderClass = PROVIDER_CLASSES[dest.provider];
    if (!ProviderClass) return { ok: false, detail: `unknown provider "${dest.provider}"` };
    const cfg = _decryptCfgOrThrow(dest);
    const provider = new ProviderClass();
    const ctx = { destinationId: id, log: _log, signal: new AbortController().signal };
    try {
        await provider.init(cfg, ctx);
        const r = await provider.testConnection(ctx);
        await provider.close().catch(() => {});
        return r;
    } catch (e) {
        await provider.close().catch(() => {});
        return { ok: false, detail: e.message };
    }
}

/**
 * Toggle encryption on a destination. Requires the operator's passphrase
 * — we derive the AES key + cache it (in memory only, never persisted).
 */
export function setEncryption(id, { enabled, passphrase }) {
    const dest = _loadDestRowOrThrow(id);
    if (enabled && !passphrase) throw new Error('passphrase required to enable encryption');
    if (!enabled) {
        getDb().prepare(`
            UPDATE backup_destinations SET encryption = 0, encryption_salt = NULL WHERE id = ?
        `).run(Number(id));
        _passphraseCache.delete(Number(id));
        _log({ source: 'backup', level: 'info', msg: `encryption disabled for #${id}` });
    } else {
        const salt = dest.encryption && dest.encryption_salt
            ? dest.encryption_salt
            : generateSalt();
        getDb().prepare(`
            UPDATE backup_destinations SET encryption = 1, encryption_salt = ? WHERE id = ?
        `).run(salt, Number(id));
        _passphraseCache.set(Number(id), deriveKey(passphrase, salt));
        _log({ source: 'backup', level: 'info', msg: `encryption enabled for #${id}` });
    }
    const updated = _loadDestRowOrThrow(id);
    _broadcast({ type: 'backup_destination_updated', destination: _scrubDest(updated) });
    return _scrubDest(updated);
}

/** Provide a passphrase after a server restart. Caches the AES key. */
export function unlockEncryption(id, passphrase) {
    const dest = _loadDestRowOrThrow(id);
    if (!dest.encryption || !dest.encryption_salt) {
        throw new Error('encryption is not enabled for this destination');
    }
    const key = deriveKey(passphrase, dest.encryption_salt);
    _passphraseCache.set(Number(id), key);
    return true;
}

/** Manual retry of a failed job. */
export function retryJob(jobId) {
    const job = queue.getJob(jobId);
    if (!job) return false;
    queue.requeue(jobId);
    _wakeWorker(job.destination_id);
    return true;
}

// ---- Mirror hook ----------------------------------------------------------

function _onDownloadComplete(e) {
    if (e?.type !== 'download_complete' || !e.payload) return;
    // The downloader emits `download_complete` shaped as
    //   { filePath, fileName, size, groupId, message, mediaType, deduped }
    // — we need the `downloads.id` so the queue row can FK into it.
    const payload = e.payload;
    if (payload.deduped) return;   // nothing new on disk to ship
    const filePath = String(payload.filePath || '').replace(/\\/g, '/');
    if (!filePath) return;
    // Resolve the downloads row by file_path. The downloader's emitted
    // path can have a few prefixes (see server.js's normaliser); we
    // tolerate the same set here.
    let rel = filePath;
    while (rel.startsWith('./')) rel = rel.slice(2);
    while (rel.startsWith('data/downloads/')) rel = rel.slice('data/downloads/'.length);
    const row = getDb().prepare(
        'SELECT id, file_name, file_path, file_size FROM downloads WHERE file_path = ? OR file_path = ? ORDER BY id DESC LIMIT 1',
    ).get(rel, filePath);
    if (!row) return;

    for (const dest of listDestinations({ scrubbed: false })) {
        if (!dest.enabled) continue;
        if (dest.mode !== 'mirror') continue;
        if (queue.hasJobForDownload(dest.id, row.id)) continue;
        queue.enqueue({
            destinationId: dest.id,
            downloadId: row.id,
            remotePath: _mirrorRemotePath(row),
        });
        _wakeWorker(dest.id);
    }
}

function _mirrorRemotePath(row) {
    // Same shape as the downloads dir: `<group>/<type>/<file>`. Forward
    // slashes only — providers apply them to S3 keys / SFTP paths
    // verbatim.
    return String(row.file_path || '').replace(/\\/g, '/');
}

// ---- Workers --------------------------------------------------------------

class Worker {
    /**
     * @param {number} destinationId
     */
    constructor(destinationId) {
        this.destinationId = Number(destinationId);
        this.running = false;
        this.paused = false;
        this.activeAborters = new Set();
        this._tickScheduled = false;
        // Reset any in-flight rows from a previous boot.
        queue.recoverInflight(this.destinationId);
    }

    tick() {
        if (this._tickScheduled) return;
        this._tickScheduled = true;
        setImmediate(() => {
            this._tickScheduled = false;
            this._fillSlots().catch((e) => {
                _log({ source: 'backup', level: 'error', msg: `worker fill failed: ${e.message}` });
            });
        });
    }

    async _fillSlots() {
        if (this.paused) return;
        const dest = _loadDestRow(this.destinationId);
        if (!dest || !dest.enabled) return;
        const concurrency = DEFAULT_WORKERS_PER_DEST;
        while (this.activeAborters.size < concurrency && !this.paused) {
            const job = queue.claim(this.destinationId);
            if (!job) break;
            this.running = true;
            const aborter = new AbortController();
            this.activeAborters.add(aborter);
            this._runOne(job, aborter)
                .catch(() => {})
                .finally(() => {
                    this.activeAborters.delete(aborter);
                    if (this.activeAborters.size === 0) this.running = false;
                    // Try to pick up the next job — single-item-trickle
                    // is enough since the loop above pulls until empty
                    // each tick.
                    this.tick();
                });
        }
        // If we drained the queue, broadcast a "drained" signal so the
        // dashboard can collapse the active progress strip.
        if (this.activeAborters.size === 0) {
            _broadcast({ type: 'backup_queue_drained', destinationId: this.destinationId });
        }
    }

    async _runOne(job, aborter) {
        const dest = _loadDestRow(this.destinationId);
        if (!dest) return;
        const ctx = { destinationId: this.destinationId, log: _log, signal: aborter.signal };
        let provider;
        let cfg;
        try {
            cfg = _decryptCfgOrThrow(dest);
        } catch (e) {
            queue.markFailed(job.id, `credentials decrypt failed: ${e.message}`);
            _broadcast({
                type: 'backup_error',
                destinationId: this.destinationId,
                jobId: job.id,
                error: e.message,
                willRetry: false,
            });
            _log({ source: 'backup', level: 'error', msg: `decrypt failed for #${this.destinationId}: ${e.message}` });
            _markFailureOnDest(this.destinationId, e.message);
            return;
        }

        const ProviderClass = PROVIDER_CLASSES[dest.provider];
        if (!ProviderClass) {
            queue.markFailed(job.id, `unknown provider "${dest.provider}"`);
            return;
        }

        let encryptKey;
        if (dest.encryption) {
            encryptKey = _passphraseCache.get(this.destinationId);
            if (!encryptKey) {
                const msg = 'encryption passphrase missing — unlock this destination from the dashboard';
                queue.markRetry(job.id, msg);
                _broadcast({
                    type: 'backup_error',
                    destinationId: this.destinationId,
                    jobId: job.id,
                    error: msg,
                    willRetry: true,
                });
                return;
            }
        }

        let localPath;
        let remotePath = job.remote_path;
        let downloadRow = null;
        if (job.snapshot_path) {
            localPath = job.snapshot_path;
            remotePath = remotePath || `snapshots/${path.basename(localPath)}`;
        } else if (job.download_id != null) {
            downloadRow = getDb().prepare(
                'SELECT id, file_name, file_path, file_size FROM downloads WHERE id = ?',
            ).get(Number(job.download_id));
            if (!downloadRow || !downloadRow.file_path) {
                queue.markFailed(job.id, `download #${job.download_id} no longer exists`);
                return;
            }
            localPath = path.join(DOWNLOADS_DIR, downloadRow.file_path.replace(/\\/g, path.sep));
            remotePath = remotePath || _mirrorRemotePath(downloadRow);
        } else {
            queue.markFailed(job.id, 'job missing both snapshot_path and download_id');
            return;
        }

        provider = new ProviderClass();
        try {
            await provider.init(cfg, ctx);
            // Skip if the remote already has the same size — saves egress.
            try {
                const head = await provider.stat(remotePath, ctx);
                let localSize = 0;
                try { localSize = (await fsp.stat(localPath)).size; } catch {}
                // For encrypted uploads, the remote is BIGGER than the
                // local file (header + tag overhead). Skip only when not
                // encrypted and sizes match.
                if (head && !dest.encryption && head.size === localSize && localSize > 0) {
                    queue.markDone(job.id, { bytes: head.size, remotePath });
                    _bumpDestStats(this.destinationId, head.size, 1);
                    _broadcast({ type: 'backup_done', destinationId: this.destinationId, jobId: job.id,
                        downloadId: job.download_id, etag: head.etag, bytes: head.size, skipped: true });
                    return;
                }
            } catch { /* stat failures are not fatal — try the upload */ }

            let lastBroadcast = 0;
            const result = await provider.upload(localPath, remotePath, {
                encryptKey,
                throttleBps: dest.throttle_bps || 0,
                onProgress: ({ bytesUploaded }) => {
                    const now = Date.now();
                    if (now - lastBroadcast < 500) return;
                    lastBroadcast = now;
                    _broadcast({
                        type: 'backup_progress',
                        destinationId: this.destinationId,
                        jobId: job.id,
                        downloadId: job.download_id,
                        bytesUploaded,
                    });
                },
            }, ctx);
            queue.markDone(job.id, { bytes: result.bytes, remotePath: result.remotePath });
            _bumpDestStats(this.destinationId, result.bytes, 1, true);
            _broadcast({
                type: 'backup_done',
                destinationId: this.destinationId,
                jobId: job.id,
                downloadId: job.download_id,
                etag: result.etag,
                bytes: result.bytes,
            });
            _log({ source: 'backup', level: 'info', msg: `uploaded ${remotePath} (${result.bytes} B) → #${this.destinationId}` });
        } catch (e) {
            const msg = e?.message || String(e);
            const { willRetry, nextRetryAt } = queue.markRetry(job.id, msg);
            _broadcast({
                type: 'backup_error',
                destinationId: this.destinationId,
                jobId: job.id,
                error: msg,
                willRetry,
                nextRetryAt,
            });
            if (!willRetry) _markFailureOnDest(this.destinationId, msg);
            _log({ source: 'backup', level: willRetry ? 'warn' : 'error',
                msg: `upload failed for job #${job.id} on dest #${this.destinationId}: ${msg}` });
        } finally {
            await provider?.close().catch(() => {});
        }
    }

    cancelAll() {
        for (const a of this.activeAborters) {
            try { a.abort(); } catch {}
        }
        this.activeAborters.clear();
        this.running = false;
    }
}

function _ensureWorker(id) {
    const num = Number(id);
    if (_workers.has(num)) return _workers.get(num);
    const w = new Worker(num);
    _workers.set(num, w);
    w.tick();
    return w;
}

function _wakeWorker(id) {
    const w = _ensureWorker(id);
    w.tick();
}

function _killWorker(id) {
    const w = _workers.get(Number(id));
    if (!w) return;
    w.cancelAll();
    _workers.delete(Number(id));
}

// ---- Snapshot mode --------------------------------------------------------

function _scheduleSnapshot(dest) {
    if (dest.mode !== 'snapshot' || !dest.cron) return;
    _clearSnapshot(dest.id);
    // Tiny built-in cron — supports the common `m h dom mon dow` shape
    // with `*` and integer values. For full cron grammar we'd pull a
    // dependency, but the dashboard restricts the field to a small set
    // of presets in practice. We re-evaluate every 30 s, which is plenty
    // since the smallest cron unit is a minute.
    const handle = setInterval(() => {
        if (_snapshotInflight.has(dest.id)) return;
        if (_cronMatches(dest.cron, new Date())) {
            _kickSnapshotRun(_loadDestRow(dest.id)).catch((e) => {
                _log({ source: 'backup', level: 'error', msg: `snapshot run failed for #${dest.id}: ${e.message}` });
            });
        }
    }, 30 * 1000);
    handle.unref?.();
    _snapshotTimers.set(dest.id, handle);
}

function _clearSnapshot(id) {
    const h = _snapshotTimers.get(Number(id));
    if (h) { clearInterval(h); _snapshotTimers.delete(Number(id)); }
}

/** Tiny `m h dom mon dow` matcher. Supports `*` and exact integers. */
function _cronMatches(expr, date) {
    const parts = String(expr || '').trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const fields = [
        date.getMinutes(),
        date.getHours(),
        date.getDate(),
        date.getMonth() + 1,
        date.getDay(),
    ];
    for (let i = 0; i < 5; i++) {
        const p = parts[i];
        if (p === '*') continue;
        // `*/N` step
        const stepMatch = /^\*\/(\d+)$/.exec(p);
        if (stepMatch) {
            const step = Number(stepMatch[1]);
            if (step <= 0 || fields[i] % step !== 0) return false;
            continue;
        }
        // Comma list of integers
        const allowed = p.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
        if (!allowed.includes(fields[i])) return false;
    }
    return true;
}

async function _kickSnapshotRun(dest) {
    if (_snapshotInflight.has(dest.id)) return;
    _snapshotInflight.add(dest.id);
    try {
        await fsp.mkdir(SNAPSHOTS_DIR, { recursive: true });
        const stamp = _isoCompact(new Date());
        const archivePath = path.join(SNAPSHOTS_DIR, `snapshot-${stamp}.tar.gz`);
        await _buildSnapshotArchive(archivePath);
        // Enqueue the upload.
        const remotePath = `snapshots/${path.basename(archivePath)}`;
        queue.enqueue({
            destinationId: dest.id,
            snapshotPath: archivePath,
            remotePath,
        });
        _wakeWorker(dest.id);
        // Apply retention — keep the last N archives on the remote.
        // Done after a short delay so the just-uploaded file is included
        // in the listing.
        setTimeout(() => {
            _applyRetention(dest.id).catch((e) => {
                _log({ source: 'backup', level: 'warn', msg: `retention prune failed for #${dest.id}: ${e.message}` });
            });
        }, 60 * 1000);
        _log({ source: 'backup', level: 'info', msg: `snapshot built ${archivePath} → enqueued for #${dest.id}` });
    } finally {
        _snapshotInflight.delete(dest.id);
    }
}

/**
 * Build a tar.gz of the data dir (db.sqlite, config.json, sessions/).
 * Uses the better-sqlite3 backup() API to grab a consistent DB copy
 * so a snapshot during an active write doesn't corrupt the archive.
 *
 * Implementation note: we deliberately avoid an extra `tar` dependency
 * here. The format is a vanilla GNU-tar+gzip stream produced by piping
 * `child_process.spawn('tar', ...)` when the binary is available, and
 * a tiny in-process tar writer as a portable fallback. The fallback is
 * sufficient for the small set of files we archive (db.sqlite +
 * config.json + sessions/), so we don't drag in a node-tar dep just
 * for backup.
 */
async function _buildSnapshotArchive(archivePath) {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tgdl-snap-'));
    try {
        // 1. Consistent DB copy via the SQLite backup API.
        const db = getDb();
        const dbBackup = path.join(tmpRoot, 'db.sqlite');
        await db.backup(dbBackup);

        // 2. config.json
        const configSrc = path.join(DATA_DIR, 'config.json');
        const configDst = path.join(tmpRoot, 'config.json');
        try { await fsp.copyFile(configSrc, configDst); } catch { /* missing config — fine */ }

        // 3. sessions/ — copy recursively if present.
        const sessSrc = path.join(DATA_DIR, 'sessions');
        const sessDst = path.join(tmpRoot, 'sessions');
        try { await _copyRecursive(sessSrc, sessDst); } catch { /* missing — fine */ }

        // 4. Pack to .tar.gz.
        await _writeTarGz(tmpRoot, archivePath);
    } finally {
        await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
}

async function _copyRecursive(src, dst) {
    const st = await fsp.stat(src);
    if (st.isFile()) {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
        return;
    }
    if (st.isDirectory()) {
        await fsp.mkdir(dst, { recursive: true });
        const entries = await fsp.readdir(src, { withFileTypes: true });
        for (const e of entries) {
            await _copyRecursive(path.join(src, e.name), path.join(dst, e.name));
        }
    }
}

/**
 * Write a gzipped USTAR archive of `srcDir` to `archivePath`. No
 * external `tar` binary required — we emit headers + 512-byte-block
 * file bodies + a 1024-byte zero EOF marker, then gzip the whole
 * stream. Sufficient for restoring with `tar -xzf` on any platform.
 */
async function _writeTarGz(srcDir, archivePath) {
    const zlib = await import('zlib');
    const gz = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(archivePath);
    const piped = gz.pipe(out);
    const finished = new Promise((res, rej) => {
        piped.once('finish', res);
        piped.once('error', rej);
        gz.once('error', rej);
        out.once('error', rej);
    });

    // Walk srcDir and emit USTAR entries.
    async function* walk(dir, base) {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const abs = path.join(dir, e.name);
            const rel = path.posix.join(base, e.name);
            if (e.isDirectory()) {
                yield { type: 'dir', rel, abs };
                yield* walk(abs, rel);
            } else if (e.isFile()) {
                const st = await fsp.stat(abs);
                yield { type: 'file', rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
            }
        }
    }

    function tarHeader({ rel, size, mtime, typeflag }) {
        // USTAR format. Buffer.alloc zeroes the rest of the 512-byte block.
        const header = Buffer.alloc(512);
        header.write(rel.slice(0, 100), 0, 'utf8');
        header.write('0000644', 100, 'utf8');                  // mode
        header.write('0000000', 108, 'utf8');                  // uid
        header.write('0000000', 116, 'utf8');                  // gid
        header.write(size.toString(8).padStart(11, '0') + ' ', 124, 'utf8');
        header.write(Math.floor(mtime).toString(8).padStart(11, '0') + ' ', 136, 'utf8');
        header.write('        ', 148, 'utf8');                 // checksum placeholder
        header.write(typeflag, 156, 'utf8');
        header.write('ustar  ', 257, 'utf8');                  // magic + space-version (gnu-ish)
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += header[i];
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
        return header;
    }

    for await (const entry of walk(srcDir, '')) {
        if (entry.type === 'dir') {
            const h = tarHeader({ rel: entry.rel + '/', size: 0, mtime: Date.now() / 1000, typeflag: '5' });
            gz.write(h);
        } else {
            const h = tarHeader({ rel: entry.rel, size: entry.size, mtime: entry.mtime, typeflag: '0' });
            gz.write(h);
            await new Promise((res, rej) => {
                const rs = fs.createReadStream(entry.abs);
                rs.on('data', (chunk) => gz.write(chunk));
                rs.on('end', () => {
                    // Pad to 512-byte boundary.
                    const rem = entry.size % 512;
                    if (rem) gz.write(Buffer.alloc(512 - rem));
                    res();
                });
                rs.on('error', rej);
            });
        }
    }
    // End-of-archive: two 512-byte zero blocks.
    gz.write(Buffer.alloc(1024));
    gz.end();
    await finished;
}

async function _applyRetention(destinationId) {
    const dest = _loadDestRow(destinationId);
    if (!dest || !dest.enabled) return;
    if (dest.mode !== 'snapshot') return;
    const keep = Math.max(1, Number(dest.retain_count) || 7);
    let cfg;
    try { cfg = _decryptCfgOrThrow(dest); } catch { return; }
    const ProviderClass = PROVIDER_CLASSES[dest.provider];
    if (!ProviderClass) return;
    const provider = new ProviderClass();
    const ctx = { destinationId, log: _log, signal: new AbortController().signal };
    try {
        await provider.init(cfg, ctx);
        const items = [];
        for await (const item of provider.list('snapshots/', ctx)) {
            items.push(item);
        }
        items.sort((a, b) => b.mtime - a.mtime);
        const toDelete = items.slice(keep);
        for (const item of toDelete) {
            await provider.delete(item.name, ctx).catch(() => {});
            _log({ source: 'backup', level: 'info', msg: `retention pruned ${item.name} on #${destinationId}` });
        }
    } finally {
        await provider.close().catch(() => {});
    }
}

// ---- DB helpers -----------------------------------------------------------

function _loadDestRow(id) {
    return getDb().prepare('SELECT * FROM backup_destinations WHERE id = ?').get(Number(id));
}
function _loadDestRowOrThrow(id) {
    const r = _loadDestRow(id);
    if (!r) throw new Error(`destination #${id} not found`);
    return r;
}

function _decryptCfgOrThrow(dest) {
    const shareSecret = _getShareSecret();
    if (!shareSecret) throw new Error('share secret not initialised');
    return decryptConfig(dest.config_blob, shareSecret);
}

function _scrubDest(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        enabled: !!row.enabled,
        mode: row.mode,
        cron: row.cron || null,
        retainCount: row.retain_count || 7,
        encryption: !!row.encryption,
        encryptionUnlocked: row.encryption ? _passphraseCache.has(row.id) : true,
        lastSuccessAt: row.last_success_at || null,
        lastFailureAt: row.last_failure_at || null,
        lastError: row.last_error || null,
        totalBytes: Number(row.total_bytes || 0),
        totalFiles: Number(row.total_files || 0),
        createdAt: row.created_at,
    };
}

function _bumpDestStats(id, bytes, files) {
    getDb().prepare(`
        UPDATE backup_destinations
           SET total_bytes = total_bytes + ?,
               total_files = total_files + ?,
               last_success_at = ?,
               last_error = NULL
         WHERE id = ?
    `).run(Number(bytes) || 0, Number(files) || 1, Date.now(), Number(id));
}

function _markFailureOnDest(id, error) {
    getDb().prepare(`
        UPDATE backup_destinations
           SET last_failure_at = ?,
               last_error = ?
         WHERE id = ?
    `).run(Date.now(), String(error || '').slice(0, 4000), Number(id));
}

function _validateInput(input) {
    if (!input || typeof input !== 'object') throw new Error('input required');
    const name = String(input.name || '').trim().slice(0, 200);
    if (!name) throw new Error('name required');
    const provider = String(input.provider || '').trim();
    if (!PROVIDER_CLASSES[provider]) throw new Error(`unknown provider "${provider}"`);
    const mode = ['mirror', 'snapshot', 'manual'].includes(input.mode) ? input.mode : 'mirror';
    if (mode === 'snapshot' && !input.cron) {
        throw new Error('snapshot mode requires a cron expression');
    }
    return {
        name,
        provider,
        config: input.config || {},
        enabled: input.enabled !== false,
        encryption: !!input.encryption,
        passphrase: input.passphrase || null,
        mode,
        cron: input.cron || null,
        retainCount: input.retainCount || input.retain_count || 7,
    };
}

function _isoCompact(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---- Wakeup helper exposed to the queue ----------------------------------
//
// Used by tests + the manual /run path to nudge a worker after enqueueing
// a job from outside the manager.
export function _wake(destinationId) { _wakeWorker(destinationId); }
