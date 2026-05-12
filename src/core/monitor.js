/**
 * Real-time Monitor - Watch groups for new media
 * v1.1 Refined Code
 */

import { NewMessage, Raw } from 'telegram/events/index.js';
import { Api } from 'telegram';
import { EventEmitter } from 'events';
import { colorize } from '../cli/colors.js';
import { sanitizeName } from './downloader.js';
import { markRescued } from './db.js';
import { effectiveRescueMs } from './rescue.js';
import { loadConfig, saveConfig, watchConfig } from '../config/manager.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export class RealtimeMonitor extends EventEmitter {
    constructor(client, downloader, config, accountManager = null) {
        super();
        this.client = client;
        this.downloader = downloader;
        this.config = config;
        this.accountManager = accountManager;
        this.running = false;
        this.handler = null;
        this.handlerClients = []; // Track all clients with registered handlers
        this.stats = {
            messages: 0,
            media: 0,
            downloaded: 0,
            skipped: 0,
            urls: 0,
        };
        this.spamGuard = new SpamGuard(); // Active Defense System
        this.linkedChatMap = new Map(); // normalized linkedChatId -> { group, rawId }

        // Per-group failure reason from the most recent resolver pass.
        // Populated inside `_resolveUnknownGroup` + the discoverClientForGroup
        // probe loop; consumed by `start()` to write a single summary log
        // line + auto-disable failed groups via saveConfig().
        // Map<groupId, reasonCode>. Cleared at the start of each `start()`.
        this._lastResolveReason = new Map();

        // Live sync with Web UI: config changes arrive on the in-process
        // EventEmitter from src/config/manager.js — no filesystem watch
        // needed since kv['config'] writes emit synchronously.
        this.watchConfig();
    }

    /**
     * Get the correct client for a group — priority:
     * 1. Explicit monitorAccount from config
     * 2. Cached auto-discovered client
     * 3. Default client as last resort
     */
    getClientForGroup(group) {
        // 1. Explicit config setting
        if (this.accountManager && group.monitorAccount) {
            const client = this.accountManager.getClient(group.monitorAccount);
            if (client) return client;
        }
        // 2. Auto-discovered & cached
        if (this.groupClientCache && this.groupClientCache.has(group.id)) {
            return this.groupClientCache.get(group.id);
        }
        // 3. Fallback
        return this.client;
    }

    /**
     * Build a one-line label of every loaded account — `@bbbbbn5` /
     * `@bbbbbn5 + 2 others` / `<no accounts>`. Used in the resolver's
     * summary log so the operator can tell at-a-glance which account
     * was searched (and which one is missing).
     */
    _describeLoadedAccounts() {
        if (!this.accountManager || !this.accountManager.clients) return '<no accounts>';
        const labels = [];
        for (const [acctId] of this.accountManager.clients) {
            const meta = this.accountManager.metadata?.get?.(acctId) || {};
            labels.push(meta.username ? `@${meta.username}` : meta.name || meta.phone || acctId);
        }
        if (!labels.length) return '<no accounts>';
        if (labels.length === 1) return labels[0];
        return `${labels[0]} + ${labels.length - 1} other${labels.length === 2 ? '' : 's'}`;
    }

    /**
     * Reverse-lookup a client back to its accountId + a human label so
     * the Queue page can render which session is pulling each job. Returns
     * `{ accountId: null, accountName: null }` when the AccountManager
     * hasn't been wired (CLI standalone) or the client predates loadAll().
     */
    _describeAccount(client) {
        if (!this.accountManager || !client) return { accountId: null, accountName: null };
        const accountId = this.accountManager.getIdForClient(client);
        if (!accountId) return { accountId: null, accountName: null };
        const meta = this.accountManager.metadata?.get?.(accountId) || {};
        const accountName =
            meta.name || meta.username || meta.phone || (accountId ? `#${accountId}` : null);
        return { accountId, accountName };
    }

    /**
     * Try every available client to find one that can access a group.
     *
     * When `group.id` is a synthetic `unknown:<sanitisedFolderName>` id
     * (created by `reindexFromDisk` when files exist on disk but the DB
     * was empty), `getMessages(group.id, …)` always throws because there
     * is no real Telegram entity behind that id. We resolve the synthetic
     * id to a numeric one against a pre-built dialogs index — see
     * `_buildDialogsIndex()` for the index construction. On match we
     * rewrite `group.id` (in memory + persisted config + the downloads
     * table) so every downstream caller — polling, photo lookup, history,
     * forwarder — uses the canonical id.
     *
     * `dialogsIdx` is the Map<sanitizedTitle, {client, numericId, title}>
     * built once per `start()` call. Pre-resolution loops without it
     * (e.g. `getClientForGroup` callers later) get a null index and
     * fall straight to the probe loop.
     *
     * @param {object} group
     * @param {Map<string,{client:any,numericId:string,title:string}>|null} [dialogsIdx]
     * @returns {TelegramClient|null}
     */
    async discoverClientForGroup(group, dialogsIdx = null) {
        if (!this.accountManager) return this.client;

        // Synthetic recovery id — try to resolve it to a real numeric id
        // BEFORE probing, otherwise every client throws CHANNEL_INVALID
        // and we log "no account has access" for groups the operator is
        // very much a member of.
        if (typeof group.id === 'string' && group.id.startsWith('unknown:')) {
            const resolved = await this._resolveUnknownGroup(group, dialogsIdx);
            if (resolved) {
                this.groupClientCache.set(group.id, resolved.client);
                // Cache under the new numeric id too so subsequent lookups
                // via getClientForGroup() hit the same client.
                this.groupClientCache.set(resolved.numericId, resolved.client);
                return resolved.client;
            }
            // No live dialog matched — fall through and let the original
            // probe loop log the existing "no account has access" warning.
        }

        for (const [_id, acctClient] of this.accountManager.clients) {
            try {
                const history = await acctClient.getMessages(group.id, { limit: 1 });
                if (history) {
                    // Cache the working client
                    this.groupClientCache.set(group.id, acctClient);
                    return acctClient;
                }
            } catch (e) {
                // This client can't access the group, try next
            }
        }
        return null; // No client can access
    }

    /**
     * Pre-build a Map<sanitizedTitle, {client, numericId, title}> by
     * fetching every loaded client's dialogs ONCE — both active and
     * archived, with a generous limit so users with hundreds of joined
     * chats don't lose less-active groups outside the default top-500.
     *
     * Called from `start()` before the resolution loop so the per-group
     * resolver does O(1) Map lookup instead of re-fetching dialogs N×M
     * times (N groups × M clients × 500 dialogs each = wasteful + slow
     * + still misses chats outside the top 500).
     */
    async _buildDialogsIndex() {
        const idx = new Map();
        if (!this.accountManager) return idx;
        for (const [_id, acctClient] of this.accountManager.clients) {
            if (!acctClient?.connected) continue;
            let active = [];
            let archived = [];
            try {
                // limit:3000 covers heavy users; gramjs paginates internally
                // via repeat GetDialogs RPCs until it has enough rows or the
                // server runs out. Archived adds another 500 (typical cap).
                [active, archived] = await Promise.all([
                    acctClient.getDialogs({ limit: 3000 }).catch(() => []),
                    acctClient.getDialogs({ limit: 500, archived: true }).catch(() => []),
                ]);
            } catch {
                continue;
            }
            for (const d of [...(active || []), ...(archived || [])]) {
                const title =
                    d.title ||
                    d.name ||
                    (
                        (d.entity?.firstName || '') +
                        (d.entity?.lastName ? ' ' + d.entity.lastName : '')
                    ).trim() ||
                    d.entity?.username ||
                    null;
                if (!title) continue;
                const key = sanitizeName(title);
                if (!key) continue;
                // First-wins — consistent with `_dialogsNameCache` in server.js.
                if (!idx.has(key)) {
                    idx.set(key, {
                        client: acctClient,
                        numericId: String(d.id),
                        title,
                    });
                }
                // Also index by the username (folder names sometimes carry
                // the @-handle when reindexFromDisk ran on a CLI archive).
                const uname = d.entity?.username;
                if (uname && !idx.has(String(uname))) {
                    idx.set(String(uname), {
                        client: acctClient,
                        numericId: String(d.id),
                        title,
                    });
                }
            }
        }
        return idx;
    }

    /**
     * Resolve `unknown:<folderName>` to a real numeric id via a pre-built
     * dialogs index (see `_buildDialogsIndex()`). Falls back to a direct
     * `getEntity(folder)` per-client probe so usernames + invite-link
     * fragments that didn't appear in the dialog list still resolve.
     * On match rewrites the group id in-place + persists to kv['config']
     * + backfills `downloads.group_id`.
     *
     * Returns `{ numericId, client }` on match, or null on miss.
     */
    async _resolveUnknownGroup(group, dialogsIdx) {
        const folder = String(group.id).slice('unknown:'.length);
        if (!folder) {
            this._lastResolveReason.set(group.id, 'empty_folder');
            return null;
        }

        let hit = null;
        if (dialogsIdx instanceof Map) hit = dialogsIdx.get(folder) || null;

        // Fallback — folder name might actually be a public username
        // (Telegram @handle) that wasn't in the user's dialog list. Try
        // each client's `getEntity` with the folder string directly; if
        // any returns an entity, we're golden.
        if (!hit && this.accountManager) {
            for (const [_id, acctClient] of this.accountManager.clients) {
                let entity;
                try {
                    entity = await acctClient.getEntity(folder);
                } catch {
                    continue;
                }
                if (!entity) continue;
                const numericId = String(entity.id);
                const title =
                    entity.title ||
                    (
                        (entity.firstName || '') + (entity.lastName ? ' ' + entity.lastName : '')
                    ).trim() ||
                    entity.username ||
                    folder;
                hit = { client: acctClient, numericId, title };
                break;
            }
        }

        if (!hit) {
            // Folder is neither in any client's dialogs index NOR a public
            // username — most often the original downloader account isn't
            // logged in anymore. Operator can fix it from
            // Maintenance → Recovery cleanup.
            this._lastResolveReason.set(group.id, 'index_miss');
            return null;
        }

        // Confirm the matched dialog is actually readable before
        // committing the rewrite — handles edge cases where the user
        // joined a channel but lost permission to read history.
        try {
            const probe = await hit.client.getMessages(hit.numericId, { limit: 1 });
            if (!probe) {
                this._lastResolveReason.set(group.id, 'probe_empty');
                return null;
            }
        } catch (e) {
            const code = e?.errorMessage || e?.message || 'unknown';
            this._lastResolveReason.set(
                group.id,
                code === 'CHANNEL_PRIVATE' || /BANNED/.test(code)
                    ? `banned:${code}`
                    : `probe_failed:${code}`,
            );
            return null;
        }

        console.log(
            colorize(
                `🔁 Resolved "${folder}" → ${hit.numericId} (was synthetic, rewriting config)`,
                'cyan',
            ),
        );
        // Rewrite in memory so the rest of `start()` uses the numeric
        // id from this point on.
        group.id = hit.numericId;
        if (!group.name || group.name === folder) group.name = hit.title;
        // Persist to kv['config'] so the next boot is clean.
        try {
            const cfg = loadConfig();
            if (Array.isArray(cfg.groups)) {
                const target = cfg.groups.find((g) => g && String(g.id) === `unknown:${folder}`);
                if (target) {
                    target.id = hit.numericId;
                    if (!target.name || target.name === folder) target.name = hit.title;
                    saveConfig(cfg);
                }
            }
        } catch (e) {
            console.log(
                colorize(
                    `⚠️ Could not persist unknown→${hit.numericId} rewrite: ${e?.message || e}`,
                    'yellow',
                ),
            );
        }
        // Backfill downloads.group_id so the gallery doesn't show two
        // rows for the same chat (synthetic + numeric).
        try {
            const dbMod = await import('./db.js');
            dbMod
                .getDb()
                .prepare('UPDATE downloads SET group_id = ? WHERE group_id = ?')
                .run(hit.numericId, `unknown:${folder}`);
            dbMod
                .getDb()
                .prepare('UPDATE downloads SET group_name = ? WHERE group_id = ?')
                .run(hit.title, hit.numericId);
        } catch (e) {
            console.log(
                colorize(
                    `⚠️ Could not backfill downloads.group_id for unknown:${folder}: ${e?.message || e}`,
                    'yellow',
                ),
            );
        }
        return { numericId: hit.numericId, client: hit.client };
    }

    watchConfig() {
        // Subscribe to the EventEmitter that saveConfig() fires after every
        // commit to the kv table. Synchronous delivery, no debounce window
        // needed — the previous fs.watch debounce existed only to coalesce
        // duplicate filesystem events from the OS, which no longer apply.
        const unsub = watchConfig((newConfig) => {
            this.reloadConfig(newConfig);
        });
        this._configWatcher = { close: unsub };
        this._configWatchDebounceClear = () => {};
    }

    async reloadConfig(maybeConfig) {
        try {
            // Accept the freshly-saved tree from the bus when available;
            // otherwise re-read it (covers manual reloadConfig() callers).
            const newConfig = maybeConfig || loadConfig();
            const oldGroupIds = this.config.groups.map((g) => String(g.id));
            const newGroupIds = newConfig.groups.map((g) => String(g.id));

            // Detect changes
            const added = newConfig.groups.filter((g) => !oldGroupIds.includes(String(g.id)));
            const removed = this.config.groups.filter((g) => !newGroupIds.includes(String(g.id)));
            const changed = newConfig.groups.filter((g) => {
                const old = this.config.groups.find((og) => String(og.id) === String(g.id));
                return old && old.enabled !== g.enabled;
            });

            // Re-run the resolver for any newly-added `unknown:` group so
            // operators don't need a full monitor restart after adding a
            // recovery row via the dashboard. Successful resolutions
            // overwrite kv['config'] in-place; failures stay as-is and
            // surface on Maintenance → Recovery cleanup.
            const unknownAdded = added.filter(
                (g) => typeof g.id === 'string' && g.id.startsWith('unknown:'),
            );
            if (unknownAdded.length && this.accountManager?.clients?.size) {
                try {
                    const idx = await this._buildDialogsIndex();
                    let resolvedNow = 0;
                    for (const g of unknownAdded) {
                        const r = await this._resolveUnknownGroup(g, idx).catch(() => null);
                        if (r) resolvedNow += 1;
                    }
                    if (resolvedNow) {
                        console.log(
                            colorize(
                                `🔁 Resolver: rewrote ${resolvedNow}/${unknownAdded.length} synthetic id(s) on config reload`,
                                'cyan',
                            ),
                        );
                    } else {
                        console.log(
                            colorize(
                                `🔁 Resolver: 0/${unknownAdded.length} synthetic id(s) matched on config reload (Maintenance → Recovery cleanup)`,
                                'yellow',
                            ),
                        );
                    }
                } catch (e) {
                    console.log(colorize(`⚠️ Resolver re-run failed: ${e?.message || e}`, 'yellow'));
                }
            }

            this.config = newConfig;

            // Log changes
            if (added.length)
                console.log(colorize(`📋 Config: ${added.length} group(s) added`, 'green'));
            if (removed.length)
                console.log(colorize(`📋 Config: ${removed.length} group(s) removed`, 'yellow'));
            if (changed.length) {
                changed.forEach((g) => {
                    const status = g.enabled ? '✓ enabled' : '✗ disabled';
                    console.log(
                        colorize(`📋 Config: ${g.name} ${status}`, g.enabled ? 'green' : 'dim'),
                    );
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
        this.groupClientCache = new Map(); // groupId -> TelegramClient

        // Migrate old unsanitized folder names (space → underscore)
        const { migrateFolders } = await import('./downloader.js');
        await migrateFolders(this.config.download?.path);

        // Start URL Batch Writer
        this.urlFlushInterval = setInterval(() => this.flushUrls(), 5000);

        // Initialize Last Message IDs for Polling
        this.lastIds = new Map();
        console.log(colorize('🔄 Syncing state for Active Polling...', 'cyan'));

        // Cluster: skip groups whose ownerPeerId is set to another peer.
        // The owner peer downloads them; we'll see their files via the
        // sync engine + bridge instead of duplicating Telegram traffic.
        const { isLocalGroup } = await import('./cluster/router.js').catch(() => ({
            isLocalGroup: () => true,
        }));
        const enabledGroups = this.config.groups.filter((g) => {
            if (!g.enabled) return false;
            if (!isLocalGroup(g)) {
                console.log(
                    colorize(
                        `⏭  Skipping "${g.name}" — owned by another peer in the cluster`,
                        'cyan',
                    ),
                );
                return false;
            }
            return true;
        });
        if (enabledGroups.length === 0) {
            console.log('⚠️  Warning: No groups enabled in config. Monitor will be idle.');
        }

        // Suppress Telegram library's internal RPCError logging for invalid channels
        this._origConsoleError = console.error;
        console.error = (...args) => {
            const msg = args.map((a) => String(a)).join(' ');
            if (msg.includes('CHANNEL_INVALID')) return;
            this._origConsoleError.apply(console, args);
        };

        // Build the dialogs index ONCE before the resolution loop. Without
        // this, every `unknown:<folderName>` group triggered an N×M
        // re-fetch of dialogs (groups × clients × ~500 dialogs each) AND
        // chats outside the default top-500 silently fell through to the
        // "no account has access" warning even though the operator was
        // very much a member. Pre-fetching with a higher limit + archived
        // gives the resolver one O(1) Map lookup per group.
        const dialogsIdx = await this._buildDialogsIndex();
        const hasUnknown = enabledGroups.some(
            (g) => typeof g.id === 'string' && g.id.startsWith('unknown:'),
        );
        if (hasUnknown) {
            console.log(
                colorize(
                    `🔁 Resolver index built — ${dialogsIdx.size} dialogs across ${this.accountManager?.clients?.size || 1} account(s)`,
                    'cyan',
                ),
            );
        }

        // Auto-discover which client works for each group + capture the
        // current top message id so the v2.3.34 catch-up hook below can
        // detect gaps between the last DB row and Telegram's "now".
        //
        // Failures are accumulated into `_resolveFailures` instead of being
        // logged per-group; we emit a single summary line at the end + flip
        // each failed group to `enabled:false` + persist the rewrite so
        // subsequent restarts are silent. Operator surfaces the list +
        // bulk operations on Maintenance → Recovery cleanup.
        this._lastResolveReason.clear();
        const _topPerGroup = new Map();
        const _resolveFailures = []; // [{ group, reason }]
        let _resolvedCount = 0;
        for (const group of enabledGroups) {
            const wasUnknown = typeof group.id === 'string' && group.id.startsWith('unknown:');
            try {
                const workingClient = await this.discoverClientForGroup(group, dialogsIdx);
                if (!workingClient) {
                    const reason =
                        this._lastResolveReason.get(group.id) ||
                        (wasUnknown ? 'index_miss' : 'probe_failed:unknown');
                    _resolveFailures.push({ group, reason });
                    group.enabled = false;
                    continue;
                }
                if (wasUnknown && !String(group.id).startsWith('unknown:')) {
                    // The resolver rewrote the id in-place — count it.
                    _resolvedCount += 1;
                }
                const history = await workingClient.getMessages(group.id, { limit: 1 });
                if (history && history.length > 0) {
                    this.lastIds.set(group.id, history[0].id);
                    _topPerGroup.set(String(group.id), history[0].id);
                }
            } catch (e) {
                if (e.errorMessage === 'CHANNEL_INVALID') {
                    _resolveFailures.push({ group, reason: 'probe_failed:CHANNEL_INVALID' });
                    group.enabled = false;
                }
            }
        }

        // ---- Single summary line + persisted auto-disable -----------------
        if (_resolveFailures.length || _resolvedCount) {
            const accountLabel = this._describeLoadedAccounts();
            if (_resolvedCount) {
                console.log(
                    colorize(
                        `🔁 Resolver: rewrote ${_resolvedCount} synthetic id(s) → numeric (active account: ${accountLabel})`,
                        'cyan',
                    ),
                );
            }
            if (_resolveFailures.length) {
                // Tally reasons so the summary tells the operator at-a-glance
                // whether to add an account or open the cleanup page.
                const tally = new Map();
                for (const { reason } of _resolveFailures) {
                    const head = String(reason).split(':')[0];
                    tally.set(head, (tally.get(head) || 0) + 1);
                }
                const tallyStr = [...tally.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
                console.log(
                    colorize(
                        `⚠️ Auto-disabled ${_resolveFailures.length} group(s) — none of the loaded account(s) (${accountLabel}) can access them. Reasons: ${tallyStr}`,
                        'yellow',
                    ),
                );
                console.log(
                    colorize(
                        '   Open Maintenance → Recovery cleanup to add the matching account, re-resolve, or remove these entries.',
                        'dim',
                    ),
                );
                // Persist the auto-disable so subsequent restarts are silent.
                try {
                    const cfg = loadConfig();
                    if (Array.isArray(cfg.groups)) {
                        const failedIds = new Set(_resolveFailures.map((f) => String(f.group.id)));
                        let dirty = false;
                        for (const g of cfg.groups) {
                            if (!g) continue;
                            if (failedIds.has(String(g.id))) {
                                g.enabled = false;
                                g._resolveFailedAt = Date.now();
                                g._resolveFailedReason =
                                    _resolveFailures.find(
                                        (f) => String(f.group.id) === String(g.id),
                                    )?.reason || 'index_miss';
                                dirty = true;
                            }
                        }
                        if (dirty) saveConfig(cfg);
                    }
                } catch (e) {
                    console.log(
                        colorize(`⚠️ Could not persist auto-disable: ${e?.message || e}`, 'yellow'),
                    );
                }
            }
        }

        // ---- Comment tracking: discover linked discussion groups --------
        // For groups with trackComments: true, fetch the channel's linked
        // discussion group ID via GetFullChannel. Messages from that group
        // are routed back through handleEvent using the parent group config.
        this.linkedChatMap = new Map();
        for (const group of enabledGroups) {
            if (!group.enabled || !group.trackComments) continue;
            try {
                const client = this.getClientForGroup(group);
                const result = await client.invoke(
                    new Api.channels.GetFullChannel({ channel: group.id }),
                );
                const linkedId = result?.fullChat?.linkedChatId;
                if (linkedId) {
                    const normalizeId = (id) => String(id).replace(/^-100/, '').replace(/^-/, '');
                    const normalizedLinkedId = normalizeId(linkedId);
                    this.linkedChatMap.set(normalizedLinkedId, {
                        group,
                        rawId: linkedId,
                    });
                    // Seed poll cursor for linked chat
                    try {
                        const history = await client.getMessages(linkedId, { limit: 1 });
                        if (history && history.length > 0) {
                            this.lastIds.set(`comment:${group.id}`, history[0].id);
                        }
                    } catch {
                        /* non-fatal */
                    }
                    console.log(
                        colorize(
                            `${new Date().toLocaleString()} 💬 Comment tracking active for "${group.name}" (linked chat: ${linkedId})`,
                            'cyan',
                        ),
                    );
                }
            } catch (e) {
                // Channel has no linked discussion group — skip silently
            }
        }

        // ---- Catch-up backfill (v2.3.34) -------------------------------
        //
        // For every monitored group whose newest stored message_id lags
        // Telegram's current top by more than `autoCatchUpThreshold`
        // messages, schedule a `catch-up` backfill so the gap that
        // accumulated while monitor was offline closes itself without
        // manual intervention. Honors the same per-group lock as a
        // user-triggered backfill (won't fight the user).
        try {
            const histCfg = this.config?.advanced?.history || {};
            const enabled = histCfg.autoCatchUp !== false; // default ON
            const threshold = Math.max(1, Number(histCfg.autoCatchUpThreshold) || 5);
            if (enabled) {
                const { getMessageIdRange } = await import('./db.js');
                for (const group of enabledGroups) {
                    if (!group.enabled) continue;
                    const top = _topPerGroup.get(String(group.id));
                    if (!top) continue;
                    const { maxMessageId, count } = getMessageIdRange(String(group.id));
                    // count === 0 means a brand-new group; auto-first
                    // backfill (POST /api/groups handler) covers that case
                    // already, so don't fire again here.
                    if (count === 0 || maxMessageId == null) continue;
                    const gap = top - maxMessageId;
                    if (gap >= threshold) {
                        // Emit so server.js (the only place that owns the
                        // history-job lifecycle) can spawn the backfill.
                        // Decoupling means monitor.js stays small + the
                        // CLI "monitor" command doesn't need a background
                        // backfill orchestrator (the standalone use case
                        // simply ignores this event).
                        try {
                            this.emit('catch_up_needed', { groupId: String(group.id), gap });
                        } catch (e) {
                            console.warn('[catch-up] emit failed:', e?.message || e);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[catch-up] hook error:', e?.message || e);
        }

        // Start Polling Loop (Smart Recursive Mode)
        this.startPollingLoop();

        // Create handler (Hybrid Mode)
        this.handler = async (event) => {
            if (this.running) await this.handleEvent(event);
        };

        // Rescue Mode delete handler — Raw subscription to the two delete
        // updates Telegram emits (UpdateDeleteChannelMessages for channels
        // & supergroups, UpdateDeleteMessages for legacy chats / DMs). When
        // a source message vanishes inside the retention window, mark the
        // local row rescued so the sweeper skips it.
        this.deleteHandler = async (update) => {
            if (!this.running) return;
            try {
                await this.handleDeleteEvent(update);
            } catch (e) {
                // Keep the monitor alive but log the cause — a silent swallow
                // here used to hide DB-locked + FloodWait + markRescued failures
                // from the rescue panel.
                console.warn('[monitor] delete event failed:', e?.message || e);
            }
        };

        // Register handler on ALL available clients (multi-account)
        this.handlerClients = [];
        if (this.accountManager && this.accountManager.count > 1) {
            for (const [_id, acctClient] of this.accountManager.clients) {
                try {
                    acctClient.addEventHandler(this.handler, new NewMessage({}));
                    acctClient.addEventHandler(
                        this.deleteHandler,
                        new Raw({
                            types: [Api.UpdateDeleteChannelMessages, Api.UpdateDeleteMessages],
                        }),
                    );
                    this.handlerClients.push(acctClient);
                } catch (e) {
                    /* skip failed clients */
                }
            }
        } else {
            this.client.addEventHandler(this.handler, new NewMessage({}));
            try {
                this.client.addEventHandler(
                    this.deleteHandler,
                    new Raw({
                        types: [Api.UpdateDeleteChannelMessages, Api.UpdateDeleteMessages],
                    }),
                );
            } catch (e) {
                /* old gramjs without Raw filter? — non-fatal */
            }
            this.handlerClients.push(this.client);
        }

        // Start download workers
        this.downloader.start();

        this.emit('started', {
            groupCount: enabledGroups.length,
            groups: enabledGroups.map((g) => g.name),
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

        const { isLocalGroup } = await import('./cluster/router.js').catch(() => ({
            isLocalGroup: () => true,
        }));
        const enabledGroups = this.config.groups.filter((g) => g.enabled && isLocalGroup(g));

        for (const group of enabledGroups) {
            // Tiny delay between groups to prevent flood (Rate Limit Protection)
            await new Promise((r) => setTimeout(r, 1000));

            try {
                const lastId = this.lastIds.get(group.id) || 0;
                const pollClient = this.getClientForGroup(group);

                // Fetch messages NEWER than lastId
                const messages = await pollClient.getMessages(group.id, {
                    minId: lastId,
                    limit: 10,
                });

                if (messages && messages.length > 0) {
                    messages.reverse();

                    for (const msg of messages) {
                        await this.handleEvent({ message: msg, client: pollClient });
                        if (msg.id > lastId) {
                            this.lastIds.set(group.id, msg.id);
                        }
                    }
                }
            } catch (e) {
                // Silent fail
            }
        }

        // Poll linked discussion groups for comment media
        if (this.linkedChatMap && this.linkedChatMap.size > 0) {
            for (const [, { group: parentGroup, rawId }] of this.linkedChatMap) {
                if (!parentGroup.enabled) continue;
                await new Promise((r) => setTimeout(r, 1000));
                try {
                    const lastIdKey = `comment:${parentGroup.id}`;
                    const lastId = this.lastIds.get(lastIdKey) || 0;
                    const pollClient = this.getClientForGroup(parentGroup);
                    const messages = await pollClient.getMessages(rawId, {
                        minId: lastId,
                        limit: 10,
                    });
                    if (messages && messages.length > 0) {
                        messages.reverse();
                        for (const msg of messages) {
                            await this.handleEvent({ message: msg, client: pollClient });
                            if (msg.id > lastId) {
                                this.lastIds.set(lastIdKey, msg.id);
                            }
                        }
                    }
                } catch (e) {
                    // Silent fail
                }
            }
        }
    }

    async stop() {
        this.running = false;
        // Restore console.error
        if (this._origConsoleError) {
            console.error = this._origConsoleError;
            this._origConsoleError = null;
        }
        if (this.urlFlushInterval) {
            clearInterval(this.urlFlushInterval);
            this.urlFlushInterval = null;
            await this.flushUrls(); // Final sync (awaited)
        }
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout); // Stop Hybrid Polling
            this.pollTimeout = null;
        }
        // Release the config-file watcher + any pending debounce timer.
        if (this._configWatcher) {
            try {
                this._configWatcher.close();
            } catch {
                /* already closed */
            }
            this._configWatcher = null;
        }
        if (this._configWatchDebounceClear) {
            this._configWatchDebounceClear();
            this._configWatchDebounceClear = null;
        }
        // Remove event handlers from ALL registered clients
        if (this.handler && this.handlerClients.length > 0) {
            for (const c of this.handlerClients) {
                try {
                    c.removeEventHandler(this.handler, new NewMessage({}));
                } catch (e) {
                    /* ignore */
                }
                if (this.deleteHandler) {
                    try {
                        c.removeEventHandler(
                            this.deleteHandler,
                            new Raw({
                                types: [Api.UpdateDeleteChannelMessages, Api.UpdateDeleteMessages],
                            }),
                        );
                    } catch (e) {
                        /* ignore */
                    }
                }
            }
            this.handlerClients = [];
            this.deleteHandler = null;
        }
        await this.downloader.stop();
        this.emit('stopped', this.stats);
    }

    async handleEvent(event) {
        const message = event.message;

        try {
            if (!message) return; // Ignore updates without message

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
                chatId =
                    message.peerId?.channelId?.toString() || message.peerId?.chatId?.toString();
            }

            if (!chatId) return; // Should not happen

            // Normalize ID helper (Handles -100 prefix and negative signs)
            const normalizeId = (id) => String(id).replace(/^-100/, '').replace(/^-/, '');

            const targetId = normalizeId(chatId);

            let group = this.config.groups.find((g) => normalizeId(g.id) === targetId && g.enabled);

            // Linked-chat messages use a distinct group_id (comment:<parentId>)
            // so they don't collide with the parent channel's message IDs in
            // the downloads table UNIQUE(group_id, message_id) constraint or
            // the queue de-duplication key.
            let commentGroupId = null;
            let commentGroupName = null;

            if (!group) {
                // Check if this is a linked discussion group (comment tracking)
                const linkedEntry = this.linkedChatMap?.get(targetId);
                if (linkedEntry) {
                    group = linkedEntry.group;
                    commentGroupId = `comment:${group.id}`;
                    commentGroupName = `${group.name} (comments)`;
                } else {
                    // Helpful log for users wondering why it's ignored
                    // Only log once per group per session to avoid spam
                    if (!this._unknownGroups) this._unknownGroups = new Set();
                    if (!this._unknownGroups.has(chatId)) {
                        // console.log(`⚠️  Ignored message from Group ID: ${chatId} (Not enabled in Config)`);
                        this._unknownGroups.add(chatId);
                    }
                    return;
                }
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

                // Detect TTL / self-destructing media — fast-path queue at the
                // front of the realtime lane so the file is captured before
                // it expires.
                const ttlSeconds = message?.media?.ttlSeconds;
                const priority = ttlSeconds && ttlSeconds > 0 ? 0 : 1;
                if (ttlSeconds) {
                    this.emit('download', {
                        group: group.name,
                        type: 'ttl',
                        messageId: message.id,
                        ttl: ttlSeconds,
                    });
                }

                // Rescue Mode: stamp the job with pending_until if this group
                // (or the global default) has rescue on. The DB row inserted
                // in registerDownload() carries this through, and the rescue
                // sweeper auto-deletes it after expiry unless markRescued()
                // fired in the meantime.
                const rescueMs = effectiveRescueMs(group, this.config);
                const pendingUntil = rescueMs ? Date.now() + rescueMs : null;

                // Pin the client that actually surfaced this message so the
                // downloader fetches bytes through the same session. The poll
                // path injects `event.client`; gramJS attaches `_client` to
                // messages delivered through the event handler. Without this
                // pin, every job went through the default account and any
                // group only the 2nd/3rd account could read failed silently.
                const sourceClient =
                    event.client ||
                    message._client ||
                    message.client ||
                    this.getClientForGroup(group);
                const { accountId, accountName } = this._describeAccount(sourceClient);

                const added = await this.downloader.enqueue(
                    {
                        message,
                        groupId: commentGroupId || group.id,
                        groupName: commentGroupName || group.name,
                        mediaType,
                        ttlSeconds,
                        pendingUntil,
                        client: sourceClient,
                        accountId,
                        accountName,
                    },
                    priority,
                );

                if (added) {
                    this.stats.downloaded++;
                    this.emit('download', {
                        group: commentGroupName || group.name,
                        type: mediaType,
                        messageId: message.id,
                    });
                } else {
                    this.stats.skipped++;
                }
            }
        } catch (error) {
            this.emit('error', { error: error.message });
        }
    }

    /**
     * Handle a Telegram delete-update.
     *
     * UpdateDeleteChannelMessages → channel/supergroup deletes; carries
     *   `channelId` so we can resolve the group reliably.
     * UpdateDeleteMessages → legacy chats and DMs; message_ids are globally
     *   unique per account, so we sweep every monitored group's pending
     *   rows for a matching message_id.
     *
     * For each rescued row we emit a `rescued` WS event and bump the
     * stats counter so the SPA can refresh badges live.
     */
    async handleDeleteEvent(update) {
        const ids = Array.isArray(update?.messages) ? update.messages : [];
        if (!ids.length) return;
        const cls = update?.className || '';
        const isChannel = cls === 'UpdateDeleteChannelMessages' || update?.channelId != null;

        if (isChannel) {
            const channelId = update.channelId?.toString?.() || String(update.channelId || '');
            if (!channelId) return;
            const normalize = (id) => String(id).replace(/^-100/, '').replace(/^-/, '');
            const target = normalize(channelId);
            const group = this.config.groups.find((g) => normalize(g.id) === target);
            if (!group) return;
            for (const mid of ids) {
                try {
                    const changed = markRescued(group.id, Number(mid));
                    if (changed > 0) {
                        this.emit('rescued', { groupId: String(group.id), messageId: Number(mid) });
                    }
                } catch {
                    /* swallow */
                }
            }
        } else {
            // DM / small-group delete — no channelId. Telegram message IDs
            // are unique per account, so try every monitored group.
            for (const mid of ids) {
                for (const group of this.config.groups) {
                    try {
                        const changed = markRescued(group.id, Number(mid));
                        if (changed > 0) {
                            this.emit('rescued', {
                                groupId: String(group.id),
                                messageId: Number(mid),
                            });
                            break; // matched a row — no need to check other groups
                        }
                    } catch {
                        /* swallow */
                    }
                }
            }
        }
    }

    passUserFilter(message, group) {
        if (!group.trackUsers?.enabled) return true;
        if (group.trackUsers.mode === 'all') return true;

        const senderId = String(message.senderId || '');
        const isTracked = (group.trackUsers.users || []).some(
            (u) => String(u.id) === senderId || u.username === message.sender?.username,
        );

        // Also check global tracked users
        const globalTracked = (this.config.globalTrackedUsers || []).some(
            (u) => String(u.id) === senderId || u.username === message.sender?.username,
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
                (
                    m.photo ||
                    m.document ||
                    m.sticker || // Check inside media
                    m.className === 'MessageMediaPhoto' ||
                    m.className === 'MessageMediaDocument' ||
                    (m.className === 'MessageMediaWebPage' && m.webPage?.document)
                ) // Webpage with media preview
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
        // Resolve actual media object — message.media may itself wrap a
        // photo/document, but the inner shape is already what we want.
        let m = message;
        if (message.media && !message.photo && !message.document && !message.sticker) {
            m = message.media;
        }

        // 1. Check for Sticker
        if (m.sticker || message.sticker) return 'stickers';

        // 2. Check document mime type for sticker/webp
        const doc = m.document || (m.className === 'MessageMediaDocument' ? m : null);
        if (doc) {
            const mime = doc.mimeType || '';
            if (mime.includes('image/webp') || mime.includes('application/x-tgsticker'))
                return 'stickers';
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

        urls.forEach((url) => {
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

            const group = this.config.groups.find((g) => g.id === groupId);
            const groupName = group ? group.name : groupId;
            const safeName = sanitizeName(groupName);
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
