
/**
 * Telegram Bot Control
 * Handles commands via Telegram chat to control the downloader.
 */

import { NewMessage } from 'telegram/events/index.js';

export class BotControl {
    constructor(client, downloader, config) {
        this.client = client;
        this.downloader = downloader;
        this.config = config;
        this.startTime = Date.now();
    }

    start() {
        console.log('🤖 Bot Control Active. Send /status to your account (Saved Messages) or the bot account.');
        
        this.client.addEventHandler(async (event) => {
            const message = event.message;
            if (!message || !message.text) return;

            const text = message.text;

            // Security: Only allow commands from admin (Self) or configured admins?
            // For now, let's restrict to "Self" (Saved Messages) or if we are a bot, the owner.
            // But since this runs as Userbot usually, we check if `out` is true (sent by us) or from specific user.
            // Let's allow commands from "Saved Messages" (which has peerId = user's ID)
            
            const senderId = message.senderId ? message.senderId.toString() : '';
            const me = await this.client.getMe();
            const myId = me.id.toString();

            // Allow if sender is ME
            if (senderId !== myId) return; 

            // Handle Commands
            if (text.startsWith('/status')) {
                await this.handleStatus(message);
            } else if (text.startsWith('/add')) {
                await this.handleAdd(message);
            } else if (text.startsWith('/pause')) {
                await this.handlePause(message);
            } else if (text.startsWith('/resume')) {
                await this.handleResume(message);
            } else if (text.startsWith('/ping')) {
                await this.reply(message, '🏓 Pong!');
            }

        }, new NewMessage({}));
    }

    async reply(message, text) {
        try {
            await this.client.sendMessage(message.chatId, { 
                message: text, 
                replyTo: message.id 
            });
        } catch (e) {
            console.error('Bot Reply Error:', e);
        }
    }

    async handleStatus(message) {
        const stats = this.downloader.getStatus(); // { queued, active, completed, downloads }
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);

        let msg = `📊 **Downloader Status**\n\n`;
        msg += `⏱ Uptime: ${h}h ${m}m\n`;
        msg += `📥 Active: ${stats.active}\n`;
        msg += `⏳ Queued: ${stats.queued}\n`;
        msg += `✅ Session Completed: ${stats.completed}\n`;
        
        if (stats.active > 0) {
            msg += `\n**Currently Downloading:**\n`;
            stats.downloads.forEach(d => {
                msg += `🔹 ${d.mediaType} (${d.progress || 0}%)\n`;
            });
        }

        await this.reply(message, msg);
    }

    async handleAdd(message) {
        const parts = message.text.split(' ');
        if (parts.length < 2) {
            return await this.reply(message, 'Usage: /add <channel_username_or_id>');
        }

        const input = parts[1];
        await this.reply(message, `🔍 Resolving ${input}...`);

        try {
            const entity = await this.client.getEntity(input);
            if (entity) {
                // Add to config groups
                const newGroup = {
                    id: entity.id.toString(),
                    name: entity.title || entity.username || 'New Group',
                    enabled: true,
                    filters: { photos: true, videos: true, files: true, links: true }
                };
                
                // We need to update existing config. 
                // Since Config Manager isn't exported as singleton with write access easily here,
                // we might need to rely on the fs direct write or a passed save function.
                // NOTE: For now, we just mock the success or need to use the `config/manager.js` if available.
                // Let's try to read/write config file directly for simplicity here as we did in server.js
                
                // Or better, emit an event? 
                // Let's just say "Please add via Web UI" for complex stuff, 
                // but if we want to support it, we need to request Config reload.
                
                await this.reply(message, `✅ Found: **${newGroup.name}**\nID: \`${newGroup.id}\`\n\n(Auto-add via bot is pending implementation - please use Web UI or add ID manually for now)`);
            }
        } catch (e) {
            await this.reply(message, `❌ Error: ${e.message}`);
        }
    }

    async handlePause(message) {
        // this.downloader.pause(); // Need to implement pause in downloader if not exists
        // Downloader has stop() but that kills workers.
        await this.reply(message, '⚠️ Pause not yet implemented in Downloader engine.');
    }

    async handleResume(message) {
        await this.reply(message, '⚠️ Resume not yet implemented.');
    }
}
