/**
 * Right-click context menu for gallery tiles — Telegram-style.
 *
 * Desktop only. Mobile long-press already triggers select-mode via
 * gestures.js, which we deliberately do NOT touch.
 *
 * Items shown depend on the session role:
 *   guest → Open · Download · Copy link · Share link
 *   admin → … above + Pin/Unpin · Forward · Delete
 *
 * Keyboard equivalent: pressing the `Menu` (`ContextMenu`) key on a
 * focused tile fires the same menu at the tile's centre — a mouse-free
 * fallback for accessibility users.
 *
 * Cross-platform: pure DOM, no third-party deps. Default key bindings
 * are configurable via `localStorage['tgdl-shortcut-overrides']` (see
 * shortcuts.js).
 */

import { state } from './store.js';
import { api } from './api.js';
import { showToast } from './utils.js';
import { t as i18nT } from './i18n.js';

const MENU_ID = 'tgdl-gallery-context';
let _wired = false;
let _activeMenu = null;

function _findFile(el) {
    const tile = el?.closest?.('.media-item[data-index]');
    if (!tile) return null;
    const idx = parseInt(tile.dataset.index, 10);
    if (!Number.isFinite(idx)) return null;
    return { tile, idx, file: state.files[idx] };
}

function _items(file) {
    const isAdmin = (state.role === 'admin') || !state.role;
    const out = [
        { id: 'open',     icon: 'ri-eye-line',          label: i18nT('gallery.context.open',     'Open') },
        { id: 'download', icon: 'ri-download-line',     label: i18nT('gallery.context.download', 'Download original') },
        { id: 'copy',     icon: 'ri-link',              label: i18nT('gallery.context.copy',     'Copy link') },
        { id: 'share',    icon: 'ri-share-line',        label: i18nT('gallery.context.share',    'Share link'),         adminOnly: false },
    ];
    if (isAdmin) {
        out.push({ id: 'sep', divider: true });
        out.push({ id: 'pin',     icon: 'ri-pushpin-2-line',    label: file?.pinned ? i18nT('gallery.context.unpin', 'Unpin') : i18nT('gallery.context.pin', 'Pin') });
        out.push({ id: 'forward', icon: 'ri-share-forward-line', label: i18nT('gallery.context.forward', 'Forward') });
        out.push({ id: 'sep2', divider: true });
        out.push({ id: 'delete',  icon: 'ri-delete-bin-line',   label: i18nT('gallery.context.delete', 'Delete'), danger: true });
    }
    return out;
}

function _close() {
    if (!_activeMenu) return;
    _activeMenu.remove();
    _activeMenu = null;
    document.removeEventListener('click', _onAnyClick, true);
    document.removeEventListener('keydown', _onAnyKey, true);
    window.removeEventListener('resize', _close);
    window.removeEventListener('scroll', _close, true);
}

function _onAnyClick(e) {
    if (!_activeMenu) return;
    if (_activeMenu.contains(e.target)) return;
    _close();
}

function _onAnyKey(e) {
    if (e.key === 'Escape') { _close(); return; }
    if (!_activeMenu) return;
    const items = Array.from(_activeMenu.querySelectorAll('.ctx-item'));
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(cur + 1 + items.length) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(cur - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
        if (cur >= 0) { e.preventDefault(); items[cur].click(); }
    }
}

function _open(x, y, file, idx) {
    _close();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'tg-context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const items = _items(file);
    const html = items.map(it => {
        if (it.divider) return `<div class="ctx-divider" role="separator"></div>`;
        const cls = it.danger ? 'ctx-item ctx-danger' : 'ctx-item';
        return `<div class="${cls}" role="menuitem" tabindex="-1" data-action="${it.id}">
            <i class="${it.icon}"></i><span>${it.label}</span>
        </div>`;
    }).join('');
    menu.innerHTML = html;

    document.body.appendChild(menu);
    requestAnimationFrame(() => menu.classList.add('is-open'));

    // Clamp to viewport so the menu doesn't disappear off the right/bottom edge.
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (rect.right > vw - 4) menu.style.left = `${vw - rect.width - 8}px`;
    if (rect.bottom > vh - 4) menu.style.top  = `${vh - rect.height - 8}px`;

    menu.addEventListener('click', async (ev) => {
        const item = ev.target.closest('.ctx-item');
        if (!item) return;
        const action = item.dataset.action;
        _close();
        await _handle(action, file, idx);
    });

    _activeMenu = menu;
    setTimeout(() => menu.querySelector('.ctx-item')?.focus(), 0);
    document.addEventListener('click', _onAnyClick, true);
    document.addEventListener('keydown', _onAnyKey, true);
    window.addEventListener('resize', _close);
    window.addEventListener('scroll', _close, true);
}

async function _handle(action, file, idx) {
    if (!file) return;
    if (action === 'open') {
        // Lazy import — viewer.js is a sibling module, ESM circular-safe.
        const { openMediaViewer } = await import('./viewer.js');
        openMediaViewer(idx);
        return;
    }
    if (action === 'download') {
        const a = document.createElement('a');
        a.href = `/files/${encodeURIComponent(file.fullPath)}`;
        a.download = file.name || '';
        document.body.appendChild(a); a.click(); a.remove();
        return;
    }
    if (action === 'copy') {
        const url = new URL(`/files/${encodeURIComponent(file.fullPath)}?inline=1`, window.location.origin).toString();
        try {
            await navigator.clipboard.writeText(url);
            showToast(i18nT('gallery.context.copied', 'Link copied'), 'success');
        } catch {
            showToast(i18nT('gallery.context.copy_failed', 'Could not copy — paste from the address bar'), 'error');
        }
        return;
    }
    if (action === 'share') {
        // Lazy-import the share module — only loaded when actually used.
        if (file.id == null) {
            showToast(i18nT('gallery.context.share_no_id', 'This row has no DB id — share not available'), 'error');
            return;
        }
        try {
            const { openShareSheet } = await import('./share.js');
            openShareSheet({ downloadId: file.id, fileName: file.name });
        } catch {
            showToast(i18nT('gallery.context.share_unavailable', 'Share not available'), 'error');
        }
        return;
    }
    if (action === 'pin') {
        if (file.id == null) {
            showToast(i18nT('favorites.no_id', 'This row has no DB id — cannot pin'), 'error');
            return;
        }
        const next = !file.pinned;
        try {
            await api.post(`/api/downloads/${encodeURIComponent(file.id)}/pin`, { pinned: next });
            file.pinned = next;
            const tile = document.querySelector(`.media-item[data-id="${CSS.escape(String(file.id))}"]`);
            if (tile) tile.classList.toggle('is-pinned', next);
            showToast(next
                ? i18nT('favorites.pinned', 'Pinned')
                : i18nT('favorites.unpinned', 'Unpinned'),
                'success');
        } catch (e) {
            showToast(e?.message || 'Pin failed', 'error');
        }
        return;
    }
    if (action === 'forward') {
        // No dedicated forward UI yet — open the share sheet which is the
        // closest existing flow (admin can grab a share link to send on).
        if (file.id == null) {
            showToast(i18nT('gallery.context.forward_unavailable', 'Forward not available'), 'error');
            return;
        }
        try {
            const { openShareSheet } = await import('./share.js');
            openShareSheet({ downloadId: file.id, fileName: file.name });
        } catch {
            showToast(i18nT('gallery.context.forward_unavailable', 'Forward not available'), 'error');
        }
        return;
    }
    if (action === 'delete') {
        const { confirmSheet } = await import('./sheet.js');
        const ok = await confirmSheet({
            title: i18nT('gallery.context.delete', 'Delete'),
            message: i18nT('gallery.context.delete_confirm', 'Delete this file? This cannot be undone.'),
            danger: true,
        });
        if (!ok) return;
        try {
            await api.delete(`/api/file?path=${encodeURIComponent(file.fullPath)}`);
            // Re-render delegated to the existing WS file_deleted handler.
        } catch (e) {
            showToast(e?.message || 'Delete failed', 'error');
        }
        return;
    }
}

export function setupGalleryContextMenu() {
    if (_wired) return;
    _wired = true;

    document.addEventListener('contextmenu', (ev) => {
        const hit = _findFile(ev.target);
        if (!hit) return;
        ev.preventDefault();
        _open(ev.clientX, ev.clientY, hit.file, hit.idx);
    });

    // Keyboard `ContextMenu` key — fire the same menu at the focused tile.
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ContextMenu') return;
        const tile = document.activeElement?.closest?.('.media-item[data-index]');
        if (!tile) return;
        const idx = parseInt(tile.dataset.index, 10);
        if (!Number.isFinite(idx)) return;
        const rect = tile.getBoundingClientRect();
        ev.preventDefault();
        _open(rect.left + 16, rect.top + 16, state.files[idx], idx);
    });
}
