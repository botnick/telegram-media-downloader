// Chat access state in the dashboard — one badge, one wording, everywhere.
//
// The server tells us, per chat, whether it can still be used (`access` on
// /api/groups, /api/dialogs and /api/chats/lookup rows; src/core/
// chat-access.js on the server). A chat no account can read is paused — no
// polling, backfill, avatar lookups or forwarding — until a re-check or a
// dialogs sync sees it again. This module turns that state into the badge
// (Chats list, sidebar, Add sheet, chat page), the plain-words reason and
// what to do, and the actions (Check again, Follow the new group, Stop
// monitoring, Remove from list).

import { api } from './api.js';
import { state } from './store.js';
import { escapeHtml, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const BLOCKING = new Set(['left', 'banned', 'private', 'deleted', 'restricted', 'migrated']);

const ICON = {
    left: 'ri-logout-box-r-line',
    banned: 'ri-forbid-2-line',
    private: 'ri-lock-2-line',
    deleted: 'ri-delete-bin-6-line',
    restricted: 'ri-error-warning-line',
    migrated: 'ri-arrow-right-up-line',
};

const LABEL = {
    left: ['access.state.left', 'Not a member'],
    banned: ['access.state.banned', 'Banned'],
    private: ['access.state.private', 'Private'],
    deleted: ['access.state.deleted', 'Deleted'],
    restricted: ['access.state.restricted', 'Restricted'],
    migrated: ['access.state.migrated', 'Moved'],
};

const REASON = {
    left: [
        'access.reason.left',
        'None of your accounts is a member of this chat any more — it was left, or the account that was in it is gone.',
    ],
    banned: ['access.reason.banned', 'Your account was banned or removed from this chat.'],
    private: [
        'access.reason.private',
        "This chat is private and your accounts can't open it any more — you left, were removed, or it became private.",
    ],
    deleted: [
        'access.reason.deleted',
        "Telegram says this chat doesn't exist any more — it was deleted, or its link is no longer valid.",
    ],
    restricted: ['access.reason.restricted', "Telegram restricts this chat, so it can't be read."],
    migrated: [
        'access.reason.migrated',
        'This group was upgraded to a supergroup with a new id. New posts go to the new group.',
    ],
};

const ADVICE = {
    left: [
        'access.advice.rejoin',
        'Rejoin it in Telegram with one of your accounts, then press Check again — or stop monitoring it.',
    ],
    banned: [
        'access.advice.banned',
        'Ask a chat admin to let you back in, or use another account that is still a member — or stop monitoring it.',
    ],
    private: [
        'access.advice.rejoin',
        'Rejoin it in Telegram with one of your accounts, then press Check again — or stop monitoring it.',
    ],
    deleted: [
        'access.advice.deleted',
        'Nothing new will arrive. Stop monitoring it or remove it from the list — downloaded files stay.',
    ],
    restricted: [
        'access.advice.restricted',
        "It can't be downloaded while Telegram restricts it. Check again later, or stop monitoring it.",
    ],
    migrated: [
        'access.advice.migrated',
        'Follow the new group to keep downloading with the same settings.',
    ],
};

const tr = (pair) => i18nT(pair[0], pair[1]);

/** True when the chat is paused because no account can read it. */
export function isBlockedAccess(access) {
    return !!access && BLOCKING.has(access.state);
}

/** Access of a chat: its config entry's (from /api/groups), else the dialog's. */
export function accessFor(id, fallback = null) {
    const key = String(id);
    const g = (state.groups || []).find((x) => String(x.id) === key && !x.peerId);
    if (g?.access) return g.access;
    const d = (state.allDialogs || []).find((x) => String(x.id) === key);
    if (d?.access) return d.access;
    return fallback?.access || { state: 'ok' };
}

export function accessLabel(access) {
    const p = LABEL[access?.state];
    return p ? tr(p) : '';
}

/** Plain-words reason (with Telegram's own restriction text when given). */
export function accessReason(access) {
    const p = REASON[access?.state];
    if (!p) return '';
    let text = tr(p);
    if (access.state === 'restricted' && access.detail && access.detail !== 'restricted') {
        text += ` ${i18nTf('access.reason.restricted_detail', { text: access.detail }, `Telegram says: “${access.detail}”`)}`;
    }
    if (access.state === 'banned' && /^until:\d+$/.test(String(access.detail || ''))) {
        const until = Number(String(access.detail).slice(6)) * 1000;
        if (until > Date.now()) {
            text += ` ${i18nTf('access.reason.banned_until', { when: new Date(until).toLocaleString() }, `The ban ends ${new Date(until).toLocaleString()}.`)}`;
        }
    }
    return text;
}

export function accessAdvice(access) {
    const p = ADVICE[access?.state];
    return p ? tr(p) : '';
}

/** The badge. Empty string for a chat that's fine. */
export function accessBadgeHtml(access, { compact = false } = {}) {
    if (!isBlockedAccess(access)) return '';
    const label = accessLabel(access);
    const title = `${i18nT('access.badge.title', "Can't reach this chat")} — ${accessReason(access)}`;
    return `<span class="access-badge${compact ? ' access-badge--compact' : ''}" data-access="${escapeHtml(access.state)}" title="${escapeHtml(title)}"><i class="${ICON[access.state] || 'ri-error-warning-line'}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></span>`;
}

function relTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const lang = document.documentElement.lang || 'en';
    const diff = Math.round((ms - Date.now()) / 1000);
    const abs = Math.abs(diff);
    try {
        const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
        if (abs < 60) return rtf.format(0, 'minute');
        if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
        return rtf.format(Math.round(diff / 86400), 'day');
    } catch {
        return new Date(ms).toLocaleString();
    }
}

function accountName(id) {
    // Either list knows the account: /api/dialogs' directory, or
    // /api/accounts (the chat page loads it).
    const list = [...(state.dialogsAccounts || []), ...(state.accountsList || [])];
    const a = list.find((x) => String(x.id) === String(id));
    if (!a) return String(id);
    return a.username ? `@${a.username}` : a.name || a.phone || a.id;
}

/** "Telegram said CHANNEL_PRIVATE · since 2 hours ago · checked … · next check …" */
export function accessMetaLine(access, { showNext = true } = {}) {
    if (!isBlockedAccess(access)) return '';
    const parts = [];
    if (access.code) {
        parts.push(
            i18nTf('access.meta.code', { code: access.code }, `Telegram said ${access.code}`),
        );
    }
    if (access.firstSeenAt) {
        parts.push(
            i18nTf(
                'access.meta.since',
                { when: relTime(access.firstSeenAt) },
                `since ${relTime(access.firstSeenAt)}`,
            ),
        );
    }
    if (access.checkedAt && access.checkedAt !== access.firstSeenAt) {
        parts.push(
            i18nTf(
                'access.meta.checked',
                { when: relTime(access.checkedAt) },
                `checked ${relTime(access.checkedAt)}`,
            ),
        );
    }
    // Re-checks run for monitored chats only (see the caller).
    if (showNext && access.nextCheckAt) {
        parts.push(
            access.nextCheckAt <= Date.now() + 60_000
                ? i18nT('access.meta.next_soon', 'next check soon')
                : i18nTf(
                      'access.meta.next',
                      { when: relTime(access.nextCheckAt) },
                      `next check ${relTime(access.nextCheckAt)}`,
                  ),
        );
    }
    return parts.join(' · ');
}

/** "Accounts asked: @a (private), @b (not a member)" — only with 2+ accounts. */
export function accessAccountsLine(access) {
    const list = Array.isArray(access?.accounts) ? access.accounts : [];
    if (list.length < 2) return '';
    const items = list.map((a) => {
        const st =
            a.state === 'ok' ? i18nT('access.meta.account_ok', 'can read it') : accessLabel(a);
        return `${accountName(a.id)} (${st})`;
    });
    return i18nTf(
        'access.meta.accounts',
        { list: items.join(', ') },
        `Accounts asked: ${items.join(', ')}`,
    );
}

/** Mirror a fresh access answer into the in-memory lists. */
export function applyAccess(id, access) {
    const key = String(id);
    for (const g of state.groups || []) {
        if (String(g.id) === key && !g.peerId) g.access = access;
    }
    for (const d of state.allDialogs || []) {
        if (String(d.id) === key) d.access = access;
    }
}

/**
 * "Check again" for one chat: asks the server to try every account now.
 * Resolves to the server's answer (`{ state, access, inconclusive }`).
 */
export async function recheckChat(id, { name = '', toast = true } = {}) {
    const r = await api.post('/api/chats/access/recheck', { id: String(id) });
    if (r?.access) applyAccess(id, r.access);
    if (toast) {
        const who = name || String(id);
        if (r?.state === 'ok') {
            showToast(
                i18nTf('access.toast.back', { name: who }, `${who} can be reached again.`),
                'success',
            );
        } else if (r?.inconclusive) {
            showToast(
                i18nT(
                    'access.toast.inconclusive',
                    "Couldn't check right now — Telegram asked to wait or no account is connected. Try again later.",
                ),
                'warning',
            );
        } else {
            showToast(
                i18nTf(
                    'access.toast.still',
                    { name: who, state: accessLabel(r?.access) },
                    `Still can't reach ${who} (${accessLabel(r?.access)}).`,
                ),
                'warning',
            );
        }
    }
    return r;
}

/**
 * "Check all again": the server re-checks every configured chat that
 * can't be reached, one every 2 s, in the background (progress over WS:
 * `chat_access_recheck_progress` / `_done`). Resolves to `{ started, total }`.
 */
export async function recheckAllUnreachable() {
    return api.post('/api/chats/access/recheck', { all: true });
}

/** A migrated basic group: add the new supergroup with the same settings. */
export async function followMigration(id) {
    const r = await api.post(`/api/chats/${encodeURIComponent(String(id))}/follow-migration`, {});
    showToast(i18nT('access.toast.followed', 'Now following the new group.'), 'success');
    return r;
}

export async function stopMonitoringChats(ids) {
    const r = await api.post('/api/chats/access/stop', { ids: ids.map(String) });
    showToast(i18nT('access.toast.stopped', 'Monitoring stopped.'), 'success');
    return r;
}

/** Remove from the list — config only; files and gallery rows stay. */
export async function removeChatsFromList(ids) {
    const r = await api.post('/api/chats/access/remove', { ids: ids.map(String) });
    showToast(i18nT('access.toast.removed', 'Removed from the list — files kept.'), 'success');
    return r;
}

/** Configured chats (this instance) that can't be reached. */
export function unreachableGroups() {
    return (state.groups || []).filter((g) => !g.peerId && isBlockedAccess(g.access));
}
