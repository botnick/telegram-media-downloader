// Chat details — the page at #/groups/<id>.
//
// Replaces the three-tab Group Settings modal with one page: the chat's
// header (avatar, name, type, Monitoring switch, file count + size, Open
// gallery and Backfill…) and every per-chat setting below it in one
// scrolling list — what to download (forum topics under "More"), Forward
// to, Accounts (only with 2+ accounts; cluster routing only with paired
// peers), Storage and a Danger zone.
//
// Edits save on their own through the same PUT /api/groups/:id the modal
// used — toggles right away, text fields after a short pause or on blur —
// with a small "Saved" note and no list reload. A chat that isn't in the
// config yet can be opened; its first save adds it (photos + videos, the
// same defaults as the Add sheet), like the modal's Save did.
//
// The controls keep the modal's element ids (group-enable-toggle,
// filter-options, topics-ids, fwd-destination, monitor-account,
// group-owner-peer, setting-rescue-mode, group-data-purge-btn, …).

import { api } from './api.js';
import { state, getGroupName } from './store.js';
import { createAvatar, escapeHtml, formatBytes, formatRelativeTime, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { confirmSheet, openSheet } from './sheet.js';
import { navigate } from './router.js';
import { ws } from './ws.js';
import { NEW_CHAT_FILTERS, saveChatConfig, findConfigGroup, findDialog } from './add-sheet.js';

const FILTERS = [
    { key: 'photos', icon: 'ri-image-line', label: () => i18nT('group.filter.photos', 'Photos') },
    { key: 'videos', icon: 'ri-video-line', label: () => i18nT('group.filter.videos', 'Videos') },
    {
        key: 'files',
        icon: 'ri-file-line',
        label: () => i18nT('group.filter.files', 'Files / Documents'),
    },
    { key: 'links', icon: 'ri-link', label: () => i18nT('group.filter.links', 'Links') },
    {
        key: 'voice',
        icon: 'ri-mic-line',
        label: () => i18nT('group.filter.voice', 'Voice Messages'),
    },
    { key: 'gifs', icon: 'ri-file-gif-line', label: () => i18nT('group.filter.gifs', 'GIFs') },
    {
        key: 'stickers',
        icon: 'ri-emoji-sticker-line',
        label: () => i18nT('group.filter.stickers', 'Stickers'),
    },
    { key: 'urls', icon: 'ri-links-line', label: () => i18nT('group.filter.urls', 'URLs in Text') },
];

// Rescue mode per chat: follow the global setting, or force on / off.
const RESCUE_LABEL = {
    auto: () => i18nT('chat.rescue.default', 'Default'),
    on: () => i18nT('group.rescue.mode_on', 'On'),
    off: () => i18nT('group.rescue.mode_off', 'Off'),
};

const TEXT_SAVE_MS = 800;
const TOGGLE_SAVE_MS = 150;

// One page open at a time.
let cur = null; // { id, name, group, fromApp, prev, prevGroup, stats }
let pending = null; // merged PUT body waiting to be sent
let saveTimer = null;
let inflight = null;
let savedTimer = null;
let wsWired = false;

function root() {
    let el = document.getElementById('page-chat');
    if (el) return el;
    const host = document.getElementById('content-area');
    if (!host) return null;
    el = document.createElement('div');
    el.id = 'page-chat';
    el.className = 'hidden';
    host.appendChild(el);
    return el;
}

/** Make sure #page-chat exists before renderPage() toggles `hidden`. */
export function ensureChatPage() {
    root();
}

function typeLabel(type) {
    if (type === 'channel') return i18nT('groups.type.channel', 'Channel');
    if (type === 'group' || type === 'supergroup') return i18nT('groups.type.group', 'Group');
    if (type === 'bot') return i18nT('groups.type.bot', 'Bot');
    if (type === 'user') return i18nT('groups.type.user', 'Direct message');
    return '';
}

function heroMeta() {
    const d = findDialog(cur.id);
    const parts = [];
    const tl = typeLabel(d?.type || cur.group?.type);
    if (tl) parts.push(tl);
    if (d?.members) {
        parts.push(
            i18nTf(
                'groups.members',
                { count: Number(d.members).toLocaleString() },
                '{count} members',
            ),
        );
    }
    return parts.join(' · ');
}

function statsLine(stats) {
    if (!stats) return '';
    const n = Number(stats.totalFiles) || 0;
    if (!n) return i18nT('chat.stats.none', 'Nothing downloaded yet');
    return i18nTf(
        'groups.files_size',
        { count: n.toLocaleString(), size: formatBytes(Number(stats.totalBytes) || 0) },
        '{count} files · {size}',
    );
}

// ---- Current values (config entry, or the defaults a first save adds) ----

function filtersNow() {
    // Configured chat: its saved filters (a missing key counts as on, as
    // the downloader reads it). New chat: the draft the chips edit.
    const f = cur.group?.filters;
    const out = {};
    for (const { key } of FILTERS) {
        out[key] = f ? f[key] !== false : cur.draftFilters[key] === true;
    }
    return out;
}

function monitoringNow() {
    const g = cur.group;
    return !!g && g.suspended !== true && g.enabled !== false;
}

// ---- Rendering ------------------------------------------------------------

function switchRow({ id, label, sub, on, disabled = false, extraClass = '' }) {
    return `
        <button type="button" role="switch" id="${id}" class="cd-switch-row ${extraClass}"
            aria-checked="${on ? 'true' : 'false'}" ${disabled ? 'disabled aria-disabled="true"' : ''}>
            <span class="cd-switch-text">
                <span class="cd-switch-label">${escapeHtml(label)}</span>
                ${sub ? `<span class="cd-switch-sub">${escapeHtml(sub)}</span>` : ''}
            </span>
            <span class="tg-toggle ${on ? 'active' : ''}" data-a11y-toggle="1" aria-hidden="true"></span>
        </button>`;
}

function monitorSub() {
    if (cur.group?.suspended) return i18nT('groups.status.suspended', 'Suspended');
    if (!cur.group) return i18nT('chat.monitor.sub_new', 'Not monitored yet');
    return monitoringNow()
        ? i18nT('chat.monitor.sub_on', 'New posts download automatically')
        : i18nT('chat.monitor.sub_off', 'Off — new posts are not downloaded');
}

function render() {
    const el = root();
    if (!el || !cur) return;
    const g = cur.group;
    const fwd = g?.autoForward || {};
    const topics = g?.topics || {};
    const filters = filtersNow();
    const rescue = ['on', 'off', 'auto'].includes(g?.rescueMode) ? g.rescueMode : 'auto';
    const suspended = g?.suspended === true;
    const d = findDialog(cur.id);

    el.classList.add('cd-page');
    el.innerHTML = `
        <div class="cd-topbar">
            <button type="button" class="cd-back" data-cd-back>
                <i class="ri-arrow-left-line" aria-hidden="true"></i>
                <span>${escapeHtml(i18nT('chat.back', 'Back'))}</span>
            </button>
            <span id="cd-save-status" class="cd-save" data-state="idle" role="status" aria-live="polite"></span>
        </div>

        <section class="cd-card cd-hero" aria-labelledby="cd-name">
            <div class="cd-hero-top">
                ${createAvatar({ id: cur.id, name: cur.name, type: d?.type || g?.type, size: 'xl' })}
                <div class="cd-hero-text">
                    <h2 id="cd-name" class="cd-name">${escapeHtml(cur.name)}</h2>
                    <p class="cd-meta" data-cd-meta>${escapeHtml(heroMeta())}</p>
                    <p class="cd-meta" data-cd-stats>${escapeHtml(statsLine(cur.stats))}</p>
                </div>
            </div>
            <div id="group-suspended-banner" class="cd-banner ${suspended ? '' : 'hidden'}" role="note">
                <i class="ri-forbid-line" aria-hidden="true"></i>
                <span>${escapeHtml(i18nT('group.suspended.banner', 'This group was deleted or suspended on Telegram. Monitoring is permanently disabled.'))}</span>
            </div>
            ${
                g
                    ? ''
                    : `<p class="cd-note" data-cd-new><i class="ri-information-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.not_in_list', 'Not in your list yet — any change here adds it.'))}</span></p>`
            }
            ${switchRow({
                id: 'group-enable-toggle',
                label: i18nT('chat.monitor.label', 'Monitoring'),
                sub: monitorSub(),
                on: monitoringNow(),
                disabled: suspended,
                extraClass: 'cd-switch-row--hero',
            })}
            <div class="cd-actions">
                <button type="button" class="tg-btn-secondary cd-action" data-cd-gallery>
                    <i class="ri-gallery-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.open_gallery', 'Open gallery'))}</span>
                </button>
                <button type="button" id="group-backfill-btn" class="tg-btn cd-action">
                    <i class="ri-history-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.backfill', 'Backfill…'))}</span>
                </button>
            </div>
        </section>

        <section class="cd-section" aria-labelledby="cd-h-download">
            <h3 id="cd-h-download" class="cd-heading">${escapeHtml(i18nT('chat.section.download', 'What to download'))}</h3>
            <div class="cd-card">
                <div id="filter-options" class="cd-chips" role="group" aria-labelledby="cd-h-download">
                    ${FILTERS.map(
                        (f) => `
                        <button type="button" class="cd-chip" data-filter="${f.key}" aria-pressed="${filters[f.key] ? 'true' : 'false'}">
                            <i class="${f.icon}" aria-hidden="true"></i>
                            <span>${escapeHtml(f.label())}</span>
                            <i class="ri-check-line cd-chip-check" aria-hidden="true"></i>
                        </button>`,
                    ).join('')}
                </div>
                <details class="cd-more" ${topics.enabled ? 'open' : ''}>
                    <summary class="cd-more-summary">
                        <span>${escapeHtml(i18nT('chat.more', 'More'))}</span>
                        <span class="cd-more-hint">${escapeHtml(i18nT('group.topics.title', 'Forum-topic filter'))}</span>
                        <i class="ri-arrow-down-s-line cd-more-chevron" aria-hidden="true"></i>
                    </summary>
                    <div class="cd-more-body">
                        ${switchRow({
                            id: 'topics-enable-toggle',
                            label: i18nT('group.topics.title', 'Forum-topic filter'),
                            sub: i18nT(
                                'chat.topics.sub',
                                'Forum groups only: download from some topics',
                            ),
                            on: topics.enabled === true,
                        })}
                        <label class="cd-label" for="topics-ids">${escapeHtml(i18nT('chat.topics.ids', 'Topic IDs'))}</label>
                        <input id="topics-ids" type="text" inputmode="numeric" autocomplete="off"
                            class="tg-input cd-input" value="${escapeHtml((topics.ids || []).join(', '))}"
                            placeholder="${escapeHtml(i18nT('group.topics.ids_placeholder', 'e.g., 12, 34, 56'))}"
                            aria-describedby="cd-topics-help">
                        <p id="cd-topics-help" class="cd-help">${i18nT('group.topics.note', 'Empty list = monitor every topic. Toggle off to disable filtering entirely.')}</p>
                    </div>
                </details>
            </div>
        </section>

        <section class="cd-section" aria-labelledby="cd-h-forward">
            <h3 id="cd-h-forward" class="cd-heading">${escapeHtml(i18nT('chat.section.forward', 'Forward to'))}</h3>
            <div class="cd-card">
                ${switchRow({
                    id: 'fwd-enable-toggle',
                    label: i18nT('chat.fwd.label', 'Forward new files'),
                    sub: i18nT('group.fwd.subtitle', 'Forward media to another channel'),
                    on: fwd.enabled === true,
                })}
                <div id="fwd-settings" class="cd-sub ${fwd.enabled ? '' : 'hidden'}">
                    <label class="cd-label" for="fwd-destination">${escapeHtml(i18nT('group.fwd.destination', 'Destination'))}</label>
                    <div class="cd-inline">
                        <input id="fwd-destination" type="text" autocomplete="off" spellcheck="false"
                            class="tg-input cd-input" value="${escapeHtml(fwd.destination || '')}"
                            placeholder="${escapeHtml(i18nT('chat.fwd.dest_placeholder', 'Chat ID, @username or me'))}"
                            aria-describedby="cd-fwd-help">
                        <button type="button" class="tg-btn-secondary cd-pick" data-cd-pick>
                            <i class="ri-list-check-2" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.fwd.pick', 'Pick'))}</span>
                        </button>
                    </div>
                    <p id="cd-fwd-help" class="cd-help">${escapeHtml(i18nT('group.fwd.dest_help', 'Leave empty to use "Telegram Downloader Storage".'))}</p>
                    ${switchRow({
                        id: 'fwd-delete-toggle',
                        label: i18nT('group.fwd.delete_after', 'Delete after forward'),
                        sub: i18nT(
                            'group.fwd.delete_after_help',
                            'Remove local file after successful upload.',
                        ),
                        on: fwd.deleteAfterForward === true,
                    })}
                </div>
            </div>
        </section>

        <section id="cd-accounts" class="cd-section hidden" aria-labelledby="cd-h-accounts">
            <h3 id="cd-h-accounts" class="cd-heading">${escapeHtml(i18nT('group.modal.tab.accounts', 'Accounts'))}</h3>
            <div class="cd-card cd-fields">
                <div id="cd-account-fields" class="hidden">
                    <label class="cd-label" for="monitor-account">${escapeHtml(i18nT('group.accounts.monitor', 'Monitor account'))}</label>
                    <select id="monitor-account" class="tg-input cd-input"></select>
                    <p class="cd-help">${escapeHtml(i18nT('group.accounts.monitor_help', 'This account will watch and download media from this group.'))}</p>
                    <label class="cd-label" for="forward-account">${escapeHtml(i18nT('group.accounts.forward', 'Forward account'))}</label>
                    <select id="forward-account" class="tg-input cd-input"></select>
                    <p class="cd-help">${escapeHtml(i18nT('group.accounts.forward_help', 'This account will re-upload forwarded media (Auto Forward).'))}</p>
                </div>
                <div id="group-cluster-routing" class="hidden">
                    <div class="cd-subheading"><i class="ri-broadcast-line" aria-hidden="true"></i>${escapeHtml(i18nT('group.cluster.title', 'Cluster routing'))}</div>
                    <label class="cd-label" for="group-owner-peer">${escapeHtml(i18nT('group.cluster.owner_peer', 'Owner peer'))}</label>
                    <select id="group-owner-peer" class="tg-input cd-input"></select>
                    <p class="cd-help">${escapeHtml(i18nT('group.cluster.owner_help', 'Designates which peer downloads this group. Empty = any peer with the matching account.'))}</p>
                    <label class="cd-label" for="group-backup-peer">${escapeHtml(i18nT('group.cluster.backup_peer', 'Backup peer'))}</label>
                    <select id="group-backup-peer" class="tg-input cd-input"></select>
                    <p class="cd-help">${escapeHtml(i18nT('group.cluster.backup_help', 'If the owner is silent past the cluster grace window, the backup takes over downloading.'))}</p>
                </div>
            </div>
        </section>

        <section class="cd-section" aria-labelledby="cd-h-storage">
            <h3 id="cd-h-storage" class="cd-heading">${escapeHtml(i18nT('chat.section.storage', 'Storage'))}</h3>
            <div class="cd-card">
                <div id="group-data-stats" class="cd-stats">${renderStats(cur.stats)}</div>
                <div class="cd-subheading" id="cd-rescue-label"><i class="ri-lifebuoy-line" aria-hidden="true"></i>${escapeHtml(i18nT('group.rescue.title', 'Rescue mode'))}</div>
                <p class="cd-help">${escapeHtml(i18nT('group.rescue.help', 'Only keeps messages that get deleted from this chat within X hours. Anything still on Telegram after that gets pruned locally.'))}</p>
                <div id="setting-rescue-mode" class="gf-seg cd-seg" role="radiogroup" aria-labelledby="cd-rescue-label">
                    ${['auto', 'on', 'off']
                        .map(
                            (v) => `
                        <button type="button" role="radio" data-rescue-value="${v}"
                            class="gf-seg-btn rescue-chip ${v === rescue ? 'active' : ''}"
                            aria-checked="${v === rescue ? 'true' : 'false'}"><span>${escapeHtml(RESCUE_LABEL[v]())}</span></button>`,
                        )
                        .join('')}
                </div>
                <label class="cd-label" for="setting-rescue-hours">${escapeHtml(i18nT('group.rescue.hours_label', 'Retention (hours)'))}</label>
                <input id="setting-rescue-hours" type="number" inputmode="numeric" min="1" max="720"
                    class="tg-input cd-input cd-input-short" placeholder="48"
                    value="${escapeHtml(g?.rescueRetentionHours ? String(g.rescueRetentionHours) : '')}">
            </div>
        </section>

        <section id="cd-danger" class="cd-section ${g || Number(cur.stats?.totalFiles) > 0 ? '' : 'hidden'}" aria-labelledby="cd-h-danger">
            <h3 id="cd-h-danger" class="cd-heading cd-heading--danger">${escapeHtml(i18nT('chat.section.danger', 'Danger zone'))}</h3>
            <div class="cd-card cd-danger">
                <div class="cd-danger-row">
                    <div class="min-w-0">
                        <div class="cd-danger-title">${escapeHtml(i18nT('group.data.delete_files', 'Delete files only'))}</div>
                        <p class="cd-help">${escapeHtml(i18nT('chat.danger.delete_files_help', "Removes this chat's downloaded files. Its settings stay."))}</p>
                    </div>
                    <button type="button" id="group-data-delete-files-btn" class="cd-danger-btn cd-danger-btn--warn">
                        <i class="ri-eraser-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.danger.delete_files_btn', 'Delete files'))}</span>
                    </button>
                </div>
                <div class="cd-danger-row">
                    <div class="min-w-0">
                        <div class="cd-danger-title">${escapeHtml(i18nT('group.data.wipe_all', 'Wipe all data'))}</div>
                        <p class="cd-help">${escapeHtml(i18nT('chat.danger.wipe_help', 'Removes the chat from your list together with every file.'))}</p>
                    </div>
                    <button type="button" id="group-data-purge-btn" class="cd-danger-btn">
                        <i class="ri-delete-bin-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.danger.wipe_btn', 'Wipe all'))}</span>
                    </button>
                </div>
            </div>
        </section>`;
}

function renderStats(s) {
    if (!s) {
        return `<div class="cd-stat cd-stat--wide"><span class="cd-stat-label">${escapeHtml(i18nT('common.loading', 'Loading…'))}</span></div>`;
    }
    const typeName = {
        photo: i18nT('group.filter.photos', 'Photos'),
        video: i18nT('group.filter.videos', 'Videos'),
        audio: i18nT('viewer.tab.audio', 'Audio'),
        document: i18nT('viewer.tab.documents', 'Files'),
        sticker: i18nT('group.filter.stickers', 'Stickers'),
    };
    const typeText =
        Object.entries(s.byType || {})
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${n.toLocaleString()} ${typeName[k] || k}`)
            .join(' · ') || '—';
    // SQLite CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS" in UTC.
    const raw = String(s.lastDownloadAt || '');
    const when = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
    const last = raw
        ? formatRelativeTime(when) || new Date(when).toLocaleString()
        : i18nT('common.never', 'Never');
    const cell = (label, value) =>
        `<div class="cd-stat"><span class="cd-stat-label">${escapeHtml(label)}</span><span class="cd-stat-value">${escapeHtml(value)}</span></div>`;
    return (
        cell(
            i18nT('group.data.stat.total', 'Files'),
            (Number(s.totalFiles) || 0).toLocaleString(),
        ) +
        cell(i18nT('group.data.stat.size', 'Size'), formatBytes(Number(s.totalBytes) || 0)) +
        cell(i18nT('group.data.stat.last', 'Last download'), last) +
        cell(i18nT('group.data.stat.types', 'Types'), typeText)
    );
}

function setSwitch(id, on, sub) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.querySelector('.tg-toggle')?.classList.toggle('active', on);
    if (sub != null) {
        const s = btn.querySelector('.cd-switch-sub');
        if (s) s.textContent = sub;
    }
}

// ---- Accounts + cluster (filled once their data arrives) -------------------

function accountLabel(a) {
    let label = a.name && a.name !== a.id ? `${a.name} (${a.id})` : a.id;
    if (a.username) label += ` @${a.username}`;
    return label;
}

async function loadAccountsAndPeers(token) {
    const [accounts, peers] = await Promise.all([
        api.get('/api/accounts').catch(() => []),
        api
            .get('/api/cluster/peers')
            .then((r) => (Array.isArray(r?.peers) ? r.peers : []))
            .catch(() => []),
    ]);
    if (!cur || cur.token !== token) return;
    const g = cur.group;
    const section = document.getElementById('cd-accounts');
    const accFields = document.getElementById('cd-account-fields');
    const cluster = document.getElementById('group-cluster-routing');
    const many = Array.isArray(accounts) && accounts.length >= 2;
    const hasPeers = peers.length > 0;
    cur.clusterEditable = hasPeers;
    if (many && accFields) {
        const def = i18nT('group.accounts.default_option_star', '(Default Account ⭐)');
        const opts = (sel) =>
            `<option value="">${escapeHtml(def)}</option>` +
            accounts
                .map(
                    (a) =>
                        `<option value="${escapeHtml(a.id)}" ${sel === a.id ? 'selected' : ''}>${escapeHtml(accountLabel(a))}</option>`,
                )
                .join('');
        document.getElementById('monitor-account').innerHTML = opts(g?.monitorAccount);
        document.getElementById('forward-account').innerHTML = opts(g?.forwardAccount);
        accFields.classList.remove('hidden');
    }
    if (hasPeers && cluster) {
        const peerLabel = (p) =>
            `${p.status === 'online' ? '🟢' : '⚪'} ${p.name || String(p.peerId).slice(0, 12)}`;
        const opts = (sel, emptyLabel) =>
            `<option value="">${escapeHtml(emptyLabel)}</option>` +
            peers
                .map(
                    (p) =>
                        `<option value="${escapeHtml(p.peerId)}" ${sel === p.peerId ? 'selected' : ''}>${escapeHtml(peerLabel(p))}</option>`,
                )
                .join('');
        document.getElementById('group-owner-peer').innerHTML = opts(
            g?.ownerPeerId,
            i18nT('group.cluster.any_peer', '(Any peer — first online wins)'),
        );
        document.getElementById('group-backup-peer').innerHTML = opts(
            g?.backupPeerId,
            i18nT('group.cluster.no_backup', '(No automatic failover)'),
        );
        cluster.classList.remove('hidden');
    }
    section?.classList.toggle('hidden', !many && !hasPeers);
}

async function loadStats(token) {
    try {
        const s = await api.get(`/api/groups/${encodeURIComponent(cur.id)}/stats`);
        if (!cur || cur.token !== token) return;
        cur.stats = s;
    } catch {
        if (!cur || cur.token !== token) return;
        cur.stats = { totalFiles: 0, totalBytes: 0, byType: {}, lastDownloadAt: null };
    }
    const statsEl = document.querySelector('#page-chat [data-cd-stats]');
    if (statsEl) statsEl.textContent = statsLine(cur.stats);
    const grid = document.getElementById('group-data-stats');
    if (grid) grid.innerHTML = renderStats(cur.stats);
    if (Number(cur.stats.totalFiles) > 0) {
        document.getElementById('cd-danger')?.classList.remove('hidden');
    }
}

// The hero's type + member count come from the dialogs list. Opening the
// page from a deep link / the sidebar may happen before the Chats page
// ever loaded it — fetch it once in the background (the server caches it).
async function loadDialogMeta(token) {
    if (findDialog(cur.id) || state._chatDialogsLoading) return;
    state._chatDialogsLoading = true;
    try {
        const r = await api.get('/api/dialogs');
        const list = r?.dialogs || [];
        if (!state.allDialogs) state.allDialogs = list;
        if (Array.isArray(r?.accounts) && !state.dialogsAccounts)
            state.dialogsAccounts = r.accounts;
    } catch {
        /* no account / not connected — the hero just shows less */
    } finally {
        state._chatDialogsLoading = false;
    }
    if (!cur || cur.token !== token) return;
    const meta = document.querySelector('#page-chat [data-cd-meta]');
    if (meta) meta.textContent = heroMeta();
    const d = findDialog(cur.id);
    // A chat that's only in the dialogs list (not configured, nothing
    // downloaded): its real name arrives with them.
    if (d?.name && (!cur.name || /^Unknown/.test(cur.name))) {
        cur.name = getGroupName(cur.id, { fallback: d.name });
        if (/^Unknown/.test(cur.name)) cur.name = d.name;
        const h = document.getElementById('cd-name');
        if (h) h.textContent = cur.name;
        const av = document.querySelector('#page-chat .cd-hero-top > :first-child');
        if (av)
            av.outerHTML = createAvatar({ id: cur.id, name: cur.name, type: d.type, size: 'xl' });
        cur.onName?.(cur.name);
    }
}

// ---- Saving -----------------------------------------------------------------

function setSaveStatus(kind, msg) {
    const el = document.getElementById('cd-save-status');
    if (!el) return;
    if (savedTimer) {
        clearTimeout(savedTimer);
        savedTimer = null;
    }
    el.dataset.state = kind;
    if (kind === 'saving') {
        el.innerHTML = `<i class="ri-loader-4-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.save.saving', 'Saving…'))}</span>`;
    } else if (kind === 'saved') {
        el.innerHTML = `<i class="ri-check-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('common.saved', 'Saved'))}</span>`;
        savedTimer = setTimeout(() => {
            el.dataset.state = 'idle';
            el.textContent = '';
        }, 2000);
    } else if (kind === 'error') {
        el.innerHTML = `<i class="ri-error-warning-line" aria-hidden="true"></i><span>${escapeHtml(msg || i18nT('chat.save.failed', "Couldn't save"))}</span>
            <button type="button" class="cd-save-retry" data-cd-retry>${escapeHtml(i18nT('chat.save.retry', 'Retry'))}</button>`;
    } else {
        el.textContent = '';
    }
}

function mergePatch(a, b) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
        if (
            v &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            out[k] &&
            typeof out[k] === 'object' &&
            !Array.isArray(out[k])
        ) {
            out[k] = { ...out[k], ...v };
        } else {
            out[k] = v;
        }
    }
    return out;
}

function queueSave(patch, delay = TOGGLE_SAVE_MS) {
    if (!cur) return;
    pending = mergePatch(pending, patch);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flush();
    }, delay);
}

async function flush() {
    if (!cur || !pending) return;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (inflight) {
        // The next flush runs once this one settles (see finally).
        return;
    }
    const target = cur;
    let body = pending;
    pending = null;
    // First save of a chat that isn't configured yet: send everything the
    // page shows, so the new entry matches what the operator sees (the
    // server would otherwise fill in its own defaults).
    const adding = !target.group;
    if (adding) {
        body = mergePatch({ name: target.name, enabled: false, filters: filtersNow() }, body);
    }
    setSaveStatus('saving');
    inflight = saveChatConfig(target.id, body);
    try {
        const group = await inflight;
        if (cur === target) {
            target.group = group || target.group;
            setSaveStatus('saved');
            if (adding) {
                document.querySelector('#page-chat [data-cd-new]')?.remove();
                document.getElementById('cd-danger')?.classList.remove('hidden');
                setSwitch('group-enable-toggle', monitoringNow(), monitorSub());
            }
        }
    } catch (e) {
        if (cur === target) {
            pending = mergePatch(body, pending);
            const msg =
                e?.data?.code === 'GROUP_SUSPENDED'
                    ? i18nT('groups.status.suspended', 'Suspended')
                    : e?.data?.error || e?.message;
            setSaveStatus(
                'error',
                i18nTf('chat.save.failed_msg', { msg }, `Couldn't save: ${msg}`),
            );
        }
    } finally {
        inflight = null;
        if (pending && cur === target && !saveTimer) {
            // Edits made while the request was out.
            saveTimer = setTimeout(() => {
                saveTimer = null;
                flush();
            }, TOGGLE_SAVE_MS);
        }
    }
}

// Tab closing / page reload with edits not sent yet: fire them with
// keepalive so they survive the unload.
function flushOnUnload() {
    if (!cur || !pending) return;
    let body = pending;
    if (!cur.group) {
        body = mergePatch({ name: cur.name, enabled: false, filters: filtersNow() }, body);
    }
    pending = null;
    try {
        fetch(`/api/groups/${encodeURIComponent(cur.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true,
        });
    } catch {
        /* best effort */
    }
}

// ---- Field reads -------------------------------------------------------------

function parseTopicIds(raw) {
    return String(raw || '')
        .split(/[,\s]+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
}

function topicsPatch() {
    const enabled =
        document.getElementById('topics-enable-toggle')?.getAttribute('aria-checked') === 'true';
    const ids = parseTopicIds(document.getElementById('topics-ids')?.value);
    return {
        topics: { enabled, mode: enabled && ids.length > 0 ? 'whitelist' : 'all', ids },
    };
}

function rescueHoursPatch() {
    const n = parseInt(document.getElementById('setting-rescue-hours')?.value, 10);
    return { rescueRetentionHours: Number.isFinite(n) && n > 0 ? Math.min(720, n) : null };
}

// ---- Actions -------------------------------------------------------------------

function goBack() {
    const from = history.state?.tgdlChatFrom;
    if (from) history.back();
    else navigate('#/groups');
}

function openGallery() {
    const from = history.state?.tgdlChatFrom;
    // Came here from this chat's gallery: step back to it (keeps its
    // scroll position) instead of stacking another gallery entry.
    if (from === 'viewer' && String(history.state?.tgdlChatFromGroup) === String(cur.id)) {
        history.back();
        return;
    }
    window.openGroup?.(cur.id, cur.name);
}

async function openBackfill() {
    const id = cur.id;
    // Not configured yet: add it first with this page's filters, so the
    // backfill uses them (POST /api/history would register the chat with
    // the server's own defaults).
    if (!cur.group) {
        queueSave({});
        await flush();
        if (!cur?.group) return;
    }
    import('./backfill.js')
        .then((m) => m.openBackfillSheet(id))
        .catch((e) => console.error('backfill sheet', e));
}

async function deleteFiles() {
    const ok = await confirmSheet({
        title: i18nT('group.data.delete_files', 'Delete files only'),
        message: i18nT(
            'group.data.delete_files_confirm',
            'Drop every download row + on-disk file for this group. Group config (filters, monitor, accounts) is kept so the next pass can re-download fresh.',
        ),
        confirmLabel: i18nT('group.data.delete_files', 'Delete files only'),
        danger: true,
    });
    if (!ok || !cur) return;
    try {
        await api.post(`/api/groups/${encodeURIComponent(cur.id)}/delete-files`, {});
        showToast(i18nT('group.data.delete_files_started', 'Deleting files…'), 'info');
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    }
}

async function wipeAll() {
    const ok = await confirmSheet({
        title: i18nT('group.data.wipe_all', 'Wipe all data'),
        message: i18nT(
            'group.data.wipe_all_confirm',
            'Removes the group from your monitor list, drops every download row, and deletes the on-disk folder. This is destructive.',
        ),
        confirmLabel: i18nT('group.data.wipe_all', 'Wipe all data'),
        danger: true,
    });
    if (!ok || !cur) return;
    try {
        // Nothing left to save for a chat that's about to go.
        pending = null;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        await api.delete(`/api/groups/${encodeURIComponent(cur.id)}/purge`);
        showToast(i18nT('group.data.wipe_started', 'Wiping group…'), 'info');
        goBack();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    }
}

/**
 * Forward-destination picker (Saved Messages, the default storage
 * channel, or any dialog). Fills `#fwd-destination`; the input's change
 * event saves it.
 */
export async function openDestinationPicker() {
    const target = document.getElementById('fwd-destination');
    if (!target) return;
    const box = document.createElement('div');
    box.innerHTML = `
        <input id="dest-search" type="search" autocomplete="off" class="tg-input w-full cd-input mb-3"
            placeholder="${escapeHtml(i18nT('picker.search_placeholder', 'Search by name…'))}"
            aria-label="${escapeHtml(i18nT('picker.search_placeholder', 'Search by name…'))}">
        <div id="dest-list" class="text-sm overflow-y-auto" style="max-height: 60vh">
            <div class="text-tg-textSecondary p-2">${escapeHtml(i18nT('picker.loading', 'Loading dialogs…'))}</div>
        </div>`;
    const handle = openSheet({
        title: i18nT('picker.title', 'Pick a destination'),
        content: box,
        size: 'md',
    });
    const list = box.querySelector('#dest-list');
    const search = box.querySelector('#dest-search');
    let dialogs = [];
    try {
        const r = await api.get('/api/dialogs');
        dialogs = r.dialogs || [];
    } catch (e) {
        if (e?.data?.error === 'no_account') {
            list.innerHTML = `<div class="p-3 text-sm text-tg-textSecondary">${escapeHtml(i18nT('picker.no_account', 'Add a Telegram account first to pick a forward destination.'))} <a href="#/account/add" class="text-tg-blue hover:underline">${escapeHtml(i18nT('groups.no_account.cta', 'Add account'))}</a></div>`;
            return;
        }
        list.innerHTML = `<div class="text-red-400 p-2">${escapeHtml(i18nTf('picker.failed', { msg: e.message }, `Failed to load dialogs: ${e.message}`))}</div>`;
        return;
    }
    const pick = (value) => {
        target.value = value;
        target.dispatchEvent(new Event('change', { bubbles: true }));
        handle.close();
    };
    const renderList = () => {
        const q = search.value.trim().toLowerCase();
        const rows = dialogs.filter(
            (d) => !q || (d.name || '').toLowerCase().includes(q) || String(d.id).includes(q),
        );
        list.innerHTML = `
            <button data-pick="me" type="button" class="cd-pick-row">
                <span class="text-tg-blue">${escapeHtml(i18nT('picker.saved_messages', '📥 Saved Messages'))}</span>
                <span class="cd-pick-sub">${escapeHtml(i18nT('picker.saved_messages_help', 'value: '))}<code>me</code></span>
            </button>
            <button data-pick="" type="button" class="cd-pick-row">
                <span>${escapeHtml(i18nT('picker.default_storage', 'Default storage channel'))}</span>
                <span class="cd-pick-sub">${escapeHtml(i18nT('picker.default_storage_help', 'leave the field empty'))}</span>
            </button>
            <hr class="border-tg-border my-2">
            ${rows
                .slice(0, 300)
                .map(
                    (d) => `
                <button data-pick="${escapeHtml(String(d.id))}" type="button" class="cd-pick-row">
                    <span class="truncate">${escapeHtml(getGroupName(d.id, { fallback: d.name || d.title }))}</span>
                    <span class="cd-pick-sub">${escapeHtml(typeLabel(d.type) || d.type || '')} · <code>${escapeHtml(String(d.id))}</code></span>
                </button>`,
                )
                .join('')}`;
    };
    list.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-pick]');
        if (b) pick(b.dataset.pick);
    });
    renderList();
    search.addEventListener('input', renderList);
    setTimeout(() => search.focus(), 60);
}

// ---- Events --------------------------------------------------------------------

function onClick(e) {
    if (!cur) return;
    const t = e.target;
    if (t.closest('[data-cd-back]')) return goBack();
    if (t.closest('[data-cd-gallery]')) return openGallery();
    if (t.closest('#group-backfill-btn')) return void openBackfill();
    if (t.closest('[data-cd-pick]')) return void openDestinationPicker();
    if (t.closest('#group-data-delete-files-btn')) return void deleteFiles();
    if (t.closest('#group-data-purge-btn')) return void wipeAll();
    if (t.closest('[data-cd-retry]')) {
        queueSave({}, 0);
        return;
    }

    const sw = t.closest('.cd-switch-row[role="switch"]');
    if (sw && !sw.disabled) {
        const on = sw.getAttribute('aria-checked') !== 'true';
        if (sw.id === 'group-enable-toggle') {
            if (cur.group?.suspended) return;
            setSwitch(sw.id, on);
            queueSave({ enabled: on });
            // Sub-line follows the state it will be saved as.
            const sub = sw.querySelector('.cd-switch-sub');
            if (sub) {
                sub.textContent = on
                    ? i18nT('chat.monitor.sub_on', 'New posts download automatically')
                    : i18nT('chat.monitor.sub_off', 'Off — new posts are not downloaded');
            }
        } else if (sw.id === 'fwd-enable-toggle') {
            setSwitch(sw.id, on);
            document.getElementById('fwd-settings')?.classList.toggle('hidden', !on);
            queueSave({ autoForward: { enabled: on } });
        } else if (sw.id === 'fwd-delete-toggle') {
            setSwitch(sw.id, on);
            queueSave({ autoForward: { deleteAfterForward: on } });
        } else if (sw.id === 'topics-enable-toggle') {
            setSwitch(sw.id, on);
            queueSave(topicsPatch());
        }
        return;
    }

    const chip = t.closest('.cd-chip[data-filter]');
    if (chip) {
        const on = chip.getAttribute('aria-pressed') !== 'true';
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        // Keep the local copy in step so a first save (new chat) sends it.
        const key = chip.dataset.filter;
        if (cur.group) cur.group.filters = { ...(cur.group.filters || {}), [key]: on };
        else cur.draftFilters[key] = on;
        queueSave({ filters: { [key]: on } });
        return;
    }

    const radio = t.closest('#setting-rescue-mode [data-rescue-value]');
    if (radio) {
        for (const b of document.querySelectorAll('#setting-rescue-mode [data-rescue-value]')) {
            const sel = b === radio;
            b.setAttribute('aria-checked', sel ? 'true' : 'false');
            b.classList.toggle('active', sel);
        }
        queueSave({ rescueMode: radio.dataset.rescueValue });
    }
}

function onChange(e) {
    if (!cur) return;
    const id = e.target.id;
    if (id === 'fwd-destination') {
        queueSave({ autoForward: { destination: e.target.value.trim() } }, 0);
    } else if (id === 'topics-ids') {
        queueSave(topicsPatch(), 0);
    } else if (id === 'setting-rescue-hours') {
        queueSave(rescueHoursPatch(), 0);
    } else if (id === 'monitor-account') {
        queueSave({ monitorAccount: e.target.value || null }, 0);
    } else if (id === 'forward-account') {
        queueSave({ forwardAccount: e.target.value || null }, 0);
    } else if (id === 'group-owner-peer' && cur.clusterEditable) {
        queueSave({ ownerPeerId: e.target.value || null }, 0);
    } else if (id === 'group-backup-peer' && cur.clusterEditable) {
        queueSave({ backupPeerId: e.target.value || null }, 0);
    }
}

function onInput(e) {
    if (!cur) return;
    const id = e.target.id;
    if (id === 'fwd-destination') {
        queueSave({ autoForward: { destination: e.target.value.trim() } }, TEXT_SAVE_MS);
    } else if (id === 'topics-ids') {
        queueSave(topicsPatch(), TEXT_SAVE_MS);
    } else if (id === 'setting-rescue-hours') {
        queueSave(rescueHoursPatch(), TEXT_SAVE_MS);
    }
}

function onKeydown(e) {
    if (e.key === 'Enter' && e.target.matches?.('#page-chat input.cd-input')) {
        e.preventDefault();
        flush();
    }
}

let wired = false;
function wire(el) {
    if (wired) return;
    wired = true;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKeydown);
    window.addEventListener('pagehide', flushOnUnload);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) flush();
    });
}

function wireWs() {
    if (wsWired) return;
    wsWired = true;
    // A backfill completes files in bursts — refetch the numbers once
    // things settle, not per file.
    let timer = null;
    const refresh = (m) => {
        if (!cur || String(m?.groupId) !== String(cur.id)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (cur && document.body.dataset.page === 'chat') loadStats(cur.token);
        }, 1500);
    };
    ws.on('group_files_deleted', refresh);
    ws.on('download_complete', (m) => refresh(m?.payload || m));
}

// ---- Public API ------------------------------------------------------------------

let tokenSeq = 0;

/**
 * Render the page for `groupId`. `from` / `fromGroup` describe the page
 * the router came from (null for a deep link / reload) — kept on the
 * history entry so Back steps back to it instead of stacking a new one.
 */
export function showChatDetails({ groupId, from = null, fromGroup = null, onName = null }) {
    const el = root();
    if (!el) return;
    const id = String(groupId);
    // Re-rendering (same or another chat) with an edit still waiting:
    // send it for the chat it belongs to.
    if (cur && pending) {
        const target = cur;
        const body = target.group
            ? pending
            : mergePatch({ name: target.name, enabled: false, filters: filtersNow() }, pending);
        pending = null;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        Promise.resolve(inflight)
            .catch(() => {})
            .then(() => saveChatConfig(target.id, body))
            .catch((e) => showToast(e?.data?.error || e?.message || 'Save failed', 'error'));
    }
    // Stamp the history entry the first time it's shown with where it was
    // opened from ('' for a deep link). Coming back to it later through
    // Back / Forward keeps that stamp, so the page's Back button always
    // means "the entry before this one" — or #/groups when there's none.
    if (!history.state?.tgdlChatSeen) {
        try {
            history.replaceState(
                {
                    ...(history.state || {}),
                    tgdlChatSeen: 1,
                    tgdlChatFrom: from || '',
                    tgdlChatFromGroup: fromGroup,
                },
                '',
                location.href,
            );
        } catch {
            /* history unavailable */
        }
    }
    const group = findConfigGroup(id);
    cur = {
        id,
        token: ++tokenSeq,
        group: group ? { ...group, filters: { ...(group.filters || {}) } } : null,
        draftFilters: { ...NEW_CHAT_FILTERS },
        name: getGroupName(id, { fallback: findDialog(id)?.name }),
        onName,
        stats: null,
        clusterEditable: false,
    };
    pending = null;
    render();
    wire(el);
    wireWs();
    setSaveStatus('idle');
    const token = cur.token;
    loadStats(token);
    loadAccountsAndPeers(token);
    loadDialogMeta(token);
}

/** The router is leaving the page — send any edit still waiting. */
export function leaveChatDetails() {
    if (pending) flush();
}

/** Flush now (the old modal's window.saveGroupSettings()). */
export function saveChatDetailsNow() {
    return flush();
}

export function currentChatName() {
    return cur?.name || null;
}
