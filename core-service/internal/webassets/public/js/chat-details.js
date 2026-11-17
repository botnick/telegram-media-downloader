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
import {
    accessAccountsLine,
    accessAdvice,
    accessFor,
    accessLabel,
    accessMetaLine,
    accessReason,
    followMigration,
    isBlockedAccess,
    openLeaveChatSheet,
    recheckChat,
    removeChatsFromList,
    stopMonitoringChats,
} from './chat-access.js';

const FILTERS = [
    { key: 'photos', icon: 'ri-image-line', label: () => i18nT('group.filter.photos', 'Photos') },
    { key: 'videos', icon: 'ri-video-line', label: () => i18nT('group.filter.videos', 'Videos') },
    {
        key: 'files',
        icon: 'ri-file-line',
        label: () => i18nT('group.filter.files', 'Files / Documents'),
    },
    { key: 'audio', icon: 'ri-music-line', label: () => i18nT('group.filter.audio', 'Audio / Music') },
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
let globalForwardProtection = null;
let pending = null; // merged PUT body waiting to be sent
let saveTimer = null;
let inflight = null;
let savedTimer = null;
let wsWired = false;
let forwardRouteSequence = 0;
const forumTopicsCache = new Map();
let dialogsRequest = null;

function loadDialogs() {
    if (state.allDialogs) return Promise.resolve(state.allDialogs);
    if (!dialogsRequest) {
        dialogsRequest = api.get('/api/dialogs').then((result) => {
            state.allDialogs = result?.dialogs || [];
            if (Array.isArray(result?.accounts)) state.dialogsAccounts = result.accounts;
            return state.allDialogs;
        }).catch((error) => {
            dialogsRequest = null;
            throw error;
        });
    }
    return dialogsRequest;
}

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

function fwdSettingsNow() {
    return cur?.group?.autoForward || cur?.draftAutoForward || {};
}

function forwardProtectionIsEnabled(settings = fwdSettingsNow()) {
    if (settings.protect != null) return settings.protect === true || settings.protect === 'on';
    if (globalForwardProtection != null) return globalForwardProtection;
    const configured = state.config?.forwarding?.protect;
    return configured == null ? true : configured === true;
}

function canTryDirectForwardNow(settings = fwdSettingsNow()) {
    return !forwardProtectionIsEnabled(settings);
}

function updateChatAutoForward(patch) {
    if (!cur) return;
    if (cur.group) cur.group.autoForward = { ...(cur.group.autoForward || {}), ...patch };
    else cur.draftAutoForward = { ...(cur.draftAutoForward || {}), ...patch };
}

function syncDirectForwardToggle(settings = fwdSettingsNow()) {
    const current = document.getElementById('fwd-direct-toggle');
    if (!canTryDirectForwardNow(settings)) {
        current?.remove();
        return;
    }
    if (current) return;
    const template = document.createElement('template');
    template.innerHTML = switchRow({
        id: 'fwd-direct-toggle',
        label: i18nT('group.fwd.direct', 'Try direct forward first'),
        sub: i18nT('group.fwd.direct_help', 'When caption and protection settings allow, Telegram forwarding avoids a local download. If Telegram rejects it, the job downloads and uploads the media.'),
        on: settings.directForward === true,
    });
    document.getElementById('fwd-delete-toggle')?.after(template.content.firstElementChild);
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
    return !!g && g.enabled !== false;
}

// ---- Access state (js/chat-access.js) -------------------------------------

function accessNow() {
    return accessFor(cur.id, findDialog(cur.id) || cur.group);
}

function blockedNow() {
    return isBlockedAccess(accessNow());
}

const ACCESS_ICON = {
    migrated: 'ri-arrow-right-up-line',
    deleted: 'ri-delete-bin-6-line',
    banned: 'ri-forbid-2-line',
    restricted: 'ri-error-warning-line',
};

/**
 * The banner for a chat no account can read: what happened in plain
 * words, what to do, when it's checked next, and the actions. Keeps the
 * old `#group-suspended-banner` id.
 */
function accessBannerHtml() {
    const a = accessNow();
    if (!isBlockedAccess(a)) {
        return '<div id="group-suspended-banner" class="cd-banner hidden" role="note"></div>';
    }
    const g = cur.group;
    const migrated = a.state === 'migrated';
    const title = migrated
        ? i18nT('access.banner.moved', 'Moved to a new group')
        : i18nTf(
              'access.banner.title',
              { state: accessLabel(a) },
              `Can't reach this chat — ${accessLabel(a)}`,
          );
    const actions = [];
    if (migrated && a.migratedTo) {
        actions.push(
            `<button type="button" class="tg-btn" data-cd-access="follow"><i class="ri-arrow-right-up-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('access.action.follow', 'Follow the new group'))}</span></button>`,
        );
    }
    actions.push(
        `<button type="button" class="${migrated ? 'tg-btn-secondary' : 'tg-btn'}" data-cd-access="recheck"><i class="ri-refresh-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('access.action.recheck', 'Check again'))}</span></button>`,
    );
    if (g && (cur.accountCount || 0) >= 2 && !['deleted', 'migrated'].includes(a.state)) {
        actions.push(
            `<button type="button" class="tg-btn-secondary" data-cd-access="switch"><i class="ri-user-shared-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('access.action.switch', 'Switch account'))}</span></button>`,
        );
    }
    if (g && g.enabled !== false) {
        actions.push(
            `<button type="button" class="tg-btn-secondary" data-cd-access="stop"><i class="ri-pause-circle-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('access.action.stop', 'Stop monitoring'))}</span></button>`,
        );
    }
    if (g) {
        actions.push(
            `<button type="button" class="cd-access-quiet" data-cd-access="remove">${escapeHtml(i18nT('access.action.remove', 'Remove from list'))}</button>`,
        );
    }
    actions.push(`<button type="button" class="tg-btn-secondary" data-cd-access="leave" data-admin-only><i class="ri-logout-box-r-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('access.leave.action', 'Leave / remove from Telegram'))}</span></button>`);
    return `
        <div id="group-suspended-banner" class="cd-banner cd-access" data-access="${escapeHtml(a.state)}" role="status">
            <div class="cd-access-head">
                <i class="${ACCESS_ICON[a.state] || 'ri-lock-2-line'}" aria-hidden="true"></i>
                <span>${escapeHtml(title)}</span>
            </div>
            <p class="cd-access-text">${escapeHtml(accessReason(a))} ${escapeHtml(accessAdvice(a))}</p>
            <p class="cd-access-meta">${escapeHtml(
                migrated
                    ? i18nT(
                          'access.paused_note_moved',
                          'Monitoring, backfill and forwarding are paused for this chat. Downloaded files are kept.',
                      )
                    : g && g.enabled !== false
                      ? i18nT(
                            'access.paused_note',
                            "Monitoring, backfill and forwarding are paused for this chat. Check again refreshes its Telegram status. Downloaded files are kept.",
                        )
                      : i18nT(
                            'access.paused_note_off',
                            "Monitoring is off for this chat, and backfill is paused while it can't be reached. Downloaded files are kept.",
                        ),
            )}</p>
            <p class="cd-access-meta" data-cd-access-meta>${escapeHtml(accessMetaLine(a, { showNext: !!g && g.enabled !== false }))}</p>
            <p class="cd-access-meta">${escapeHtml(accessAccountsLine(a))}</p>
            <div class="cd-access-actions">${actions.join('')}</div>
        </div>`;
}

/** Repaint everything that depends on the access state, in place. */
function paintAccess() {
    if (!cur) return;
    const el = document.getElementById('group-suspended-banner');
    if (el) el.outerHTML = accessBannerHtml();
    const blocked = blockedNow();
    const bf = document.getElementById('group-backfill-btn');
    if (bf) {
        bf.disabled = blocked;
        bf.title = blocked ? i18nT('access.backfill_off', "This chat can't be reached") : '';
    }
    const sw = document.getElementById('group-enable-toggle');
    if (sw) {
        const legacyOff = cur.group?.suspended === true;
        sw.disabled = (legacyOff || blocked || findDialog(cur.id)?.dmDisabled) && !monitoringNow();
        if (sw.disabled) sw.setAttribute('aria-disabled', 'true');
        else sw.removeAttribute('aria-disabled');
    }
    setSwitch('group-enable-toggle', monitoringNow(), monitorSub());
}

/** WS `chat_access_changed` / a groups reload: pick up the new state. */
export function refreshChatAccess() {
    if (!cur) return;
    const fresh = findConfigGroup(cur.id);
    if (fresh && cur.group) {
        cur.group.access = fresh.access;
        if (fresh.suspended !== true) delete cur.group.suspended;
        cur.group.enabled = fresh.enabled;
        cur.group.forwardAccess = fresh.forwardAccess;
    }
    paintAccess();
}

async function onAccessAction(kind, btn) {
    if (!cur) return;
    const target = cur;
    const setBusy = (on) => {
        if (!btn) return;
        btn.disabled = on;
        if (on) {
            btn.dataset.label = btn.querySelector('span')?.textContent || '';
            const s = btn.querySelector('span');
            if (s && kind === 'recheck') s.textContent = i18nT('access.checking', 'Checking…');
        } else if (btn.dataset.label) {
            const s = btn.querySelector('span');
            if (s) s.textContent = btn.dataset.label;
        }
    };
    try {
        if (kind === 'leave') {
            openLeaveChatSheet({ ...(findDialog(target.id) || target.group), id: target.id, name: target.name }, { onRemoved: () => goBack() });
        } else if (kind === 'recheck') {
            setBusy(true);
            const r = await recheckChat(target.id, { name: target.name });
            if (cur !== target) return;
            if (target.group && r?.access) {
                target.group.access = r.access;
                if (r.state === 'ok') delete target.group.suspended;
            }
            paintAccess();
        } else if (kind === 'switch') {
            const sec = document.getElementById('cd-accounts');
            sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(() => document.getElementById('monitor-account')?.focus(), 350);
        } else if (kind === 'stop') {
            setBusy(true);
            await stopMonitoringChats([target.id]);
            if (cur !== target) return;
            if (target.group) target.group.enabled = false;
            paintAccess();
        } else if (kind === 'remove') {
            const ok = await confirmSheet({
                title: i18nT('access.confirm.remove_title', 'Remove from list?'),
                message: i18nTf(
                    'access.confirm.remove_body',
                    { name: target.name },
                    `Removes ${target.name} from your chats list. Downloaded files stay in the library, and nothing changes in Telegram.`,
                ),
                confirmLabel: i18nT('access.action.remove', 'Remove from list'),
            });
            if (!ok) return;
            pending = null;
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = null;
            await removeChatsFromList([target.id]);
            goBack();
        } else if (kind === 'follow') {
            const ok = await confirmSheet({
                title: i18nT('access.confirm.follow_title', 'Follow the new group?'),
                message: i18nT(
                    'access.confirm.follow_body',
                    "Adds the new group with this chat's settings and stops monitoring this one. Files already downloaded stay where they are.",
                ),
                confirmLabel: i18nT('access.action.follow', 'Follow the new group'),
            });
            if (!ok) return;
            const r = await followMigration(target.id);
            const next = r?.group?.id;
            if (next != null) navigate(`#/groups/${encodeURIComponent(String(next))}`);
        }
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'Failed';
        showToast(msg, 'error');
    } finally {
        if (btn?.isConnected) setBusy(false);
    }
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

function forwardGroupDestinations() {
    const byID = new Map();
    for (const chat of [...(state.allDialogs || []), ...(state.groups || [])]) {
        if (chat?.id == null) continue;
        const id = String(chat.id);
        if (id === 'me' || id === 'storage') continue;
        byID.set(id, { id, name: getGroupName(id, { fallback: chat.name || chat.title }) });
    }
    if (cur?.id) byID.set(String(cur.id), { id: String(cur.id), name: cur.name });
    return [...byID.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function forwardGroupOptions(selected, groups = forwardGroupDestinations()) {
    const byID = new Map(groups.map((group) => [group.id, group]));
    const special = [
        { id: 'storage', name: i18nT('group.fwd.storage', 'Telegram Downloader Storage') },
        { id: 'me', name: i18nT('group.fwd.saved_messages', 'Saved Messages') },
    ];
    if (selected && !special.some((item) => item.id === String(selected)) && !byID.has(String(selected))) {
        special.push({ id: String(selected), name: getGroupName(String(selected), { fallback: String(selected) }) });
    }
    return `<option value="">${escapeHtml(i18nT('group.fwd.select_destination', 'Select a destination…'))}</option>${special
        .map((item) => `<option value="${item.id}" ${item.id === String(selected || '') ? 'selected' : ''}>${escapeHtml(item.name)}</option>`)
        .join('')}${groups
        .map((group) => `<option value="${escapeHtml(group.id)}" ${group.id === String(selected || '') ? 'selected' : ''}>${escapeHtml(group.name)}</option>`)
        .join('')}`;
}

function forwardRouteHtml(route = {}, index = 0, groups) {
    const routeLabel = i18nTf('group.fwd.route_number', { number: index + 1 }, `Route ${index + 1}`);
    const suffix = ++forwardRouteSequence;
    const sourceID = `fwd-source-topic-${suffix}`;
    const destinationID = `fwd-destination-group-${suffix}`;
    const destinationTopicID = `fwd-destination-topic-${suffix}`;
    const destinationGroupId = route.destinationGroupId ?? 'storage';
    const captions = Object.fromEntries(['captionMode', 'captionModeOverride', 'caption', 'regexPattern', 'regexReplacement']
        .filter((key) => key in route).map((key) => [key, route[key]]));
    return `<fieldset class="cd-forward-route" data-forward-route data-caption-settings="${escapeHtml(JSON.stringify(captions))}">
        <div class="cd-route-head"><span class="cd-route-number">${escapeHtml(routeLabel)}</span>
        <button type="button" class="cd-route-remove" data-route-remove aria-label="${escapeHtml(i18nTf('group.fwd.remove_route_number', { number: index + 1 }, `Remove route ${index + 1}`))}"><i class="ri-delete-bin-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('group.fwd.remove_route', 'Remove route'))}</span></button></div>
        <div class="cd-route-field hidden" data-route-source-topic-wrap><label class="cd-label" for="${sourceID}-trigger">${escapeHtml(i18nTf('group.fwd.source_topic', { name: cur?.name || '' }, 'Source topic · {name}'))}</label>
        <div class="cd-search-select" data-search-select><button id="${sourceID}-trigger" type="button" class="tg-input cd-input cd-select-trigger" data-select-trigger aria-haspopup="listbox" aria-expanded="false"><span data-select-value></span><i class="ri-arrow-down-s-line" aria-hidden="true"></i></button><div class="cd-select-menu hidden" data-select-menu><input id="${sourceID}-search" class="tg-input cd-input cd-option-search" type="search" data-option-search data-option-search-empty="${escapeHtml(i18nT('group.fwd.no_search_results', 'No matching options.'))}" placeholder="${escapeHtml(i18nT('group.fwd.search_topics', 'Search topics…'))}" aria-label="${escapeHtml(i18nT('group.fwd.search_source_topics', 'Search source topics'))}" autocomplete="off"><div class="cd-select-options" data-select-options role="listbox"></div></div>
        <select id="${sourceID}" class="cd-native-select" data-route-source-topic data-selected="${escapeHtml(String(route.sourceTopicId || 0))}" tabindex="-1" aria-hidden="true">
            <option value="0">${escapeHtml(i18nT('group.fwd.all_topics', 'All topics'))}</option>
        </select></div></div>
        <div class="cd-route-field"><label class="cd-label" for="${destinationID}-trigger">${escapeHtml(i18nT('group.fwd.destination_group', 'Destination group'))}</label>
        <div class="cd-search-select" data-search-select><button id="${destinationID}-trigger" type="button" class="tg-input cd-input cd-select-trigger" data-select-trigger aria-haspopup="listbox" aria-expanded="false"><span data-select-value></span><i class="ri-arrow-down-s-line" aria-hidden="true"></i></button><div class="cd-select-menu hidden" data-select-menu><input id="${destinationID}-search" class="tg-input cd-input cd-option-search" type="search" data-option-search data-option-search-empty="${escapeHtml(i18nT('group.fwd.no_search_results', 'No matching options.'))}" placeholder="${escapeHtml(i18nT('group.fwd.search_groups', 'Search groups…'))}" aria-label="${escapeHtml(i18nT('group.fwd.search_groups', 'Search groups…'))}" autocomplete="off"><div class="cd-select-options" data-select-options role="listbox"></div></div>
        <select id="${destinationID}" class="cd-native-select" data-route-destination data-selected="${escapeHtml(String(destinationGroupId))}" tabindex="-1" aria-hidden="true">${forwardGroupOptions(destinationGroupId, groups)}</select></div></div>
        <div class="cd-route-field hidden" data-route-destination-topic-wrap><label class="cd-label" for="${destinationTopicID}-trigger">${escapeHtml(i18nT('group.fwd.destination_topic', 'Destination topic'))}</label>
        <div class="cd-search-select" data-search-select><button id="${destinationTopicID}-trigger" type="button" class="tg-input cd-input cd-select-trigger" data-select-trigger aria-haspopup="listbox" aria-expanded="false"><span data-select-value></span><i class="ri-arrow-down-s-line" aria-hidden="true"></i></button><div class="cd-select-menu hidden" data-select-menu><input id="${destinationTopicID}-search" class="tg-input cd-input cd-option-search" type="search" data-option-search data-option-search-empty="${escapeHtml(i18nT('group.fwd.no_search_results', 'No matching options.'))}" placeholder="${escapeHtml(i18nT('group.fwd.search_topics', 'Search topics…'))}" aria-label="${escapeHtml(i18nT('group.fwd.search_destination_topics', 'Search destination topics'))}" autocomplete="off"><div class="cd-select-options" data-select-options role="listbox"></div></div>
        <select id="${destinationTopicID}" class="cd-native-select" data-route-destination-topic data-selected="${escapeHtml(String(route.destinationTopicId || 0))}" tabindex="-1" aria-hidden="true" disabled>
            <option value="0">${escapeHtml(i18nT('group.fwd.no_topic', 'No topic'))}</option>
        </select></div></div>
        <p class="cd-help cd-route-full" data-route-topics-status role="status"></p><p class="cd-help cd-route-full hidden" data-route-wildcard-note>${escapeHtml(i18nT('group.fwd.all_topics_route_note', 'This route includes all source topics.'))}</p>
    </fieldset>`;
}

function appendForwardRoute() {
    const routes = document.getElementById('fwd-routes');
    if (!routes) return null;
    const template = document.createElement('template');
    template.innerHTML = forwardRouteHtml({}, routes.querySelectorAll('[data-forward-route]').length).trim();
    const card = template.content.firstElementChild;
    routes.appendChild(card);
    void loadForwardRouteOptions(card);
    return card;
}

function globalCaptionFields(settings = {}) {
    const savedMode = settings.captionMode;
    const mode = ['source_info', 'source', 'none', 'override', 'regex', 'custom'].includes(savedMode)
        ? ['source_info', 'override', 'regex'].includes(savedMode) ? 'custom' : savedMode
        : 'source';
    let caption = settings.caption || (savedMode === 'source_info' ? '{{source_caption}}\n\n{{source_info}}' : '');
    if (savedMode === 'regex' || (savedMode === 'custom' && settings.captionBase === 'source')) {
        caption = '{{source_caption}}';
    }
    return `<div class="cd-caption-fields" data-global-caption>
        <div class="cd-route-field">
            <label class="cd-label" for="fwd-caption-mode-trigger">${escapeHtml(i18nT('group.fwd.caption_mode', 'Group caption'))}</label>
            <div class="cd-search-select" data-search-select>
                <button id="fwd-caption-mode-trigger" type="button" class="tg-input cd-input cd-select-trigger" data-select-trigger aria-haspopup="listbox" aria-expanded="false">
                    <span data-select-value></span>
                    <i class="ri-arrow-down-s-line" aria-hidden="true"></i>
                </button>
                <div class="cd-select-menu hidden" data-select-menu data-no-search>
                    <div class="cd-select-options" data-select-options role="listbox"></div>
                </div>
                <select id="fwd-caption-mode" class="cd-native-select" data-global-caption-mode data-selected="${escapeHtml(mode)}" tabindex="-1" aria-hidden="true">
                    <option value="source" ${mode === 'source' ? 'selected' : ''}>${escapeHtml(i18nT('group.fwd.caption_source', 'Use caption from source message'))}</option>
                    <option value="none" ${mode === 'none' ? 'selected' : ''}>${escapeHtml(i18nT('group.fwd.caption_none', 'No caption'))}</option>
                    <option value="custom" ${mode === 'custom' ? 'selected' : ''}>${escapeHtml(i18nT('group.fwd.caption_custom', 'Customize caption'))}</option>
                </select>
            </div>
        </div>
        <div class="cd-route-field cd-caption-full ${mode === 'custom' ? '' : 'hidden'}" data-global-caption-override-wrap>
            <label class="cd-label" for="fwd-caption-override">${escapeHtml(i18nT('group.fwd.override_text', 'Custom caption text'))}</label>
            <textarea id="fwd-caption-override" class="tg-input cd-input" rows="2" data-global-caption-override>${escapeHtml(caption)}</textarea>
            <p class="cd-help">${escapeHtml(i18nT('group.fwd.caption_custom_help', 'Template variables for the replacement caption and regex Replace with: {{source_caption}}, {{source_name}}, {{source_id}}, {{message_id}}, {{source_info}}, {{source_link}} (when available).'))}</p>
        </div>
        <div class="cd-caption-full cd-caption-regex ${mode === 'custom' ? '' : 'hidden'}" data-global-caption-regex-wrap>
            <p class="cd-subheading">${escapeHtml(i18nT('group.fwd.regex_transform', 'Regex transform (optional)'))}</p>
            <p class="cd-help">${escapeHtml(i18nT('group.fwd.regex_help', 'Find and replace text in the custom caption. Leave the pattern empty to skip this step.'))}</p>
            <div class="cd-route-field">
                <label class="cd-label" for="fwd-caption-regex">${escapeHtml(i18nT('group.fwd.regex_pattern', 'Find pattern (regular expression)'))}</label>
                <input id="fwd-caption-regex" class="tg-input cd-input" type="text" data-global-caption-regex value="${escapeHtml(settings.regexPattern || '')}">
            </div>
            <div class="cd-route-field">
                <label class="cd-label" for="fwd-caption-replacement">${escapeHtml(i18nT('group.fwd.regex_replacement', 'Replace with'))}</label>
                <textarea id="fwd-caption-replacement" class="tg-input cd-input" rows="2" data-global-caption-replacement>${escapeHtml(settings.regexReplacement || '')}</textarea>
            </div>
        </div>
    </div>`;
}

async function loadTopicOptions(select, groupID, emptyLabel, disableClosed = false) {
    if (!select) return;
    const wrapper = select.closest('[data-route-source-topic-wrap], [data-route-destination-topic-wrap]');
    const isSourceTopic = select.matches('[data-route-source-topic]');
    if (!select.isConnected) return;
    wrapper?.classList.remove('hidden');
    const loadToken = (Number(select.dataset.loadToken) || 0) + 1;
    select.dataset.loadToken = String(loadToken);
    const selected = select.dataset.selected || select.value || '0';
    select.disabled = true;
    select.innerHTML = `<option value="${escapeHtml(selected)}" selected>${escapeHtml(i18nT('group.fwd.topics_loading', 'Loading topics…'))}</option>`;
    cacheSearchOptions(select);
    try {
        let request = forumTopicsCache.get(groupID);
        if (!request) {
            request = api
                .get(`/api/dialogs/${encodeURIComponent(groupID)}/topics`, { timeoutMs: 130_000 })
                .then((result) => (Array.isArray(result?.topics) ? result.topics : []))
                .catch((error) => {
                    forumTopicsCache.delete(groupID);
                    throw error;
                });
            forumTopicsCache.set(groupID, request);
        }
        const topics = await request;
        if (!select.isConnected || select.dataset.loadToken !== String(loadToken)) return;
        let availableTopics = topics;
        let rule = null;
        if (select.matches('[data-route-source-topic]')) {
            rule = topicsPatch().topics;
            if (rule.enabled && rule.ids.length) {
                const ids = new Set(rule.ids.map(String));
                availableTopics = topics.filter((topic) => rule.mode === 'whitelist' ? ids.has(String(topic.id)) : !ids.has(String(topic.id)));
            }
        }
        const resolvedSelection = selected;
        select.dataset.selected = resolvedSelection;
        const resolvedEmptyLabel = select.matches('[data-route-source-topic]') && rule?.enabled && rule.ids.length
            ? i18nT('group.fwd.all_processed_topics', 'All processed topics')
            : emptyLabel;
        select.innerHTML = `<option value="0">${escapeHtml(resolvedEmptyLabel)}</option>${availableTopics
            .map((topic) => `<option value="${escapeHtml(String(topic.id))}" ${String(topic.id) === resolvedSelection ? 'selected' : ''} ${disableClosed && topic.closed ? 'disabled' : ''}>${escapeHtml(topic.name)}${topic.closed ? ` · ${escapeHtml(i18nT('group.fwd.closed', 'closed'))}` : ''}</option>`)
            .join('')}${selected !== '0' && !availableTopics.some((topic) => String(topic.id) === selected) ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(emptyLabel)} #${escapeHtml(selected)}</option>` : ''}`;
        cacheSearchOptions(select);
        select.disabled = topics.length === 0;
        if (wrapper) wrapper.classList.toggle('hidden', topics.length === 0);
        filterSearchOptions(select);
        updateRouteWildcardState();
        const status = select.closest('[data-forward-route]')?.querySelector('[data-route-topics-status]');
        if (status) status.textContent = '';
    } catch (error) {
        if (!select.isConnected || select.dataset.loadToken !== String(loadToken)) return;
        select.innerHTML = `<option value="${escapeHtml(selected)}" selected>${escapeHtml(i18nT('group.fwd.topics_unavailable', 'Topics unavailable'))} #${escapeHtml(selected)}</option>`;
        wrapper?.classList.remove('hidden');
        cacheSearchOptions(select);
        const status = select.closest('[data-forward-route]')?.querySelector('[data-route-topics-status]');
        if (status) status.textContent = error?.data?.message || error?.data?.error || i18nT('group.fwd.topics_error', 'Could not load topic names. Check the Telegram connection and try again.');
    }
}

function cacheSearchOptions(select) {
    if (!select) return;
    select._searchOptions = [...select.options].map((option) => ({
        value: option.value,
        label: option.textContent,
        searchLabel: option.textContent.toLocaleLowerCase(),
        disabled: option.disabled,
    }));
    select._searchOptionsByValue = new Map(select._searchOptions.map((option) => [option.value, option]));
    filterSearchOptions(select);
}

function filterSearchOptions(select, query = null) {
    if (!select) return;
    const widget = select.closest('[data-search-select]');
    const input = widget?.querySelector('[data-option-search]');
    const options = select._searchOptions || [...select.options].map((option) => ({
        value: option.value,
        label: option.textContent,
        searchLabel: option.textContent.toLocaleLowerCase(),
        disabled: option.disabled,
    }));
    const value = input ? (query ?? input.value).trim().toLocaleLowerCase() : '';
    const selected = select.value;
    // The native <select> is the canonical full option set. Rebuilding all
    // options for every search keystroke was O(N) DOM churn and could stall
    // configuration pages with thousands of dialogs or forum topics.
    // Search the cached descriptors and render only a bounded visible menu.
    const MAX_VISIBLE_OPTIONS = 100;
    const matching = [];
    let matchCount = 0;
    for (const option of options) {
        if (value && !option.searchLabel.includes(value)) continue;
        matchCount++;
        if (matching.length < MAX_VISIBLE_OPTIONS) matching.push(option);
    }
    const list = widget?.querySelector('[data-select-options]');
    if (list) {
        list.innerHTML = matchCount
            ? matching.map((option) => `<button type="button" role="option" class="${option.value === selected ? 'is-selected' : ''}" aria-selected="${option.value === selected}" data-select-option="${escapeHtml(option.value)}" ${option.disabled ? 'disabled' : ''}><span class="cd-select-option-text">${escapeHtml(option.label)}</span>${option.value === selected ? '<i class="ri-check-line cd-select-check" aria-hidden="true"></i>' : ''}</button>`).join('')
            : `<span class="cd-select-empty">${escapeHtml(input?.dataset.optionSearchEmpty || 'No matching options.')}</span>`;
        if (matchCount > matching.length) {
            const hint = document.createElement('span');
            hint.className = 'cd-select-empty';
            hint.setAttribute('role', 'status');
            hint.textContent = `Showing first ${matching.length} of ${matchCount} matches. Type to narrow results.`;
            list.appendChild(hint);
        }
    }
    const selectedOption = select._searchOptionsByValue?.get(selected) || options.find((option) => option.value === selected);
    const trigger = widget?.querySelector('[data-select-trigger]');
    if (trigger) {
        trigger.querySelector('[data-select-value]').textContent = selectedOption?.label || '';
        trigger.disabled = select.disabled;
        trigger.setAttribute('aria-label', selectedOption?.label || input?.getAttribute('aria-label') || 'Select option');
    }
    const empty = input?.dataset.optionSearchEmpty;
    input?.setAttribute('aria-description', value && matchCount === 0 ? empty : '');
}

function closeSearchSelect(widget) {
    if (!widget) return;
    widget.querySelector('[data-select-menu]')?.classList.add('hidden');
    widget.querySelector('[data-select-trigger]')?.setAttribute('aria-expanded', 'false');
}

function refreshSourceTopicOptions() {
    return Promise.all([...document.querySelectorAll('[data-route-source-topic]')]
        .map((select) => loadTopicOptions(select, cur.id, i18nT('group.fwd.all_topics', 'All topics'))));
}

function updateRouteWildcardState() {
    const routes = [...document.querySelectorAll('[data-forward-route]')];
    // Index the selected pairs once instead of re-querying every other route
    // for each option. This matters with many destinations/topics and routes.
    const selections = routes.map((card) => ({
        card,
        source: card.querySelector('[data-route-source-topic]'),
        destination: card.querySelector('[data-route-destination]'),
    }));
    const countsByDestination = new Map();
    const countsBySource = new Map();
    for (const entry of selections) {
        entry.sourceID = Number(entry.source?.value) || 0;
        entry.destinationID = entry.destination?.value || '';
        const bySource = countsByDestination.get(entry.destinationID) || new Map();
        bySource.set(entry.sourceID, (bySource.get(entry.sourceID) || 0) + 1);
        countsByDestination.set(entry.destinationID, bySource);
        const byDestination = countsBySource.get(entry.sourceID) || new Map();
        byDestination.set(entry.destinationID, (byDestination.get(entry.destinationID) || 0) + 1);
        countsBySource.set(entry.sourceID, byDestination);
    }
    for (const { card, source, destination, sourceID, destinationID } of selections) {
        const remove = card.querySelector('[data-route-remove]');
        if (remove) remove.disabled = routes.length <= 1;
        const sourceAll = source && !source.closest('[data-route-source-topic-wrap]')?.classList.contains('hidden') && sourceID === 0;
        card.querySelector('[data-route-wildcard-note]')?.classList.toggle('hidden', !sourceAll);

        const sourceCache = new Map((source?._searchOptions || []).map((item) => [item.value, item]));
        const destinationCache = new Map((destination?._searchOptions || []).map((item) => [item.value, item]));
        for (const option of source?.options || []) {
            const value = Number(option.value);
            const conflicts = countsByDestination.get(destinationID)?.get(value) || 0;
            option.disabled = Boolean(destinationID) && conflicts > (sourceID === value ? 1 : 0);
            const cached = sourceCache.get(option.value);
            if (cached) cached.disabled = option.disabled;
        }
        for (const option of destination?.options || []) {
            const conflicts = countsBySource.get(sourceID)?.get(option.value) || 0;
            option.disabled = Boolean(option.value) && conflicts > (destinationID === option.value ? 1 : 0);
            const cached = destinationCache.get(option.value);
            if (cached) cached.disabled = option.disabled;
        }
    }
}

async function loadForwardRouteOptions(route = null) {
    const cards = route ? [route] : [...(document.querySelectorAll('[data-forward-route]') || [])];
    if (!state.allDialogs) await loadDialogs().catch(() => {});
    for (const card of cards) {
        const source = card.querySelector('[data-route-source-topic]');
        const destination = card.querySelector('[data-route-destination]');
        if (destination) {
            const selected = destination.dataset.selected || destination.value;
            destination.innerHTML = forwardGroupOptions(selected);
            destination.dataset.selected = selected;
        }
        cacheSearchOptions(destination);
        card.querySelector('[data-route-source-topic]')?.closest('select')?.setAttribute('aria-label', `${i18nT('group.fwd.source_topic', 'Source topic')} · ${cur?.name || ''}`);
    }

    await Promise.all(cards.map((card) => {
        const source = card.querySelector('[data-route-source-topic]');
        return source && cur?.id
            ? loadTopicOptions(source, cur.id, i18nT('group.fwd.all_topics', 'All topics'))
            : Promise.resolve();
    }));

    await Promise.all(cards.map(async (card) => {
        const destination = card.querySelector('[data-route-destination]');
        const targetTopic = card.querySelector('[data-route-destination-topic]');
        if (targetTopic) {
            const selected = targetTopic.dataset.selected || targetTopic.value || '0';
            targetTopic.innerHTML = `<option value="0">${escapeHtml(i18nT('group.fwd.no_topic', 'No topic'))}</option>${selected !== '0' ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(i18nT('group.fwd.no_topic', 'No topic'))} #${escapeHtml(selected)}</option>` : ''}`;
            targetTopic.value = selected;
            targetTopic.disabled = !destination?.value || ['storage', 'me'].includes(destination.value);
            targetTopic.dataset.selected = selected;
            targetTopic.closest('[data-route-destination-topic-wrap]')?.classList.add('hidden');
        }
        card.querySelectorAll('[data-search-select] select').forEach((select) => filterSearchOptions(select));
    }));
    updateRouteWildcardState();
}

function updateTopicFilterCount() {
    const list = document.getElementById('topics-list');
    const total = list ? list.querySelectorAll('[data-topic-filter-id]').length : 0;
    const selected = list ? list.querySelectorAll('[data-topic-filter-id]:checked').length : 0;
    const counter = document.querySelector('[data-topic-counter]');
    if (counter) {
        counter.textContent = i18nTf(
            'group.topics.count',
            { selected, total },
            `${selected} of ${total} topics selected`,
        );
    }
}

export function preloadGroupTopics(groupId) {
    const id = String(groupId || '');
    if (!id) return Promise.resolve([]);
    let request = forumTopicsCache.get(id);
    if (!request) {
        request = api.get(`/api/dialogs/${encodeURIComponent(id)}/topics`, { timeoutMs: 130_000 })
            .then((result) => (Array.isArray(result?.topics) ? result.topics : []))
            .catch((error) => { forumTopicsCache.delete(id); throw error; });
        forumTopicsCache.set(id, request);
    }
    return request;
}

function collectForwardRoutes() {
    return [...document.querySelectorAll('[data-forward-route]')]
        .map((card) => ({
            sourceTopicId: Number(card.querySelector('[data-route-source-topic]')?.dataset.selected ?? card.querySelector('[data-route-source-topic]')?.value) || 0,
            destinationGroupId: card.querySelector('[data-route-destination]')?.value || '',
            destinationTopicId: Number(card.querySelector('[data-route-destination-topic]')?.dataset.selected ?? card.querySelector('[data-route-destination-topic]')?.value) || 0,
            captionMode: 'inherit',
            captionModeOverride: false,
            ...JSON.parse(card.dataset.captionSettings || '{}'),
        }))
        .filter((route) => route.destinationGroupId);
}

function monitorSub() {
    if (cur.group?.suspended) return i18nT('groups.status.suspended', 'Suspended');
    if (!cur.group) return i18nT('chat.monitor.sub_new', 'Not monitored yet');
    if (monitoringNow() && blockedNow()) {
        return i18nT('access.monitor_paused', "Paused — this chat can't be reached");
    }
    return monitoringNow()
        ? i18nT('chat.monitor.sub_on', 'New posts download automatically')
        : i18nT('chat.monitor.sub_off', 'Off — new posts are not downloaded');
}

function render() {
    const el = root();
    if (!el || !cur) return;
    const g = cur.group;
    const fwd = fwdSettingsNow();
    const savedRoutes = Array.isArray(fwd.routes) ? fwd.routes : [];
    const forwardRoutes = savedRoutes.filter((route) => String(route?.destinationGroupId || '').trim());
    if (!forwardRoutes.length && !Array.isArray(fwd.routes) && fwd.destination) {
        forwardRoutes.push({ sourceTopicId: 0, destinationGroupId: String(fwd.destination) });
    }
    if (!forwardRoutes.length && !Array.isArray(fwd.routes) && fwd.enabled === true) {
        forwardRoutes.push({ sourceTopicId: 0, destinationGroupId: 'storage' });
    }
    if (!forwardRoutes.length) forwardRoutes.push({ sourceTopicId: 0, destinationGroupId: 'storage' });
    const forwardingConfigured = forwardRoutes.length > 0 && forwardRoutes.every((route) => String(route.destinationGroupId || '').trim());
    const forwardingEnabled = fwd.enabled === true;
    const forwardProtectionEnabled = forwardProtectionIsEnabled(fwd);
    const canTryDirectForward = !forwardProtectionEnabled;
    const topicRule = g?.topics || {};
    const forumTopics = Array.isArray(cur.forumTopics) ? cur.forumTopics : [];
    const selectedTopics = new Set((topicRule.ids || []).map(String));
    const filters = filtersNow();
    const rescue = ['on', 'off', 'auto'].includes(g?.rescueMode) ? g.rescueMode : 'auto';
    const suspended = g?.suspended === true;
    const blocked = blockedNow();
    const fwdBlocked = isBlockedAccess(g?.forwardAccess) && forwardingEnabled;
    const d = findDialog(cur.id);
    const forwardDestinations = forwardGroupDestinations();

    el.classList.add('cd-page');
    el.innerHTML = `
        <div class="cd-topbar">
            <button type="button" class="cd-back" data-cd-back>
                <i class="ri-arrow-left-line" aria-hidden="true"></i>
                <span>${escapeHtml(i18nT('chat.back', 'Back'))}</span>
            </button>
            <span id="cd-save-status" class="cd-save" data-state="idle" role="status" aria-live="polite"></span>
            <button type="button" class="tg-btn cd-save-action" data-cd-save>
                <i class="ri-save-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.save.now', 'Save now'))}</span>
            </button>
        </div>
        <p class="cd-save-help">${escapeHtml(i18nT('chat.save.auto_hint', 'Edits auto-save. Save now commits any changes still pending.'))}</p>

        <section class="cd-card cd-hero" aria-labelledby="cd-name">
            <div class="cd-hero-top">
                ${createAvatar({ id: cur.id, name: cur.name, type: d?.type || g?.type, size: 'xl' })}
                <div class="cd-hero-text">
                    <h2 id="cd-name" class="cd-name">${escapeHtml(cur.name)}</h2>
                    <p class="cd-meta" data-cd-meta>${escapeHtml(heroMeta())}</p>
                    <p class="cd-meta" data-cd-stats>${escapeHtml(statsLine(cur.stats))}</p>
                </div>
            </div>
            ${accessBannerHtml()}
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
                disabled: (suspended || blocked || findDialog(cur.id)?.dmDisabled) && !monitoringNow(),
                extraClass: 'cd-switch-row--hero',
            })}
            <div class="cd-actions">
                <button type="button" class="tg-btn-secondary cd-action" data-cd-gallery>
                    <i class="ri-gallery-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.open_gallery', 'Open gallery'))}</span>
                </button>
                <button type="button" id="group-backfill-btn" class="tg-btn cd-action" ${blocked ? `disabled title="${escapeHtml(i18nT('access.backfill_off', "This chat can't be reached"))}"` : ''}>
                    <i class="ri-history-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chat.backfill', 'Backfill…'))}</span>
                </button>
            </div>
        </section>

        <section class="cd-section" aria-labelledby="cd-h-download">
            <h3 id="cd-h-download" class="cd-heading">${escapeHtml(i18nT('chat.section.download', 'What to download'))}</h3>
            <p class="cd-help">${escapeHtml(i18nT('chat.section.download_help', 'Choose which new messages are processed. These filters apply to both downloads and auto-forward.'))}</p>
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
                ${forumTopics.length ? `
                    <section class="cd-topic-section cd-more" aria-labelledby="cd-topics-title">
                        <div class="cd-more-body">
                        <h4 id="cd-topics-title" class="cd-subheading">${escapeHtml(i18nT('chat.more', 'Forum topics'))}</h4>
                        ${switchRow({
                            id: 'topics-enable-toggle',
                            label: i18nT('group.topics.title', 'Limit by forum topic'),
                            sub: i18nT('chat.topics.sub', 'In forum groups, limit processing to selected topics.'),
                            on: topicRule.enabled === true,
                        })}
                        <div id="topics-settings" class="${topicRule.enabled === true ? '' : 'hidden'}">
                        <div class="cd-route-field">
                            <label class="cd-label" for="topics-mode-trigger">${escapeHtml(i18nT('group.topics.mode', 'Selected topic rule'))}</label>
                            <div class="cd-search-select" data-search-select>
                                <button id="topics-mode-trigger" type="button" class="tg-input cd-input cd-select-trigger" data-select-trigger aria-haspopup="listbox" aria-expanded="false">
                                    <span data-select-value></span>
                                    <i class="ri-arrow-down-s-line" aria-hidden="true"></i>
                                </button>
                                <div class="cd-select-menu hidden" data-select-menu data-no-search>
                                    <div class="cd-select-options" data-select-options role="listbox"></div>
                                </div>
                                <select id="topics-mode" class="cd-native-select" data-selected="${topicRule.mode === 'blacklist' ? 'blacklist' : 'whitelist'}" tabindex="-1" aria-hidden="true">
                                    <option value="whitelist" ${topicRule.mode !== 'blacklist' ? 'selected' : ''}>${escapeHtml(i18nT('group.topics.process_selected', 'Include selected topics'))}</option>
                                    <option value="blacklist" ${topicRule.mode === 'blacklist' ? 'selected' : ''}>${escapeHtml(i18nT('group.topics.ignore_selected', 'Exclude selected topics'))}</option>
                                </select>
                            </div>
                        </div>
                        <div class="cd-topic-toolbar">
                            <span class="cd-topic-counter" data-topic-counter>0 selected</span>
                            <div class="cd-topic-actions">
                                <button type="button" class="cd-pill-btn" data-topics-select-all>${escapeHtml(i18nT('common.select_all', 'Select all'))}</button>
                                <button type="button" class="cd-pill-btn" data-topics-clear-all>${escapeHtml(i18nT('common.clear_all', 'Clear'))}</button>
                            </div>
                        </div>
                        <div id="topics-list" class="cd-topic-list" role="group" aria-labelledby="topics-mode-trigger">
                            ${forumTopics.map((topic) => `
                                <label class="cd-topic-option">
                                    <input type="checkbox" class="cd-checkbox-input" data-topic-filter-id value="${escapeHtml(String(topic.id))}" ${selectedTopics.has(String(topic.id)) ? 'checked' : ''}>
                                    <span class="cd-checkbox-control" aria-hidden="true"><i class="ri-check-line"></i></span>
                                    <span class="cd-topic-name">${escapeHtml(topic.name)}</span>
                                    ${topic.closed ? `<span class="cd-topic-badge">${escapeHtml(i18nT('group.fwd.closed', 'closed'))}</span>` : ''}
                                </label>`).join('')}
                        </div>
                        <p id="cd-topics-help" class="cd-help">${escapeHtml(i18nT('group.topics.note', 'No topics selected means all topics. This filter decides which messages reach download and auto-forward; Forward to routes choose their destinations.'))}</p>
                        </div>
                        </div>
                    </section>` : cur.topicsUnavailable ? `
                        <p class="cd-help" role="status">${escapeHtml(i18nT('group.fwd.topics_error', "Topic names are unavailable. Saved topic rules still apply, but you can't edit them now."))}</p>` : ''}
            </div>
        </section>

        <section class="cd-section" aria-labelledby="cd-h-forward">
            <h3 id="cd-h-forward" class="cd-heading">${escapeHtml(i18nT('chat.section.forward', 'Forward to'))}</h3>
            <p class="cd-help">${escapeHtml(i18nT('chat.section.forward_help', 'Choose destinations for messages allowed by the content filters above.'))}</p>
            <div class="cd-card">
                ${switchRow({
                    id: 'fwd-enable-toggle',
                    label: i18nT('chat.fwd.label', 'Forward new files'),
                    sub: i18nT('group.fwd.subtitle', 'Forward media to another channel'),
                    on: forwardingEnabled,
                })}
                <div id="fwd-settings" class="cd-sub ${forwardingEnabled ? '' : 'hidden'}">
                    ${
                        fwdBlocked
                            ? `<p class="cd-fwd-warn" role="note"><i class="ri-error-warning-line" aria-hidden="true"></i><span>${escapeHtml(
                                  i18nTf(
                                      'access.fwd_blocked',
                                      { state: accessLabel(g.forwardAccess) },
                                      `Can't post to this destination (${accessLabel(g.forwardAccess)}) — forwarding is paused. Pick another destination.`,
                                  ),
                              )}</span></p>`
                            : ''
                    }
                    ${switchRow({
                        id: 'fwd-protect-toggle',
                        label: i18nT('group.fwd.protect_default', 'Protect forwarded copies in this group'),
                        sub: fwd.protect == null
                            ? i18nT('group.fwd.protection_inherit', 'Following global protection rule')
                            : i18nT('group.fwd.protection_override', 'Overrides global protection rule'),
                        on: forwardProtectionEnabled,
                    })}
                    ${switchRow({
                        id: 'fwd-delete-toggle',
                        label: i18nT('group.fwd.delete_after', 'Delete after forward'),
                        sub: i18nT('group.fwd.delete_after_help', 'Remove local file after successful upload.'),
                        on: fwd.deleteAfterForward === true,
                    })}
                    ${canTryDirectForward ? switchRow({
                        id: 'fwd-direct-toggle',
                        label: i18nT('group.fwd.direct', 'Try direct forward first'),
                        sub: i18nT('group.fwd.direct_help', 'When caption and protection settings allow, Telegram forwarding avoids a local download. If Telegram rejects it, the job downloads and uploads the media.'),
                        on: fwd.directForward === true,
                    }) : ''}
                    <div class="cd-route-field">
                        <label class="cd-label" for="fwd-scan-route">${escapeHtml(i18nT('group.fwd.scan_route', 'Route scanned messages'))}</label>
                        <select id="fwd-scan-route" class="tg-input cd-input">
                            <option value="download" ${fwd.scanRoute === 'direct' || fwd.scanRoute === 'both' ? '' : 'selected'}>${escapeHtml(i18nT('group.fwd.scan_route.download', 'Download only'))}</option>
                            <option value="direct" ${fwd.scanRoute === 'direct' ? 'selected' : ''}>${escapeHtml(i18nT('group.fwd.scan_route.direct', 'Direct forward only'))}</option>
                            <option value="both" ${fwd.scanRoute === 'both' ? 'selected' : ''}>${escapeHtml(i18nT('group.fwd.scan_route.both', 'Download and direct forward'))}</option>
                        </select>
                        <p class="cd-help">${escapeHtml(i18nT('group.fwd.scan_route_help', 'Direct forwarding sends accepted Telegram messages without saving media locally.'))}</p>
                    </div>
                    ${globalCaptionFields(fwd)}
                    <section class="cd-route-section" aria-labelledby="cd-routes-title">
                        <div class="cd-route-heading">
                            <div><h4 id="cd-routes-title" class="cd-subheading">${escapeHtml(i18nT('group.fwd.routes', 'Routes'))}</h4>
                            <p class="cd-help">${escapeHtml(i18nT('group.fwd.routes_help', 'Choose a destination for every route. Topic groups also let you route each topic.'))}</p></div>
                            <button type="button" class="tg-btn cd-route-add" data-cd-add-route><i class="ri-add-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('group.fwd.add_route', 'Add route'))}</span></button>
                        </div>
                        <div id="fwd-routes" class="cd-fields">${forwardRoutes.map((route, index) => forwardRouteHtml(route, index, forwardDestinations)).join('')}</div>
                        <p class="cd-help ${forwardingConfigured ? 'hidden' : ''}" role="status" data-forward-route-required>${escapeHtml(i18nT('group.fwd.destination_required', 'Choose a destination before forwarding can start.'))}</p>
                    </section>
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
    initAllSearchSelects(el);
    const topicsList = document.getElementById('topics-list');
    if (topicsList) {
        topicsList.dataset.loaded = 'true';
        updateTopicFilterCount();
    }
    if (forwardRoutes.length) void loadForwardRouteOptions();
}

function initAllSearchSelects(scope = document) {
    scope.querySelectorAll('[data-search-select] select').forEach((select) => {
        cacheSearchOptions(select);
        filterSearchOptions(select);
    });
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
        api.get('/api/cluster/peers').then((r) => (Array.isArray(r?.peers) ? r.peers : [])).catch(() => []),
    ]);
    if (!cur || cur.token !== token) return;
    const g = cur.group;
    const section = document.getElementById('cd-accounts');
    const accFields = document.getElementById('cd-account-fields');
    const cluster = document.getElementById('group-cluster-routing');
    const many = Array.isArray(accounts) && accounts.length >= 2;
    const hasPeers = peers.length > 0;
    cur.clusterEditable = hasPeers;
    // "Switch account" in the access banner only makes sense with 2+.
    cur.accountCount = Array.isArray(accounts) ? accounts.length : 0;
    if (Array.isArray(accounts)) state.accountsList = accounts;
    if (blockedNow()) paintAccess();
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
    if (findDialog(cur.id)) return;
    try {
        await loadDialogs();
    } catch {
        /* no account / not connected — the hero just shows less */
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
    let ok = false;
    try {
        let group;
        try {
            group = await inflight;
        } catch (e) {
            if (e?.data?.code !== 'FORWARD_JOB_ACTIVE' || !body.autoForward) throw e;
            const accepted = await confirmSheet({
                title: i18nT('group.fwd.reroute_title', 'Change forwarding destination?'),
                message: i18nT('group.fwd.reroute_confirm', 'The active forward keeps its current destination. Only new files will use this destination.'),
                confirmLabel: i18nT('group.fwd.reroute_apply', 'Apply to new files'),
            });
            if (!accepted) throw e;
            inflight = saveChatConfig(target.id, { ...body, confirmForwardReroute: true });
            group = await inflight;
        }
        ok = true;
        if (cur === target) {
            target.group = group || target.group;
            paintAccess();
            setSaveStatus('saved');
            if (adding) {
                document.querySelector('#page-chat [data-cd-new]')?.remove();
                document.getElementById('cd-danger')?.classList.remove('hidden');
                setSwitch('group-enable-toggle', monitoringNow(), monitorSub());
            }
            const savedForward = group?.autoForward || {};
            if (typeof body.autoForward?.enabled === 'boolean') {
                const savedEnabled = savedForward.enabled === true;
                setSwitch('fwd-enable-toggle', savedEnabled);
                document.getElementById('fwd-settings')?.classList.toggle('hidden', !savedEnabled);
                if (body.autoForward.enabled && !savedEnabled) {
                    document.querySelector('[data-forward-route-required]')?.classList.remove('hidden');
                }
            }
        }
    } catch (e) {
        if (cur === target) {
            pending = mergePatch(body, pending);
            if (typeof body.autoForward?.enabled === 'boolean') {
                const savedEnabled = target.group?.autoForward?.enabled === true;
                setSwitch('fwd-enable-toggle', savedEnabled);
                document.getElementById('fwd-settings')?.classList.toggle('hidden', !savedEnabled);
            }
            if ((e?.data?.error || e?.data?.message) === 'choose a forwarding destination before enabling auto-forward') {
                setSwitch('fwd-enable-toggle', false);
                document.getElementById('fwd-settings')?.classList.remove('hidden');
                document.querySelector('[data-forward-route-required]')?.classList.remove('hidden');
            }
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
        // Edits made while the request was out go next. After a failure
        // they wait for Retry or the next edit — no retry loop.
        if (ok && pending && cur === target && !saveTimer) {
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
    const list = document.getElementById('topics-list');
    const ids = list?.dataset.loaded === 'true'
        ? [...(document.querySelectorAll('[data-topic-filter-id]:checked') || [])]
              .map((input) => parseInt(input.value, 10))
              .filter((id) => Number.isSafeInteger(id) && id > 0)
        : cur.group?.topics?.ids || [];
    const selectedMode = document.getElementById('topics-mode')?.value;
    return {
        topics: { enabled, mode: enabled && ids.length > 0 ? selectedMode : 'all', ids },
    };
}

function globalCaptionPatch() {
    return {
        autoForward: {
            captionMode: document.getElementById('fwd-caption-mode')?.value || 'source',
            captionBase: 'custom',
            caption: document.getElementById('fwd-caption-override')?.value || '',
            regexPattern: document.getElementById('fwd-caption-regex')?.value || '',
            regexReplacement: document.getElementById('fwd-caption-replacement')?.value || '',
        },
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
    if (blockedNow() || findDialog(id)?.dmDisabled || cur.group?.suspended) return;
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
    const t = e.target;
    const option = t.closest('[data-select-option]');
    if (option) {
        const widget = option.closest('[data-search-select]');
        const select = widget?.querySelector('select');
        if (!select || option.disabled) return;
        select.value = option.dataset.selectOption;
        if (!select.matches('[data-route-destination]')) select.dataset.selected = select.value;
        filterSearchOptions(select, '');
        closeSearchSelect(widget);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }
    const trigger = t.closest('[data-select-trigger]');
    if (trigger) {
        const widget = trigger.closest('[data-search-select]');
        const menu = widget?.querySelector('[data-select-menu]');
        const open = menu?.classList.contains('hidden');
        document.querySelectorAll('[data-search-select] [data-select-menu]').forEach((item) => item.classList.add('hidden'));
        document.querySelectorAll('[data-search-select] [data-select-trigger]').forEach((item) => item.setAttribute('aria-expanded', 'false'));
        if (open) {
            menu.classList.remove('hidden');
            trigger.setAttribute('aria-expanded', 'true');
            const rect = trigger.getBoundingClientRect();
            const margin = 8;
            const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
            menu.style.left = `${left}px`;
            menu.style.width = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`;
            const input = widget.querySelector('[data-option-search]');
            if (input) {
                input.value = '';
                filterSearchOptions(widget.querySelector('select'), '');
            } else {
                filterSearchOptions(widget.querySelector('select'), '');
            }
            const menuHeight = menu.getBoundingClientRect().height;
            const roomBelow = Math.max(0, window.innerHeight - rect.bottom - margin * 2);
            const roomAbove = Math.max(0, rect.top - margin * 2);
            const openBelow = roomBelow >= Math.min(180, menuHeight) || roomBelow >= roomAbove;
            const availableHeight = Math.max(0, Math.min(menuHeight, openBelow ? roomBelow : roomAbove));
            menu.dataset.placement = openBelow ? 'below' : 'above';
            menu.style.maxHeight = `${availableHeight}px`;
            const top = openBelow ? rect.bottom + margin : Math.max(margin, rect.top - availableHeight - margin);
            menu.style.top = `${top}px`;
            if (input) input.focus();
            else {
                const activeBtn = menu.querySelector('[aria-selected="true"]') || menu.querySelector('[data-select-option]:not(:disabled)');
                activeBtn?.focus();
            }
        }
        return;
    }
    if (t.closest('[data-topics-select-all]')) {
        const checkboxes = document.querySelectorAll('#topics-list [data-topic-filter-id]');
        checkboxes.forEach((cb) => { cb.checked = true; });
        updateTopicFilterCount();
        const rule = topicsPatch().topics;
        if (cur.group) cur.group.topics = { ...(cur.group.topics || {}), ...rule };
        const refresh = refreshSourceTopicOptions();
        queueSave(topicsPatch(), 0);
        void refresh.then(() => queueSave({ autoForward: { routes: collectForwardRoutes() } }, 0));
        return;
    }
    if (t.closest('[data-topics-clear-all]')) {
        const checkboxes = document.querySelectorAll('#topics-list [data-topic-filter-id]');
        checkboxes.forEach((cb) => { cb.checked = false; });
        updateTopicFilterCount();
        const rule = topicsPatch().topics;
        if (cur.group) cur.group.topics = { ...(cur.group.topics || {}), ...rule };
        const refresh = refreshSourceTopicOptions();
        queueSave(topicsPatch(), 0);
        void refresh.then(() => queueSave({ autoForward: { routes: collectForwardRoutes() } }, 0));
        return;
    }
    if (!t.closest('[data-search-select]')) document.querySelectorAll('[data-search-select]').forEach(closeSearchSelect);
    if (!cur) return;
    if (t.closest('[data-cd-back]')) return goBack();
    if (t.closest('[data-cd-gallery]')) return openGallery();
    if (t.closest('#group-backfill-btn')) return void openBackfill();
    if (t.closest('[data-cd-save]')) {
        queueSave({ autoForward: { routes: collectForwardRoutes() } }, 0);
        return void flush();
    }
    if (t.closest('[data-cd-add-route]')) {
        appendForwardRoute();
        return;
    }
    if (t.closest('[data-route-remove]')) {
        if (document.querySelectorAll('[data-forward-route]').length <= 1) {
            showToast(i18nT('group.fwd.last_route', 'At least one forwarding route is required.'), 'error');
            return;
        }
        t.closest('[data-forward-route]')?.remove();
        updateRouteWildcardState();
        const routes = collectForwardRoutes();
        const configured = routes.length > 0 && [...document.querySelectorAll('[data-route-destination]')].every((select) => select.value.trim());
        document.querySelector('[data-forward-route-required]')?.classList.toggle('hidden', configured);
        queueSave({ autoForward: { routes, ...(configured && document.getElementById('fwd-enable-toggle')?.getAttribute('aria-checked') === 'true' ? { enabled: true } : {}) } }, 0);
        return;
    }
    if (t.closest('[data-cd-pick]')) return void openDestinationPicker();
    const accessBtn = t.closest('[data-cd-access]');
    if (accessBtn) return void onAccessAction(accessBtn.dataset.cdAccess, accessBtn);
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
            if (on && (cur.group?.suspended || blockedNow() || findDialog(cur.id)?.dmDisabled)) return;
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
            const routes = on ? collectForwardRoutes() : undefined;
            const configured = Array.isArray(routes) && routes.length > 0;
            document.querySelector('[data-forward-route-required]')?.classList.toggle('hidden', configured);
            queueSave({ autoForward: { enabled: on, ...(on ? { routes } : {}) } });
        } else if (sw.id === 'fwd-delete-toggle') {
            setSwitch(sw.id, on);
            const autoForward = { deleteAfterForward: on };
            if (!on || forwardProtectionIsEnabled()) autoForward.directForward = false;
            queueSave({ autoForward });
            updateChatAutoForward(autoForward);
            syncDirectForwardToggle({ ...fwdSettingsNow(), ...autoForward });
        } else if (sw.id === 'fwd-direct-toggle') {
            if (!on || !canTryDirectForwardNow()) return;
            setSwitch(sw.id, on);
            updateChatAutoForward({ directForward: on });
            queueSave({ autoForward: { directForward: on } });
        } else if (sw.id === 'fwd-protect-toggle') {
            setSwitch(sw.id, on);
            const autoForward = { protect: on };
            if (on) autoForward.directForward = false;
            queueSave({ autoForward });
            updateChatAutoForward(autoForward);
            syncDirectForwardToggle();
        } else if (sw.id === 'topics-enable-toggle') {
            setSwitch(sw.id, on);
            document.getElementById('topics-settings')?.classList.toggle('hidden', !on);
            const rule = topicsPatch().topics;
            if (cur.group) cur.group.topics = { ...(cur.group.topics || {}), ...rule };
            const refresh = refreshSourceTopicOptions();
            queueSave(topicsPatch());
            void refresh.then(() => queueSave({ autoForward: { routes: collectForwardRoutes() } }, 0));
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

async function onChange(e) {
    if (!cur) return;
    const id = e.target.id;
    if (e.target.matches('[data-global-caption-mode]')) {
        document.querySelector('[data-global-caption-override-wrap]')?.classList.toggle('hidden', e.target.value !== 'custom');
        document.querySelector('[data-global-caption-regex-wrap]')?.classList.toggle('hidden', e.target.value !== 'custom');
        queueSave(globalCaptionPatch(), 0);
    } else if (e.target.closest('[data-global-caption]')) {
        queueSave(globalCaptionPatch(), 0);
    } else if (e.target.matches('[data-route-destination]')) {
        const card = e.target.closest('[data-forward-route]');
        const targetTopic = card?.querySelector('[data-route-destination-topic]');
        const previous = e.target.dataset.selected || '';
        const next = e.target.value;
        let confirmForwardReroute = false;
        if (previous !== next && cur?.id) {
            let snapshot;
            try {
                snapshot = await api.get('/api/queue/snapshot');
            } catch {
                e.target.value = previous;
                filterSearchOptions(e.target);
                showToast(i18nT('group.fwd.reroute_check_failed', 'Could not check active forwards. Try changing the destination again.'), 'error');
                return;
            }
            const active = (snapshot?.forwardQueue?.items || []).some((item) =>
                String(item.groupId) === String(cur.id) && item.status === 'processing',
            );
            if (active) {
                const accepted = await confirmSheet({
                    title: i18nT('group.fwd.reroute_title', 'Change forwarding destination?'),
                    message: i18nT('group.fwd.reroute_confirm', 'The active forward keeps its current destination. Only new files will use this destination.'),
                    confirmLabel: i18nT('group.fwd.reroute_apply', 'Apply to new files'),
                });
                if (!accepted) {
                    e.target.value = previous;
                    filterSearchOptions(e.target);
                    return;
                }
                confirmForwardReroute = true;
            }
        }
        e.target.dataset.selected = e.target.value;
        if (targetTopic) {
            targetTopic.dataset.selected = '0';
            if (e.target.value && !['storage', 'me'].includes(e.target.value)) {
                void loadTopicOptions(targetTopic, e.target.value, i18nT('group.fwd.no_topic', 'No topic'), true).then(() => filterSearchOptions(targetTopic));
            } else {
                targetTopic.innerHTML = `<option value="0">${escapeHtml(i18nT('group.fwd.no_topic', 'No topic'))}</option>`;
                targetTopic.disabled = true;
                targetTopic.closest('[data-route-destination-topic-wrap]')?.classList.add('hidden');
            }
        }
        filterSearchOptions(e.target);
        updateRouteWildcardState();
        const routes = collectForwardRoutes();
        const configured = routes.length > 0 && [...document.querySelectorAll('[data-route-destination]')].every((select) => select.value.trim());
        document.querySelector('[data-forward-route-required]')?.classList.toggle('hidden', configured);
        if (configured && document.getElementById('fwd-enable-toggle')?.getAttribute('aria-checked') === 'true') {
            queueSave({ autoForward: { routes, enabled: true }, ...(confirmForwardReroute ? { confirmForwardReroute: true } : {}) }, 0);
        } else {
            queueSave({ autoForward: { routes }, ...(confirmForwardReroute ? { confirmForwardReroute: true } : {}) }, 0);
        }
    } else if (e.target.matches('[data-topic-filter-id]') || id === 'topics-mode') {
        const rule = topicsPatch().topics;
        if (cur.group) cur.group.topics = { ...(cur.group.topics || {}), ...rule };
        const refresh = refreshSourceTopicOptions();
        queueSave(topicsPatch(), 0);
        void refresh.then(() => queueSave({ autoForward: { routes: collectForwardRoutes() } }, 0));
    } else if (e.target.closest('[data-forward-route]')) {
        if (e.target.matches('[data-route-source-topic], [data-route-destination-topic]')) {
            e.target.dataset.selected = e.target.value;
            filterSearchOptions(e.target);
            updateRouteWildcardState();
        }
        const routes = collectForwardRoutes();
        const configured = routes.length > 0 && [...document.querySelectorAll('[data-route-destination]')].every((select) => select.value.trim());
        document.querySelector('[data-forward-route-required]')?.classList.toggle('hidden', configured);
        if (configured && document.getElementById('fwd-enable-toggle')?.getAttribute('aria-checked') === 'true') {
            queueSave({ autoForward: { routes, enabled: true } }, 0);
        } else queueSave({ autoForward: { routes } }, 0);
    } else if (id === 'fwd-destination') {
        queueSave({ autoForward: { destination: e.target.value.trim() } }, 0);
    } else if (id === 'fwd-scan-route') {
        queueSave({ autoForward: { scanRoute: e.target.value } }, 0);
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
    if (e.target.matches('[data-option-search]')) {
        filterSearchOptions(e.target.closest('[data-search-select]')?.querySelector('select'), e.target.value);
        return;
    }
    const id = e.target.id;
    if (e.target.closest('[data-global-caption]')) {
        if (e.target.matches('[data-global-caption-regex]')) return;
        queueSave(globalCaptionPatch(), TEXT_SAVE_MS);
    } else if (e.target.closest('[data-forward-route]')) {
        queueSave({ autoForward: { routes: collectForwardRoutes() } }, TEXT_SAVE_MS);
    } else if (id === 'fwd-destination') {
        queueSave({ autoForward: { destination: e.target.value.trim() } }, TEXT_SAVE_MS);
    } else if (id === 'setting-rescue-hours') {
        queueSave(rescueHoursPatch(), TEXT_SAVE_MS);
    }
}

function onKeydown(e) {
    const widget = e.target.closest?.('[data-search-select]');
    if (widget) {
        const menu = widget.querySelector('[data-select-menu]');
        const isOpen = menu && !menu.classList.contains('hidden');
        if (e.key === 'Escape' && isOpen) {
            e.preventDefault();
            closeSearchSelect(widget);
            widget.querySelector('[data-select-trigger]')?.focus();
            return;
        }
        if (isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            const options = [...menu.querySelectorAll('[data-select-options] [data-select-option]:not(:disabled)')];
            if (!options.length) return;
            const input = widget.querySelector('[data-option-search]');
            const currentIndex = options.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') {
                if (document.activeElement === input || currentIndex === -1) {
                    options[0]?.focus();
                } else {
                    const next = options[Math.min(options.length - 1, currentIndex + 1)];
                    next?.focus();
                }
            } else if (e.key === 'ArrowUp') {
                if (currentIndex <= 0) {
                    if (input) input.focus();
                    else options[0]?.focus();
                } else {
                    options[currentIndex - 1]?.focus();
                }
            }
            return;
        }
        if (e.key === 'Enter') {
            if (e.target.matches?.('[data-option-search]')) {
                e.preventDefault();
                widget?.querySelector('[data-select-options] [data-select-option]:not(:disabled)')?.click();
                return;
            }
            if (e.target.matches?.('[data-select-option]')) {
                e.preventDefault();
                e.target.click();
                return;
            }
        }
    }
    if (e.key === 'Enter' && e.target.matches?.('#page-chat input.cd-input:not([data-option-search])')) {
        e.preventDefault();
        flush();
    }
}

function repositionOpenSearchSelects() {
    document.querySelectorAll('[data-search-select] [data-select-trigger][aria-expanded="true"]').forEach((trigger) => {
        const widget = trigger.closest('[data-search-select]');
        const menu = widget?.querySelector('[data-select-menu]');
        if (!menu || menu.classList.contains('hidden')) return;
        const rect = trigger.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
            closeSearchSelect(widget);
            return;
        }
        const margin = 8;
        const left = Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin));
        menu.style.left = `${left}px`;
        menu.style.width = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`;
        const roomBelow = Math.max(0, window.innerHeight - rect.bottom - margin * 2);
        const roomAbove = Math.max(0, rect.top - margin * 2);
        const openBelow = roomBelow >= roomAbove;
        const height = Math.max(0, Math.min(240, window.innerHeight * 0.42, openBelow ? roomBelow : roomAbove));
        menu.dataset.placement = openBelow ? 'below' : 'above';
        menu.style.maxHeight = `${height}px`;
        menu.style.top = `${openBelow ? rect.bottom + margin : Math.max(margin, rect.top - height - margin)}px`;
    });
}

let wired = false;
function wire(el) {
    if (wired) return;
    wired = true;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', repositionOpenSearchSelects, { passive: true });
    window.addEventListener('scroll', repositionOpenSearchSelects, { passive: true, capture: true });
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
export function showChatDetails({ groupId, from = null, fromGroup = null, onName = null, forumTopics = [], topicsUnavailable = false }) {
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
        forumTopics,
        topicsUnavailable,
        group: group ? { ...group, filters: { ...(group.filters || {}) } } : null,
        draftFilters: { ...NEW_CHAT_FILTERS },
        name: getGroupName(id, { fallback: findDialog(id)?.name }),
        onName,
        stats: null,
        clusterEditable: false,
        accountCount: (state.dialogsAccounts || []).length,
    };
    globalForwardProtection = null;
    pending = null;
    render();
    wire(el);
    wireWs();
    setSaveStatus('idle');
    const token = cur.token;
    loadStats(token);
    loadAccountsAndPeers(token);
    loadDialogMeta(token);
    globalForwardProtection = null;
    if (fwdSettingsNow().protect != null) {
        syncDirectForwardToggle();
    } else {
        void api.get('/api/config').then((config) => {
            globalForwardProtection = config?.forwarding?.protect === true;
            if (cur?.token !== token) return;
            setSwitch('fwd-protect-toggle', globalForwardProtection);
            syncDirectForwardToggle();
        }).catch(() => {
            if (cur?.token === token) syncDirectForwardToggle();
        });
    }
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
