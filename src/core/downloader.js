/**
 * Download Manager - Multi-threaded downloads with deduplication
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Api } from 'telegram';
import { DebugLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, '../../data/downloaded.json');

export class DownloadManager extends EventEmitter {
    constructor(client, config, rateLimiter) {
        super();
        this.client = client;
        this.config = config;
        this.rateLimiter = rateLimiter;
        this.queue = [];
        this.active = new Map();
        this.downloadedIds = new Map(); // Cache of Set<key> per group
        this.failedJobs = new Map();    // DLQ per group
        this.pendingWrites = new Map(); // Bucket writes buffer
        this.registries = new Map(); 
        this.registryQueues = new Map(); 
        this.running = false;
        
        // Batch Saving Optimization (100k files scale)
        this.dirtyRegistries = new Set();
        this.flushInterval = null;
        this.workers = [];
        this.concurrency = config.download?.concurrent || 3;
        this.LOG_DIR = path.join(__dirname, '../../data/logs');
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
            // Log for debugging
            DebugLogger.log('downloader_debug.log', 'Found Document', {
                virtualClass: doc.className,
                id: doc.id ? doc.id.toString() : 'missing',
                hasAccessHash: !!doc.accessHash,
                fileRefLen: doc.fileReference ? doc.fileReference.length : 0
            });

            // Ensure fileReference is valid
            const fileRef = doc.fileReference || Buffer.alloc(0);

            // Construct InputDocumentFileLocation
            // GramJS expects BigInt for IDs. The object from 'history' usually has them as BigInt wrapper or similar.
            // We safely access properties.
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
             DebugLogger.log('downloader_debug.log', 'Found Photo', { id: photo.id.toString() });
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
        try {
            if (!fsSync.existsSync(this.LOG_DIR)) {
                await fs.mkdir(this.LOG_DIR, { recursive: true });
            }
            // Auto-Flush Every 5s
            this.flushInterval = setInterval(() => this.flushData(), 5000);
            this.emit('ready');
        } catch (error) {
            DebugLogger.error(error, 'DownloadManager Init Failed');
            throw error;
        }
    }

    // --- PARTITIONING LOGIC ---

    getBucketId(messageId) {
        // Safe BigInt handling: If string, parse. If number, use.
        // Assuming message.id is Number for legacy CLI, or BigInt. 
        // Monitor usually returns Integer/Number for ID.
        // We partition by 5000 range.
        const id = Number(messageId);
        return Math.floor(id / this.BUCKET_SIZE);
    }

    async loadGroupIndex(groupId) {
        // Loads ALL downloaded IDs into memory Set for fast O(1) checks.
        // Does NOT load full metadata to save RAM.
        if (this.downloadedIds.has(groupId)) return;

        const groupDir = path.join(this.LOG_DIR, String(groupId));
        const ids = new Set();

        try {
            // 1. Check for Migration (Legacy flat file)
            const legacyPath = path.join(this.LOG_DIR, `${groupId}.json`);
            if (fsSync.existsSync(legacyPath)) {
                DebugLogger.log('storage.log', `Migrating legacy log for ${groupId}...`);
                const data = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
                // Sort into buckets and save immediately
                await this.migrateLegacyData(groupId, data.files || {});
                await fs.unlink(legacyPath); // Delete old after migration
            }

            // 2. Load Buckets
            if (fsSync.existsSync(groupDir)) {
                const files = await fs.readdir(groupDir);
                for (const file of files) {
                    if (file.startsWith('bucket_') && file.endsWith('.json')) {
                        const content = JSON.parse(await fs.readFile(path.join(groupDir, file), 'utf8'));
                        Object.keys(content).forEach(k => ids.add(k));
                    }
                }
            }
        } catch (e) {
            DebugLogger.error(e, `Load Index Fail [${groupId}]`);
        }

        this.downloadedIds.set(groupId, ids);
        // Load existing failures too
        await this.loadDLQ(groupId);
    }

    async migrateLegacyData(groupId, files) {
        // Convert flat object to bucketed structure
        const buckets = new Map();
        
        for (const [key, meta] of Object.entries(files)) {
            // Key format: "groupId_msgId" -> extract msgId
            const parts = key.split('_');
            const msgId = parts.length > 1 ? parts[1] : 0;
            const bId = this.getBucketId(msgId);
            
            if (!buckets.has(bId)) buckets.set(bId, {});
            buckets.get(bId)[key] = meta;
        }

        const groupDir = path.join(this.LOG_DIR, String(groupId));
        await fs.mkdir(groupDir, { recursive: true });

        for (const [bId, data] of buckets) {
            await fs.writeFile(
                path.join(groupDir, `bucket_${bId}.json`), 
                JSON.stringify(data, null, 2)
            );
        }
    }

    isDownloaded(groupId, messageId) {
        // Instant check
        const key = `${groupId}_${messageId}`;
        const set = this.downloadedIds.get(groupId);
        return set ? set.has(key) : false;
    }

    // --- DEAD LETTER QUEUE (DLQ) ---
    async loadDLQ(groupId) {
        const dlqPath = path.join(this.LOG_DIR, String(groupId), 'failed.json');
        try {
            if (fsSync.existsSync(dlqPath)) {
                this.failedJobs.set(groupId, JSON.parse(await fs.readFile(dlqPath, 'utf8')));
            } else {
                this.failedJobs.set(groupId, []);
            }
        } catch (e) { this.failedJobs.set(groupId, []); }
    }

    async reportFailure(job, reason) {
        const groupId = job.groupId;
        if (!this.failedJobs.has(groupId)) this.failedJobs.set(groupId, []);
        
        const list = this.failedJobs.get(groupId);
        // Prevent duplicates
        if (!list.find(j => j.id === job.message.id)) {
            list.push({
                id: job.message.id,
                reason: reason,
                date: Date.now()
            });
            // Auto-save DLQ immediately or via flush? Flush is safer.
            // Mark bucket 'dlq' as pending? Let's just write DLQ separately in flush.
        }
    }

    // --- STORAGE FLUSH ---
    async flushData() {
        // 1. Flush Buckets
        for (const [groupId, buckets] of this.pendingWrites) {
            if (buckets.size === 0) continue;
            
            const groupDir = path.join(this.LOG_DIR, String(groupId));
            try { await fs.mkdir(groupDir, { recursive: true }); } catch (e) {}

            for (const [bId, newEntries] of buckets) {
                const p = path.join(groupDir, `bucket_${bId}.json`);
                // Read-Merge-Write safely
                // Since this is single-threaded Node, we just need to ensure we don't overwrite parallel writes.
                // But we are the only writer loop.
                try {
                    let existing = {};
                    try {
                        if (fsSync.existsSync(p)) existing = JSON.parse(await fs.readFile(p, 'utf8'));
                    } catch (e) {}
                    
                    const merged = { ...existing, ...newEntries };
                    await fs.writeFile(p, JSON.stringify(merged, null, 2));
                    
                } catch (e) { DebugLogger.error(e, `Flush Fail ${groupId}:${bId}`); }
            }
            buckets.clear();
        }

        // 2. Flush DLQ
        for (const [groupId, failures] of this.failedJobs) {
            if (failures.length === 0) continue;
            const dlqPath = path.join(this.LOG_DIR, String(groupId), 'failed.json');
            try {
                await fs.writeFile(dlqPath, JSON.stringify(failures, null, 2));
            } catch (e) {}
        }
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
        for (let i = 0; i < this.concurrency; i++) {
            this.workers.push(this.runWorker(i));
        }
        this.emit('started', { workers: this.concurrency });
    }

    async stop() {
        this.running = false;
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            await this.flushData(); // Final sync (awaited)
        }
    }
    
    async enqueue(job, priority = 1) {
        const key = `${job.groupId}_${job.message.id}`;
        job.key = key;

        // Dedup check (Memory + Active)
        if (this.active.has(key)) return false;
        
        // Ensure registry is loaded for checking
        if (!this.downloadedIds.has(job.groupId)) {
            await this.loadGroupIndex(job.groupId);
        }

        if (this.isDownloaded(job.groupId, job.message.id)) return false;

        // --- DYNAMIC DEFENSE: DISK SPILLOVER ---
        // If RAM queue is too full, spill to disk to prevent crash
        if (this.queue.length > 2000) {
            await this.spillToDisk(job);
            return true;
        }
        // ---------------------------------------

        // Priority Insertion
        if (priority === 2) this.queue.push(job); // History: End
        else this.queue.unshift(job); // Realtime: Front

        this.emit('queue', this.queue.length);
        return true;
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
            // If disk fail, force RAM push (Desperate mode)
            this.queue.push(job);
        }
    }

    async rehydrateFromDisk() {
        if (!this.BACKLOG_PATH || !fsSync.existsSync(this.BACKLOG_PATH)) return false;

        try {
            // Read first 1000 lines efficiently
            // For simplicity in Node, we read whole file, splice, write back.
            // For production with 1GB backlog, we should use streams.
            // Let's use a safe 'Head' reader.
            
            const content = await fs.readFile(this.BACKLOG_PATH, 'utf8');
            if (!content.trim()) return false;

            const lines = content.split('\n').filter(l => l.trim());
            const chunk = lines.splice(0, 1000); // Take 1000
            
            // Refill Queue
            for (const line of chunk) {
                try {
                    this.queue.push(JSON.parse(line));
                } catch(e) {}
            }

            // Write back remaining
            if (lines.length > 0) {
                await fs.writeFile(this.BACKLOG_PATH, lines.join('\n') + '\n');
            } else {
                await fs.unlink(this.BACKLOG_PATH); // Done
            }
            
            DebugLogger.log('system.log', `Rehydrated ${chunk.length} jobs from disk.`);
            return true;

        } catch (e) {
            DebugLogger.error(e, 'Rehydration Failed');
            return false;
        }
    }

    async runWorker(id) {
        while (this.running) {
            // 1. Try to get job from RAM
            let job = this.queue.shift();

            // 2. If RAM empty, check Disk Backlog
            if (!job) {
                const hasMore = await this.rehydrateFromDisk();
                if (hasMore) {
                    job = this.queue.shift(); // Try again after refill
                }
            }

            // 3. Still empty? Sleep.
            if (!job) {
                await this.sleep(200);
                continue;
            }

            this.active.set(job.key, { ...job, workerId: id, progress: 0, startedAt: Date.now() });
            this.emit('start', job);

            try {
                // Ensure index is loaded
                if (!this.downloadedIds.has(job.groupId)) {
                     await this.loadGroupIndex(job.groupId);
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

    registerDownload(job, filePath, size) {
        const groupId = job.groupId || 'unknown';
        const key = job.key; // "groupId_msgId"
        const msgId = job.message.id;

        // 1. Update In-Memory Set
        if (!this.downloadedIds.has(groupId)) this.downloadedIds.set(groupId, new Set());
        this.downloadedIds.get(groupId).add(key);

        // 2. Queue for Write (Bucket Partitioning)
        const bId = this.getBucketId(msgId);
        
        if (!this.pendingWrites.has(groupId)) this.pendingWrites.set(groupId, new Map());
        const groupPending = this.pendingWrites.get(groupId);

        if (!groupPending.has(bId)) groupPending.set(bId, {});
        // Add metadata
        groupPending.get(bId)[key] = {
            file: path.basename(filePath),
            size: size,
            date: Date.now()
        };
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
            if (attempt === 1) await this.rateLimiter.acquire();

            // 4. Build Paths
            const finalPath = await this.buildPath(job);
            const partPath = `${finalPath}.part`;

            // 5. Execute Download using High-Level reliable method
            try {
                DebugLogger.log('downloader_debug.log', `Starting download: ${job.key}`, {
                    messageId: job.message.id,
                    mediaType: job.mediaType
                });

                // downloadMedia handles all extraction/DC logic internally and is much more stable than manual blocks
                await this.client.downloadMedia(job.message, {
                    outputFile: partPath,
                    progressCallback: (downloaded, total) => {
                        if (total) {
                            const pct = Number((BigInt(downloaded) * 100n) / BigInt(total));
                            // Update active map for UI
                            const active = this.active.get(job.key);
                            if (active) active.progress = pct;
                            this.emit('progress', { job, progress: pct });
                        }
                    }
                });

                // 7. Success - Verify and Rename
                const finalStats = await fs.stat(partPath);
                await fs.rename(partPath, finalPath);
                return this.registerDownload(job, finalPath, finalStats.size);

            } catch (error) {
                // Cleanup incomplete .part file on any error
                try {
                    if (fsSync.existsSync(partPath)) {
                        await fs.unlink(partPath);
                        DebugLogger.log('downloader_debug.log', `Cleaned up broken .part file: ${partPath}`);
                    }
                } catch (cleanupErr) { /* ignore */ }

                throw error;
            }

        } catch (error) {
            if (error.errorMessage === 'FLOOD_WAIT' || error.message?.includes('FLOOD_WAIT')) {
                const seconds = error.seconds || 60;
                await this.rateLimiter.pauseForFloodWait(seconds);
                return this.download(job, attempt);
            }

            if (
                error.message?.includes('FILE_REFERENCE_EXPIRED') || 
                error.errorMessage === 'FILE_REFERENCE_EXPIRED'
            ) {
                if (attempt < maxRetries) {
                    DebugLogger.log('downloader_debug.log', `Refreshing File Reference: ${job.key}`);
                    try {
                        const messages = await this.client.getMessages(job.message.peerId, { ids: [job.message.id] });
                        if (messages && messages.length > 0) {
                            job.message = messages[0]; // Update with fresh fileReference
                            return this.download(job, attempt + 1);
                        }
                    } catch (refreshErr) {
                        DebugLogger.error(refreshErr, `Failed to refresh message ${job.key}`);
                    }
                }
            }

            // Handles other errors or disconnects -> Retry
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
        const key = job.key; // "groupId_msgId"
        const msgId = job.message.id;

        // 1. Update In-Memory Set
        if (!this.downloadedIds.has(groupId)) this.downloadedIds.set(groupId, new Set());
        this.downloadedIds.get(groupId).add(key);

        // 2. Queue for Write (Bucket Partitioning)
        const bId = this.getBucketId(msgId);
        
        if (!this.pendingWrites.has(groupId)) this.pendingWrites.set(groupId, new Map());
        const groupPending = this.pendingWrites.get(groupId);

        if (!groupPending.has(bId)) groupPending.set(bId, {});
        // Add metadata
        groupPending.get(bId)[key] = {
            file: path.basename(filePath),
            size: size,
            date: Date.now()
        };

        // SMART COUNTER: Update usage immediately
        this.incrementDiskUsage(size);

        return filePath;
    }

    getFileSize(message) {
        if (message.document) return Number(message.document.size);
        if (message.photo) {
            // Photos have multiple sizes, usually we download the largest.
            // But getting exact size from metadata without downloading is tricky for 'Sizes'.
            // Often 'size' attribute exists on the largest variant.
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
        if (message.document) return 'document'; // generic
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

    // --- Helpers ---

    async getDiskUsage() {
         // SMART COUNTER: Use cached value + incremental updates
         // Only true scan on startup or if cache missing.
         
         if (this._diskUsageCache) {
             // Incremental Cache exists (in-memory)
             return this._diskUsageCache.size;
         }

         // Try load from disk
         const cachePath = path.join(this.LOG_DIR, '../disk_usage.json');
         try {
             if (fsSync.existsSync(cachePath)) {
                 const data = JSON.parse(await fs.readFile(cachePath, 'utf8'));
                 this._diskUsageCache = { size: data.size, timestamp: Date.now() };
                 return data.size;
             }
         } catch (e) {}

         // Fallback: Full Scan (Expensive, do once)
         DebugLogger.log('system.log', 'Performing Full Disk Scan (Initialization)...');
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

    // Call this when file is added
    incrementDiskUsage(bytes) {
        if (!this._diskUsageCache) this._diskUsageCache = { size: 0, timestamp: Date.now() };
        this._diskUsageCache.size += bytes;
        this.saveDiskUsageCache(); // Debounce this in prod, but for now safe
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
        
        // TYPE-BASED STORAGE (User Request)
        // Organization: downloads/GroupName/images/file.jpg
        let typeFolder = 'others';
        const type = job.mediaType || this.getFileTypeCategory(job.message);

        if (type === 'photos' || type === 'image') typeFolder = 'images';
        else if (type === 'videos' || type === 'video') typeFolder = 'videos';
        else if (type === 'audio' || type === 'voice') typeFolder = 'audio';
        else if (type === 'gifs') typeFolder = 'gifs';
        else if (type === 'stickers') typeFolder = 'stickers'; // New Folder
        else typeFolder = 'documents';
        
        const fullDir = path.join(basePath, groupDir, typeFolder);
        await fs.mkdir(fullDir, { recursive: true });

        const filename = this.generateFilename(job);
        return path.join(fullDir, filename);
    }

    generateFilename(job) {
        const msg = job.message;
        const ext = this.getExtension(msg);
        // Use message date for better organization instead of current system time
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
        
        if (message.sticker) {
            // Stickers often come as documents with specific mime types
            const mime = message.sticker.mimeType;
            if (mime === 'application/x-tgsticker') return '.tgs'; // Animated sticker
            if (mime === 'image/webp') return '.webp'; // Static sticker
            if (mime === 'video/webm') return '.webm'; // Video sticker (WebM)
            if (mime === 'application/x-bad-tgsticker') return '.tgs'; 
        }

        if (message.document) {
            // Check for filename in attributes
            const attrs = message.document.attributes || [];
            for (const attr of attrs) {
                if (attr.fileName) {
                    const ext = path.extname(attr.fileName);
                    if (ext) return ext;
                }
            }
            // Use MIME type
            const mime = message.document.mimeType;
            const mimeMap = {
                'application/pdf': '.pdf',
                'application/zip': '.zip',
                'image/png': '.png',
                'image/jpeg': '.jpg',
                'image/gif': '.gif',
                'video/mp4': '.mp4',
                'application/x-tgsticker': '.tgs',
                'image/webp': '.webp'
            };
            return mimeMap[mime] || '.bin';
        }
        
        return '.bin';
    }

    sanitize(name) {
        return name
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 80);
    }

    getStatus() {
        let completedCount = 0;
        for (const registry of this.registries.values()) {
            if (registry && registry.files) {
                completedCount += Object.keys(registry.files).length;
            }
        }

        return {
            queued: this.queue.length,
            active: this.active.size,
            completed: completedCount,
            downloads: Array.from(this.active.values())
        };
    }

    async waitForCompletion(timeoutMs = 0) {
        const start = Date.now();
        // If timeoutMs is 0, wait indefinitely
        while (this.queue.length > 0 || this.active.size > 0) {
            if (timeoutMs > 0 && (Date.now() - start > timeoutMs)) break;
            await this.sleep(500);
        }
    }

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}
