// "Add" sheet — what the + (FAB) button opens — plus the chat result rows
// it shares with the Chats page and the account wizard's last step.
//
// One field takes a chat name (searches your chats), an @username, or a
// t.me link: public (t.me/name), private (t.me/c/<id>), invite
// (t.me/+hash, joinchat/…) or message link. Chats show up as rows with a
// Monitor switch and "Backfill…"; a message link gets a Download button
// (POST /api/download/url, the same endpoint the paste-link sheet uses).
// Names are matched against the dialogs list in the browser; anything
// else goes to GET /api/chats/lookup.
//
// Turning Monitor on for a chat that isn't configured yet adds it with
// photos + videos only and says so, with a "Customize" link to its chat
// details page — no settings dialog in the way.

import { api } from './api.js';
import { state, getGroupName, updateGroupNameCache } from './store.js';
import { createAvatar, escapeHtml, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { openSheet } from './sheet.js';
import { navigate } from './router.js';
import { accessBadgeHtml, accessFor, isBlockedAccess } from './chat-access.js';

/** Media types a chat gets when it's added from a row or the Add sheet. */
export const NEW_CHAT_FILTERS = {
    photos: true,
    videos: true,
    files: false,
    links: false,
    voice: false,
    gifs: false,
    stickers: false,
    urls: false,
};

/** This instance's config entry for a chat (not a cluster peer's copy). */
export function findConfigGroup(id) {
    return (state.groups || []).find((g) => String(g.id) === String(id) && !g.peerId) || null;
}

export function findDialog(id) {
    return (state.allDialogs || []).find((d) => String(d.id) === String(id)) || null;
}

/**
 * PUT /api/groups/:id and mirror the result into the in-memory lists, so
 * the sidebar, the Chats page and the rows agree before the WebSocket
 * `config_updated` reload lands. Resolves to the saved config entry.
 */
export async function saveChatConfig(id, body) {
    const r = await api.put(`/api/groups/${encodeURIComponent(id)}`, body);
    const group = r?.group || null;
    if (!group) return null;
    const key = String(id);
    const list = state.groups || (state.groups = []);
    const i = list.findIndex((g) => String(g.id) === key && !g.peerId);
    const merged =
        i >= 0
            ? { ...list[i], ...group, id: list[i].id }
            : {
                  ...group,
                  id: key,
                  type: group.type || findDialog(key)?.type || null,
                  photoUrl: null,
                  peerId: null,
                  peerName: null,
              };
    if (i >= 0) list[i] = merged;
    else list.push(merged);
    const d = findDialog(key);
    if (d) {
        d.inConfig = true;
        d.enabled = group.enabled === true;
        d.suspended = group.suspended === true;
    }
    return merged;
}

/** Monitor on/off. A chat that isn't configured yet is added (photos + videos). */
export function setChatMonitoring(chat, on) {
    if (findConfigGroup(chat.id) || chat.inConfig) {
        return saveChatConfig(chat.id, { enabled: on });
    }
    return saveChatConfig(chat.id, {
        name: chat.name,
        enabled: on,
        filters: { ...NEW_CHAT_FILTERS },
    });
}

// ---- Result rows ------------------------------------------------------------

function typeLabel(type) {
    if (type === 'channel') return i18nT('groups.type.channel', 'Channel');
    if (type === 'group' || type === 'supergroup') return i18nT('groups.type.group', 'Group');
    if (type === 'bot') return i18nT('groups.type.bot', 'Bot');
    if (type === 'user') return i18nT('groups.type.user', 'Direct message');
    return '';
}

function rowState(chat) {
    const cfg = findConfigGroup(chat.id);
    const inConfig = !!cfg || !!chat.inConfig;
    const suspended = cfg ? cfg.suspended === true : chat.suspended === true;
    const enabled = cfg ? cfg.enabled !== false && !suspended : !!chat.enabled && !suspended;
    // Can we still use it? (config entry's answer, else the row's own)
    const access = cfg?.access || chat.access || accessFor(chat.id);
    return { inConfig, suspended, enabled, blocked: chat.dmDisabled === true, access };
}

/**
 * One chat as a row: tap the name for its chat details page, a Monitor
 * switch, and "Backfill…".
 *
 * @param {object} chat  { id, name, type, members?, archived?, joined?,
 *                         inConfig?, enabled?, suspended?, dmDisabled? }
 * @param {object} [opts] { accountChips: [{id,label,title}] }
 */
export function renderChatResultRow(chat, opts = {}) {
    const id = String(chat.id);
    const name = getGroupName(id, { fallback: chat.name || chat.title });
    const { suspended, enabled, blocked, access } = rowState(chat);
    const unreachable = isBlockedAccess(access);
    const sub = [];
    const tl = typeLabel(chat.type);
    if (tl) sub.push(tl);
    if (chat.members) {
        sub.push(
            i18nTf(
                'groups.members',
                { count: Number(chat.members).toLocaleString() },
                '{count} members',
            ),
        );
    }
    if (chat.archived) sub.push(i18nT('groups.archived', 'archived'));
    let flag = '';
    if (unreachable) {
        // The same badge the sidebar and the chat page show.
        flag = accessBadgeHtml(access);
    } else if (suspended) {
        flag = `<span class="status-pill status-pill-suspended">${escapeHtml(i18nT('groups.status.suspended', 'Suspended'))}</span>`;
    } else if (blocked) {
        flag = `<span class="cr-flag">${escapeHtml(i18nT('add.row.dm_off', 'Direct messages are off in Settings'))}</span>`;
    } else if (chat.joined === false) {
        flag = `<span class="cr-flag cr-flag--muted">${escapeHtml(i18nT('add.row.not_joined', 'Not in your chats'))}</span>`;
    }
    const chips = Array.isArray(opts.accountChips)
        ? `<span class="cr-chips">${opts.accountChips
              .map(
                  (c) =>
                      `<span class="account-chip" style="--chip-hue:${chipHue(c.id)}" title="${escapeHtml(c.title || c.label)}">${escapeHtml(c.label)}</span>`,
              )
              .join('')}</span>`
        : '';
    const disabled = suspended || blocked;
    // Backfill of a chat no account can read is refused (the chat page
    // says why); its Monitor switch stays usable so it can be stopped.
    const noBackfill = disabled || unreachable;
    return `
        <div class="cr-row${unreachable ? ' is-unreachable' : ''}" data-chat-id="${escapeHtml(id)}" role="listitem">
            <button type="button" class="cr-main" data-cr-open
                aria-label="${escapeHtml(i18nTf('add.row.open_aria', { name }, `Settings of ${name}`))}">
                ${createAvatar({ id, name, type: chat.type, size: 'md' })}
                <span class="cr-text">
                    <span class="cr-name">${escapeHtml(name)}</span>
                    <span class="cr-sub">${escapeHtml(sub.join(' · '))}</span>
                    ${flag}${chips}
                </span>
            </button>
            <button type="button" class="cr-backfill" data-cr-backfill ${noBackfill ? 'disabled' : ''}
                aria-label="${escapeHtml(i18nTf('add.row.backfill_aria', { name }, `Backfill older messages of ${name}`))}">
                <i class="ri-history-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('add.row.backfill', 'Backfill…'))}</span>
            </button>
            <button type="button" role="switch" class="cr-switch" data-cr-monitor
                aria-checked="${enabled ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}
                aria-label="${escapeHtml(i18nTf('add.row.monitor_aria', { name }, `Monitor ${name}`))}">
                <span class="tg-toggle ${enabled ? 'active' : ''}" data-a11y-toggle="1" aria-hidden="true"></span>
            </button>
            <div class="cr-note hidden" data-cr-note role="status"></div>
        </div>`;
}

function chipHue(id) {
    const s = String(id || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
}

function openChat(id) {
    navigate(`#/groups/${encodeURIComponent(id)}`);
}

function openBackfillSheet(id) {
    import('./backfill.js')
        .then((m) => m.openBackfillSheet(id))
        .catch((e) => console.error('backfill sheet', e));
}

/**
 * Delegated handlers for rows rendered by renderChatResultRow().
 *
 * @param {HTMLElement} container
 * @param {object} opts
 *   getChat(id)      → the chat object behind a row
 *   beforeNavigate() → called before leaving for a chat page (close a sheet)
 */
export function wireChatResultRows(container, opts = {}) {
    if (!container || container.dataset.crWired) return;
    container.dataset.crWired = '1';
    const getChat = (row) =>
        opts.getChat?.(row.dataset.chatId) ||
        findDialog(row.dataset.chatId) || {
            id: row.dataset.chatId,
            name: row.querySelector('.cr-name')?.textContent || row.dataset.chatId,
        };
    const leaveTo = (id) => {
        opts.beforeNavigate?.();
        openChat(id);
    };

    container.addEventListener('click', async (e) => {
        const row = e.target.closest('.cr-row[data-chat-id]');
        if (!row || !container.contains(row)) return;
        const id = row.dataset.chatId;

        if (e.target.closest('[data-cr-open], [data-cr-customize]')) {
            leaveTo(id);
            return;
        }

        if (e.target.closest('[data-cr-backfill]')) {
            const btn = e.target.closest('[data-cr-backfill]');
            const chat = getChat(row);
            // Not configured yet: add it (paused, photos + videos) so the
            // backfill downloads what the row promised.
            if (!findConfigGroup(id) && !chat.inConfig) {
                btn.disabled = true;
                try {
                    await saveChatConfig(id, {
                        name: chat.name,
                        enabled: false,
                        filters: { ...NEW_CHAT_FILTERS },
                    });
                } catch (err) {
                    showToast(err?.data?.error || err?.message || 'Failed', 'error');
                    return;
                } finally {
                    btn.disabled = false;
                }
            }
            openBackfillSheet(id);
            return;
        }

        const sw = e.target.closest('[data-cr-monitor]');
        if (sw && !sw.disabled) {
            if (sw.dataset.busy) return;
            sw.dataset.busy = '1';
            const chat = getChat(row);
            const wasNew = !findConfigGroup(id) && !chat.inConfig;
            const next = sw.getAttribute('aria-checked') !== 'true';
            const paint = (on) => {
                sw.setAttribute('aria-checked', on ? 'true' : 'false');
                sw.querySelector('.tg-toggle')?.classList.toggle('active', on);
            };
            paint(next);
            try {
                await setChatMonitoring(chat, next);
                chat.inConfig = true;
                chat.enabled = next;
                const note = row.querySelector('[data-cr-note]');
                if (note && wasNew && next) {
                    note.innerHTML = `<i class="ri-check-line" aria-hidden="true"></i>
                        <span>${escapeHtml(i18nT('add.row.monitoring_now', 'Monitoring photos and videos.'))}</span>
                        <button type="button" class="cr-link" data-cr-customize>${escapeHtml(i18nT('add.row.customize', 'Customize'))}</button>`;
                    note.classList.remove('hidden');
                } else if (note) {
                    note.classList.add('hidden');
                    note.textContent = '';
                }
                opts.onChange?.(chat);
            } catch (err) {
                paint(!next);
                const msg = err?.data?.error || err?.message || 'Failed';
                showToast(
                    i18nTf('add.row.monitor_failed', { msg }, `Couldn't change monitoring: ${msg}`),
                    'error',
                );
            } finally {
                delete sw.dataset.busy;
            }
        }
    });
}

// ---- Input classification (mirrors parseChatQuery on the server) -----------

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;

/**
 * What the Add box holds. Names (and usernames / ids already in the
 * dialogs list) are found here; the rest goes to GET /api/chats/lookup,
 * which has the full parser (parseChatQuery). Returns { kind, … }:
 *   empty | name{text} | username{username} | id{chatRef} |
 *   message{chatRef, messageId} | server (invites, tg:// and odd links)
 */
export function classifyAddInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return { kind: 'empty' };
    if (/^-?100\d{5,}$/.test(s)) return { kind: 'id', chatRef: `-100${s.replace(/^-?100/, '')}` };
    if (s.startsWith('@')) {
        const u = s.slice(1);
        return USERNAME_RE.test(u) ? { kind: 'username', username: u } : { kind: 'name', text: s };
    }
    if (/^tg:\/\//i.test(s)) return { kind: 'server' };
    const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(.*)$/i);
    if (!m) return { kind: 'name', text: s };
    let segs = m[1].split(/[?#]/)[0].split('/').filter(Boolean);
    if (segs[0] === 's') segs = segs.slice(1);
    const last = segs[segs.length - 1];
    if (segs[0] === 'c' && /^\d+$/.test(segs[1] || '')) {
        const chatRef = `-100${segs[1]}`;
        if (segs.length === 2) return { kind: 'id', chatRef };
        if (segs.length <= 4 && /^\d+$/.test(last)) {
            return { kind: 'message', chatRef, messageId: Number(last) };
        }
    } else if (segs[0] && USERNAME_RE.test(segs[0]) && segs[0].toLowerCase() !== 'joinchat') {
        if (segs.length === 1) return { kind: 'username', username: segs[0] };
        if (segs.length <= 3 && /^\d+$/.test(last)) {
            return { kind: 'message', chatRef: `@${segs[0]}`, messageId: Number(last) };
        }
    }
    return { kind: 'server' };
}

function localChatFor(parsed) {
    const dialogs = state.allDialogs || [];
    if (parsed.kind === 'username') {
        const u = parsed.username.toLowerCase();
        return dialogs.find((d) => String(d.username || '').toLowerCase() === u) || null;
    }
    const ref = parsed.chatRef || '';
    if (ref.startsWith('@')) {
        const u = ref.slice(1).toLowerCase();
        return dialogs.find((d) => String(d.username || '').toLowerCase() === u) || null;
    }
    return ref ? findDialog(ref) : null;
}

function humanWait(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return i18nTf('time.wait.seconds', { n: s }, `${s} s`);
    if (s < 3600) {
        const m = Math.ceil(s / 60);
        return i18nTf('time.wait.minutes', { n: m }, `${m} min`);
    }
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return i18nTf('time.wait.hours', { h, m }, `${h} h ${m} min`);
}
export { humanWait };

// ---- The sheet -------------------------------------------------------------------

const MAX_ROWS = 30;
const SUGGESTED = 8;

async function loadDialogs() {
    if (Array.isArray(state.allDialogs) && state.allDialogs.length) {
        return { dialogs: state.allDialogs, error: null };
    }
    try {
        const r = await api.get('/api/dialogs');
        state.allDialogs = r.dialogs || [];
        state.dialogsAccounts = Array.isArray(r.accounts) ? r.accounts : [];
        return { dialogs: state.allDialogs, error: null };
    } catch (e) {
        return { dialogs: [], error: e?.data?.error || e?.message || 'failed' };
    }
}

function moreItems() {
    return [
        {
            id: 'paste-link',
            icon: 'ri-links-line',
            label: i18nT('add.more.paste', 'Paste several links'),
            sub: i18nT('add.more.paste_sub', 'Download messages from a list of t.me links'),
            run: () => document.getElementById('paste-url-btn')?.click(),
        },
        {
            id: 'stories',
            icon: 'ri-camera-line',
            label: i18nT('fab.stories', 'Stories'),
            sub: i18nT('fab.stories_sub', "Save someone's active Stories"),
            run: () => document.getElementById('stories-btn')?.click(),
        },
        {
            id: 'add-account',
            icon: 'ri-user-add-line',
            label: i18nT('fab.add_account', 'Add Telegram account'),
            sub: i18nT('fab.add_account_sub', 'Phone → code → 2FA'),
            run: () =>
                import('./account-wizard.js')
                    .then((m) => m.openAccountWizard())
                    .catch((e) => console.error('account wizard', e)),
        },
        {
            id: 'browse-chats',
            icon: 'ri-chat-3-line',
            label: i18nT('fab.browse_chats', 'Browse chats'),
            sub: i18nT('fab.browse_chats_sub', 'Pick a chat to monitor or backfill'),
            run: () => navigate('#/groups'),
        },
    ];
}

/** Open the Add sheet (the + button). */
export function openAddSheet() {
    const box = document.createElement('div');
    box.className = 'as-sheet';
    box.innerHTML = `
        <div class="as-search" role="search">
            <i class="ri-search-line as-search-icon" aria-hidden="true"></i>
            <input type="search" class="tg-input as-input" data-as-input name="add-q" autocomplete="nope"
                autocapitalize="off" spellcheck="false" enterkeyhint="search"
                data-form-type="other" data-lpignore="true" data-1p-ignore="true" data-bwignore="true"
                placeholder="${escapeHtml(i18nT('add.search.placeholder', 'Chat name, @username or t.me link'))}"
                aria-label="${escapeHtml(i18nT('add.search.label', 'Find a chat or paste a link'))}"
                aria-describedby="as-hint">
        </div>
        <p id="as-hint" class="as-hint">${escapeHtml(i18nT('add.hint', 'Search your chats by name, or paste a @username, a t.me link, an invite link or a message link.'))}</p>
        <div class="as-notice hidden" data-as-notice></div>
        <div class="as-status" data-as-status role="status" aria-live="polite"></div>
        <div class="as-card-slot" data-as-cards></div>
        <h4 class="as-heading hidden" data-as-list-heading></h4>
        <div class="as-results" data-as-results role="list"></div>
        <p class="as-more-note hidden" data-as-more-note></p>
        <div class="as-more">
            <h4 class="as-heading">${escapeHtml(i18nT('add.more', 'More'))}</h4>
            <div class="as-actions">
                ${moreItems()
                    .map(
                        (it) => `
                    <button type="button" class="as-action" data-as-more="${it.id}">
                        <i class="${it.icon}" aria-hidden="true"></i>
                        <span class="as-action-text">
                            <span class="as-action-label">${escapeHtml(it.label)}</span>
                            <span class="as-action-sub">${escapeHtml(it.sub)}</span>
                        </span>
                        <i class="ri-arrow-right-s-line as-action-chev" aria-hidden="true"></i>
                    </button>`,
                    )
                    .join('')}
            </div>
        </div>`;

    let closed = false;
    const handle = openSheet({
        title: i18nT('add.title', 'Add a chat'),
        content: box,
        size: 'md',
        onClose: () => {
            closed = true;
            clearTimeout(lookupTimer);
        },
    });
    const input = box.querySelector('[data-as-input]');
    const statusEl = box.querySelector('[data-as-status]');
    const cardsEl = box.querySelector('[data-as-cards]');
    const results = box.querySelector('[data-as-results]');
    const heading = box.querySelector('[data-as-list-heading]');
    const moreNote = box.querySelector('[data-as-more-note]');
    const notice = box.querySelector('[data-as-notice]');
    const hint = box.querySelector('#as-hint');

    // Chats shown by a server lookup (not in the dialogs list).
    const extra = new Map();
    let dialogs = [];
    let dialogsError = null;
    let lookupTimer = null;
    let seq = 0;

    wireChatResultRows(results, {
        getChat: (id) => extra.get(String(id)) || findDialog(id),
        beforeNavigate: () => handle.close(),
    });
    // Rows inside cards (message / invite) use the same handlers.
    wireChatResultRows(cardsEl, {
        getChat: (id) => extra.get(String(id)) || findDialog(id),
        beforeNavigate: () => handle.close(),
    });

    const setStatus = (text, kind = '') => {
        statusEl.textContent = text || '';
        statusEl.dataset.kind = kind;
    };
    const setList = (chats, title, total = chats.length) => {
        heading.textContent = title || '';
        heading.classList.toggle('hidden', !title || !chats.length);
        results.innerHTML = chats.map((c) => renderChatResultRow(c)).join('');
        const rest = total - chats.length;
        moreNote.textContent =
            rest > 0
                ? i18nTf(
                      'add.results_more',
                      { n: rest.toLocaleString() },
                      '{n} more — keep typing to narrow it down',
                  )
                : '';
        moreNote.classList.toggle('hidden', rest <= 0);
    };
    const clearAll = () => {
        cardsEl.innerHTML = '';
        setList([]);
        setStatus('');
    };

    const showSuggestions = () => {
        clearAll();
        hint.classList.remove('hidden');
        if (!dialogs.length) return;
        setList(dialogs.slice(0, SUGGESTED), i18nT('add.your_chats', 'Your chats'));
    };

    const searchNames = (text) => {
        const q = text.toLowerCase();
        const hits = dialogs.filter(
            (d) =>
                String(getGroupName(d.id, { fallback: d.name }) || '')
                    .toLowerCase()
                    .includes(q) ||
                String(d.username || '')
                    .toLowerCase()
                    .includes(q.replace(/^@/, '')) ||
                String(d.id).includes(q),
        );
        cardsEl.innerHTML = '';
        setList(hits.slice(0, MAX_ROWS), '', hits.length);
        if (!hits.length) {
            setStatus(
                dialogsError === 'no_account'
                    ? i18nT('add.no_account', 'Add a Telegram account first.')
                    : i18nTf('add.no_match', { q: text }, `No chat named “${text}”.`),
            );
        } else {
            setStatus('');
        }
    };

    const messageCard = (parsed, chat) => `
        <div class="as-card" data-as-msg>
            <span class="as-card-icon" aria-hidden="true"><i class="ri-chat-download-line"></i></span>
            <div class="as-card-text">
                <div class="as-card-title">${escapeHtml(i18nTf('add.message.title', { id: parsed.messageId }, `Message ${parsed.messageId}`))}</div>
                <div class="as-card-sub">${escapeHtml(
                    i18nTf(
                        'add.message.in',
                        {
                            chat: chat
                                ? getGroupName(chat.id, { fallback: chat.name })
                                : parsed.chatRef,
                        },
                        `in ${chat ? chat.name : parsed.chatRef}`,
                    ),
                )}</div>
            </div>
            <button type="button" class="tg-btn as-card-btn" data-as-download>
                <i class="ri-download-2-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('common.download', 'Download'))}</span>
            </button>
            <p class="as-card-status hidden" data-as-dl-status role="status"></p>
        </div>`;

    const inviteCard = (inv) => `
        <div class="as-card">
            <span class="as-card-icon" aria-hidden="true"><i class="ri-user-add-line"></i></span>
            <div class="as-card-text">
                <div class="as-card-title">${escapeHtml(inv.title || i18nT('add.invite.title', 'Private chat'))}</div>
                <div class="as-card-sub">${escapeHtml(
                    [
                        typeLabel(inv.type),
                        inv.members
                            ? i18nTf(
                                  'groups.members',
                                  { count: Number(inv.members).toLocaleString() },
                                  '{count} members',
                              )
                            : '',
                    ]
                        .filter(Boolean)
                        .join(' · '),
                )}</div>
                <p class="as-card-help">${escapeHtml(i18nT('add.invite.not_joined', "You're not in this chat. Join it in Telegram first, then add it here."))}</p>
            </div>
            <a class="tg-btn-secondary as-card-btn" href="${escapeHtml(inv.url)}" target="_blank" rel="noopener noreferrer">
                <i class="ri-external-link-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('add.invite.open', 'Open in Telegram'))}</span>
            </a>
        </div>`;

    const lookupError = (status, data) => {
        if (data?.error === 'no_account')
            return i18nT('add.no_account', 'Add a Telegram account first.');
        if (data?.error === 'invite_invalid') {
            return i18nT('add.invite_invalid', 'This invite link has expired or is invalid.');
        }
        if (data?.error === 'flood') {
            const time = humanWait(data.seconds);
            return i18nTf(
                'add.flood',
                { time },
                `Telegram asks to wait ${time} before the next lookup.`,
            );
        }
        if (status === 422) return i18nT('add.unsupported', "This link isn't a chat or a message.");
        if (status === 404) {
            return i18nT('add.not_found', 'Telegram has no chat at this link or username.');
        }
        const msg = data?.error || '';
        return i18nTf('add.lookup_failed', { msg }, `Couldn't look this up: ${msg}`);
    };

    const runLookup = async (text, parsed, mySeq) => {
        setStatus(i18nT('add.looking_up', 'Looking up…'), 'busy');
        let r;
        try {
            r = await api.get(`/api/chats/lookup?q=${encodeURIComponent(text)}`);
        } catch (e) {
            if (closed || mySeq !== seq) return;
            setStatus(lookupError(e?.status, e?.data), 'error');
            // A message link still downloads through /api/download/url
            // even when the chat itself couldn't be shown.
            if (parsed.kind === 'message' && e?.data?.error !== 'no_account') {
                cardsEl.innerHTML = messageCard(parsed, null);
            }
            return;
        }
        if (closed || mySeq !== seq) return;
        setStatus('');
        const chat = r?.chat || null;
        if (chat) {
            extra.set(String(chat.id), chat);
            // So its details page (and the header) know the name before
            // it's in the config.
            updateGroupNameCache([{ id: chat.id, name: chat.name }]);
        }
        if (r?.kind === 'message' || parsed.kind === 'message') {
            const p =
                parsed.kind === 'message'
                    ? parsed
                    : { messageId: r?.message?.messageId, chatRef: '' };
            cardsEl.innerHTML = messageCard(p, chat);
        } else if (r?.invite && (!chat || chat.joined === false)) {
            cardsEl.innerHTML = inviteCard(r.invite);
        }
        if (chat && !(r?.invite && chat.joined === false)) setList([chat], '');
    };

    const update = () => {
        if (closed) return;
        clearTimeout(lookupTimer);
        const text = input.value.trim();
        const parsed = classifyAddInput(text);
        const mySeq = ++seq;
        hint.classList.toggle('hidden', parsed.kind !== 'empty');
        if (parsed.kind === 'empty') {
            showSuggestions();
            return;
        }
        if (parsed.kind === 'name') {
            searchNames(text);
            return;
        }
        clearAll();
        const local = parsed.kind === 'server' ? null : localChatFor(parsed);
        if (parsed.kind === 'message') {
            cardsEl.innerHTML = messageCard(parsed, local);
            if (local) {
                setList([local], '');
                return;
            }
        } else if (local) {
            setList([local], '');
            return;
        }
        // Resolve on the server. Typed @names wait a little longer — a
        // pause mid-word shouldn't spend a Telegram username lookup.
        const delay = parsed.kind === 'username' && text.startsWith('@') ? 900 : 350;
        setStatus(i18nT('add.looking_up', 'Looking up…'), 'busy');
        lookupTimer = setTimeout(() => {
            lookupTimer = null;
            runLookup(text, parsed, mySeq);
        }, delay);
    };

    input.addEventListener('input', update);
    // Enter skips the wait before a lookup.
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (!lookupTimer) return;
        clearTimeout(lookupTimer);
        lookupTimer = null;
        const text = input.value.trim();
        runLookup(text, classifyAddInput(text), seq);
    });

    box.addEventListener('click', async (e) => {
        const more = e.target.closest('[data-as-more]');
        if (more) {
            const it = moreItems().find((x) => x.id === more.dataset.asMore);
            handle.close();
            setTimeout(() => it?.run(), 80); // let the sheet close first
            return;
        }
        const add = e.target.closest('[data-as-add-account]');
        if (add) {
            handle.close();
            setTimeout(
                () =>
                    import('./account-wizard.js')
                        .then((m) => m.openAccountWizard())
                        .catch((err) => console.error('account wizard', err)),
                80,
            );
            return;
        }
        const dl = e.target.closest('[data-as-download]');
        if (dl) {
            const card = dl.closest('[data-as-msg]');
            const st = card?.querySelector('[data-as-dl-status]');
            dl.disabled = true;
            try {
                const r = await api.post('/api/download/url', { url: input.value.trim() });
                const res = r?.results?.[0];
                if (res?.ok) {
                    dl.classList.add('hidden');
                    if (st) {
                        st.innerHTML = `<i class="ri-check-line" aria-hidden="true"></i> ${escapeHtml(i18nT('add.message.queued', 'Queued.'))} <a href="#/queue" class="cr-link" data-as-queue>${escapeHtml(i18nT('backfill.sheet.open_queue', 'Queue'))}</a>`;
                        st.dataset.kind = 'ok';
                    }
                } else {
                    throw new Error(res?.error || 'Failed');
                }
            } catch (err) {
                dl.disabled = false;
                const msg = err?.data?.error || err?.message || 'Failed';
                if (st) {
                    st.textContent = i18nTf(
                        'add.message.failed',
                        { msg },
                        `Couldn't download: ${msg}`,
                    );
                    st.dataset.kind = 'error';
                }
            }
            st?.classList.remove('hidden');
            return;
        }
        if (e.target.closest('[data-as-queue]')) {
            e.preventDefault();
            handle.close();
            navigate('#/queue');
        }
    });

    setTimeout(() => input.focus(), 60);

    loadDialogs().then((r) => {
        if (closed) return;
        dialogs = r.dialogs;
        dialogsError = r.error;
        if (r.error === 'no_account') {
            notice.innerHTML = `
                <i class="ri-user-add-line" aria-hidden="true"></i>
                <span>${escapeHtml(i18nT('add.no_account_body', 'Add your Telegram account to see your chats here.'))}</span>
                <button type="button" class="tg-btn as-notice-btn" data-as-add-account>${escapeHtml(i18nT('groups.no_account.cta', 'Add account'))}</button>`;
            notice.classList.remove('hidden');
        } else if (r.error) {
            notice.textContent = i18nTf(
                'picker.failed',
                { msg: r.error },
                `Failed to load dialogs: ${r.error}`,
            );
            notice.classList.remove('hidden');
        }
        if (!input.value.trim()) showSuggestions();
        else update();
    });
    return handle;
}
