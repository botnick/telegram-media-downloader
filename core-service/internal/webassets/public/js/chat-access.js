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
import { openSheet } from './sheet.js';
import { escapeHtml, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const BLOCKING = new Set(['left', 'banned', 'private', 'inaccessible', 'deleted', 'restricted', 'migrated']);

const ICON = {
    left: 'ri-logout-box-r-line',
    banned: 'ri-forbid-2-line',
    private: 'ri-lock-2-line',
    inaccessible: 'ri-lock-2-line',
    deleted: 'ri-delete-bin-6-line',
    restricted: 'ri-error-warning-line',
    migrated: 'ri-arrow-right-up-line',
};

const LABEL = {
    left: ['access.state.left', 'Not a member'],
    banned: ['access.state.banned', 'Banned'],
    private: ['access.state.private', 'Private'],
    inaccessible: ['access.state.inaccessible', 'Inaccessible'],
    unknown: ['access.state.unknown', 'Not yet confirmed'],
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
    inaccessible: ['access.reason.inaccessible', "Telegram does not allow access to this chat. This does not confirm that it was deleted."],
    deleted: ['access.reason.deleted', 'Telegram marks this chat or account as deleted.'],
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
    inaccessible: ['access.advice.inaccessible', 'Check again to refresh its Telegram status, or leave / remove it from the selected account.'],
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

/** Live Telegram dialog metadata overrides potentially stale saved config. */
export function accessFor(id, fallback = null) {
    const key = String(id);
    const d = (state.allDialogs || []).find((x) => String(x.id) === key);
    if (d?.access) return d.access;
    if (fallback?.access) return fallback.access;
    const g = (state.groups || []).find((x) => String(x.id) === key && !x.peerId);
    return g?.access || { state: 'unknown' };
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
export function accessMetaLine(access) {
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
 * Missing rows and unknown metadata are inconclusive, never proof of deletion.
 */
export async function recheckChat(id, { name = '', toast = true } = {}) {
    await refreshDialogs();
    const dialog = (state.allDialogs || []).find((d) => String(d.id) === String(id));
    const access = dialog?.access;
    const r = { state: access?.state || 'unknown', access, inconclusive: !access || access.state === 'unknown' };
    if (access) applyAccess(id, access);
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

/** Refresh Telegram metadata and notify every open chat view. No remote mutation. */
export async function refreshDialogs() {
    const r = await api.get('/api/dialogs?fresh=1', { timeoutMs: 120_000 });
    if (!Array.isArray(r?.dialogs)) throw new Error(i18nT('groups.load_failed', 'Failed to load dialogs'));
    state.allDialogs = r.dialogs;
    state.dialogsAccounts = Array.isArray(r.accounts) ? r.accounts : [];
    window.dispatchEvent(new CustomEvent('dialogs-refreshed'));
    return r;
}

export async function recheckAllUnreachable() {
    const ids = unavailableChats().map((c) => String(c.id));
    await refreshDialogs();
    return { total: ids.length, reachable: ids.filter((id) => accessFor(id).state === 'ok').length };
}

/** All known chats, with fresh dialog metadata and local monitoring settings. */
export function mergedChats() {
    const byId = new Map();
    for (const g of state.groups || []) {
        if (!g.peerId) byId.set(String(g.id), { ...g, id: String(g.id), inConfig: true });
    }
    for (const d of state.allDialogs || []) {
        const id = String(d.id);
        const g = byId.get(id);
        byId.set(id, {
            ...g, ...d, id,
            inConfig: !!g || !!d.inConfig,
            enabled: g ? g.enabled !== false : !!d.enabled,
            access: d.access || g?.access || { state: 'unknown' },
        });
    }
    return [...byId.values()];
}

export function unavailableChats() {
    return mergedChats().filter((c) => isBlockedAccess(c.access));
}

/** Explicit, single-account Telegram removal. Opening or dismissing never submits. */
export function openLeaveChatSheet(chat, { onRemoved } = {}) {
    const id = String(chat.id);
    const current = (state.allDialogs || []).find((d) => String(d.id) === id) || chat;
    const access = accessFor(id, current);
    const holders = [...new Set((current.accountIds || access.accounts?.map((a) => a.id) || []).map(String))];
    // A chat no account holds any more can still be removed from the app.
    const ids = holders.length ? holders : [...new Set((state.dialogsAccounts || state.accountsList || []).map((a) => String(a.id)))];
    const isDM = current.type === 'user' || current.type === 'bot' || Number(id) > 0;
    const name = chat.name || current.name || id;
    const type = isDM ? i18nT('groups.type.user', 'Direct message')
        : current.type === 'channel' ? i18nT('groups.type.channel', 'Channel') : i18nT('groups.type.group', 'Group');
    const box = document.createElement('div');
    box.className = 'chat-leave-sheet';
    box.innerHTML = `
        <p class="chat-leave-name">${escapeHtml(name)}</p>
        <p class="cd-help">${escapeHtml(type)} · ${escapeHtml(id)}</p>
        <p>${escapeHtml(isDM
            ? i18nT('access.leave.dm_effect', 'Removes this conversation and its history only from the selected Telegram account. It does not delete the other person’s history.')
            : i18nT('access.leave.group_effect', 'Leaves this group or channel using the selected Telegram account. You may need an invitation to join again.'))}</p>
        <p>${escapeHtml(i18nT('access.leave.files_kept', 'Downloaded files stay in your library. Other Telegram accounts are unchanged.'))}</p>
        <label class="cd-label" for="chat-leave-account">${escapeHtml(i18nT('access.leave.account', 'Telegram account'))}</label>
        <select id="chat-leave-account" class="tg-input" data-leave-account>
            <option value="">${escapeHtml(i18nT('access.leave.choose_account', 'Choose an account…'))}</option>
            ${ids.map((accountId) => {
                const evidence = access.accounts?.find((a) => String(a.id) === accountId);
                const label = evidence?.state === 'ok' ? i18nT('access.meta.account_ok', 'can read it') : accessLabel(evidence);
                return `<option value="${escapeHtml(accountId)}">${escapeHtml(accountName(accountId))}${label ? ` — ${escapeHtml(label)}` : ''}</option>`;
            }).join('')}
        </select>
        <p class="cd-help">${escapeHtml(i18nT('access.leave.choose_help', 'Only the account you choose will be changed.'))}</p>
        <p class="chat-leave-status" data-leave-status role="status" aria-live="polite">${ids.length ? '' : escapeHtml(i18nT('access.leave.no_account', 'No account is confirmed for this chat. Check again before removing it.'))}</p>
        <div class="cd-access-actions">
            <button type="button" class="tg-btn-secondary" data-leave-cancel>${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>
            <button type="button" class="tg-btn" data-leave-confirm disabled>${escapeHtml(i18nT('access.leave.confirm', 'Confirm leave / remove'))}</button>
        </div>`;
    const handle = openSheet({ title: i18nT('access.leave.title', 'Leave / remove from Telegram?'), content: box });
    const select = box.querySelector('[data-leave-account]');
    const confirm = box.querySelector('[data-leave-confirm]');
    const status = box.querySelector('[data-leave-status]');
    const cancel = box.querySelector('[data-leave-cancel]');
    let busy = false;
    let removed = false;
    select.addEventListener('change', () => { confirm.disabled = busy || removed || !ids.includes(select.value); });
    cancel.addEventListener('click', () => handle.close());
    // No form or global Enter shortcut: only activating the final button submits.
    confirm.addEventListener('click', async () => {
        const accountId = select.value;
        if (busy || removed || !ids.includes(accountId)) return;
        busy = true;
        confirm.disabled = true;
        select.disabled = true;
        status.dataset.kind = '';
        status.textContent = i18nT('access.leave.working', 'Request sent to Telegram. Closing this dialog does not cancel it. Waiting for the result…');
        cancel.textContent = i18nT('access.leave.close_running', 'Close — request continues');
        try {
            const r = await api.post(`/api/chats/${encodeURIComponent(id)}/leave`, { accountId, confirm: id }, { timeoutMs: 120_000 });
            if (r?.success !== true) throw new Error(r?.error || i18nT('access.leave.failed', 'Telegram did not confirm removal.'));
            removed = true;
            const warning = r.warning ? i18nTf('access.leave.partial_success', { message: String(r.warning) }, `Telegram removed the chat, but local cleanup needs attention: ${r.warning}`) : '';
            if (r.localConfigRemoved || r.alreadyGone) state.groups = (state.groups || []).filter((g) => g.peerId || String(g.id) !== id);
            try {
                await refreshDialogs();
                onRemoved?.(r);
                if (warning) {
                    status.textContent = warning;
                    status.dataset.kind = 'warning';
                    showToast(warning, 'warning', 7000);
                } else {
                    handle.close();
                    showToast(r.alreadyGone
                        ? i18nT('access.leave.already_gone', 'Already gone on Telegram — removed from the app. Downloaded files kept.')
                        : i18nT('access.leave.success', 'Removed from the selected Telegram account. Downloaded files kept.'), 'success');
                }
            } catch {
                status.textContent = [warning, i18nT('access.leave.refresh_failed', 'Telegram confirmed removal, but the list could not refresh. Close this dialog and press Check again.')].filter(Boolean).join(' ');
                status.dataset.kind = 'warning';
                showToast(status.textContent, 'warning');
            }
        } catch (e) {
            status.textContent = e?.data?.message || e?.data?.error || e?.message || i18nT('access.leave.failed', 'Telegram did not confirm removal.');
            status.dataset.kind = 'error';
            showToast(status.textContent, 'error', 7000);
        } finally {
            busy = false;
            cancel.textContent = removed ? i18nT('common.close', 'Close') : i18nT('common.cancel', 'Cancel');
            select.disabled = removed;
            confirm.disabled = removed || !ids.includes(select.value);
        }
    });
    return handle;
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
    return (state.groups || []).filter((g) => !g.peerId && isBlockedAccess(accessFor(g.id, g)));
}
