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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

/**
 * Shared folder name sanitizer — use everywhere to prevent duplicate folders
 */
export function sanitizeName(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 80);
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
     * Remove a queued job. Active jobs can't be cancelled mid-flight here
     * (gramJS exposes no abort signal on downloadMedia), but we drop them
     * from `_jobs` so the snapshot stops listing them and the partial file
     * is wiped on the next worker cycle.
     */
    cancelJob(key) {
        if (!key) return false;
        const before = this._high.length + this.queue.length;
        this._high = this._high.filter(j => j.key !== key);
        this.queue = this.queue.filter(j => j.key !== key);
        this._jobs.delete(key);
        this._paused.delete(key);
        const removed = (this._high.length + this.queue.length) < before;
        if (removed) {
            this.emit('queue', this.pendingCount);
            this.emit('queue_changed', { key, op: 'cancel' });
        }
        return removed;
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

            // 5. Execute Download
            try {
                let prevBytes = 0n;
                let prevTs = Date.now();
                await this.client.downloadMedia(job.message, {
                    outputFile: partPath,
                    progressCallback: (downloaded, total) => {
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
                await fs.rename(partPath, finalPath);
                let finalStats;
                try { finalStats = await fs.stat(finalPath); }
                catch (e) { throw new Error(`Post-rename verify failed: ${e.message}`); }
                if (!finalStats.size) {
                    try { await fs.unlink(finalPath); } catch {}
                    throw new Error('Final file is 0 bytes after rename');
                }
                return this.registerDownload(job, finalPath, finalStats.size);

            } catch (error) {
                try {
                    if (existsSync(partPath)) await fs.unlink(partPath);
                } catch (cleanupErr) { }
                throw error;
            }

        } catch (error) {
            if (error.errorMessage === 'FLOOD_WAIT' || error.message?.includes('FLOOD_WAIT')) {
                const seconds = error.seconds || 60;
                this.throttle(); // Dynamic: reduce concurrency on flood
                if (this.rateLimiter) await this.rateLimiter.pauseForFloodWait(seconds);
                else await this.sleep(seconds * 1000);
                return this.download(job, attempt);
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

    registerDownload(job, filePath, size) {
        const groupId = job.groupId || 'unknown';
        const msgId = job.message.id;

        // DB Insert
        try {
            // Determine type based on extension or message
            let type = 'document';
            const ext = path.extname(filePath).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) type = 'photo';
            else if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) type = 'video';
            else if (['.mp3', '.ogg', '.wav', '.m4a'].includes(ext)) type = 'audio';

            insertDownload({
                groupId: String(groupId),
                groupName: job.groupName || null,
                messageId: msgId,
                fileName: path.basename(filePath),
                fileSize: size,
                fileType: type,
                filePath: path.relative(DOWNLOADS_DIR, filePath),
                ttlSeconds: job.ttlSeconds || null,
                // Rescue Mode: when the monitor stamps `pendingUntil` on the
                // job, the row gets inserted with that expiry so the rescue
                // sweeper can prune it later (unless a delete event rescues
                // it first).
                pendingUntil: job.pendingUntil || null,
            });
        } catch(e) {
            console.error('DB Insert Error', e);
        }

        this.incrementDiskUsage(size);
        
        this.emit('download_complete', {
            filePath,
            fileName: path.basename(filePath),
            size,
            groupId,
            groupName: job.groupName,
            message: job.message,
            mediaType: job.mediaType
        });

        return filePath;
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
        const date = new Date(msg.date * 1000);
        const timestamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        return `${timestamp}_${msg.id}${ext}`;
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
