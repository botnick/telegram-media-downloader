/**
 * Real-time Monitor - Watch groups for new media
 */

import { NewMessage } from 'telegram/events/index.js';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export class RealtimeMonitor extends EventEmitter {
    constructor(client, downloader, config) {
        super();
        this.client = client;
        this.downloader = downloader;
        this.config = config;
        this.running = false;
        this.handler = null;
        this.stats = {
            messages: 0,
            media: 0,
            downloaded: 0,
            skipped: 0,
            skipped: 0,
            urls: 0
        };
        this.spamGuard = new SpamGuard(); // Active Defense System
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.stats = { messages: 0, media: 0, downloaded: 0, skipped: 0, urls: 0 };
        this.urlBuffer = new Map();
        
        // Start URL Batch Writer
        this.urlFlushInterval = setInterval(() => this.flushUrls(), 5000);

        const enabledGroups = this.config.groups.filter(g => g.enabled);
        
        if (enabledGroups.length === 0) {
            throw new Error('No groups enabled for monitoring');
        }

        const groupIds = enabledGroups.map(g => g.id);

        // Create handler
        this.handler = async (event) => {
            if (this.running) {
                await this.handleEvent(event);
            }
        };

        // Subscribe to new messages (Listen to ALL, filter inside handler)
        // This fixes the issue where GramJS fails to resolve chat IDs on startup.
        this.client.addEventHandler(this.handler, new NewMessage({}));

        // Start download workers
        this.downloader.start();

        this.emit('started', { 
            groupCount: groupIds.length,
            groups: enabledGroups.map(g => g.name)
        });
    }

    async stop() {
        this.running = false;
        if (this.urlFlushInterval) {
            clearInterval(this.urlFlushInterval);
            await this.flushUrls(); // Final sync (awaited)
        }
        await this.downloader.stop();
        this.emit('stopped', this.stats);
    }

    async handleEvent(event) {
        try {
            const message = event.message;
            this.stats.messages++;

            // --- SPAM GUARD ACTIVE DEFENSE ---
            if (this.spamGuard.isSpam(message)) {
                this.stats.skipped++;
                return;
            }
            // ---------------------------------

            // Find group config
            const chatId = message.peerId?.channelId?.toString() || 
                           message.peerId?.chatId?.toString() ||
                           message.chatId?.toString();
            
            const group = this.config.groups.find(
                g => String(g.id).replace('-100', '') === chatId?.replace('-100', '') && g.enabled
            );

            if (!group) return;

            // User tracking filter
            if (!this.passUserFilter(message, group)) {
                this.stats.skipped++;
                return;
            }

            // Topic filter (for forum groups)
            if (!this.passTopicFilter(message, group)) {
                this.stats.skipped++;
                return;
            }

            // Handle URLs (Granular check)
            if (group.filters?.urls !== false) {
                await this.handleUrls(message, group);
            }

            // Handle media
            if (this.hasMedia(message)) {
                this.stats.media++;
                
                const mediaType = this.getMediaType(message);
                
                // Check filter (Granular default to true if undefined, except for voice/audio often default false)
                // We assume if config is missing, we default to TRUE for common types
                
                const filterValue = group.filters?.[mediaType];
                const isAllowed = filterValue !== false; // Default true if undefined

                if (!isAllowed) {
                    this.stats.skipped++;
                    return;
                }

                // Queue for download with HIGH priority
                const added = await this.downloader.enqueue({
                    message,
                    groupId: group.id,
                    groupName: group.name,
                    mediaType
                }, 1);

                if (added) {
                    this.stats.downloaded++;
                    this.emit('download', {
                        group: group.name,
                        type: mediaType,
                        messageId: message.id
                    });
                } else {
                    this.stats.skipped++;
                }
            }
        } catch (error) {
            this.emit('error', { error: error.message });
        }
    }

    passUserFilter(message, group) {
        if (!group.trackUsers?.enabled) return true;
        if (group.trackUsers.mode === 'all') return true;

        const senderId = String(message.senderId || '');
        const isTracked = (group.trackUsers.users || []).some(
            u => String(u.id) === senderId || u.username === message.sender?.username
        );

        // Also check global tracked users
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
        
        // Check if message is in a topic
        const replyTo = message.replyTo;
        if (!replyTo?.forumTopic) return true; // Not a topic message

        const topicId = replyTo.replyToMsgId;
        const isInList = (group.topics.ids || []).includes(topicId);

        if (group.topics.mode === 'whitelist') return isInList;
        if (group.topics.mode === 'blacklist') return !isInList;
        return true;
    }

    hasMedia(message) {
        return !!(
            message.photo ||
            message.video ||
            message.document ||
            message.audio ||
            message.voice ||
            message.videoNote ||
            message.gif
        );
    }

    getMediaType(message) {
        if (message.photo) return 'photos';
        
        if (message.video || message.videoNote) {
             // Check if it's a GIF (usually silent video or has attribute)
             if (message.gif || (message.document?.mimeType === 'image/gif')) return 'gifs';
             return 'videos';
        }
        
        if (message.voice) return 'voice';
        if (message.audio) return 'audio';
        
        if (message.document) {
            // Further check for animated stickers or gifs masked as documents
            const mime = message.document.mimeType || '';
            if (mime.includes('image/gif')) return 'gifs';
            if (mime.includes('video/')) return 'videos';
            if (mime.includes('image/')) return 'photos';
            if (mime.includes('audio/')) return 'audio';
        }

        return 'files';
    }

    async handleUrls(message, group) {
        let text = message.message || message.text || '';
        
        // SECURITY: Truncate to 1000 chars to prevent ReDoS attacks on massive text
        if (text.length > 1000) text = text.slice(0, 1000);

        const urls = text.match(/https?:\/\/[^\s<>)"']+/gi);
        if (!urls?.length) return;

        // BATCH WRITER OPTIMIZATION
        // Instead of writing to disk immediately (blocking), add to buffer.
        const groupId = group.id;
        
        if (!this.urlBuffer) this.urlBuffer = new Map(); // groupId -> Array<String>
        if (!this.urlBuffer.has(groupId)) this.urlBuffer.set(groupId, []);

        const date = new Date().toISOString().split('T')[0];
        const time = new Date().toISOString().split('T')[1].slice(0, 8);
        
        urls.forEach(url => {
            this.urlBuffer.get(groupId).push(`[${date} ${time}] ${url}`);
        });

        this.stats.urls += urls.length;
        this.emit('urls', { group: group.name, count: urls.length });
    }

    async flushUrls() {
        if (!this.urlBuffer || this.urlBuffer.size === 0) return;

        const basePath = this.config.download?.path || './data/downloads';

        for (const [groupId, lines] of this.urlBuffer) {
            if (lines.length === 0) continue;

            const group = this.config.groups.find(g => g.id === groupId);
            const groupName = group ? group.name : groupId;
            const groupDir = path.join(basePath, this.sanitize(groupName));

            try {
                if (!fsSync.existsSync(groupDir)) {
                    await fs.mkdir(groupDir, { recursive: true });
                }

                // Batch append
                const content = lines.join('\n') + '\n';
                await fs.appendFile(path.join(groupDir, 'urls.txt'), content);
                
                // Clear buffer for this group
                lines.length = 0; 
            } catch (error) {
                // Retry next time
            }
        }
    }

    sanitize(name) {
        return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
    }

    getStats() {
        return { ...this.stats };
    }
}

/**
 * Active Spam Defense System
 * Blocks bots based on rate limits and content hashing.
 */
class SpamGuard {
    constructor() {
        this.userRateLimits = new Map(); // userId -> { count, expires }
        this.contentHashes = new Map();  // hash -> { count, expires }
        
        // Cleanup interval (Every 1 min)
        setInterval(() => this.cleanup(), 60000);
    }

    isSpam(message) {
        const userId = message.senderId ? String(message.senderId) : null;
        if (!userId) return false;

        // 1. User Rate Limit (Max 20 msgs / 5 sec)
        // Simple sliding window check
        const now = Date.now();
        
        if (!this.userRateLimits.has(userId)) {
            this.userRateLimits.set(userId, { count: 1, reset: now + 5000 });
        } else {
            const entry = this.userRateLimits.get(userId);
            if (now > entry.reset) {
                entry.count = 1;
                entry.reset = now + 5000;
            } else {
                entry.count++;
                if (entry.count > 20) {
                    // Ban for 1 minute
                    if (entry.count === 21) console.log(`🛡️  SpamGuard: Temp Ban User ${userId}`);
                    return true;
                }
            }
        }

        // 2. Duplicate Content Check (Hash Text/Media)
        // Generate simple signature
        let signature = null;
        if (message.message) signature = `txt:${message.message.slice(0, 50)}`; // First 50 chars
        else if (message.document) signature = `doc:${message.document.size}`;
        else if (message.photo) signature = `img:${message.photo.id}`;

        if (signature) {
             if (!this.contentHashes.has(signature)) {
                 this.contentHashes.set(signature, { count: 1, reset: now + 10000 });
             } else {
                 const entry = this.contentHashes.get(signature);
                 if (now > entry.reset) {
                     entry.count = 1;
                     entry.reset = now + 10000;
                 } else {
                     entry.count++;
                     if (entry.count > 5) { // Same text/kb > 5 times in 10s
                         return true; 
                     }
                 }
             }
        }

        return false;
    }

    cleanup() {
        const now = Date.now();
        for (const [key, val] of this.userRateLimits) {
            if (now > val.reset + 60000) this.userRateLimits.delete(key);
        }
        for (const [key, val] of this.contentHashes) {
            if (now > val.reset + 60000) this.contentHashes.delete(key);
        }
    }
}
