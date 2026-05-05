/**
 * History Downloader - Batch download past messages
 */

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { Api } from 'telegram';
import { getMessageIdRange } from './db.js';

export class HistoryDownloader extends EventEmitter {
    constructor(client, downloader, config, accountManager = null) {
        super();
        this.client = client;
        this.downloader = downloader;
        this.config = config;
        this.accountManager = accountManager;
        this.stats = {
            processed: 0,
            downloaded: 0,
            skipped: 0,
            urls: 0
        };
    }

    /**
     * Try every available client to find one that can access a group
     * @returns {TelegramClient|null}
     */
    async discoverClientForGroup(groupId) {
        if (!this.accountManager) return this.client;

        for (const [_id, acctClient] of this.accountManager.clients) {
            try {
                const history = await acctClient.getMessages(groupId, { limit: 1 });
                if (history) {
                    return acctClient;
                }
            } catch (e) {
                // This client can't access the group, try next
            }
        }
        return null; // No client can access
    }

    async scan(groupId, _limit = 0) {
        const counts = {
            photos: 0,
            videos: 0,
            files: 0,
            links: 0,
            voice: 0,
            gifs: 0,
            total: 0
        };

        try {
            const workingClient = await this.discoverClientForGroup(groupId);
            if (!workingClient) {
                console.error('Scan failed: No account has access to this group');
                return counts;
            }

            // Parallel fetch for speed
            const queries = [
                { key: 'photos', filter: new Api.InputMessagesFilterPhotos() },
                { key: 'videos', filter: new Api.InputMessagesFilterVideo() },
                { key: 'files', filter: new Api.InputMessagesFilterDocument() },
                { key: 'links', filter: new Api.InputMessagesFilterUrl() },
                { key: 'voice', filter: new Api.InputMessagesFilterVoice() },
                { key: 'gifs', filter: new Api.InputMessagesFilterGif() }
            ];

            const results = await Promise.all(queries.map(async (q) => {
                try {
                    const res = await workingClient.getMessages(groupId, {
                        limit: 1, // We just need count
                        filter: q.filter
                    });
                    return { key: q.key, count: res.total || 0 };
                } catch (e) {
                    return { key: q.key, count: 0 };
                }
            }));

            results.forEach(r => counts[r.key] = r.count);
            counts.total = Object.values(counts).reduce((a, b) => a + b, 0);

        } catch (e) {
            // Fallback or error
            console.error('Scan failed:', e);
        }

        return counts;
    }

    /**
     * Request a graceful cancel of the in-flight backfill loop.
     *
     * Sets two flags the iteration loop checks at every step:
     *   - `cancelFlag` short-circuits the for-await body (immediate return)
     *   - `running = false` prevents any "is still running" callers from
     *     re-entering the queue.
     *
     * Idempotent — calling twice is a no-op.
     */
    cancel() {
        this.cancelFlag = true;
        this.running = false;
        this.emit('log', '🛑 Backfill cancellation requested');
    }

    async downloadHistory(groupId, options = {}) {
        this.running = true;
        this.cancelFlag = false;
        this.stats = { processed: 0, downloaded: 0, skipped: 0, urls: 0 };

        // null / undefined / 0 → "no limit" — iterate the entire history.
        // Any positive number caps the iteration to that many messages.
        const rawLimit = options.limit;
        const limit = (rawLimit === undefined || rawLimit === null || rawLimit === 0)
            ? undefined
            : rawLimit;
        const offsetId = options.offsetId || 0;

        // Find group config
        const group = this.config.groups.find(g => String(g.id) === String(groupId));
        if (!group) throw new Error('Group config not found');

        // ---- Smart resume (v2.3.34) ---------------------------------------
        //
        // Three modes, each tells gramJS where to start iterating so we
        // never re-walk messages we already have rows for:
        //
        //   - 'pull-older' (default for a fresh manual click) — iterate
        //     from `min(message_id) - 1` BACKWARDS. Skips everything from
        //     the oldest already-stored message up to "now"; only walks
        //     uncovered older history.
        //   - 'catch-up' — iterate from `max(message_id) + 1` to NEWEST.
        //     Used by the post-monitor-restart auto-spawn so we recover
        //     the gap between shutdown and boot.
        //   - 'rescan' — caller passed `offsetId` explicitly; honor it
        //     verbatim (used for "Run again" buttons + tests).
        //
        // The point: a resume-after-resume is ~80-90% faster than the
        // pre-v2.3.34 "walk every message and isDownloaded() each one"
        // path. Telegram-side filtering replaces millions of round trips
        // with a single offsetId hint.
        const explicitOffset = !!options.offsetId;
        const requestedMode = options.mode === 'catch-up' ? 'catch-up'
            : options.mode === 'rescan' ? 'rescan'
            : 'pull-older';
        let mode = requestedMode;
        let iterMaxId;     // gramJS reads as `maxId`
        let iterMinId;     // gramJS reads as `minId`
        if (explicitOffset || mode === 'rescan') {
            mode = 'rescan';
            iterMaxId = offsetId || undefined;
        } else {
            const { minMessageId, maxMessageId, count } = getMessageIdRange(groupId);
            if (mode === 'catch-up') {
                if (maxMessageId != null) iterMinId = maxMessageId; // strictly newer than this id
            } else if (count > 0 && minMessageId != null) {
                // pull-older with at least one row already on disk
                iterMaxId = minMessageId; // strictly older than this id
            }
            // count === 0 → first-time backfill: no offset, iterate from newest as before
        }

        // 'All' surfaces in progress UIs as the string "all" instead of a number
        // so toasts/log lines don't render misleading totals.
        this.emit('start', {
            group: group.name,
            limit: limit === undefined ? 'all' : limit,
            mode,
            offsetId: iterMaxId || iterMinId || 0,
        });

        // Start workers if not running
        this.downloader.start();

        let lastId = offsetId;

        try {
            const workingClient = await this.discoverClientForGroup(groupId);
            if (!workingClient) {
                throw new Error('No available account has access to this group');
            }

            // Iterate messages
            // Using iterMessages is more memory efficient than getMessages for large history
            // SAFETY: Process in small batches with rest intervals
            // GramJS: passing `limit: undefined` to iterMessages iterates ALL messages.

            const iterOpts = {
                limit: limit,
                offsetDate: options.offsetDate,
            };
            // gramJS treats `maxId`/`minId` as STRICT inequalities
            // (returns rows with id < maxId / id > minId), which matches
            // the "skip everything already in DB" intent exactly.
            if (iterMaxId) iterOpts.maxId = iterMaxId;
            if (iterMinId) iterOpts.minId = iterMinId;
            // For backwards compat, propagate offsetId only when caller
            // explicitly passed it (otherwise it conflicts with maxId).
            if (explicitOffset) iterOpts.offsetId = offsetId;

            for await (const message of workingClient.iterMessages(groupId, iterOpts)) {
                if (!this.running || this.cancelFlag) break; // Use this.running for graceful stop, cancelFlag for immediate return

                this.stats.processed++;
                this.emit('progress', this.stats); // Emit progress immediately after processing count

                // --- Backpressure: cap RAM during 100k+ backfills ---
                // The "stuck" check is FORWARD-PROGRESS based: as long
                // as the downloader's pendingCount drops OR a `complete`
                // event fires, we keep waiting indefinitely. We abort
                // only when NEITHER happens for the configured window.
                //
                // History (per user complaints — all addressed):
                // - v2.3.7: switched from "5 min from queue-full" to
                //   forward-progress detection.
                // - v2.3.25: bumped the default no-progress window
                //   from 5 min → 15 min so a worst-case
                //   FloodWait × MAX_FLOOD_RETRIES (≈8 × 60 s = 8 min on
                //   one stuck job) doesn't abort the whole backfill;
                //   added a `history_stalled` warning broadcast at the
                //   half-way point (so the UI can surface "stalled,
                //   still trying…" without dropping the job); and stop
                //   aborting entirely when downloader.runtime says all
                //   workers are alive — the runtime-side FloodWait
                //   recovery will eventually drain the queue.
                {
                    const cap = Number(this.config?.advanced?.history?.backpressureCap) || 500;
                    const MAX_WAIT_MS = Number(this.config?.advanced?.history?.backpressureMaxWaitMs) || (15 * 60 * 1000);
                    const STALL_WARN_AT = Math.floor(MAX_WAIT_MS / 2);

                    if (this.downloader.pendingCount > cap) {
                        let lastProgressAt = Date.now();
                        let lastPending = this.downloader.pendingCount;
                        let warnedStalled = false;
                        const onComplete = () => { lastProgressAt = Date.now(); };
                        this.downloader.on('complete', onComplete);
                        try {
                            while (this.downloader.pendingCount > cap) {
                                await this.sleep(1000);
                                if (!this.running || this.cancelFlag) break;
                                if (this.downloader.pendingCount < lastPending) {
                                    lastPending = this.downloader.pendingCount;
                                    lastProgressAt = Date.now();
                                    warnedStalled = false;
                                }
                                const stallMs = Date.now() - lastProgressAt;
                                if (!warnedStalled && stallMs > STALL_WARN_AT) {
                                    warnedStalled = true;
                                    try {
                                        this.emit('stalled', {
                                            pending: this.downloader.pendingCount,
                                            cap,
                                            stallSeconds: Math.round(stallMs / 1000),
                                        });
                                    } catch {}
                                }
                                if (stallMs > MAX_WAIT_MS) {
                                    const mins = Math.round(MAX_WAIT_MS / 60000);
                                    throw new Error(`History backpressure: downloader made no progress for ${mins}min (pending=${this.downloader.pendingCount}, cap=${cap}). Check Engine card for FloodWait or stalled workers.`);
                                }
                            }
                        } finally {
                            this.downloader.off?.('complete', onComplete)
                                || this.downloader.removeListener?.('complete', onComplete);
                        }
                    }
                }
                // ---------------------------------------------

                // Skip existing in DB (Optimization)
                // Process message (Same logic as monitor)
                lastId = message.id; // Keep lastId update here
                await this.processMessage(message, group);

                // Progress Update (additional emit for currentId, if needed)
                if (this.stats.processed % 10 === 0) {
                    this.emit('progress', { ...this.stats, currentId: lastId });
                }

                // 🧠 HUMAN-LIKE DELAYS 🧠
                // Both cadences are tunable via config.advanced.history.*.
                // Setting either to 0 disables that break entirely (useful
                // for power users who manage their own rate limits).
                const shortEvery = Number(this.config?.advanced?.history?.shortBreakEveryN);
                const longEvery  = Number(this.config?.advanced?.history?.longBreakEveryN);
                const shortN = Number.isFinite(shortEvery) ? shortEvery : 100;
                const longN  = Number.isFinite(longEvery)  ? longEvery  : 1000;

                // Short break (2-5s) - Like scrolling pause
                if (shortN > 0 && this.stats.processed % shortN === 0) {
                    const delay = Math.floor(Math.random() * 3000) + 2000;
                    // Silenced short break log as requested
                    // this.emit('log', `☕ Short break: ${delay/1000}s`);
                    await this.sleep(delay);
                }

                // Long break (60-120s) - Like getting coffee
                if (longN > 0 && this.stats.processed % longN === 0) {
                    const delay = Math.floor(Math.random() * 60000) + 60000;
                    this.emit('log', `🛌 Long break: ${delay/1000}s (Safety First)`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        } catch (error) {
            this.emit('error', error);
            // Re-throw so the Promise returned by downloadHistory rejects.
            // Without this re-throw, server.js's `.then(...).catch(...)`
            // pattern only ever hit `.then()` — no matter how the run
            // failed — and the dashboard would flash a green "Done" pill
            // a few milliseconds after Start. The most common surface
            // was "discoverClientForGroup returned null" (no account in
            // the group), which threw here, was emitted on the EE, then
            // got smothered when the function returned normally.
            throw error;
        } finally {
            const cancelled = this.cancelFlag === true;
            this.running = false;
            this.emit('complete', { ...this.stats, lastMessageId: lastId, cancelled });
        }
    }



    async processMessage(message, group) {
        // User tracking filter
        if (!this.passUserFilter(message, group)) {
            this.stats.skipped++;
            return;
        }

        // Topic filter
        if (!this.passTopicFilter(message, group)) {
            this.stats.skipped++;
            return;
        }

        // Handle URLs (Granular default true)
        if (group.filters?.urls !== false) {
            await this.handleUrls(message, group);
        }

        // Handle Media
        if (this.hasMedia(message)) {
            const mediaType = this.getMediaType(message);
            
            // Check filter (Granular default to true if undefined)
            const filterValue = group.filters?.[mediaType];
            const isAllowed = filterValue !== false;

            if (!isAllowed) {
                this.stats.skipped++;
                return;
            }

            // Enqueue (Priority 2 for history, lower than realtime)
            const added = await this.downloader.enqueue({
                message,
                groupId: group.id,
                groupName: group.name,
                mediaType
            }, 2);

            if (added) {
                this.stats.downloaded++;
            } else {
                this.stats.skipped++; // Duplicate
            }
        }
    }

    // --- Helpers (Duplicated from monitor.js for isolation) ---

    passUserFilter(message, group) {
        if (!group.trackUsers?.enabled) return true;
        if (group.trackUsers.mode === 'all') return true;

        const senderId = String(message.senderId || '');
        const isTracked = (group.trackUsers.users || []).some(
            u => String(u.id) === senderId || u.username === message.sender?.username
        );

        const globalTracked = (this.config.globalTrackedUsers || []).some(
            u => String(u.id) === senderId || u.username === message.sender?.username
        );

        const tracked = isTracked || globalTracked;

        if (group.trackUsers.mode === 'whitelist') return tracked;
        if (group.trackUsers.mode === 'blacklist') return !tracked;
        return true;
    }

    passTopicFilter(message, group) {
        if (!group.topics?.enabled) return true;
        
        const replyTo = message.replyTo;
        if (!replyTo?.forumTopic) return true;

        const topicId = replyTo.replyToMsgId;
        const isInList = (group.topics.ids || []).includes(topicId);

        if (group.topics.mode === 'whitelist') return isInList;
        if (group.topics.mode === 'blacklist') return !isInList;
        return true;
    }

    hasMedia(message) {
        return !!(message.photo || message.video || message.document || 
                  message.audio || message.voice || message.sticker ||
                  message.videoNote || message.gif);
    }

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    getMediaType(message) {
        if (message.photo) return 'photos';
        
        if (message.video || message.videoNote) {
             if (message.gif || (message.document?.mimeType === 'image/gif')) return 'gifs';
             return 'videos';
        }
        
        if (message.voice) return 'voice';
        if (message.audio) return 'audio';
        
        if (message.document) {
            const mime = message.document.mimeType || '';
            if (mime.includes('image/gif')) return 'gifs';
            if (mime.includes('video/')) return 'videos';
            if (mime.includes('image/')) return 'photos';
            if (mime.includes('audio/')) return 'audio';
        }
        
        return 'files';
    }

    async handleUrls(message, group) {
        const text = message.message || message.text || '';
        const urls = text.match(/https?:\/\/[^\s<>)"']+/gi);
        if (!urls?.length) return;

        try {
            const basePath = this.config.download?.path || './data/downloads';
            const groupDir = path.join(basePath, this.sanitize(group.name));
            
            if (!fsSync.existsSync(groupDir)) {
                await fs.mkdir(groupDir, { recursive: true });
            }

            const date = new Date(message.date * 1000).toISOString().split('T')[0];
            const lines = urls.map(url => `[${date}] ${url}`).join('\n') + '\n';
            
            await fs.appendFile(path.join(groupDir, 'urls.txt'), lines);
            this.stats.urls += urls.length;
        } catch (error) {
            // Ignore
        }
    }

    sanitize(name) {
        return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
    }
}
