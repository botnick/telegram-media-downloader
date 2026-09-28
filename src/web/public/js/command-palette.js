// "Go anywhere" command palette — Ctrl/Cmd+K, or the search button in the
// header (phones) / sidebar (desktop).
//
// One list of everything you can jump to or do: pages, the Tools groups
// and tools, every setting (from the Settings search index, js/settings-
// search.js), chats by name, and a few actions (start / stop the monitor,
// add an account or a chat, paste a link, switch theme). Matching is
// word-by-word, in the current language and English, with a loose
// in-order fallback for typos ("thmb" finds Thumbnails).
//
// Keyboard: ↑ ↓ move, Enter opens, Esc closes (sheet.js), Home / End.
// The input is a combobox driving a listbox via aria-activedescendant.

import { openSheet } from './sheet.js';
import { navigate } from './router.js';
import { api } from './api.js';
import { state, getGroupName } from './store.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { escapeHtml, showToast } from './utils.js';
import { getLatest as monitorStatus, refreshNow as refreshMonitor } from './monitor-status.js';
import { TOOL_GROUPS, TOOLS, getGroup, groupOfTool, toolHref, groupHref } from './tools-catalog.js';

const MAX_RESULTS = 60;
const SECTION_ORDER = ['actions', 'pages', 'tools', 'settings', 'chats'];
const SECTION_LABEL = {
    actions: () => i18nT('palette.section.actions', 'Actions'),
    pages: () => i18nT('palette.section.pages', 'Pages'),
    tools: () => i18nT('palette.section.tools', 'Tools'),
    settings: () => i18nT('palette.section.settings', 'Settings'),
    chats: () => i18nT('palette.section.chats', 'Chats'),
};

let _open = null; // the open sheet handle
let _seq = 0;

function norm(s) {
    return String(s || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

const isAdmin = () => state.role !== 'guest';
const T = (pair) => i18nT(pair[0], pair[1]);

// --------------------------------------------------------------- items
//
// { section, label, hint, icon, text (search haystack), href | run() }

function item(section, label, en, opts) {
    return {
        section,
        label,
        hint: opts.hint || '',
        icon: opts.icon || 'ri-arrow-right-line',
        href: opts.href,
        run: opts.run,
        text: norm(`${label} ${en || ''} ${opts.hint || ''} ${opts.words || ''}`),
        labelN: norm(label),
        enN: norm(en || ''),
    };
}

function pageItems() {
    const admin = isAdmin();
    const out = [
        item('pages', i18nT('nav.library', 'Library'), 'Library', {
            icon: 'ri-gallery-line',
            href: '#/viewer',
            words: 'gallery all media photos videos files home',
            hint: i18nT('viewer.all_media.title', 'All Media'),
        }),
        item('pages', i18nT('nav.settings', 'Settings'), 'Settings', {
            icon: 'ri-settings-3-line',
            href: '#/settings',
            words: 'preferences options configuration',
        }),
    ];
    if (admin) {
        out.push(
            item('pages', i18nT('nav.chats', 'Chats'), 'Chats', {
                icon: 'ri-chat-3-line',
                href: '#/groups',
                words: 'groups channels dialogs monitor',
            }),
            item('pages', i18nT('nav.backfill', 'Backfill'), 'Backfill', {
                icon: 'ri-history-line',
                href: '#/backfill',
                hint: i18nT('nav.chats', 'Chats'),
                words: 'history older messages',
            }),
            item('pages', i18nT('nav.queue', 'Queue'), 'Queue', {
                icon: 'ri-download-cloud-2-line',
                href: '#/queue',
                words: 'downloads active paused failed',
            }),
            item('pages', i18nT('tools.title', 'Tools'), 'Tools', {
                icon: 'ri-tools-line',
                href: '#/settings/tools',
                hint: i18nT('nav.settings', 'Settings'),
                words: 'maintenance admin',
            }),
        );
    }
    return out;
}

function toolItems() {
    if (!isAdmin()) return [];
    const out = [];
    for (const g of TOOL_GROUPS) {
        out.push(
            item('tools', T(g.title), g.title[1], {
                icon: g.icon,
                href: groupHref(g.slug),
                hint: i18nT('tools.title', 'Tools'),
                words: `maintenance ${g.tools.map((t) => TOOLS[t].name[1]).join(' ')}`,
            }),
        );
    }
    for (const [slug, t] of Object.entries(TOOLS)) {
        out.push(
            item('tools', T(t.name), t.name[1], {
                icon: t.icon,
                href: toolHref(slug),
                hint: T(getGroup(groupOfTool(slug)).title),
                words: `${slug} ${t.words} maintenance`,
            }),
        );
    }
    return out;
}

function chatItems() {
    const seen = new Map(); // id → { downloaded }
    for (const d of state.downloads || []) {
        const id = String(d.downloadId || d.id || '');
        if (id && !d.peerId) seen.set(id, { downloaded: true, files: d.totalFiles || 0 });
    }
    if (isAdmin()) {
        for (const g of state.groups || []) {
            const id = String(g.id || '');
            if (id && !seen.has(id)) seen.set(id, { downloaded: false });
        }
        for (const d of state.allDialogs || []) {
            const id = String(d.id || '');
            if (id && !seen.has(id)) seen.set(id, { downloaded: false, dialog: true });
        }
    }
    const out = [];
    for (const [id, info] of seen) {
        const name = getGroupName(id, { fallback: '' });
        if (!name) continue;
        const enc = encodeURIComponent(id);
        out.push(
            item('chats', name, '', {
                icon: 'ri-chat-3-line',
                href: info.downloaded || !isAdmin() ? `#/viewer/${enc}` : `#/groups/${enc}`,
                hint: info.downloaded
                    ? i18nTf('viewer.subtitle.files', { count: info.files }, `${info.files} files`)
                    : '',
            }),
        );
    }
    return out;
}

async function monitorPost(path, okKey, okText, type) {
    try {
        await api.post(path);
        showToast(i18nT(okKey, okText), type);
    } catch (e) {
        showToast(e?.data?.error || e?.message || i18nT('common.error', 'Error'), 'error');
    }
    refreshMonitor();
}

function actionItems() {
    const out = [];
    const dark = document.documentElement.classList.contains('theme-dark');
    out.push(
        item(
            'actions',
            dark
                ? i18nT('palette.action.theme_light', 'Switch to light theme')
                : i18nT('palette.action.theme_dark', 'Switch to dark theme'),
            dark ? 'Switch to light theme' : 'Switch to dark theme',
            {
                icon: dark ? 'ri-sun-line' : 'ri-moon-line',
                words: 'theme appearance mode',
                run: () =>
                    document
                        .querySelector(`[data-theme-set="${dark ? 'light' : 'dark'}"]`)
                        ?.click(),
            },
        ),
        item('actions', i18nT('shortcuts.title', 'Keyboard shortcuts'), 'Keyboard shortcuts', {
            icon: 'ri-keyboard-line',
            words: 'keys hotkeys help cheatsheet',
            run: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })),
        }),
    );
    if (!isAdmin()) return out;
    const running = ['running', 'starting', 'reconnecting'].includes(monitorStatus()?.state);
    out.unshift(
        running
            ? item('actions', i18nT('settings.engine.stop', 'Stop monitor'), 'Stop monitor', {
                  icon: 'ri-stop-circle-line',
                  words: 'engine realtime pause',
                  run: () =>
                      monitorPost(
                          '/api/monitor/stop',
                          'toast.monitor_stopped',
                          'Monitor stopped',
                          'info',
                      ),
              })
            : item('actions', i18nT('settings.engine.start', 'Start monitor'), 'Start monitor', {
                  icon: 'ri-play-circle-line',
                  words: 'engine realtime run',
                  run: () =>
                      monitorPost(
                          '/api/monitor/start',
                          'toast.monitor_started',
                          'Monitor started',
                          'success',
                      ),
              }),
        // The Add sheet — same as the + button / Chats → Add chat or link.
        item('actions', i18nT('add.button', 'Add chat or link'), 'Add chat or link', {
            icon: 'ri-add-circle-line',
            words: 'new group channel monitor link username t.me',
            run: () =>
                import('./add-sheet.js')
                    .then((m) => m.openAddSheet())
                    .catch((e) => console.error('add sheet', e)),
        }),
        // The account wizard opens where you are, like any in-app
        // #/account/add link (app.js); a typed #/account/add URL opens it
        // over Settings → Accounts.
        item('actions', i18nT('fab.add_account', 'Add Telegram account'), 'Add Telegram account', {
            icon: 'ri-user-add-line',
            words: 'login phone new account wizard',
            run: () =>
                import('./account-wizard.js')
                    .then((m) => m.openAccountWizard())
                    .catch(() => navigate('#/account/add')),
        }),
        item('actions', i18nT('fab.paste_link', 'Paste a Telegram link'), 'Paste a Telegram link', {
            icon: 'ri-link-m',
            words: 'url t.me download message',
            run: () => document.getElementById('paste-url-btn')?.click(),
        }),
        item(
            'actions',
            i18nT('header.stories', 'Download Telegram Stories'),
            'Download Telegram Stories',
            {
                icon: 'ri-camera-line',
                words: 'stories',
                run: () => document.getElementById('stories-btn')?.click(),
            },
        ),
    );
    if (running) {
        out.splice(
            1,
            0,
            item('actions', i18nT('settings.engine.restart', 'Restart'), 'Restart monitor', {
                icon: 'ri-restart-line',
                words: 'engine monitor realtime',
                hint: i18nT('settings.engine.title', 'Realtime monitor'),
                run: () =>
                    monitorPost(
                        '/api/monitor/restart',
                        'toast.monitor_restarted',
                        'Monitor restarted',
                        'success',
                    ),
            }),
        );
    }
    return out;
}

// Settings come from the Settings page search index.
async function settingsItems() {
    try {
        const m = await import('./settings-search.js');
        const entries = await m.paletteEntries({ admin: isAdmin() });
        const settingsLabel = i18nT('nav.settings', 'Settings');
        return entries.map((e) =>
            item('settings', e.label, e.en, {
                icon: e.card ? 'ri-equalizer-line' : 'ri-settings-3-line',
                hint: e.card ? `${settingsLabel} › ${e.card}` : settingsLabel,
                words: e.words,
                run: () => openSetting(e, m.revealSetting),
            }),
        );
    } catch (e) {
        console.warn('palette settings', e);
        return [];
    }
}

// Go to the Settings page, then to the card / field.
function openSetting(entry, reveal) {
    if (!entry.card && entry.anchor) {
        navigate(`#/settings/${entry.anchor}`);
        return;
    }
    navigate('#/settings');
    const page = document.getElementById('page-settings');
    const started = Date.now();
    const tick = () => {
        if (page && !page.classList.contains('hidden')) {
            setTimeout(() => reveal(entry.el), 120);
        } else if (Date.now() - started < 1500) {
            setTimeout(tick, 50);
        }
    };
    tick();
}

// --------------------------------------------------------------- search

// Loose in-order match for typos / abbreviations: every character of the
// query appears in order in the label. Latin only — Thai has no word
// boundaries and a subsequence match there is mostly noise.
function subsequence(q, s) {
    if (!/^[a-z0-9 ]+$/.test(q) || q.length < 3) return false;
    let i = 0;
    for (const ch of s) {
        if (ch === q[i]) i++;
        if (i === q.length) return true;
    }
    return false;
}

function score(it, q, tokens) {
    const label = it.labelN;
    if (label === q || it.enN === q) return 100;
    if (label.startsWith(q) || it.enN.startsWith(q)) return 90;
    const wordStart = (s) => s.split(/[\s›·/&-]+/).some((w) => w.startsWith(q));
    if (wordStart(label) || wordStart(it.enN)) return 80;
    if (label.includes(q) || it.enN.includes(q)) return 70;
    if (tokens.every((t) => it.text.includes(t))) return 50;
    const compact = q.replace(/ /g, '');
    if (
        subsequence(compact, label.replace(/ /g, '')) ||
        subsequence(compact, it.enN.replace(/ /g, ''))
    )
        return 20;
    return 0;
}

function search(all, raw) {
    const q = norm(raw);
    if (!q) {
        // Empty query: actions, pages and the Tools groups.
        return all.filter(
            (it) =>
                it.section === 'actions' ||
                it.section === 'pages' ||
                (it.section === 'tools' && TOOL_GROUPS.some((g) => groupHref(g.slug) === it.href)),
        );
    }
    const tokens = q.split(' ').filter(Boolean);
    const hits = [];
    for (const it of all) {
        const s = score(it, q, tokens);
        if (s > 0) hits.push({ it, s });
    }
    hits.sort(
        (a, b) =>
            b.s - a.s ||
            SECTION_ORDER.indexOf(a.it.section) - SECTION_ORDER.indexOf(b.it.section) ||
            a.it.label.localeCompare(b.it.label),
    );
    return hits.slice(0, MAX_RESULTS).map((h) => h.it);
}

// --------------------------------------------------------------- UI

function buildUi() {
    const root = document.createElement('div');
    root.className = 'palette';
    root.innerHTML = `
        <div class="palette-field">
            <i class="ri-search-line palette-field-icon" aria-hidden="true"></i>
            <input type="text" class="palette-input" id="palette-input"
                role="combobox" aria-expanded="true" aria-autocomplete="list"
                aria-controls="palette-list" autocomplete="off" autocapitalize="off"
                spellcheck="false" enterkeyhint="go"
                aria-label="${escapeHtml(i18nT('palette.title', 'Go anywhere'))}"
                placeholder="${escapeHtml(i18nT('palette.placeholder', 'Search pages, settings, tools, chats…'))}">
            <button type="button" class="palette-cancel" data-palette-close>${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>
        </div>
        <div class="palette-list" id="palette-list" role="listbox"
            aria-label="${escapeHtml(i18nT('palette.title', 'Go anywhere'))}"></div>
        <p class="palette-status sr-only" role="status" aria-live="polite"></p>
        <div class="palette-foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> ${escapeHtml(i18nT('palette.hint.move', 'move'))}</span>
            <span><kbd>Enter</kbd> ${escapeHtml(i18nT('palette.hint.open', 'open'))}</span>
            <span><kbd>Esc</kbd> ${escapeHtml(i18nT('palette.hint.close', 'close'))}</span>
        </div>`;
    return root;
}

export async function openCommandPalette() {
    if (_open) {
        _open.body.querySelector('.palette-input')?.focus();
        return;
    }
    const ui = buildUi();
    const handle = openSheet({
        title: '',
        content: ui,
        size: 'lg',
        onClose: () => {
            _open = null;
        },
    });
    _open = handle;
    handle.root.classList.add('sheet-palette');
    handle.root.setAttribute('aria-label', i18nT('palette.title', 'Go anywhere'));

    const input = ui.querySelector('.palette-input');
    const list = ui.querySelector('.palette-list');
    const status = ui.querySelector('.palette-status');
    const seq = ++_seq;

    let all = [...actionItems(), ...pageItems(), ...toolItems(), ...chatItems()];
    let results = [];
    let active = 0;

    const setActive = (i, { scroll = true } = {}) => {
        if (!results.length) {
            input.removeAttribute('aria-activedescendant');
            return;
        }
        active = (i + results.length) % results.length;
        for (const el of list.querySelectorAll('[role="option"]')) {
            const on = Number(el.dataset.idx) === active;
            el.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on && scroll) el.scrollIntoView({ block: 'nearest' });
        }
        input.setAttribute('aria-activedescendant', `palette-opt-${active}`);
    };

    const render = () => {
        results = search(all, input.value);
        if (!results.length) {
            list.innerHTML = `<p class="palette-empty">${escapeHtml(
                i18nTf(
                    'palette.empty',
                    { q: input.value.trim() },
                    `Nothing matches “${input.value.trim()}”`,
                ),
            )}</p>`;
            status.textContent = list.textContent;
            input.removeAttribute('aria-activedescendant');
            return;
        }
        let html = '';
        let idx = 0;
        // Sections in the order of their best match, so the top hit is
        // the first row (and the one Enter opens).
        const order = input.value.trim()
            ? [...new Set(results.map((r) => r.section))]
            : SECTION_ORDER;
        for (const section of order) {
            const rows = results.filter((r) => r.section === section);
            if (!rows.length) continue;
            html += `<div role="group" aria-labelledby="palette-sec-${section}">
                <div class="palette-section" id="palette-sec-${section}">${escapeHtml(SECTION_LABEL[section]())}</div>`;
            for (const r of rows) {
                r._idx = idx;
                html += `<div role="option" id="palette-opt-${idx}" data-idx="${idx}" class="palette-option" aria-selected="false">
                    <i class="${r.icon} palette-option-icon" aria-hidden="true"></i>
                    <span class="palette-option-text"><span class="palette-option-label">${escapeHtml(r.label)}</span>${
                        r.hint
                            ? `<span class="palette-option-hint">${escapeHtml(r.hint)}</span>`
                            : ''
                    }</span>
                    <i class="ri-corner-down-left-line palette-option-enter" aria-hidden="true"></i>
                </div>`;
                idx++;
            }
            html += '</div>';
        }
        list.innerHTML = html;
        // Results are shown grouped; keep `results` in display order.
        results = [...results].sort((a, b) => a._idx - b._idx);
        status.textContent = i18nTf(
            'palette.count',
            { n: results.length },
            `${results.length} results`,
        );
        setActive(0);
    };

    const activate = (i) => {
        const r = results[i];
        if (!r) return;
        handle.close();
        if (r.href) navigate(r.href);
        // Let the sheet's history entry settle before running the action.
        else if (r.run) setTimeout(() => r.run(), 180);
    };

    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive(active + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(active - 1);
        } else if (e.key === 'Home' && e.ctrlKey) {
            e.preventDefault();
            setActive(0);
        } else if (e.key === 'End' && e.ctrlKey) {
            e.preventDefault();
            setActive(results.length - 1);
        } else if (e.key === 'PageDown') {
            e.preventDefault();
            setActive(Math.min(results.length - 1, active + 8));
        } else if (e.key === 'PageUp') {
            e.preventDefault();
            setActive(Math.max(0, active - 8));
        } else if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            activate(active);
        }
    });
    list.addEventListener('mousemove', (e) => {
        const opt = e.target.closest('[role="option"]');
        if (opt && Number(opt.dataset.idx) !== active)
            setActive(Number(opt.dataset.idx), { scroll: false });
    });
    list.addEventListener('click', (e) => {
        const opt = e.target.closest('[role="option"]');
        if (opt) activate(Number(opt.dataset.idx));
    });
    ui.querySelector('[data-palette-close]')?.addEventListener('click', () => handle.close());

    render();
    setTimeout(() => input.focus(), 30);

    // Settings entries need the (lazy) search module + English strings;
    // built on every open since the cards behind them can change.
    const settings = await settingsItems();
    if (seq !== _seq || !_open) return;
    all = [...all, ...settings];
    if (input.value) render();
}
