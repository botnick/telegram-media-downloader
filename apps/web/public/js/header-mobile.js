// Header mobile chrome — overflow ⋮ menu + notification bell.
//
// Overflow menu (visible only at <640px): hosts paste-link / stories /
// view-mode-{grid,compact,list} / refresh. Each row is delegated to the
// corresponding desktop button via .click() so the action lives in one
// place and the mobile menu is purely a remote control.
//
// Notification bell: subscribes to WS `log` events at warn/error level
// (info is too chatty for a passive notify channel), persists the last
// 50 in localStorage, badge counts the unread set, browser tab title
// flashes when a new important event lands while the page is hidden.

import { t as i18nT } from './i18n.js';

const NOTIFY_STORAGE_KEY = 'tgdl-notify-buffer';
const NOTIFY_UNREAD_KEY  = 'tgdl-notify-unread';
const NOTIFY_MAX = 50;

function _readBuffer() {
    try { return JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) || '[]'); }
    catch { return []; }
}
function _writeBuffer(arr) {
    try { localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(arr.slice(-NOTIFY_MAX))); } catch {}
}
function _readUnread() {
    try { return Math.max(0, parseInt(localStorage.getItem(NOTIFY_UNREAD_KEY), 10) || 0); }
    catch { return 0; }
}
function _writeUnread(n) {
    try { localStorage.setItem(NOTIFY_UNREAD_KEY, String(Math.max(0, n))); } catch {}
}

function _formatRel(ts) {
    const now = Date.now();
    const dt = Math.max(0, now - ts);
    if (dt < 60_000) return 'just now';
    if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m ago`;
    if (dt < 86_400_000) return `${Math.floor(dt / 3600_000)}h ago`;
    return `${Math.floor(dt / 86_400_000)}d ago`;
}

function _icon(level) {
    if (level === 'error') return 'ri-error-warning-line';
    if (level === 'warn')  return 'ri-alert-line';
    return 'ri-information-line';
}

let _origTitle = null;
function _flashTabTitle(msg) {
    if (!document.hidden) return;
    if (_origTitle == null) _origTitle = document.title;
    document.title = `(!) ${msg.slice(0, 40)} — ${_origTitle}`;
    const restore = () => {
        if (_origTitle != null) document.title = _origTitle;
        _origTitle = null;
        document.removeEventListener('visibilitychange', restore);
    };
    document.addEventListener('visibilitychange', restore);
}

function setupOverflowMenu() {
    const btn = document.getElementById('header-overflow-btn');
    const menu = document.getElementById('header-overflow-menu');
    if (!btn || !menu) return;

    const close = () => {
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Each menu row maps to a desktop button id (or a view-mode chip
    // inside the desktop view-mode-menu). Delegating to .click() keeps
    // the business logic single-sourced.
    const ACTIONS = {
        'paste-url': () => document.getElementById('paste-url-btn')?.click(),
        'stories':   () => document.getElementById('stories-btn')?.click(),
        'refresh':   () => document.getElementById('refresh-btn')?.click(),
        'vm-grid':    () => document.querySelector('#view-mode-menu [data-vm="grid"]')?.click(),
        'vm-compact': () => document.querySelector('#view-mode-menu [data-vm="compact"]')?.click(),
        'vm-list':    () => document.querySelector('#view-mode-menu [data-vm="list"]')?.click(),
    };
    menu.querySelectorAll('[data-overflow]').forEach((row) => {
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            const fn = ACTIONS[row.dataset.overflow];
            if (typeof fn === 'function') fn();
            close();
        });
    });

    document.addEventListener('click', (e) => {
        if (!menu.classList.contains('open')) return;
        if (menu.contains(e.target) || btn.contains(e.target)) return;
        close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu.classList.contains('open')) close();
    });
}

function _renderNotifyList() {
    const list = document.getElementById('notify-list');
    const empty = document.getElementById('notify-empty');
    if (!list) return;
    const buf = _readBuffer();
    if (!buf.length) {
        list.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');
    // Newest first — buffer is appended, render reversed.
    list.innerHTML = buf.slice().reverse().map((e) => {
        const icon = _icon(e.level);
        const rel = _formatRel(e.ts);
        return `<div class="notify-row" data-level="${e.level}">
            <div class="notify-icon"><i class="${icon}"></i></div>
            <div class="notify-body">
                <div class="notify-msg">${escapeHtml(e.msg)}</div>
                <div class="notify-meta">
                    <span>${escapeHtml(e.source || 'app')}</span>
                    <span>·</span>
                    <span>${rel}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

function _setBadge(n) {
    const badge = document.getElementById('notify-bell-badge');
    if (!badge) return;
    if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setupNotifyBell() {
    const btn = document.getElementById('notify-bell-btn');
    const menu = document.getElementById('notify-bell-menu');
    if (!btn || !menu) return;

    _renderNotifyList();
    _setBadge(_readUnread());

    const close = () => {
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = menu.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            // Mark as read on open.
            _writeUnread(0);
            _setBadge(0);
            _renderNotifyList();
        }
    });

    document.getElementById('notify-clear-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _writeBuffer([]);
        _writeUnread(0);
        _setBadge(0);
        _renderNotifyList();
    });

    document.addEventListener('click', (e) => {
        if (!menu.classList.contains('open')) return;
        if (menu.contains(e.target) || btn.contains(e.target)) return;
        close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu.classList.contains('open')) close();
    });
}

// Wired by app.js's WS dispatcher — every `log` event with level >= warn
// gets pushed into the bell buffer + badge increments + tab title flashes.
export function pushLogToNotify(entry) {
    if (!entry) return;
    const level = entry.level || 'info';
    if (level !== 'warn' && level !== 'error') return;
    const buf = _readBuffer();
    buf.push({ ts: entry.ts || Date.now(), source: entry.source || 'app', level, msg: String(entry.msg || '').slice(0, 400) });
    _writeBuffer(buf);
    const open = document.getElementById('notify-bell-menu')?.classList.contains('open');
    if (!open) {
        _writeUnread(_readUnread() + 1);
        _setBadge(_readUnread());
        _flashTabTitle(entry.msg || i18nT('header.notifications', 'Notification'));
    }
    if (open) _renderNotifyList();
}

export function initHeaderMobile() {
    setupOverflowMenu();
    setupNotifyBell();
}
