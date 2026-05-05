/**
 * Auto Forwarder - Uploads downloaded media to a destination channel
 * Supports: Single Aggregation Channel, Custom Destination, Delete after forward
 */

import fs from 'fs/promises';
import path from 'path';
import { Api } from 'telegram';
import { colorize } from '../cli/colors.js';

export class AutoForwarder {
    constructor(client, config, accountManager = null) {
        this.client = client;
        this.config = config;
        this.accountManager = accountManager;
        this.storageChannelId = null; // Cache for the single storage channel
    }

    /**
     * Main processing entry point
     * @param {Object} downloadInfo - From downloader 'download_complete' event
     */
    async process(downloadInfo) {
        const { filePath, groupId, groupName, message } = downloadInfo;

        // 1. Check Group Config
        const groupConfig = this.config.groups.find(g => String(g.id) === String(groupId));
        if (!groupConfig || !groupConfig.autoForward || !groupConfig.autoForward.enabled) {
            return;
        }

        const settings = groupConfig.autoForward;

        // Use per-group forward account if configured
        const fwdClient = (this.accountManager && groupConfig.forwardAccount)
            ? this.accountManager.getClient(groupConfig.forwardAccount)
            : this.client;

        console.log(colorize(`➡️  [AutoForward] Processing for ${groupName}...`, 'cyan'));

        try {
            // 2. Resolve Destination
            let targetPeer = await this.resolveDestination(settings.destination, fwdClient);
            if (!targetPeer) {
                console.log(colorize(`⚠️  [AutoForward] Could not resolve destination. Skipping.`, 'yellow'));
                return;
            }

            // 3. Prepare Caption with Message Link
            let caption = message?.message || message?.text || '';
            
            // Generate message link
            // Format: t.me/c/CHANNEL_ID/MESSAGE_ID (private) or t.me/USERNAME/MESSAGE_ID (public)
            let messageLink = '';
            const msgId = message?.id;
            if (msgId && groupId) {
                // For private channels: use /c/ format with positive ID
                const cleanId = String(groupId).replace(/^-100/, '');
                messageLink = `https://t.me/c/${cleanId}/${msgId}`;
            }
            
            // Add source attribution with clickable link
            if (messageLink) {
                caption += `\n\n📌 Source: [${groupName}](${messageLink})`;
            } else {
                caption += `\n\n📌 Source: **${groupName}**`;
            }

            // 4. Upload & Send
            // We use sendFile to bypass restricted content forwarding
            const sentMsg = await fwdClient.sendFile(targetPeer, {
                file: filePath,
                caption: caption,
                forceDocument: false,
                workers: 1 // Safer for automated uploads
            });

            // GramJS returns the new message; surface its TG message-id in the log
            // so operators can trace the destination copy back from the dashboard.
            const sentMsgId = sentMsg?.id ?? sentMsg?.message?.id ?? null;
            const dest = settings.destination || 'Storage Channel';
            const tail = sentMsgId ? ` (msg #${sentMsgId})` : '';
            console.log(colorize(`✅ [AutoForward] Sent to ${dest}${tail}`, 'green'));

            // 5. Cleanup (if enabled). Isolate the unlink in its own
            // try/catch so a successful upload isn't reported as failed
            // when the local delete races with another process. The
            // hourly integrity sweep will eventually drop the orphan
            // DB row whose file is gone (or here, whose file we
            // intentionally couldn't delete).
            if (settings.deleteAfterForward) {
                try {
                    await fs.unlink(filePath);
                    console.log(colorize(`🗑️  [AutoForward] Deleted local file: ${path.basename(filePath)}`, 'gray'));
                } catch (unlinkErr) {
                    console.warn(colorize(`⚠️  [AutoForward] Forwarded but local delete failed for ${path.basename(filePath)}: ${unlinkErr.message}`, 'yellow'));
                }
            }

        } catch (error) {
            console.log(colorize(`❌ [AutoForward] Error: ${error.message}`, 'red'));
        }
    }

    /**
     * Resolve where to send the file
     */
    async resolveDestination(destination, client) {
        client = client || this.client;
        // Case A: Specific Destination
        if (destination && destination !== 'storage') {
            // Saved Messages — accept both 'me' and 'saved' aliases.
            if (destination === 'me' || destination === 'saved') return 'me';

            // Try to parse if it's an ID
            if (/^-?\d+$/.test(destination)) {
                try {
                    const id = BigInt(destination);

                    // Primary: cheap, returns InputPeer if GramJS already has the entity cached.
                    try { return await client.getInputEntity(id); } catch { /* fall through */ }

                    // Secondary: heavier — scans dialogs and resolves usernames/peers, often
                    // succeeds where getInputEntity fails (e.g. channel never seen on this client).
                    try {
                        const entity = await client.getEntity(id);
                        if (entity) return entity;
                    } catch { /* fall through */ }

                    // Last resort: hand-roll an InputPeer from the canonical -100… layout.
                    // accessHash=0 only resolves for channels the bot/user has interacted with
                    // server-side; for fully-private channels the send will fail and the caller
                    // will see a clear error (CHANNEL_INVALID / PEER_ID_INVALID) instead of a
                    // mysterious resolve hang. Logging the fallback so operators can spot it.
                    const raw = String(destination);
                    if (raw.startsWith('-100')) {
                        console.warn(colorize(
                            `⚠️  [AutoForward] Falling back to manual InputPeerChannel for ${raw} — peer is not in dialog cache. If sends fail, open the channel once from the configured account.`,
                            'yellow'));
                        return new Api.InputPeerChannel({
                            channelId: BigInt(raw.replace(/^-100/, '')),
                            accessHash: BigInt(0),
                        });
                    }
                    if (raw.startsWith('-')) {
                        console.warn(colorize(
                            `⚠️  [AutoForward] Falling back to manual InputPeerChat for ${raw}.`,
                            'yellow'));
                        return new Api.InputPeerChat({ chatId: BigInt(raw.replace(/^-/, '')) });
                    }
                    return id;
                } catch {
                    return destination;
                }
            }

            // Treat as username or phone
            return destination;
        }

        // Case B: Auto Storage Channel (Single Channel)
        if (this.storageChannelId) return this.storageChannelId;

        // Try to find existing "Telegram Downloader Storage" in dialogs
        try {
            const dialogs = await client.getDialogs({ limit: 100 });
            const found = dialogs.find(d => d.title === 'Telegram Downloader Storage');
            
            if (found) {
                this.storageChannelId = found.entity;
                return this.storageChannelId;
            }

            // Create new if not found
            console.log(colorize(`🛠️  [AutoForward] Creating storage channel...`, 'cyan'));
            const result = await client.invoke(
                new Api.channels.CreateChannel({
                    title: 'Telegram Downloader Storage',
                    about: 'Auto-forwarded media storage from Telegram Media Downloader',
                    broadcast: true,
                    megagroup: false
                })
            );

            // Access the created channel
            if (result.chats && result.chats[0]) {
                this.storageChannelId = result.chats[0];
                console.log(colorize(`✅ [AutoForward] Created channel: Telegram Downloader Storage`, 'green'));
                return this.storageChannelId;
            }

        } catch (e) {
            console.log(colorize(`❌ [AutoForward] Failed to create/find storage channel: ${e.message}`, 'red'));
        }

        return null;
    }
}
