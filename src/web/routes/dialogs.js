import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs, { existsSync } from 'fs';
import { loadConfig } from '../../config/manager.js';
import { DIALOG_CACHE_TTL_MS } from '../../core/constants.js';
import { nameLooksUnresolved } from '../lib/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../../data');
const fsSync = fs;

// Module-level dialogs response cache — shared via export so other routers
// can invalidate it without importing an entire response object.
export let _dialogsResponseCache = { at: 0, body: null };
export function invalidateDialogsCache() {
    _dialogsResponseCache = { at: 0, body: null };
}

// Deps injected by createDialogsRouter before first route hit
let _getAccountManager = null;
let _getTelegramClient = null;

let _dialogsNameCache = { at: 0, byId: new Map() };
// Parallel type cache so the sidebar's Downloaded Groups list can
// distinguish channel / group / user / bot icons (matches what Manage
// Groups already shows). Keyed by the same string id; values are one
// of 'channel' | 'group' | 'user' | 'bot'.
let _dialogsTypeCache = new Map();
export async function getDialogsNameCache() {
    const now = Date.now();
    if (
        Math.max(0, now - _dialogsNameCache.at) < DIALOG_CACHE_TTL_MS &&
        _dialogsNameCache.byId.size > 0
    ) {
        return _dialogsNameCache.byId;
    }
    const byId = new Map();
    const typeById = new Map();
    try {
        const am = await _getAccountManager();
        const clients = [];
        for (const [, c] of am.clients) clients.push(c);
        const _tc = _getTelegramClient?.();
        if (_tc?.connected && !clients.includes(_tc)) clients.push(_tc);

        for (const client of clients) {
            if (!client?.connected) continue;
            try {
                const [active, archived] = await Promise.all([
                    client.getDialogs({ limit: 500 }).catch(() => []),
                    client.getDialogs({ limit: 200, archived: true }).catch(() => []),
                ]);
                for (const d of [...active, ...archived]) {
                    const id = String(d.id);
                    const name =
                        d.title ||
                        d.name ||
                        (
                            (d.entity?.firstName || '') +
                            (d.entity?.lastName ? ' ' + d.entity.lastName : '')
                        ).trim() ||
                        d.entity?.username ||
                        null;
                    if (name && !nameLooksUnresolved(name, id) && !byId.has(id)) {
                        byId.set(id, name);
                    }
                    if (!typeById.has(id)) {
                        let t = 'group';
                        if (d.isChannel) t = 'channel';
                        else if (d.isUser && d.entity?.bot) t = 'bot';
                        else if (d.isUser) t = 'user';
                        typeById.set(id, t);
                    }
                    // Hard cap so a runaway upstream (multi-account user
                    // with 50 k+ joined dialogs) can't blow the heap. See
                    // CLAUDE.md → Big-data patterns rule 3.
                    if (byId.size > 50000) break;
                }
            } catch {
                /* one bad client doesn't kill the whole sweep */
            }
        }
    } catch {
        /* no AM — fresh install */
    }
    _dialogsNameCache = { at: now, byId };
    _dialogsTypeCache = typeById;
    return byId;
}

// Lookup helper used by /api/groups and /api/downloads to enrich each
// row with its dialog type. Falls back to null when the type isn't
// known yet — the front-end then leans on the avatar's id-based
// heuristic (which is correct often but conflates supergroups with
// channels because both share the `-100…` id prefix).
export function dialogsTypeFor(id) {
    return _dialogsTypeCache.get(String(id)) || null;
}

export function createDialogsRouter({ getAccountManager, getTelegramClient }) {
    _getAccountManager = getAccountManager;
    _getTelegramClient = getTelegramClient;
    const router = express.Router();

    // 2. Dialogs API (Groups)
    // /api/dialogs response cache. Telegram rate-limits getDialogs aggressively
    // and the picker is opened many times in a typical session — caching the
    // fully-built result for 5 min cuts the Telegram round-trip out of every
    // repeat open. `?fresh=1` forces a refetch if the user wants to see a
    // just-added chat.
    // `at` is wallclock milliseconds; comparisons elsewhere always use Math.max(0, …)
    // to stay safe across NTP backward jumps.

    router.get('/dialogs', async (req, res) => {
        try {
            const wantFresh = req.query.fresh === '1';
            const now = Date.now();
            if (
                !wantFresh &&
                _dialogsResponseCache.body &&
                Math.max(0, now - _dialogsResponseCache.at) < DIALOG_CACHE_TTL_MS
            ) {
                return res.json(_dialogsResponseCache.body);
            }

            // Collect every connected client + its account metadata. Manage
            // Groups must surface chats from EVERY linked account — using only
            // the default client made groups visible to a second/third account
            // silently disappear from the picker. We also keep `[accountId, meta]`
            // pairs so the response can attribute each dialog back to the account
            // it came from.
            const clientPairs = []; // [{ id, meta, client }]
            try {
                const am = await getAccountManager();
                for (const [accountId, c] of am.clients) {
                    if (!c?.connected) continue;
                    const meta = am.metadata.get(accountId) || { id: accountId };
                    clientPairs.push({ id: accountId, meta, client: c });
                }
            } catch {
                /* no creds yet */
            }
            const telegramClient = _getTelegramClient?.();
            if (
                telegramClient?.connected &&
                !clientPairs.some((p) => p.client === telegramClient)
            ) {
                clientPairs.push({
                    id: 'legacy',
                    meta: { id: 'legacy', name: 'Default', phone: '', username: '' },
                    client: telegramClient,
                });
            }
            if (clientPairs.length === 0) {
                // Distinguish "no Telegram account configured yet" (operator
                // hasn't run through Add Account) from "client is briefly
                // disconnected" — the SPA renders a friendly empty-state with
                // an Add Account CTA for the former, vs. a red error for the
                // latter.
                const sessionsDir = path.join(DATA_DIR, 'sessions');
                const hasSession =
                    existsSync(sessionsDir) &&
                    fsSync.readdirSync(sessionsDir).some((f) => f.endsWith('.enc'));
                if (!hasSession) {
                    return res
                        .status(503)
                        .json({ error: 'no_account', message: 'No Telegram account configured' });
                }
                return res
                    .status(503)
                    .json({ error: 'not_connected', message: 'Telegram client not connected' });
            }

            const config = loadConfig();
            const configGroups = config.groups || [];
            const allowDM = config.allowDmDownloads === true;

            // Fan out across every account — active + archived per client in
            // parallel. One bad client (e.g. mid-reconnect) doesn't kill the
            // sweep; we just lose its chats from this response and pick them
            // up on the next refresh.
            const perClient = await Promise.all(
                clientPairs.map(async (p) => {
                    const [a, ar] = await Promise.all([
                        p.client.getDialogs({ limit: 500 }).catch(() => []),
                        p.client.getDialogs({ limit: 200, archived: true }).catch(() => []),
                    ]);
                    return { accountId: p.id, accountMeta: p.meta, active: a, archived: ar };
                }),
            );

            // Build maps keyed by dialog id:
            //   firstDialog[id] -> { d, archived } picked on first sighting (active wins over archived)
            //   accountIds[id]  -> Set of every accountId that sees this chat
            const firstDialog = new Map();
            const accountIds = new Map();
            const nameById = new Map(_dialogsNameCache.byId);

            for (const p of perClient) {
                for (const isArchived of [false, true]) {
                    const list = isArchived ? p.archived : p.active;
                    for (const d of list) {
                        const id = String(d.id);

                        if (!accountIds.has(id)) accountIds.set(id, new Set());
                        accountIds.get(id).add(p.accountId);

                        if (!firstDialog.has(id)) firstDialog.set(id, { d, archived: isArchived });

                        // Side-effect: warm the name cache used by /api/groups +
                        // /api/downloads. Free since we already have the dialog
                        // objects in hand.
                        const nm =
                            d.title ||
                            d.name ||
                            (
                                (d.entity?.firstName || '') +
                                (d.entity?.lastName ? ' ' + d.entity.lastName : '')
                            ).trim() ||
                            d.entity?.username ||
                            null;
                        if (nm && !nameLooksUnresolved(nm, id)) nameById.set(id, nm);
                    }
                }
            }
            _dialogsNameCache = { at: now, byId: nameById };

            // Account directory for the response — lets the SPA render account
            // chips by id without a second round-trip to /api/accounts.
            const accounts = clientPairs.map((p) => ({
                id: p.id,
                name: p.meta?.name || p.meta?.username || p.id,
                phone: p.meta?.phone || '',
                username: p.meta?.username || '',
            }));

            const merged = [];
            for (const [, entry] of firstDialog) {
                merged.push(entry);
            }

            const results = merged
                .filter(({ d }) => {
                    if (d.isGroup || d.isChannel) return true;
                    // DMs (user/bot conversations) are off by default for privacy;
                    // gated behind the allowDmDownloads master switch.
                    return !!d.isUser && allowDM;
                })
                .map(({ d, archived }) => {
                    const id = d.id.toString();
                    const configGroup = configGroups.find((g) => String(g.id) === id);
                    let type = 'group';
                    if (d.isChannel) type = 'channel';
                    else if (d.isUser && d.entity?.bot) type = 'bot';
                    else if (d.isUser) type = 'user';
                    // Stable order so the SPA can render account chips deterministically.
                    const accIds = Array.from(accountIds.get(id) || []).sort();
                    return {
                        id,
                        name:
                            d.title ||
                            d.name ||
                            (d.entity?.firstName || '') +
                                (d.entity?.lastName ? ' ' + d.entity.lastName : '') ||
                            'Unknown',
                        type,
                        username: d.username,
                        archived,
                        members: d.entity?.participantsCount || null,
                        enabled: configGroup?.enabled || false,
                        inConfig: !!configGroup,
                        filters: configGroup?.filters || {
                            photos: true,
                            videos: true,
                            files: true,
                            links: true,
                            voice: false,
                            gifs: false,
                            stickers: false,
                        },
                        autoForward: configGroup?.autoForward || {
                            enabled: false,
                            destination: null,
                            deleteAfterForward: false,
                            keepImages: false,
                            keepVideos: false,
                        },
                        photoUrl: `/api/groups/${id}/photo`,
                        accountIds: accIds,
                    };
                });

            const body = { success: true, dialogs: results, allowDM, accounts };
            _dialogsResponseCache = { at: now, body };
            res.json(body);
        } catch (error) {
            console.error('GET /api/dialogs:', error);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // 3. Config Groups List (with Photo URLs)

    // Server-side cache of `id -> name` from every connected account's
    // dialog list. Refreshed on demand with a 5-minute TTL — Telegram
    // rate-limits getDialogs heavily, so we don't want to call it on
    // every /api/groups request.

    return router;
}
