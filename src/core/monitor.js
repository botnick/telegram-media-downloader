/**
 * Real-time Monitor - Watch groups for new media
 * v1.1 Refined Code
 */

import { NewMessage } from 'telegram/events/index.js';
import { EventEmitter } from 'events';
import { colorize } from '../cli/colors.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export class RealtimeMonitor extends EventEmitter {
    constructor(client, downloader, config, configPath = null) {
        super();
        this.client = client;
        this.downloader = downloader;
        this.config = config;
        this.configPath = configPath;
        this.running = false;
        this.handler = null;
        this.stats = {
            messages: 0,
            media: 0,
            downloaded: 0,
            skipped: 0,
            urls: 0
        };
        this.spamGuard = new SpamGuard(); // Active Defense System
        
        // Config file watcher for live sync with Web UI
        if (configPath && fsSync.existsSync(configPath)) {
            this.watchConfig();
        }
    }
    
    watchConfig() {
        let debounce = null;
        fsSync.watch(this.configPath, (eventType) => {
            if (eventType !== 'change') return;
            clearTimeout(debounce);
            debounce = setTimeout(() => this.reloadConfig(), 500);
        });
    }
    
    async reloadConfig() {
        try {
            const newConfig = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
            const oldGroupIds = this.config.groups.map(g => String(g.id));
            const newGroupIds = newConfig.groups.map(g => String(g.id));
            
            // Detect changes
            const added = newConfig.groups.filter(g => !oldGroupIds.includes(String(g.id)));
            const removed = this.config.groups.filter(g => !newGroupIds.includes(String(g.id)));
            const changed = newConfig.groups.filter(g => {
                const old = this.config.groups.find(og => String(og.id) === String(g.id));
                return old && (old.enabled !== g.enabled);
            });
            
            this.config = newConfig;
            
            // Log changes
            if (added.length) console.log(colorize(`📋 Config: ${added.length} group(s) added`, 'green'));
            if (removed.length) console.log(colorize(`📋 Config: ${removed.length} group(s) removed`, 'yellow'));
            if (changed.length) {
                changed.forEach(g => {
                    const status = g.enabled ? '✓ enabled' : '✗ disabled';
                    console.log(colorize(`📋 Config: ${g.name} ${status}`, g.enabled ? 'green' : 'dim'));
                });
            }
            
            this.emit('configReloaded', newConfig);
        } catch (err) {
            // Ignore read errors
        }
    }

    async start() {
        if (this.running) return;
        this.running = true;
        this.stats = { messages: 0, media: 0, downloaded: 0, skipped: 0, urls: 0 };
        this.urlBuffer = new Map();
        
        // Start URL Batch Writer
        this.urlFlushInterval = setInterval(() => this.flushUrls(), 5000);

        // Initialize Last Message IDs for Polling
        this.lastIds = new Map();
        console.log(colorize('🔄 Syncing state for Active Polling...', 'cyan'));

        const enabledGroups = this.config.groups.filter(g => g.enabled);
        if (enabledGroups.length === 0) {
            console.log('⚠️  Warning: No groups enabled in config. Monitor will be idle.');
        }
        
        for (const group of enabledGroups) {
            try {
                const history = await this.client.getMessages(group.id, { limit: 1 });
                if (history && history.length > 0) {
                    this.lastIds.set(group.id, history[0].id);
                }
            } catch (e) {}
        }

        // Start Polling Loop (Smart Recursive Mode)
        // Prevents overlap and adapts to network speed
        this.startPollingLoop();

        // Create handler (Hybrid Mode)
        this.handler = async (event) => {
            if (this.running) await this.handleEvent(event);
        };
        this.client.addEventHandler(this.handler, new NewMessage({}));

        // Start download workers
        this.downloader.start();

        this.emit('started', { 
            groupCount: enabledGroups.length,
            groups: enabledGroups.map(g => g.name)
        });
        
        console.log(colorize('✅ Monitor Engine Active', 'green', 'bold'));
    }

    async startPollingLoop() {
        if (!this.running) return;
        
        // Configurable interval (Default 10s for safety)
        const interval = (this.config.pollingInterval || 10) * 1000;

        await this.poll();

        // Schedule next run only after previous one finishes
        this.pollTimeout = setTimeout(() => this.startPollingLoop(), interval);
    }

    async poll() {
        if (!this.running) return;
        
        const enabledGroups = this.config.groups.filter(g => g.enabled);

        for (const group of enabledGroups) {
            // Tiny delay between groups to prevent flood (Rate Limit Protection)
            await new Promise(r => setTimeout(r, 1000));
            
            try {
                const lastId = this.lastIds.get(group.id) || 0;
                
                // Fetch messages NEWER than lastId
                const messages = await this.client.getMessages(group.id, { 
                    minId: lastId, 
                    limit: 10 
                });

                if (messages && messages.length > 0) {
                    messages.reverse(); 

                    for (const msg of messages) {
                        await this.handleEvent({ message: msg });
                        if (msg.id > lastId) {
                            this.lastIds.set(group.id, msg.id);
                        }
                    }
                }
            } catch (e) {
                // Silent fail
            }
        }
    }

    async stop() {
        this.running = false;
        if (this.urlFlushInterval) {
            clearInterval(this.urlFlushInterval);
            await this.flushUrls(); // Final sync (awaited)
        }
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout); // Stop Hybrid Polling
            this.pollTimeout = null;
        }
        await this.downloader.stop();
        this.emit('stopped', this.stats);
    }

    async handleEvent(event) {
        const message = event.message;

        // DEBUG: Log EVERY event that has a message to see if we are receiving them
        if (message) {
             const peerId = message.peerId?.channelId?.toString() || message.peerId?.chatId?.toString() || message.peerId?.userId?.toString();
             // console.log(`📨 RAW EVENT: Peer=${peerId} ID=${message.id} Text=${(message.message || '').slice(0, 20)}...`);
        }

        try {
            if (!message) return; // Ignore updates without message

            // Debug removed for production clarity
            // console.log('DEBUG:', message.id);

            this.stats.messages++;

            // --- SPAM GUARD ACTIVE DEFENSE ---
            if (this.spamGuard.isSpam(message)) {
                this.stats.skipped++;
                return;
            }
            // ---------------------------------

            // Find group config
            // GramJS helper: message.chatId works for both groups and channels
            let chatId = message.chatId?.toString();
            
            // Fallback for raw peer
            if (!chatId) {
                chatId = message.peerId?.channelId?.toString() || message.peerId?.chatId?.toString();
            }

            if (!chatId) return; // Should not happen

            // Normalize ID helper (Handles -100 prefix and negative signs)
            const normalizeId = (id) => String(id).replace(/^-100/, '').replace(/^-/, '');
            
            const targetId = normalizeId(chatId);

            const group = this.config.groups.find(
                g => normalizeId(g.id) === targetId && g.enabled
            );

            if (!group) {
                // Helpful log for users wondering why it's ignored
                // Only log once per group per session to avoid spam
                if (!this._unknownGroups) this._unknownGroups = new Set();
                if (!this._unknownGroups.has(chatId)) {
                    // console.log(`⚠️  Ignored message from Group ID: ${chatId} (Not enabled in Config)`);
                    this._unknownGroups.add(chatId);
                }
                return;
            }

            // DEBUG: Matched Group
            const hasMedia = this.hasMedia(message);
            // console.log(`🎯 DEBUG: Group [${group.name}] MsgID: ${message.id} | Media: ${hasMedia ? this.getMediaType(message) : 'None'}`);

            if (!hasMedia && message.media) {
                 // console.log('❓ DEBUG: Msg has .media property but hasMedia() returned false.');
                 // console.log('   Media Class:', message.media.className);
            }

            // User tracking filter
            if (!this.passUserFilter(message, group)) {
                // console.log(`⛔ Skipped: User Filter rejected sender ${message.senderId || 'unknown'}`);
                this.stats.skipped++;
                return;
            }

            // Topic filter (for forum groups)
            if (!this.passTopicFilter(message, group)) {
                // console.log(`⛔ Skipped: Topic Filter rejected topic ${message.replyTo?.replyToMsgId || 'none'}`);
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
                
                const filterValue = group.filters?.[mediaType];
                
                // Default Permission Logic:
                // - Stickers: Default FALSE (Must explicitly enable)
                // - Others: Default TRUE (Must explicitly disable)
                let isAllowed = filterValue !== false;
                if (mediaType === 'stickers' && filterValue === undefined) {
                    isAllowed = false;
                }

                if (!isAllowed) {
                    // console.log(`⛔ Skipped: Media Filter [${mediaType}] is disabled for this group.`);
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
        if (message.sticker) return true; // Direct check

        if (message.media) {
             // Check inner media types
             const m = message.media;
             return !!(
                 m.photo || 
                 m.document || 
                 m.sticker || // Check inside media
                 (m.className === 'MessageMediaPhoto') ||
                 (m.className === 'MessageMediaDocument') ||
                 (m.className === 'MessageMediaWebPage' && m.webPage?.document) // Webpage with media preview
             );
        }
        
        // Fallback checks (shortcuts)
        return !!(
            message.photo ||
            message.video ||
            message.document ||
            message.audio ||
            message.voice ||
            message.sticker || // Direct property check
            message.videoNote ||
            message.gif
        );
    }

    getMediaType(message) {
        // Resolve actual media object
        let m = message;
        if (message.media && !message.photo && !message.document && !message.sticker) {
            m = message.media;
            // Handle wrapper classes
            if (m.photo) m = m; // It has photo
            else if (m.document) m = m; // It has document
        }

        // 1. Check for Sticker
        if (m.sticker || message.sticker) return 'stickers';
        
        // 2. Check document mime type for sticker/webp
        const doc = m.document || (m.className === 'MessageMediaDocument' ? m : null);
        if (doc) {
            const mime = doc.mimeType || '';
            if (mime.includes('image/webp') || mime.includes('application/x-tgsticker')) return 'stickers';
        }

        // Direct checks
        if (m.photo || m.className === 'MessageMediaPhoto') return 'photos';
        
        if (m.video || m.videoNote) {
             if (m.gif) return 'gifs';
             return 'videos';
        }
        
        if (doc) {
            const mime = doc.mimeType || '';
            if (mime.includes('image/gif')) return 'gifs';
            if (mime.includes('video/')) return 'videos'; // Some videos are documents
            if (mime.includes('image/')) return 'photos'; // Uncompressed images
            if (mime.includes('audio/')) return 'audio'; // Audio files
            if (mime.includes('voice')) return 'voice'; 
        }

        if (m.voice) return 'voice';
        if (m.audio) return 'audio';

        return 'files';
    }

    async handleUrls(message, group) {
        let text = message.message || message.text || '';
        
        // SECURITY: Truncate to 1000 chars to prevent ReDoS attacks on massive text
        if (text.length > 1000) text = text.slice(0, 1000);

        const urls = text.match(/https?:\/\/[^\s<>)"']+/gi);
        if (!urls?.length) return;

        // BATCH WRITER OPTIMIZATION
        const groupId = group.id;
        
        if (!this.urlBuffer) this.urlBuffer = new Map(); 
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
            // Use unified sanitization (Matches Downloader)
            const safeName = groupName
                .replace(/[<>:"/\\|?*]/g, '_')
                .replace(/\s+/g, '_') // Replace spaces with underscores
                .replace(/_+/g, '_')  // Collapse multiple underscores
                .slice(0, 80);
                
            const groupDir = path.join(basePath, safeName);

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

    // Restored sanitize method just in case
    sanitize(name) {
        return name
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 80);
    }

    getStats() {
        return { ...this.stats };
    }
}

/**
 * Active Spam Defense System
 */
class SpamGuard {
    constructor() {
        this.userRateLimits = new Map(); 
        this.contentHashes = new Map();  
        setInterval(() => this.cleanup(), 60000);
    }

    isSpam(message) {
        const userId = message.senderId ? String(message.senderId) : null;
        if (!userId) return false;

        // 1. User Rate Limit (Max 20 msgs / 5 sec)
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
                    if (entry.count === 21) console.log(`🛡️  SpamGuard: Temp Ban User ${userId}`);
                    return true;
                }
            }
        }

        // 2. Duplicate Content Check
        let signature = null;
        if (message.message) signature = `txt:${message.message.slice(0, 50)}`; 
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
                     if (entry.count > 5) { 
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
