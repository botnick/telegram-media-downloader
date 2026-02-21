/**
 * History Downloader - Batch download past messages
 */

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { Api } from 'telegram';

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

        for (const [id, acctClient] of this.accountManager.clients) {
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

    async scan(groupId, limit = 0) {
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

    async downloadHistory(groupId, options = {}) {
        this.running = true;
        this.cancelFlag = false;
        this.stats = { processed: 0, downloaded: 0, skipped: 0, urls: 0 };
        
        const limit = options.limit || 100;
        const offsetId = options.offsetId || 0;
        
        // Find group config
        const group = this.config.groups.find(g => String(g.id) === String(groupId));
        if (!group) throw new Error('Group config not found');

        this.emit('start', { group: group.name, limit });
        
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
            
            for await (const message of workingClient.iterMessages(groupId, { 
                limit: limit,
                offsetId: offsetId,
                offsetDate: options.offsetDate
            })) {
                if (!this.running || this.cancelFlag) break; // Use this.running for graceful stop, cancelFlag for immediate return

                this.stats.processed++;
                this.emit('progress', this.stats); // Emit progress immediately after processing count

                // --- Backpressure: Limit Queue Size to 500 ---
                // Prevents RAM explosion for 100k+ items
                // Keeps file references fresh
                while (this.downloader.queue.length > 500) {
                    await this.sleep(1000);
                    if (!this.running || this.cancelFlag) break; // Check cancel flag inside loop
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
                
                // Short break every 100 messages (2-5s) - Like scrolling pause
                // Short break every 100 messages (2-5s) - Like scrolling pause
                if (this.stats.processed % 100 === 0) {
                    const delay = Math.floor(Math.random() * 3000) + 2000;
                    // Silenced short break log as requested
                    // this.emit('log', `☕ Short break: ${delay/1000}s`);
                    await this.sleep(delay);
                }

                // Long break every 1000 messages (60-120s) - Like getting coffee
                if (this.stats.processed % 1000 === 0) {
                    const delay = Math.floor(Math.random() * 60000) + 60000;
                    this.emit('log', `🛌 Long break: ${delay/1000}s (Safety First)`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        } catch (error) {
            this.emit('error', error);
        } finally {

            this.emit('complete', { ...this.stats, lastMessageId: lastId });
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
