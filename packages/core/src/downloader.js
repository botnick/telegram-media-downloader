/**
 * Download Manager - Multi-threaded downloads with deduplication
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Api } from 'telegram';
import { DebugLogger } from './logger.js';
import { getDb, insertDownload, isDownloaded as dbIsDownloaded } from './db.js';
import { sha256OfFile, sha256OfFileViaPool } from './checksum.js';
import { pregenerateThumb } from './thumbs.js';
import { pregenerateNsfw } from './nsfw.js';
import { pregenerateAi } from './ai/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Windows reserved device names — both bare and with any extension are
// rejected by the OS (`CON.jpg` is just as bad as `CON`). Match
// case-insensitively against the part BEFORE the first dot.
const _WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/**
 * Shared folder + filename sanitizer.
 *
 * - Strips path / control / NUL chars and collapses whitespace.
 * - Prefixes Windows reserved names with `_` so a chat literally named
 *   `CON` or a file like `PRN.jpg` doesn't ENOENT on Windows hosts.
 * - Truncates by **UTF-8 byte length** rather than UTF-16 char length
 *   (`.slice(80)` would silently corrupt multi-byte CJK / emoji at the
 *   boundary; we cut at a byte cap and back off to the last full
 *   codepoint).
 */
export function sanitizeName(name) {
    let s = String(name || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_');
    if (_WIN_RESERVED.test(s)) s = '_' + s;
    return _truncUtf8(s, 80);
}

function _truncUtf8(s, maxBytes) {
    const enc = new TextEncoder();
    const dec = new TextDecoder('utf-8', { fatal: false });
    const bytes = enc.encode(s);
    if (bytes.length <= maxBytes) return s;
    // Walk back from maxBytes until we land on a UTF-8 codepoint boundary
    // (the high bits of a continuation byte are 10xxxxxx → 0x80..0xBF).
    let cut = maxBytes;
    while (cut > 0 && (bytes[cut] & 0xC0) === 0x80) cut--;
    return dec.decode(bytes.subarray(0, cut));
}

/**
 * Migrate old unsanitized folder names into sanitized ones (one-time startup)
 */
export async function migrateFolders(downloadPath) {
    const basePath = downloadPath || DOWNLOADS_DIR;
    try {
        if (!existsSync(basePath)) return;
        const entries = await fs.readdir(basePath, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory());

        for (const dir of dirs) {
            const sanitized = sanitizeName(dir.name);
            if (sanitized === dir.name) continue; // Already clean

            const oldPath = path.join(basePath, dir.name);
            const newPath = path.join(basePath, sanitized);

            // Merge into sanitized folder
            await fs.mkdir(newPath, { recursive: true });
            const children = await fs.readdir(oldPath, { withFileTypes: true });

            for (const child of children) {
                const src = path.join(oldPath, child.name);
                const dst = path.join(newPath, child.name);

                if (child.isDirectory()) {
                    // Merge subdirectory
                    await fs.mkdir(dst, { recursive: true });
                    const subFiles = await fs.readdir(src);
                    for (const f of subFiles) {
                        const sf = path.join(src, f);
                        const df = path.join(dst, f);
                        if (!existsSync(df)) await fs.rename(sf, df);
                    }
                    // Remove old subdir if empty
                    const remaining = await fs.readdir(src);
                    if (remaining.length === 0) await fs.rmdir(src);
                } else {
                    // Merge file (append for .txt, skip-if-exists for others)
                    if (child.name.endsWith('.txt') && existsSync(dst)) {
                        const content = await fs.readFile(src, 'utf8');
                        await fs.appendFile(dst, content);
                        await fs.unlink(src);
                    } else if (!existsSync(dst)) {
                        await fs.rename(src, dst);
                    }
                }
            }

            // Remove old folder if empty
            try {
                const leftovers = await fs.readdir(oldPath);
                if (leftovers.length === 0) await fs.rmdir(oldPath);
            } catch (e) {}
        }
    } catch (e) {
        // Non-critical, silently skip
    }
}

// Inline defaults — kept here so every config.advanced?.downloader?.X read
// throughout this file shares the same fallback in case `advanced` is missing
// (e.g. an older config.json that pre-dates the Settings → Advanced panel).
const MIN_CONCURRENCY = 3;
const MAX_CONCURRENCY = 20;
const DEFAULT_SCALER_INTERVAL_MS = 5000;
const DEFAULT_IDLE_SLEEP_MS = 200;
const DEFAULT_SPILLOVER_THRESHOLD = 2000;

export class DownloadManager extends EventEmitter {
    constructor(client, config, rateLimiter) {
        super();
        this.client = client;
        this.config = config;
        this.rateLimiter = rateLimiter;
        // Two-lane queue. Realtime (priority 1) jobs land in `_high` and
        // are drained first by every worker; history backfill (priority 2)
        // lands in `queue`. Disk spillover only ever displaces history —
        // realtime always stays in RAM. External code reads `pendingCount`
        // (the sum) rather than `queue.length` directly.
        this._high = [];
        this.queue = [];
        this.active = new Map(); // Key -> Promise/Status
        // Absolute paths of files currently being written (.part + final
        // candidates). The disk-rotator consults this Set before unlinking
        // anything to avoid yanking a file out from under an active write.
        this._activeFilePaths = new Set();
        this.concurrency = config.download?.concurrent || 10;
        this.running = false;
        this.workers = [];
        this.workerCount = 0;
        this.LOG_DIR = LOGS_DIR;
        this._scalerInterval = null;
        this._consecutiveSuccess = 0; // Track success streak for scaling up
        // Per-key paused set + global flag for the IDM-style Queue page.
        // A paused key sits in either lane but is skipped by the worker
        // dequeue and re-queued at the back so live jobs keep flowing.
        // `_globalPaused` short-circuits every drain — workers loop without
        // touching the queues until `resumeAll()` clears it.
        this._paused = new Set();
        this._globalPaused = false;
        // Map<key, job> snapshot for queued/high jobs so the Queue page can
        // resolve filenames + sizes for entries that haven't started yet.
        // Kept in lock-step with enqueue/cancel to stay O(1).
        this._jobs = new Map();
        
        // Ensure directories
        fs.mkdir(DOWNLOADS_DIR, { recursive: true }).catch(() => {});
        fs.mkdir(LOGS_DIR, { recursive: true }).catch(() => {});
    }

    // Helper to constructing the exact InputLocation required by GramJS
    getInputLocation(message) {
        // 1. Check for Document
        let doc = message.document;
        if (!doc && message.media) {
            if (message.media.document) doc = message.media.document;
            else if (message.media.className === 'MessageMediaDocument') doc = message.media.document;
            else if (message.media.webpage && message.media.webpage.document) doc = message.media.webpage.document;
        }

        if (doc) {
            // Ensure fileReference is valid
            const fileRef = doc.fileReference || Buffer.alloc(0);
            return new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: fileRef,
                thumbSize: '' // Full size
            });
        }

        // 2. Check for Photo
        let photo = message.photo;
        if (!photo && message.media) {
            if (message.media.photo) photo = message.media.photo;
            else if (message.media.className === 'MessageMediaPhoto') photo = message.media.photo;
            else if (message.media.webpage && message.media.webpage.photo) photo = message.media.webpage.photo;
        }

        if (photo) {
             return new Api.InputPhotoFileLocation({
                id: photo.id,
                accessHash: photo.accessHash,
                fileReference: photo.fileReference || Buffer.alloc(0),
                thumbSize: 'y' // Largest usually
            });
        }

        return null;
    }

    async init() {
        this.emit('ready');
    }

    isDownloaded(groupId, messageId) {
        return dbIsDownloaded(groupId, messageId);
    }

    /**
     * Generate unique key using Telegram server-side IDs
     */
    generateKey(message) {
        const chatId = message.peerId?.channelId || 
                       message.peerId?.chatId || 
                       message.peerId?.userId ||
                       message.chatId || 'unknown';
        return { key: `${chatId}_${message.id}`, groupId: String(chatId) };
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.workerCount = this.concurrency;
        for (let i = 0; i < this.concurrency; i++) {
            this.workers.push(this.runWorker(i));
        }
        this.emit('started', { workers: this.concurrency });

        // Dynamic scaler — tunable via config.advanced.downloader.scalerIntervalSec.
        const scalerSec = Number(this.config?.advanced?.downloader?.scalerIntervalSec);
        const scalerMs = Number.isFinite(scalerSec) && scalerSec > 0
            ? Math.floor(scalerSec * 1000)
            : DEFAULT_SCALER_INTERVAL_MS;
        this._scalerInterval = setInterval(() => this._autoScale(), scalerMs);
    }

    get pendingCount() {
        return this._high.length + this.queue.length;
    }

    _autoScale() {
        if (!this.running) return;
        const queueLen = this.pendingCount;
        const activeLen = this.active.size;
        const minC = Number(this.config?.advanced?.downloader?.minConcurrency) || MIN_CONCURRENCY;
        const maxC = Number(this.config?.advanced?.downloader?.maxConcurrency) || MAX_CONCURRENCY;

        // Scale UP: queue is building up, add more workers
        if (queueLen > this.workerCount * 2 && this.workerCount < maxC) {
            const add = Math.min(3, maxC - this.workerCount);
            for (let i = 0; i < add; i++) {
                const id = this.workerCount + i;
                this.workers.push(this.runWorker(id));
            }
            this.workerCount += add;
            this.concurrency = this.workerCount;
            this.emit('scale', { direction: 'up', workers: this.workerCount, queue: queueLen });
        }

        // Scale DOWN: queue is empty and few active, reduce target
        if (queueLen === 0 && activeLen < minC && this.workerCount > minC) {
            this.workerCount = Math.max(minC, activeLen + 1);
            this.concurrency = this.workerCount;
        }
    }

    /**
     * Called by FloodWait handler to throttle concurrency
     */
    throttle() {
        const minC = Number(this.config?.advanced?.downloader?.minConcurrency) || MIN_CONCURRENCY;
        this.workerCount = minC;
        this.concurrency = minC;
        this._consecutiveSuccess = 0;
        this.emit('scale', { direction: 'down', workers: minC, reason: 'flood' });
    }

    async stop() {
        this.running = false;
        if (this._scalerInterval) clearInterval(this._scalerInterval);
        
        // Flush pending disk usage save
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            await this.saveDiskUsageCache();
        }
    }
    
    async enqueue(job, priority = 1) {
        const key = `${job.groupId}_${job.message.id}`;
        job.key = key;
        // Stamp first-seen time for Queue-page sort-by-Added-time. Don't
        // overwrite if a re-enqueue (e.g. retry path) already set it.
        if (!job.addedAt) job.addedAt = Date.now();
        // Cache a thin file-size hint so the snapshot can render size +
        // progress before the worker actually starts the job.
        if (job.fileSize == null) {
            try { job.fileSize = this.getFileSize(job.message); } catch {}
        }

        // Dedup check (Memory + Active)
        if (this.active.has(key)) return false;

        // Check DB
        if (this.isDownloaded(job.groupId, job.message.id)) return false;

        // --- DYNAMIC DEFENSE: DISK SPILLOVER ---
        // Only history (priority 2) ever spills; realtime stays in RAM so
        // a long backfill can't push live messages off the front of the queue.
        const spillover = Number(this.config?.advanced?.downloader?.spilloverThreshold)
            || DEFAULT_SPILLOVER_THRESHOLD;
        if (priority === 2 && this.queue.length > spillover) {
            await this.spillToDisk(job);
            return true;
        }

        if (priority === 2) this.queue.push(job);             // history: FIFO normal lane
        else if (priority === 0) this._high.unshift(job);     // TTL/preempt: front of high lane
        else this._high.push(job);                            // realtime: FIFO high lane

        // Track for snapshot()/cancel(). Kept tiny on purpose — only the
        // fields the Queue page actually renders.
        this._jobs.set(key, job);

        this.emit('queue', this.pendingCount);
        this.emit('queue_changed', { key, op: 'enqueue' });
        return true;
    }

    /**
     * Queue-page surface: pause/resume/cancel/retry by key, plus globals.
     * All operations are O(queue length) at worst (single Array.filter for
     * cancel) which is fine for the < 1k queues the UI is designed for.
     */
    pauseJob(key) {
        if (!key) return false;
        this._paused.add(key);
        this.emit('queue_changed', { key, op: 'pause' });
        return true;
    }

    resumeJob(key) {
        if (!key) return false;
        const had = this._paused.delete(key);
        if (had) this.emit('queue_changed', { key, op: 'resume' });
        return had;
    }

    isPaused(key) {
        return this._globalPaused || this._paused.has(key);
    }

    /**
     * Remove a queued job — works on queued OR active jobs.
     *
     * gramJS doesn't expose an abort signal on `downloadMedia`, but the
     * progressCallback fires every chunk; throwing from inside it makes
     * the downloader reject with a "Cancelled" error, which our catch
     * block handles by deleting the .part file (no zombie). For queued
     * jobs we just splice them out of the lane.
     */
    cancelJob(key) {
        if (!key) return false;

        // Queued path: drop from lane.
        const before = this._high.length + this.queue.length;
        this._high = this._high.filter(j => j.key !== key);
        this.queue = this.queue.filter(j => j.key !== key);
        const dequeued = (this._high.length + this.queue.length) < before;

        // Active path: flag the key so the next progressCallback throws.
        const wasActive = this.active.has(key);
        if (wasActive) {
            if (!this._cancelling) this._cancelling = new Set();
            this._cancelling.add(key);
        }

        this._jobs.delete(key);
        this._paused.delete(key);

        if (dequeued || wasActive) {
            this.emit('queue', this.pendingCount);
            this.emit('queue_changed', { key, op: 'cancel' });
            return true;
        }
        return false;
    }

    /** True if `cancelJob(key)` flagged this in-flight download. */
    isCancelling(key) {
        return !!(this._cancelling && this._cancelling.has(key));
    }

    pauseAll() {
        this._globalPaused = true;
        this.emit('queue_changed', { op: 'pause-all' });
    }

    resumeAll() {
        this._globalPaused = false;
        this._paused.clear();
        this.emit('queue_changed', { op: 'resume-all' });
    }

    cancelAllQueued() {
        const removed = this._high.length + this.queue.length;
        for (const j of this._high) this._jobs.delete(j.key);
        for (const j of this.queue) this._jobs.delete(j.key);
        this._high = [];
        this.queue = [];
        this.emit('queue', this.pendingCount);
        this.emit('queue_changed', { op: 'cancel-all' });
        return removed;
    }

    /**
     * Re-enqueue a previously-failed job at the FRONT of the high lane so
     * a manual retry from the Queue page jumps the line. Caller passes the
     * raw job (the same shape originally handed to `enqueue`).
     */
    retryJob(job) {
        if (!job || !job.message) return false;
        const key = job.key || `${job.groupId}_${job.message.id}`;
        job.key = key;
        if (!job.addedAt) job.addedAt = Date.now();
        this._paused.delete(key);
        this._high.unshift(job);
        this._jobs.set(key, job);
        this.emit('queue', this.pendingCount);
        this.emit('queue_changed', { key, op: 'retry' });
        return true;
    }

    /**
     * Single-shot snapshot of the entire downloader state, used by the
     * Queue-page boot path (`GET /api/queue/snapshot`). Returns plain
     * JSON-serialisable data; the heavy `message` object stays inside
     * `_jobs` and is never emitted.
     */
    snapshot() {
        const mapJob = (job, status) => ({
            key: job.key,
            groupId: String(job.groupId || ''),
            groupName: job.groupName || null,
            mediaType: job.mediaType || null,
            messageId: job.message?.id ?? null,
            fileName: job.fileName || null,
            fileSize: job.fileSize || (job.message ? this.getFileSize(job.message) : 0) || 0,
            progress: 0,
            received: 0,
            total: 0,
            bps: 0,
            eta: null,
            status: this._paused.has(job.key) ? 'paused' : status,
            addedAt: job.addedAt || null,
        });
        const active = [];
        for (const [, st] of this.active) {
            const total = st.total || st.fileSize || 0;
            const received = st.received || 0;
            const bps = st.bps || 0;
            const eta = (bps > 0 && total > received) ? Math.round((total - received) / bps) : null;
            active.push({
                key: st.key,
                groupId: String(st.groupId || ''),
                groupName: st.groupName || null,
                mediaType: st.mediaType || null,
                messageId: st.message?.id ?? null,
                fileName: st.fileName || null,
                fileSize: total,
                progress: st.progress || 0,
                received,
                total,
                bps,
                eta,
                status: this._paused.has(st.key) ? 'paused' : 'active',
                addedAt: st.addedAt || st.startedAt || null,
            });
        }
        const queued = [];
        for (const j of this._high) queued.push(mapJob(j, 'queued'));
        for (const j of this.queue) queued.push(mapJob(j, 'queued'));
        return {
            active,
            queued,
            globalPaused: this._globalPaused,
            pausedCount: this._paused.size,
            workers: this.workerCount,
            pending: this.pendingCount,
        };
    }

    // --- SPILLOVER LOGIC ---
    async spillToDisk(job) {
        if (!this.BACKLOG_PATH) {
             this.BACKLOG_PATH = path.join(this.LOG_DIR, 'queue_backlog.jsonl');
        }
        try {
            const line = JSON.stringify(job) + '\n';
            await fs.appendFile(this.BACKLOG_PATH, line);
        } catch (e) {
            this.queue.push(job);
        }
    }

    async rehydrateFromDisk() {
        if (!this.BACKLOG_PATH || !existsSync(this.BACKLOG_PATH)) return false;

        try {
            const content = await fs.readFile(this.BACKLOG_PATH, 'utf8');
            if (!content.trim()) return false;

            const lines = content.split('\n').filter(l => l.trim());
            const chunk = lines.splice(0, 1000); // Take 1000
            
            for (const line of chunk) {
                try {
                    this.queue.push(JSON.parse(line));
                } catch(e) {}
            }

            if (lines.length > 0) {
                await fs.writeFile(this.BACKLOG_PATH, lines.join('\n') + '\n');
            } else {
                await fs.unlink(this.BACKLOG_PATH);
            }
            return true;

        } catch (e) {
            return false;
        }
    }

    async runWorker(id) {
        while (this.running) {
            // 0. Globally paused? Spin without touching the lanes so resume
            //    is instantaneous.
            if (this._globalPaused) {
                await this.sleep(250);
                continue;
            }

            // 1. Drain high-priority (realtime) lane first, then history.
            let job = this._high.shift() || this.queue.shift();

            // 2. If RAM empty, check Disk Backlog
            if (!job) {
                const hasMore = await this.rehydrateFromDisk();
                if (hasMore) {
                    job = this._high.shift() || this.queue.shift();
                }
            }

            // 3. Still empty? Sleep.
            if (!job) {
                const idle = Number(this.config?.advanced?.downloader?.idleSleepMs)
                    || DEFAULT_IDLE_SLEEP_MS;
                await this.sleep(idle);
                continue;
            }

            // 4. Per-job pause: shove it to the back of the matching lane
            //    so other queued work keeps draining. Snapshot still shows
            //    it as 'paused' (see snapshot()).
            if (this._paused.has(job.key)) {
                this.queue.push(job);
                await this.sleep(150);
                continue;
            }

            this.active.set(job.key, { ...job, workerId: id, progress: 0, startedAt: Date.now() });
            this._jobs.delete(job.key);
            this.emit('start', job);

            try {
                // Final Check DB before start (minimize race)
                if (this.isDownloaded(job.groupId, job.message.id)) {
                     this.active.delete(job.key);
                     continue;
                }

                const filePath = await this.download(job);
                this.emit('complete', { ...job, filePath });
            } catch (error) {
                await this.reportFailure(job, error.message);
                this.emit('error', { job, error: error.message });
            }

            this.active.delete(job.key);
        }
    }

    async reportFailure(job, reason) {
        DebugLogger.error(new Error(reason), `Download Failed: ${job.key}`);
        // ALSO print to stdout so the user can see it in `docker logs`
        // without SSHing into the container to tail data/logs/errors.log.
        // Use process.stderr.write directly so the global console.error
        // wrap (which demotes gramJS reconnect chatter to network.log)
        // doesn't swallow real download failures.
        try {
            const safeName = String(job?.groupName || job?.groupId || '?');
            const mid = job?.message?.id ?? '?';
            process.stderr.write(`[downloader] FAILED ${safeName} #${mid}: ${reason}\n`);
        } catch {}
    }

    async download(job, attempt = 1) {
        const maxRetries = this.config.download?.retries || 5;

        try {
            // 1. Check Disk Quota
            if (this.config.diskManagement?.maxTotalSize) {
               const usage = await this.getDiskUsage();
               const limit = this.parseSize(this.config.diskManagement.maxTotalSize);
               if (usage > limit) {
                   throw new Error(`Disk Quota Exceeded: ${usage} / ${limit} bytes`);
               }
            }

            // 2. Prepare File Info & Check Limits
            const fileSize = this.getFileSize(job.message);
            const fileType = this.getFileTypeCategory(job.message);

            if (fileSize > 0 && fileType) {
                const typeName = fileType.charAt(0).toUpperCase() + fileType.slice(1); // 'Video', 'Image'
                const limitStr = this.config.diskManagement?.[`max${typeName}Size`];
                if (limitStr) {
                    const maxBytes = this.parseSize(limitStr);
                    if (fileSize > maxBytes) {
                        throw new Error(`File too large (${this.formatBytes(fileSize)} > ${limitStr})`);
                    }
                }
            }

            // 3. Rate Limit
            if (this.rateLimiter && attempt === 1) await this.rateLimiter.acquire();

            // 4. Build Paths
            const finalPath = await this.buildPath(job);
            const partPath = `${finalPath}.part`;
            // Tell the disk-rotator: hands off these paths until we're done.
            // Both candidates go into the Set — the .part is the in-flight
            // write; finalPath is the rename target. The collision-suffix
            // path can't be predicted here but the .part is enough to guard
            // the dangerous moment.
            this._activeFilePaths.add(partPath);
            this._activeFilePaths.add(finalPath);

            // 5. Execute Download
            try {
                let prevBytes = 0n;
                let prevTs = Date.now();
                await this.client.downloadMedia(job.message, {
                    outputFile: partPath,
                    progressCallback: (downloaded, total) => {
                        // Mid-flight cancel hook — Queue page → cancelJob()
                        // adds the key to `_cancelling`, throwing here makes
                        // gramJS reject the downloadMedia promise with our
                        // Cancelled error which the outer catch cleans up.
                        if (this.isCancelling(job.key)) {
                            const err = new Error('Cancelled');
                            err.cancelled = true;
                            throw err;
                        }
                        const downloadedN = BigInt(downloaded || 0);
                        const totalN = total ? BigInt(total) : 0n;
                        const pct = totalN ? Number((downloadedN * 100n) / totalN) : 0;
                        const now = Date.now();
                        const dtMs = Math.max(now - prevTs, 1);
                        const dB = Number(downloadedN - prevBytes);
                        const bps = dtMs > 50 ? Math.max(0, Math.round(dB * 1000 / dtMs)) : null;
                        if (dtMs > 200) { prevTs = now; prevBytes = downloadedN; }

                        const active = this.active.get(job.key);
                        if (active) {
                            active.progress = pct;
                            active.received = Number(downloadedN);
                            active.total = Number(totalN);
                            if (bps !== null) active.bps = bps;
                        }
                        this.emit('progress', {
                            key: job.key,
                            groupId: job.groupId,
                            groupName: job.groupName,
                            mediaType: job.mediaType,
                            messageId: job.message?.id,
                            received: Number(downloadedN),
                            total: Number(totalN),
                            progress: pct,
                            bps,
                        });
                    },
                });
                // Belt-and-braces: gramJS may finish a tiny clip before any
                // progress tick fires, so check once more here. If cancel
                // was requested between dequeue and now, drop the .part.
                if (this.isCancelling(job.key)) {
                    this._cancelling.delete(job.key);
                    try { if (existsSync(partPath)) await fs.unlink(partPath); } catch {}
                    const err = new Error('Cancelled');
                    err.cancelled = true;
                    throw err;
                }

                // 7. Success — atomic rename + post-condition verify.
                //
                // The .part file is on the same fs as finalPath (same dir),
                // so `fs.rename` is atomic on POSIX. Re-stat the FINAL path
                // after the rename to defend against the rare case where the
                // rename returns success but the inode is gone (NFS, fuse,
                // overlay-on-overlay quirks). If the final file is missing
                // or zero bytes, treat the whole download as failed so the
                // retry path runs instead of registering a dead DB row.
                const partStats = await fs.stat(partPath);
                if (!partStats.size) {
                    try { await fs.unlink(partPath); } catch {}
                    throw new Error('Downloaded file is empty (0 bytes)');
                }
                // Collision guard: `fs.rename` silently overwrites an
                // existing destination on every major platform, so two
                // accounts that produced the same final filename for
                // different content (rare but possible — same msg via
                // a forwarded copy etc.) would silently clobber. If the
                // target exists, suffix `(1)`, `(2)` … until we land on
                // a free name before the rename.
                let writtenPath = finalPath;
                if (existsSync(writtenPath)) {
                    const ext = path.extname(writtenPath);
                    const stem = writtenPath.slice(0, writtenPath.length - ext.length);
                    let i = 1;
                    while (i < 1000 && existsSync(`${stem} (${i})${ext}`)) i++;
                    writtenPath = `${stem} (${i})${ext}`;
                }
                await fs.rename(partPath, writtenPath);
                let finalStats;
                try { finalStats = await fs.stat(writtenPath); }
                catch (e) { throw new Error(`Post-rename verify failed: ${e.message}`); }
                if (!finalStats.size) {
                    try { await fs.unlink(writtenPath); } catch {}
                    throw new Error('Final file is 0 bytes after rename');
                }
                return await this.registerDownload(job, writtenPath, finalStats.size);

            } catch (error) {
                try {
                    if (existsSync(partPath)) await fs.unlink(partPath);
                } catch (cleanupErr) { }
                throw error;
            } finally {
                // Hand control of the paths back to the rotator regardless
                // of how this attempt ended (success, failure, retry,
                // cancel). A leaked entry here would silently freeze that
                // path against future deletion forever.
                this._activeFilePaths.delete(partPath);
                this._activeFilePaths.delete(finalPath);
            }

        } catch (error) {
            // User-initiated cancel — don't retry, don't report as failure.
            // The .part is already gone (cleanup in inner catch). Emit a
            // cancelled event so the Queue page can flip the row state.
            if (error?.cancelled) {
                if (this._cancelling) this._cancelling.delete(job.key);
                this.emit('cancelled', { key: job.key, groupId: job.groupId });
                this.emit('queue_changed', { key: job.key, op: 'cancel' });
                return; // swallow — runWorker treats absence of throw as "done"
            }

            if (error.errorMessage === 'FLOOD_WAIT' || error.message?.includes('FLOOD_WAIT')) {
                const seconds = error.seconds || 60;
                this.throttle(); // Dynamic: reduce concurrency on flood
                if (this.rateLimiter) await this.rateLimiter.pauseForFloodWait(seconds);
                else await this.sleep(seconds * 1000);
                // Bug fixed in v2.3.6: previously `return this.download(job, attempt)`
                // (no bump) — a sustained throttle would tight-loop forever
                // because `attempt` never crossed `maxRetries`. Track FloodWait
                // attempts on a SEPARATE counter so a transient flood doesn't
                // burn the normal retry budget, but a persistent one still
                // gives up cleanly.
                const floods = (job._floodAttempts = (job._floodAttempts || 0) + 1);
                const MAX_FLOOD_RETRIES = 8;
                if (floods <= MAX_FLOOD_RETRIES) {
                    return this.download(job, attempt);
                }
                throw new Error(`FloodWait retry cap (${MAX_FLOOD_RETRIES}) exceeded for ${job.fileName || job.key}`);
            }

            if (error.message?.includes('FILE_REFERENCE_EXPIRED') || error.errorMessage === 'FILE_REFERENCE_EXPIRED') {
                if (attempt < maxRetries) {
                    try {
                        const messages = await this.client.getMessages(job.message.peerId, { ids: [job.message.id] });
                        if (messages && messages.length > 0) {
                            job.message = messages[0];
                            return this.download(job, attempt + 1);
                        }
                    } catch (e) { }
                }
            }

            if (attempt < maxRetries) {
                const delay = 1000 * attempt;
                this.emit('retry', { job, attempt, delay, error: error.message });
                await this.sleep(delay);
                return this.download(job, attempt + 1);
            }

            throw error;
        }
    }

    async registerDownload(job, filePath, size) {
        const groupId = job.groupId || 'unknown';
        const msgId = job.message.id;

        // ---- Download-time dedup (SHA-256) -------------------------------
        //
        // Hash the just-written file and check whether the same content is
        // already on disk under a previous DB row. If it is, drop the new
        // copy and point this row at the existing file. Net effect: no
        // duplicate bytes on disk, but the (group, message) → file mapping
        // is still recorded so the gallery shows the file in this group too.
        //
        // Failures here are non-fatal: any error (read failure, permission)
        // falls through and stores the row with the file in place. The
        // /api/maintenance/dedup catch-up scan will pick it up later.
        let fileHash = null;
        let storedPath = filePath;
        let storedSize = size;
        let bytesAddedToDisk = size;
        try {
            // Hash on a worker thread so the main event loop stays free
            // during multi-GB post-write hashing. Falls back automatically
            // to the in-process streamer if the pool is disabled.
            try {
                fileHash = await sha256OfFileViaPool(filePath);
            } catch {
                fileHash = await sha256OfFile(filePath);
            }
            // Match on hash AND size — size match guards against the
            // (vanishingly improbable) SHA-256 collision and rejects rows
            // with a NULL/zero size from older downloader versions.
            const dup = getDb().prepare(`
                SELECT id, file_path, file_size FROM downloads
                 WHERE file_hash = ? AND file_size = ?
                 ORDER BY id ASC
                 LIMIT 1
            `).get(fileHash, size);
            if (dup && dup.file_path) {
                // Confirm the existing pointer still resolves before we
                // unlink the freshly downloaded copy — otherwise we'd end
                // up with TWO DB rows pointing at a missing file.
                const dupAbs = path.isAbsolute(dup.file_path)
                    ? dup.file_path
                    : path.resolve(DOWNLOADS_DIR, dup.file_path);
                if (existsSync(dupAbs)) {
                    try { await fs.unlink(filePath); } catch { /* leave stale; integrity sweep handles it */ }
                    storedPath = dupAbs;        // share the existing on-disk file
                    bytesAddedToDisk = 0;       // no new bytes written
                    storedSize = dup.file_size; // exactly equal to `size` here
                }
            }
        } catch (e) {
            // Hash failed (very rare — file disappeared between rename and
            // open). Fall through and store the row with the new file path.
            console.warn('[downloader] dedup hash failed:', e?.message || e);
        }

        // DB Insert
        try {
            // Determine type based on extension or message. HEIC / HEIF
            // count as photo so the gallery renders them via <img> + the
            // /files/<path>?inline=1 transcode path (sharp libvips handles
            // the format on the server) — otherwise iPhone uploads land
            // in the "documents" bucket and never preview.
            let type = 'document';
            const ext = path.extname(storedPath).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif'].includes(ext)) type = 'photo';
            else if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) type = 'video';
            else if (['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac'].includes(ext)) type = 'audio';

            const insertResult = insertDownload({
                groupId: String(groupId),
                groupName: job.groupName || null,
                messageId: msgId,
                fileName: path.basename(storedPath),
                fileSize: storedSize,
                fileType: type,
                filePath: path.relative(DOWNLOADS_DIR, storedPath),
                ttlSeconds: job.ttlSeconds || null,
                fileHash,
                // Rescue Mode: when the monitor stamps `pendingUntil` on the
                // job, the row gets inserted with that expiry so the rescue
                // sweeper can prune it later (unless a delete event rescues
                // it first).
                pendingUntil: job.pendingUntil || null,
            });
            // Pre-generate the default-width thumbnail in the background so
            // the FIRST gallery scroll already finds the WebP in cache. The
            // generator queues behind the per-kind concurrency caps so this
            // never starves on-demand requests; failures (no cover art,
            // unreadable container) are silent and the on-demand path will
            // try again later.
            const newId = insertResult?.lastInsertRowid;
            if (newId) {
                // Background, fire-and-forget. Both are no-ops when their
                // respective features are disabled; thumbs is always-on,
                // NSFW is opt-in via config.advanced.nsfw.enabled.
                try { pregenerateThumb(newId); } catch {}
                try { pregenerateNsfw(newId); } catch {}
                try { pregenerateAi(newId); } catch {}
            }
        } catch(e) {
            console.error('DB Insert Error', e);
        }

        // Only count the new bytes against the disk budget — a deduped
        // download added zero bytes, so the rotator quota stays accurate.
        if (bytesAddedToDisk > 0) this.incrementDiskUsage(bytesAddedToDisk);

        const wasDeduped = bytesAddedToDisk === 0;
        // Stash the flag on the job so the queue loop's `complete` event
        // payload (`{ ...job, filePath }`) carries `deduped` through to
        // runtime.js → broadcast → queue.js, which surfaces a "Duplicate"
        // tag on the row.
        try { job.deduped = wasDeduped; } catch { /* job object frozen — old path */ }

        this.emit('download_complete', {
            filePath: storedPath,
            fileName: path.basename(storedPath),
            size: storedSize,
            groupId,
            groupName: job.groupName,
            message: job.message,
            mediaType: job.mediaType,
            // Surfaces the dedup result for monitor logs / future UI.
            deduped: wasDeduped,
        });

        return storedPath;
    }

    getFileSize(message) {
        if (message.document) return Number(message.document.size);
        if (message.photo) {
            const sizes = message.photo.sizes;
            if (sizes && sizes.length > 0) {
                const last = sizes[sizes.length - 1];
                return last.size || 0;
            }
        }
        return 0;
    }

    getFileTypeCategory(message) {
        if (message.photo) return 'image';
        if (message.video) return 'video';
        if (message.voice || message.audio) return 'audio';
        if (message.document) return 'document';
        return null;
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const dm = 2;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    async getDiskUsage() {
         if (this._diskUsageCache) return this._diskUsageCache.size;

         const cachePath = path.join(this.LOG_DIR, '../disk_usage.json');
         try {
             if (existsSync(cachePath)) {
                 const data = JSON.parse(await fs.readFile(cachePath, 'utf8'));
                 this._diskUsageCache = { size: data.size, timestamp: Date.now() };
                 return data.size;
             }
         } catch (e) {}

         const total = await this.scanDiskDeep();
         this._diskUsageCache = { size: total, timestamp: Date.now() };
         this.saveDiskUsageCache();
         return total;
    }

    async scanDiskDeep() {
         let total = 0;
         const basePath = this.config.download?.path || './data/downloads';
         const calculateSize = async (dir) => {
             try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await calculateSize(fullPath);
                    } else {
                        const stats = await fs.stat(fullPath);
                        total += stats.size;
                    }
                }
             } catch (e) {}
         };
         await calculateSize(basePath);
         return total;
    }

    async saveDiskUsageCache() {
        if (!this._diskUsageCache) return;
        const cachePath = path.join(this.LOG_DIR, '../disk_usage.json');
        try {
            await fs.writeFile(cachePath, JSON.stringify({
                size: this._diskUsageCache.size,
                lastScan: Date.now()
            }));
        } catch (e) {}
    }

    incrementDiskUsage(bytes) {
        if (!this._diskUsageCache) this._diskUsageCache = { size: 0, timestamp: Date.now() };
        this._diskUsageCache.size += bytes;
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => this.saveDiskUsageCache(), 10000);
    }

    parseSize(str) {
        const units = { 'B': 1, 'KB': 1024, 'MB': 1024**2, 'GB': 1024**3, 'TB': 1024**4 };
        const match = String(str).match(/^(\d+(\.\d+)?)\s*([A-Za-z]+)$/);
        if (!match) return Infinity;
        const val = parseFloat(match[1]);
        const unit = match[3].toUpperCase();
        return val * (units[unit] || 1);
    }

    async buildPath(job) {
        const basePath = this.config.download?.path || './data/downloads';
        const groupDir = this.sanitize(job.groupName || 'Unknown');
        
        let typeFolder = 'others';
        const type = job.mediaType || this.getFileTypeCategory(job.message);

        if (type === 'photos' || type === 'image') typeFolder = 'images';
        else if (type === 'videos' || type === 'video') typeFolder = 'videos';
        else if (type === 'audio' || type === 'voice') typeFolder = 'audio';
        else if (type === 'gifs') typeFolder = 'gifs';
        else if (type === 'stickers') typeFolder = 'stickers';
        else typeFolder = 'documents';
        
        const fullDir = path.join(basePath, groupDir, typeFolder);
        await fs.mkdir(fullDir, { recursive: true });

        const filename = this.generateFilename(job);
        return path.join(fullDir, filename);
    }

    generateFilename(job) {
        const msg = job.message;
        const ext = this.getExtension(msg);
        // Defensive: msg.date can be missing/NaN on stories or self-destruct
        // events — `new Date(NaN).toISOString()` throws "Invalid time value"
        // and used to bubble up as a Download Failed for the whole job.
        // Fall back to wall-clock so the file lands somewhere sensible.
        const epochSec = Number.isFinite(msg?.date) ? msg.date : Math.floor(Date.now() / 1000);
        const d = new Date(epochSec * 1000);
        const timestamp = (Number.isNaN(d.getTime()) ? new Date() : d)
            .toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `${timestamp}_${msg?.id ?? 'noid'}${ext}`;
    }

    getExtension(message) {
        if (message.photo) return '.jpg';
        if (message.video) return '.mp4';
        if (message.voice) return '.ogg';
        if (message.audio) return '.mp3';
        if (message.videoNote) return '.mp4';
        if (message.sticker) return '.webp';
        
        if (message.document) {
            const attrs = message.document.attributes || [];
            for (const attr of attrs) {
                if (attr.fileName) {
                    const ext = path.extname(attr.fileName);
                    if (ext) return ext;
                }
            }
            return '.bin';
        }
        return '.bin';
    }

    sanitize(name) {
        return sanitizeName(name);
    }

    getStatus() {
        return {
            queued: this.pendingCount,
            active: this.active.size,
            completed: 0, // Could track via counter if needed
            downloads: Array.from(this.active.values())
        };
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
