// Gallery toolbar — the search box and the "Sort & filter" sheet that sit
// above the type tabs (All / Photos / Videos / Files / Audio).
//
// Search: typing (debounced) searches file names + chat names through
// GET /api/downloads/search, scoped to the open chat or to All Media, and
// keeps the active type tab and pinned filter. Results use the normal
// gallery grid, paging and viewer; the loaders in app.js read
// `state.searchQuery` to pick the endpoint.
//
// Sort & filter: one sheet that combines the type (mirrors the tabs), the
// pinned mode and the layout. Pinned mode is stored exactly where the old
// controls kept it, so saved preferences carry over:
//   all   → state.pinnedFilter = false, localStorage tgdl-pinned-first = '0'
//   first → state.pinnedFilter = false, localStorage tgdl-pinned-first = '1'
//   only  → state.pinnedFilter = true  (the old "Pinned" chip; not persisted)

import { state } from './store.js';
import { openSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf, onLanguageChange } from './i18n.js';
import { escapeHtml } from './utils.js';

const PINNED_FIRST_KEY = 'tgdl-pinned-first';
const SEARCH_DEBOUNCE_MS = 300;

let _hooks = {};
let _wired = false;
let _debounce = 0;
let _lastTotal = null;

export function isPinnedFirst() {
    try {
        return localStorage.getItem(PINNED_FIRST_KEY) === '1';
    } catch {
        return false;
    }
}

/** 'all' | 'first' | 'only' */
export function getPinnedMode() {
    if (state.pinnedFilter) return 'only';
    return isPinnedFirst() ? 'first' : 'all';
}

function setPinnedMode(mode) {
    state.pinnedFilter = mode === 'only';
    if (mode !== 'only') {
        try {
            localStorage.setItem(PINNED_FIRST_KEY, mode === 'first' ? '1' : '0');
        } catch {}
    }
}

/** Query-string suffix for the pinned mode, shared by every gallery feed. */
export function pinnedQs() {
    const mode = getPinnedMode();
    if (mode === 'only') return `&pinned=1${isPinnedFirst() ? '&pinnedFirst=1' : ''}`;
    return mode === 'first' ? '&pinnedFirst=1' : '';
}

const $ = (id) => document.getElementById(id);

/**
 * Wire the toolbar once. Hooks:
 *   reload()          — refetch page 1 of the current gallery view
 *   setType(type)     — switch the type tab (same path as a tab click)
 */
export function setupGalleryToolbar(hooks = {}) {
    _hooks = hooks;
    if (_wired) return;
    const input = $('gallery-search-input');
    const clear = $('gallery-search-clear');
    const filterBtn = $('gallery-filter-btn');
    if (!input) return;
    _wired = true;

    input.addEventListener('input', () => {
        _syncClear();
        clearTimeout(_debounce);
        _debounce = setTimeout(() => _apply(input.value), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(_debounce);
            _apply(input.value);
            // Phones: hide the keyboard so the results are visible.
            if (window.matchMedia?.('(pointer: coarse)').matches) input.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (input.value) {
                input.value = '';
                clearTimeout(_debounce);
                _apply('');
            } else {
                input.blur();
            }
        }
    });
    // A native search input's own ✕ (WebKit) fires `search` with an empty value.
    input.addEventListener('search', () => {
        if (!input.value) {
            clearTimeout(_debounce);
            _apply('');
        }
    });
    clear?.addEventListener('click', () => {
        input.value = '';
        clearTimeout(_debounce);
        _apply('');
        input.focus();
    });
    filterBtn?.addEventListener('click', openFilterSheet);
    onLanguageChange(() => syncGalleryToolbar());
    syncGalleryToolbar();
}

function _apply(raw) {
    const q = String(raw || '').trim();
    if (q === (state.searchQuery || '')) {
        _syncClear();
        return;
    }
    state.searchQuery = q;
    _lastTotal = null;
    syncGalleryToolbar();
    _hooks.reload?.();
}

function _syncClear() {
    const input = $('gallery-search-input');
    $('gallery-search-clear')?.classList.toggle('hidden', !input?.value);
}

/** Drop the query without reloading (the caller is about to load a new view). */
export function resetGallerySearch() {
    clearTimeout(_debounce);
    state.searchQuery = '';
    _lastTotal = null;
    const input = $('gallery-search-input');
    if (input) input.value = '';
    syncGalleryToolbar();
}

/** Clear the query and reload the current view. */
export function clearGallerySearch() {
    const had = !!state.searchQuery;
    resetGallerySearch();
    if (had) _hooks.reload?.();
}

/** "1 result" / "12 results" (localised, grouped digits). */
export function formatResultCount(total) {
    const n = Number(total) || 0;
    return n === 1
        ? i18nT('gallery.search.results_one', '1 result')
        : i18nTf(
              'gallery.search.results',
              { count: n.toLocaleString() },
              `${n.toLocaleString()} results`,
          );
}

/** Called by the loaders once page 1 of a search lands. */
export function setSearchResultCount(total) {
    _lastTotal = Number.isFinite(total) ? total : null;
    _syncCount();
}

function _syncCount() {
    const el = $('gallery-search-count');
    if (!el) return;
    // 0 → the empty state below says it in full.
    if (state.searchQuery && _lastTotal) {
        el.textContent = formatResultCount(_lastTotal);
        el.classList.remove('hidden');
    } else {
        el.textContent = '';
        el.classList.add('hidden');
    }
}

export function focusGallerySearch() {
    const input = $('gallery-search-input');
    if (!input || input.offsetParent === null) return false;
    input.focus();
    input.select?.();
    return true;
}

/** Placeholder, clear button, result count and the filter button state. */
export function syncGalleryToolbar() {
    const input = $('gallery-search-input');
    if (input) {
        const inGroup = !!state.currentGroupId;
        input.placeholder = inGroup
            ? i18nT('gallery.search.placeholder_group', 'Search this chat')
            : i18nT('gallery.search.placeholder', 'Search files and chats');
        if ((input.value || '').trim() !== (state.searchQuery || '')) {
            // Only overwrite while the user isn't mid-typing a new query.
            if (document.activeElement !== input) input.value = state.searchQuery || '';
        }
    }
    _syncClear();
    _syncCount();
    _syncFilterButton();
}

function _syncFilterButton() {
    const btn = $('gallery-filter-btn');
    if (!btn) return;
    const mode = getPinnedMode();
    const label = $('gallery-filter-label');
    const dot = $('gallery-filter-dot');
    const text =
        mode === 'only'
            ? i18nT('gallery.filter.state_only', 'Pinned only')
            : mode === 'first'
              ? i18nT('gallery.filter.state_first', 'Pinned first')
              : i18nT('gallery.filter.button', 'Filter');
    if (label) label.textContent = text;
    btn.classList.toggle('is-active', mode !== 'all');
    dot?.classList.toggle('hidden', mode === 'all');
    const title = i18nT('gallery.filter.title', 'Sort & filter');
    btn.setAttribute('aria-label', mode === 'all' ? title : `${title}: ${text}`);
}

// ─── Sort & filter sheet ────────────────────────────────────────────

const TYPES = [
    { id: 'all', icon: 'ri-apps-2-line', k: 'viewer.tab.all', def: 'All' },
    { id: 'images', icon: 'ri-image-line', k: 'viewer.tab.images', def: 'Photos' },
    { id: 'videos', icon: 'ri-film-line', k: 'viewer.tab.videos', def: 'Videos' },
    { id: 'documents', icon: 'ri-file-text-line', k: 'viewer.tab.documents', def: 'Files' },
    { id: 'audio', icon: 'ri-music-2-line', k: 'viewer.tab.audio', def: 'Audio' },
];
const PINNED = [
    {
        id: 'all',
        icon: 'ri-time-line',
        k: 'gallery.filter.pinned_all',
        def: 'Everything, newest first',
    },
    {
        id: 'first',
        icon: 'ri-pushpin-2-line',
        k: 'gallery.filter.pinned_first',
        def: 'Pinned first, then newest',
    },
    { id: 'only', icon: 'ri-pushpin-2-fill', k: 'gallery.filter.pinned_only', def: 'Only pinned' },
];
const LAYOUTS = [
    { id: 'grid', icon: 'ri-layout-grid-line', k: 'header.view_mode.grid', def: 'Grid' },
    { id: 'compact', icon: 'ri-grid-line', k: 'header.view_mode.compact', def: 'Compact' },
    { id: 'list', icon: 'ri-list-check-2', k: 'header.view_mode.list', def: 'List' },
];

function _segment(name, items, current, labelKey, labelDef) {
    const label = i18nT(labelKey, labelDef);
    return `
        <div class="gf-seg" role="radiogroup" aria-label="${escapeHtml(label)}" data-gf-group="${name}">
            ${items
                .map(
                    (it) => `
                <button type="button" role="radio" class="gf-seg-btn" data-gf-${name}="${it.id}"
                    aria-checked="${it.id === current ? 'true' : 'false'}">
                    <i class="${it.icon}" aria-hidden="true"></i>
                    <span>${escapeHtml(i18nT(it.k, it.def))}</span>
                </button>`,
                )
                .join('')}
        </div>`;
}

function _sheetHtml() {
    const pinned = getPinnedMode();
    const layout = state.viewMode || 'grid';
    return `
        <div class="gf-sheet">
            <section class="gf-section">
                <h4 class="gf-heading">${escapeHtml(i18nT('gallery.filter.type', 'Show'))}</h4>
                ${_segment('type', TYPES, state.currentFilter || 'all', 'gallery.filter.type', 'Show')}
            </section>
            <section class="gf-section">
                <h4 class="gf-heading">${escapeHtml(i18nT('gallery.filter.order', 'Order'))}</h4>
                <div class="gf-list" role="radiogroup" aria-label="${escapeHtml(i18nT('gallery.filter.order', 'Order'))}">
                    ${PINNED.map(
                        (p) => `
                        <button type="button" role="radio" class="gf-option" data-gf-pinned="${p.id}"
                            aria-checked="${p.id === pinned ? 'true' : 'false'}">
                            <i class="${p.icon} gf-option-icon" aria-hidden="true"></i>
                            <span class="gf-option-label">${escapeHtml(i18nT(p.k, p.def))}</span>
                            <i class="ri-check-line gf-option-check" aria-hidden="true"></i>
                        </button>`,
                    ).join('')}
                </div>
            </section>
            <section class="gf-section">
                <h4 class="gf-heading">${escapeHtml(i18nT('gallery.filter.layout', 'Layout'))}</h4>
                ${_segment('layout', LAYOUTS, layout, 'gallery.filter.layout', 'Layout')}
            </section>
            <div class="gf-footer">
                <button type="button" class="gf-reset" data-gf-reset>
                    <i class="ri-restart-line" aria-hidden="true"></i>
                    <span>${escapeHtml(i18nT('gallery.filter.reset', 'Reset'))}</span>
                </button>
                <button type="button" class="tg-btn gf-done" data-gf-done>${escapeHtml(i18nT('common.done', 'Done'))}</button>
            </div>
        </div>`;
}

function _paint(root) {
    const pinned = getPinnedMode();
    const type = state.currentFilter || 'all';
    const layout = state.viewMode || 'grid';
    root.querySelectorAll('[data-gf-type]').forEach((b) =>
        b.setAttribute('aria-checked', b.dataset.gfType === type ? 'true' : 'false'),
    );
    root.querySelectorAll('[data-gf-pinned]').forEach((b) =>
        b.setAttribute('aria-checked', b.dataset.gfPinned === pinned ? 'true' : 'false'),
    );
    root.querySelectorAll('[data-gf-layout]').forEach((b) =>
        b.setAttribute('aria-checked', b.dataset.gfLayout === layout ? 'true' : 'false'),
    );
    const reset = root.querySelector('[data-gf-reset]');
    if (reset) reset.disabled = type === 'all' && pinned === 'all';
}

export function openFilterSheet() {
    const wrap = document.createElement('div');
    wrap.innerHTML = _sheetHtml();
    const handle = openSheet({
        title: i18nT('gallery.filter.title', 'Sort & filter'),
        content: wrap,
        size: 'sm',
        onClose: () => $('gallery-filter-btn')?.focus?.(),
    });
    _paint(wrap);
    wrap.addEventListener('click', (e) => {
        const typeBtn = e.target.closest('[data-gf-type]');
        if (typeBtn) {
            if (typeBtn.dataset.gfType !== (state.currentFilter || 'all')) {
                _hooks.setType?.(typeBtn.dataset.gfType);
            }
            _paint(wrap);
            return;
        }
        const pinBtn = e.target.closest('[data-gf-pinned]');
        if (pinBtn) {
            if (pinBtn.dataset.gfPinned !== getPinnedMode()) {
                setPinnedMode(pinBtn.dataset.gfPinned);
                _syncFilterButton();
                _hooks.reload?.();
            }
            _paint(wrap);
            return;
        }
        const layoutBtn = e.target.closest('[data-gf-layout]');
        if (layoutBtn) {
            document
                .querySelector(`#view-mode-menu [data-vm="${layoutBtn.dataset.gfLayout}"]`)
                ?.click();
            _paint(wrap);
            return;
        }
        if (e.target.closest('[data-gf-reset]')) {
            const typeChanged = (state.currentFilter || 'all') !== 'all';
            const pinChanged = getPinnedMode() !== 'all';
            if (pinChanged) setPinnedMode('all');
            _syncFilterButton();
            // setType reloads; only reload separately when it won't run.
            if (typeChanged) _hooks.setType?.('all');
            else if (pinChanged) _hooks.reload?.();
            _paint(wrap);
            return;
        }
        if (e.target.closest('[data-gf-done]')) handle.close();
    });
    // Arrow keys move within a radio group, like native radios.
    wrap.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        const btn = e.target.closest('[role="radio"]');
        const group = btn?.parentElement;
        if (!group) return;
        const radios = [...group.querySelectorAll('[role="radio"]')];
        const i = radios.indexOf(btn);
        const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
        const next = radios[(i + step + radios.length) % radios.length];
        e.preventDefault();
        next.focus();
        next.click();
    });
    return handle;
}
