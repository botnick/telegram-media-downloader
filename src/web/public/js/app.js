/**
 * Telegram Media Downloader - Main App
 * Uses ES Modules — Complete Implementation
 */

import { state } from './store.js';
import { api } from './api.js';
import { createAvatar, escapeHtml, getFileIcon, showToast, formatBytes } from './utils.js';
import * as Settings from './settings.js';
import * as Viewer from './viewer.js';
import { initEngine, handleEngineWsMessage } from './engine.js';
import { ws } from './ws.js';
import { initTheme, getTheme, setTheme } from './theme.js';
import { initStatusBar } from './statusbar.js';
import * as Notifications from './notifications.js';
import { initOnboarding, refreshOnboarding } from './onboarding.js';
import { initShortcuts } from './shortcuts.js';
import * as router from './router.js';
import { openSheet } from './sheet.js';
import { renderChatRow, renderEmptyState, renderRowSkeletons, renderGallerySkeletons } from './components.js';
import { formatRelativeTime } from './utils.js';
import { attachLongPress, attachPullToRefresh } from './gestures.js';
import { initI18n, setLang, getLang, applyToDOM as applyI18n, t as i18nT } from './i18n.js';

// ============ Initialization ============
async function init() {
    setupEventListeners();
    setupLazyLoading();
    setupInfiniteScroll();

    Viewer.setupViewerEvents();

    // Live updates from the server (engine state, downloads, purges).
    ws.connect();
    ws.on('*', handleEngineWsMessage);
    ws.on('group_purged', () => loadGroups());
    ws.on('purge_all', () => { loadGroups(); loadStats(); });
    ws.on('file_deleted', () => { /* gallery refresh handled by store */ });
    ws.on('config_updated', () => { if (state.currentPage === 'settings') Settings.loadSettings(); });
    ws.on('monitor_event', (m) => {
        if (m.type === 'download_complete') Notifications.notifyDownloadComplete(m.payload || {});
    });

    // Live "this group is downloading" ring state — driven by the same
    // download_progress / download_complete events the engine card uses.
    state.activeRings = state.activeRings || new Set();
    function markRing(groupId, on) {
        const id = String(groupId);
        const had = state.activeRings.has(id);
        if (on) state.activeRings.add(id); else state.activeRings.delete(id);
        if (had !== on) renderGroupsList();
    }
    ws.on('download_progress', (m) => { if (m.payload?.groupId) markRing(m.payload.groupId, true); });
    ws.on('download_complete', (m) => {
        if (m.payload?.groupId) {
            // Hold the ring for ~600ms after the last byte so users can see
            // the completion before it fades.
            setTimeout(() => markRing(m.payload.groupId, false), 600);
        }
    });
    ws.on('monitor_state', (m) => {
        if (m.state === 'stopped' || m.state === 'error') {
            if (state.activeRings?.size) {
                state.activeRings.clear();
                renderGroupsList();
            }
        }
    });

    // Sticky status bar (engine state + counters + WS link)
    initStatusBar();

    // First-run / mid-flow guidance — banner that walks the user through
    // configure-API → add-account → enable-group based on /api/monitor/status.
    initOnboarding();
    ws.on('config_updated', refreshOnboarding);
    ws.on('monitor_state', refreshOnboarding);

    // Global keyboard shortcuts (press ? for the cheatsheet).
    initShortcuts();

    await loadGroups();
    await loadStats();
    // Routes need to be registered BEFORE router.start() so the initial
    // hash dispatch lands on a real handler.
    registerRoutes();
    setupFab();
    router.start();
    
    // Expose to window for HTML onclick handlers
    window.navigateTo = navigateTo;
    window.openGroup = openGroup;
    window.showAllMedia = showAllMedia;
    window.openMediaViewer = Viewer.openMediaViewer;
    window.closeMediaViewer = Viewer.closeMediaViewer;
    window.openGroupSettings = openGroupSettings;
    window.closeGroupSettings = closeGroupSettings;
    window.saveGroupSettings = saveGroupSettings;
    window.refreshCurrentPage = refreshCurrentPage;
    window.switchGroupsTab = switchGroupsTab;
    window.switchSettingsTab = switchSettingsTab;
    window.toggleGroupEnabled = toggleGroupEnabled;
    window.closeSidebar = closeSidebar;
    window.confirmDeleteFile = confirmDeleteFile;
    window.toggleFwdEnabled = toggleFwdEnabled;
    window.toggleFwdDelete = toggleFwdDelete;
    window.openDestinationPicker = openDestinationPicker;
    window.filterDialogs = filterDialogs;
    window.showToast = showToast;
    window.purgeGroup = purgeGroup;
    window.purgeAll = purgeAll;
    
    // Settings globals
    window.applyPreset = Settings.applyPreset;
    document.getElementById('save-settings')?.addEventListener('click', Settings.saveSettings);
    document.getElementById('save-api-credentials')?.addEventListener('click', Settings.saveApiCredentials);
    document.getElementById('change-password-btn')?.addEventListener('click', Settings.changePassword);
    document.getElementById('logout-btn')?.addEventListener('click', Settings.signOut);
    document.getElementById('proxy-save')?.addEventListener('click', Settings.saveProxy);
    document.getElementById('proxy-test')?.addEventListener('click', Settings.testProxy);

    // Paste-URL drawer
    setupPasteUrl();
    setupMediaSearch();
    setupStoriesPanel();
    setupGalleryGestures();
    setupToggleA11y();

    // Initialise i18n + the language picker. The fall-through is English so
    // a missing-key during a translation roll-out still renders something.
    await initI18n();
    const langSelect = document.getElementById('setting-language');
    if (langSelect) {
        langSelect.value = getLang();
        langSelect.addEventListener('change', () => setLang(langSelect.value));
    }

    // Appearance toggle
    initTheme();
    document.querySelectorAll('[data-theme-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            setTheme(btn.dataset.themeSet);
            highlightThemeButtons();
        });
    });
    highlightThemeButtons();

    // The initial render is handled by router.start() below — it dispatches
    // to whichever hash the URL has (default /viewer).
}

// ============ Navigation ============
//
// Public navigateTo(page) is the SPA's user-facing way to switch pages — it
// always goes through the hash router so the URL stays in sync, browser
// back/forward works, and deep-links to e.g. #/settings/proxy land on the
// right place. The actual DOM swap lives in renderPage().

function navigateTo(page, opts) {
    const url = page.startsWith('#/') ? page : `#/${page}`;
    router.navigate(url, opts);
}

function renderPage(page, params = {}) {
    state.currentPage = page;
    state.currentRouteParams = params;

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

    // Bottom-nav active state
    document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.bottom-nav-item[data-nav="${page}"]`)?.classList.add('active');

    document.querySelectorAll('#content-area > div[id^="page-"]').forEach(el => el.classList.add('hidden'));
    document.getElementById(`page-${page}`)?.classList.remove('hidden');

    const mediaTabs = document.getElementById('media-tabs');
    if (mediaTabs) mediaTabs.style.display = page === 'viewer' ? '' : 'none';

    closeSidebar();

    if (page === 'settings') {
        Settings.loadSettings();
        initEngine();
        document.getElementById('page-title').textContent = 'Settings';
        document.getElementById('page-subtitle').textContent = 'System Configuration';
        // Optional deep-link: #/settings/<section> scrolls to that section.
        if (params.section) {
            setTimeout(() => {
                const el = document.querySelector(`[data-settings-section="${params.section}"]`)
                       || document.querySelector(`#setting-${params.section}, .${params.section}-section`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 80);
        }
    } else if (page === 'groups') {
        renderGroupsConfig();
        document.getElementById('page-title').textContent = 'Manage Groups';
        document.getElementById('page-subtitle').textContent = 'Configure monitoring and filters';
    } else if (page === 'viewer') {
        if (state.currentGroup) {
            document.getElementById('page-title').textContent = state.currentGroup;
        } else {
            showAllMedia();
        }
    }
}

// Register hash routes. Patterns documented in router.js.
function registerRoutes() {
    router.route('/viewer', () => renderPage('viewer'));
    router.route('/viewer/:groupId', ({ params }) => {
        // Open a specific group's gallery — match the existing openGroup()
        // behaviour so the sidebar selection stays consistent.
        renderPage('viewer');
        const g = state.groups?.find(x => String(x.id) === String(params.groupId));
        if (g) openGroup(params.groupId, g.name);
    });
    router.route('/groups', () => renderPage('groups'));
    router.route('/groups/:groupId', ({ params }) => {
        renderPage('groups');
        const g = (state.allDialogs || []).find(d => String(d.id) === String(params.groupId))
              || state.groups?.find(x => String(x.id) === String(params.groupId));
        if (g) openGroupSettings(params.groupId, g.name || g.title || params.groupId);
    });
    router.route('/engine', () => renderPage('settings', { section: 'engine' }));
    router.route('/settings', () => renderPage('settings'));
    router.route('/settings/:section', ({ params }) => renderPage('settings', { section: params.section }));
    router.route('/stories', () => {
        renderPage('viewer');
        document.getElementById('stories-btn')?.click();
    });
    router.route('/account/add', () => { window.location.href = '/add-account.html'; });
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.add('hidden');
}

// ============ Groups Logic ============
async function loadGroups() {
    // Show 6 row skeletons while we wait for the network — better than a
    // blank sidebar, especially on slow connections.
    const list = document.getElementById('groups-list');
    if (list && !list.children.length) list.innerHTML = renderRowSkeletons(6);

    try {
        const [groups, downloads] = await Promise.all([
            api.get('/api/groups'),
            api.get('/api/downloads'),
        ]);
        state.groups = groups;
        state.downloads = downloads;
        renderGroupsList();
    } catch (e) {
        console.error('Failed to load groups:', e);
        if (list) list.innerHTML = '';
    }
}

function renderGroupsList() {
    const list = document.getElementById('groups-list');
    if (!list) return;
    
    const map = new Map();
    
    // Start with config groups (these are monitored groups — the authoritative name source)
    state.groups.forEach(g => {
        map.set(String(g.id), { ...g, downloadId: String(g.id), totalFiles: 0, sizeFormatted: '0 B', type: 'config' });
    });
    
    // Enrich with download data (file counts, sizes) and add download-only groups
    state.downloads.forEach(d => {
        const key = String(d.id);
        if (map.has(key)) {
            const existing = map.get(key);
            existing.totalFiles = d.totalFiles;
            existing.sizeFormatted = d.sizeFormatted;
            existing.downloadId = d.id;
        } else {
            map.set(key, { name: d.name, id: d.id, downloadId: d.id, totalFiles: d.totalFiles, sizeFormatted: d.sizeFormatted, type: 'folder' });
        }
    });
    
    const sorted = Array.from(map.values());

    if (sorted.length === 0) {
        list.innerHTML = renderEmptyState({
            icon: 'ri-chat-3-line',
            title: 'No groups yet',
            body: 'Add a Telegram chat from the Chats page to start downloading.',
            actionLabel: 'Browse chats',
            actionHref: '#/groups',
        });
        return;
    }

    state.activeRings = state.activeRings || new Set();
    let needsResolve = false;
    list.innerHTML = sorted.map(g => {
        const id = String(g.downloadId || g.id || g.name);
        const rawName = g.name;
        // Detect unresolved entries (added via paste-link before the engine
        // could see the chat) and surface a friendly placeholder. We'll fire
        // a one-shot refresh below.
        const looksUnresolved = !rawName
            || rawName === 'Unknown'
            || rawName === id
            || /^-?\d{6,}$/.test(rawName);
        if (looksUnresolved) needsResolve = true;
        const displayName = looksUnresolved ? 'Unknown chat' : rawName;
        const subtitle = looksUnresolved
            ? `Resolving… · ${g.totalFiles || 0} files`
            : `${g.totalFiles || 0} files · ${g.sizeFormatted || '0 B'}`;
        const ring = state.activeRings.has(id) ? 'downloading' : null;
        return renderChatRow({
            id,
            name: displayName,
            subtitle,
            avatarType: g.type,
            avatarRing: ring,
            avatarDot: ring ? 'monitor' : null,
            time: g.lastDownloadAt ? formatRelativeTime(g.lastDownloadAt) : '',
            selected: state.currentGroupId === id,
            data: { groupName: rawName },
        });
    }).join('');

    // Fire a one-shot resolve in the background. We dedupe with an in-flight
    // flag so a flurry of WS-driven re-renders doesn't hammer the endpoint.
    if (needsResolve && !state._resolvingGroups) {
        state._resolvingGroups = true;
        api.post('/api/groups/refresh-info').then(r => {
            if (r?.updated > 0) loadGroups();
        }).catch(() => {}).finally(() => { state._resolvingGroups = false; });
    }

    // Event delegation — click opens the group viewer; right-click / long-press
    // shows a context menu (handled by gestures.js / future addition).
    list.querySelectorAll('.chat-row[data-id]').forEach(el => {
        el.addEventListener('click', () => openGroup(el.dataset.id, el.dataset.groupName));
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openGroup(el.dataset.id, el.dataset.groupName);
            }
        });
    });
}

function normalize(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ============ Open Group / Show All ============
function openGroup(groupId, groupName) {
    state.currentGroupId = groupId;
    state.currentGroup = groupName || groupId;
    state.page = 1;
    state.hasMore = true;
    state.files = [];
    
    document.getElementById('page-title').textContent = state.currentGroup;
    document.getElementById('page-subtitle').textContent = 'Loading...';
    navigateTo('viewer');
    loadGroupFiles(groupId);
}

function showAllMedia() {
    state.currentGroup = null;
    state.currentGroupId = null;
    state.page = 1;
    state.hasMore = true;
    state.files = [];
    
    document.getElementById('page-title').textContent = 'All Media';
    document.getElementById('page-subtitle').textContent = 'All downloaded files';
    
    const grid = document.getElementById('media-grid');
    if (grid) grid.innerHTML = '';
    
    // Load files from all groups
    loadAllFiles();
}

async function loadAllFiles() {
    try {
        const downloads = await api.get('/api/downloads');
        let allFiles = [];
        
        for (const group of downloads.slice(0, 20)) {
            try {
                const res = await api.get(`/api/downloads/${encodeURIComponent(group.id)}?page=1&limit=20`);
                if (res.files) {
                    allFiles = allFiles.concat(res.files.map(f => ({ ...f, groupName: group.name })));
                }
            } catch (e) {}
        }
        
        state.files = allFiles;
        renderMediaGrid();
        document.getElementById('page-subtitle').textContent = `${allFiles.length} files`;
    } catch (e) {
        showToast('Error loading files', 'error');
    }
}

// ============ Media Loading ============
async function loadGroupFiles(groupId) {
    state.loading = true;

    // Show 12 skeleton tiles for the very first page so users don't stare
    // at an empty grid for the duration of the network round-trip. Page 2+
    // adds rows so we don't replace what's already there.
    if (state.page === 1) {
        const grid = document.getElementById('media-grid');
        if (grid) grid.innerHTML = renderGallerySkeletons(12);
        document.getElementById('empty-state')?.classList.add('hidden');
    }

    try {
        const res = await api.get(`/api/downloads/${encodeURIComponent(groupId)}?page=${state.page}&limit=50`);
        const newFiles = res.files || [];

        if (state.page === 1) {
            state.files = newFiles;
        } else {
            state.files = state.files.concat(newFiles);
        }

        state.hasMore = newFiles.length === 50;
        renderMediaGrid();
        document.getElementById('page-subtitle').textContent = `${res.total || state.files.length} files`;
    } catch (e) {
        showToast('Error loading files', 'error');
    } finally {
        state.loading = false;
    }
}

function renderMediaGrid() {
    const grid = document.getElementById('media-grid');
    const empty = document.getElementById('empty-state');
    if (!grid) return;

    if (state.files.length === 0) {
        grid.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');

    const filtered = state.currentFilter === 'all'
        ? state.files
        : state.files.filter(f => f.type === state.currentFilter);

    if (!state.selected) state.selected = new Set();

    // Time-group the items into Today / Yesterday / This week / Older.
    // Headers are rendered as grid-column: 1 / -1 children so the existing
    // CSS Grid layout keeps each section as a row of full-width tiles.
    const sections = groupFilesByTime(filtered);
    const tilesByIndex = filtered;

    const html = sections.map(([label, items]) => {
        const headerHtml = label
            ? `<h4 class="grid-section-header" style="grid-column: 1 / -1; padding: 12px 4px 6px; color: var(--tg-textSecondary, #8B9BAA); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; background: var(--tg-bg, #17212B); z-index: 1;">${escapeHtml(label)}</h4>`
            : '';
        const tiles = items.map(({ file, originalIndex }) => {
            const checked = state.selected.has(file.fullPath);
            const checkBadge = state.selectMode
                ? `<div class="select-badge absolute top-1 left-1 w-6 h-6 rounded-full ${checked ? 'bg-tg-blue text-white' : 'bg-black/40 text-transparent'} flex items-center justify-center text-sm"><i class="ri-check-line"></i></div>`
                : '';
            const ringClass = checked ? 'ring-2 ring-tg-blue' : '';
            return `
            <div class="media-item relative aspect-square bg-tg-panel rounded overflow-hidden cursor-pointer ${ringClass}" data-index="${originalIndex}" data-path="${escapeHtml(file.fullPath)}">
                ${file.type === 'images' ?
                    `<img data-src="/files/${encodeURIComponent(file.fullPath)}?inline=1" class="w-full h-full object-cover" onerror="this.style.display='none'" alt="">` :
                    file.type === 'videos' ?
                    `<div class="relative w-full h-full bg-black">
                        <video data-src="/files/${encodeURIComponent(file.fullPath)}?inline=1" class="w-full h-full object-cover" preload="none" muted></video>
                        <div class="absolute inset-0 flex items-center justify-center">
                            <div class="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center">
                                <i class="ri-play-fill text-white text-xl ml-0.5"></i>
                            </div>
                        </div>
                    </div>` :
                    `<div class="w-full h-full flex flex-col items-center justify-center">
                        <i class="${getFileIcon(file.extension)} text-3xl text-tg-textSecondary"></i>
                        <span class="text-xs text-tg-textSecondary mt-1 truncate px-2 w-full text-center">${escapeHtml(file.name || '')}</span>
                    </div>`
                }
                ${checkBadge}
            </div>`;
        }).join('');
        return headerHtml + tiles;
    }).join('');

    grid.innerHTML = html;

    grid.querySelectorAll('.media-item[data-index]').forEach(el => {
        el.addEventListener('click', (ev) => {
            const idx = parseInt(el.dataset.index, 10);
            if (state.selectMode || ev.shiftKey) {
                toggleSelection(el.dataset.path);
                ev.preventDefault();
                return;
            }
            Viewer.openMediaViewer(idx);
        });
    });

    if (state.imageObserver) {
        state.imageObserver.disconnect();
        grid.querySelectorAll('img[data-src], video[data-src]').forEach(el => state.imageObserver.observe(el));
    }
}

function toggleSelection(path) {
    if (!state.selected) state.selected = new Set();
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    updateSelectionBar();
    renderMediaGrid();
}

function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    const count = state.selected ? state.selected.size : 0;
    document.getElementById('selection-count').textContent = `${count} selected`;
    if (bar) bar.classList.toggle('hidden', count === 0);
}

// Group files into Telegram-style time sections. Returns an array of
// [label, [{file, originalIndex}, ...]] entries in display order. The
// `originalIndex` is preserved from the supplied list so the click handler
// can still pass it to openMediaViewer().
function groupFilesByTime(files) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
    const buckets = { today: [], yesterday: [], week: [], older: [] };

    files.forEach((file, originalIndex) => {
        const t = file.modified ? Date.parse(file.modified) : NaN;
        if (!Number.isFinite(t)) { buckets.older.push({ file, originalIndex }); return; }
        if (t >= startOfToday) buckets.today.push({ file, originalIndex });
        else if (t >= startOfYesterday) buckets.yesterday.push({ file, originalIndex });
        else if (t >= startOfWeek) buckets.week.push({ file, originalIndex });
        else buckets.older.push({ file, originalIndex });
    });

    const out = [];
    if (buckets.today.length) out.push(['Today', buckets.today]);
    if (buckets.yesterday.length) out.push(['Yesterday', buckets.yesterday]);
    if (buckets.week.length) out.push(['Earlier this week', buckets.week]);
    if (buckets.older.length) out.push(['Older', buckets.older]);
    // If we ended up with a single section, drop the header so a small group
    // doesn't get an awkward "Older" label above one row.
    if (out.length === 1) out[0][0] = '';
    return out;
}

// Promote every .tg-toggle div to a keyboard-accessible switch. The visual
// markup stays the same (Tailwind-styled pill via the existing CSS) but the
// element gets role="switch" + aria-checked + tabindex so screen readers
// announce it correctly and Space/Enter toggle it. A MutationObserver
// mirrors the .active class into aria-checked when JS toggles the class.
function setupToggleA11y() {
    const observe = (el) => {
        if (el.dataset.a11yToggle) return;
        el.dataset.a11yToggle = '1';
        if (!el.hasAttribute('role')) el.setAttribute('role', 'switch');
        if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
        const sync = () => el.setAttribute('aria-checked', el.classList.contains('active') ? 'true' : 'false');
        sync();
        new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
        el.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                el.click();
            }
        });
    };
    document.querySelectorAll('.tg-toggle').forEach(observe);
    // Watch for newly-added toggles (the group-settings modal builds them dynamically).
    new MutationObserver((records) => {
        for (const rec of records) {
            for (const node of rec.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.classList?.contains('tg-toggle')) observe(node);
                node.querySelectorAll?.('.tg-toggle').forEach(observe);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
}

function setupGalleryGestures() {
    const grid = document.getElementById('media-grid');
    if (!grid) return;

    // Long-press on a tile → enter selection mode + toggle that tile.
    attachLongPress(grid, {
        selector: '.media-item[data-path]',
        onLongPress: (el) => {
            if (!state.selectMode) {
                state.selectMode = true;
                document.getElementById('select-mode-btn')?.classList.add('bg-tg-blue', 'text-white');
            }
            toggleSelection(el.dataset.path);
        },
    });

    // Pull-to-refresh on the viewer's scroll container.
    const scroll = document.getElementById('content-area');
    if (scroll) {
        scroll.style.overscrollBehavior = 'contain';
        attachPullToRefresh(scroll, {
            onRefresh: async () => {
                if (typeof refreshCurrentPage === 'function') refreshCurrentPage();
                await new Promise(r => setTimeout(r, 400));
            },
        });
    }
}

async function setupMediaSearch() {
    const input = document.getElementById('media-search');
    const clear = document.getElementById('media-search-clear');
    const selectBtn = document.getElementById('select-mode-btn');
    const selBar = document.getElementById('selection-bar');
    const selDel = document.getElementById('selection-delete');
    const selClear = document.getElementById('selection-clear');
    if (!input) return;

    let timer = null;
    let lastQuery = '';

    const runSearch = async (q) => {
        if (!q) {
            state.searchActive = false;
            // Re-render whatever was loaded for the current group
            if (state.savedFiles) state.files = state.savedFiles;
            renderMediaGrid();
            return;
        }
        try {
            const r = await api.get(`/api/downloads/search?q=${encodeURIComponent(q)}&limit=200`);
            // Keep a snapshot of pre-search files so clearing restores them
            if (!state.searchActive) state.savedFiles = state.files;
            state.searchActive = true;
            state.files = r.files;
            renderMediaGrid();
        } catch (e) {
            showToast(`Search failed: ${e.message}`, 'error');
        }
    };

    input.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        clear.classList.toggle('hidden', !q);
        if (q === lastQuery) return;
        lastQuery = q;
        clearTimeout(timer);
        timer = setTimeout(() => runSearch(q), 250);
    });
    clear?.addEventListener('click', () => { input.value = ''; lastQuery = ''; clear.classList.add('hidden'); runSearch(''); });

    selectBtn?.addEventListener('click', () => {
        state.selectMode = !state.selectMode;
        selectBtn.classList.toggle('bg-tg-blue', state.selectMode);
        selectBtn.classList.toggle('text-white', state.selectMode);
        if (!state.selectMode && state.selected) state.selected.clear();
        updateSelectionBar();
        renderMediaGrid();
    });

    selClear?.addEventListener('click', () => {
        if (state.selected) state.selected.clear();
        updateSelectionBar();
        renderMediaGrid();
    });

    selDel?.addEventListener('click', async () => {
        if (!state.selected || !state.selected.size) return;
        const paths = Array.from(state.selected);
        if (!confirm(`Delete ${paths.length} file(s)? This cannot be undone.`)) return;
        try {
            const r = await api.post('/api/downloads/bulk-delete', { paths });
            showToast(`Deleted ${r.unlinked} files`, 'success');
            state.selected.clear();
            // Drop deleted entries from the current view
            const set = new Set(paths);
            state.files = (state.files || []).filter(f => !set.has(f.fullPath));
            if (state.savedFiles) state.savedFiles = state.savedFiles.filter(f => !set.has(f.fullPath));
            updateSelectionBar();
            renderMediaGrid();
        } catch (e) {
            showToast(`Delete failed: ${e.message}`, 'error');
        }
    });
}

// ============ Groups Config Page ============
async function renderGroupsConfig() {
    const list = document.getElementById('groups-config-list');
    if (!list) return;
    
    list.innerHTML = '<div class="text-center py-8 text-tg-textSecondary">Loading dialogs...</div>';
    
    try {
        const res = await api.get('/api/dialogs');
        const dialogs = res.dialogs || res || [];
        state.allDialogs = dialogs;
        renderDialogsList(dialogs);
    } catch (e) {
        list.innerHTML = '<div class="text-center py-8 text-red-400">Failed to load dialogs</div>';
    }
}

function renderDialogsList(dialogs) {
    const list = document.getElementById('groups-config-list');
    if (!list) return;
    
    const tab = state.groupsTab || 'all';
    const filtered = tab === 'monitored' 
        ? dialogs.filter(d => d.inConfig || d.enabled) 
        : dialogs;
    
    if (filtered.length === 0) {
        list.innerHTML = '<div class="text-center py-8 text-tg-textSecondary">No groups found</div>';
        return;
    }
    
    list.innerHTML = filtered.map(d => {
        const typeLabel = d.type === 'channel' ? 'Channel'
            : d.type === 'group' ? 'Group'
            : d.type === 'bot' ? 'Bot'
            : d.type === 'user' ? 'Direct message' : 'Dialog';
        const subParts = [typeLabel];
        if (d.members) subParts.push(`${d.members} members`);
        if (d.archived) subParts.push('archived');

        const statusPill = (d.inConfig && d.enabled)
            ? { label: 'Active', kind: 'active' }
            : (d.inConfig && !d.enabled)
                ? { label: 'Paused', kind: 'paused' }
                : { label: 'Add', kind: 'add' };

        return renderChatRow({
            id: d.id,
            name: d.name,
            avatarType: d.type,
            subtitle: subParts.join(' · '),
            statusPill,
            data: { dialogName: d.name },
        });
    }).join('');

    // Click anywhere on the row → open the group settings sheet for that
    // dialog. Keyboard Enter/Space mirrors the click for accessibility.
    list.querySelectorAll('.chat-row[data-id]').forEach(el => {
        const fire = () => openGroupSettings(el.dataset.id, el.dataset.dialogName);
        el.addEventListener('click', fire);
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
        });
    });
}

function filterDialogs(query) {
    if (!state.allDialogs) return;
    const q = query.toLowerCase();
    const filtered = state.allDialogs.filter(d => 
        (d.name || '').toLowerCase().includes(q) || String(d.id).includes(q)
    );
    renderDialogsList(filtered);
}

function switchGroupsTab(tab) {
    state.groupsTab = tab;
    
    document.getElementById('groups-tab-all')?.classList.toggle('border-tg-blue', tab === 'all');
    document.getElementById('groups-tab-all')?.classList.toggle('text-tg-blue', tab === 'all');
    document.getElementById('groups-tab-all')?.classList.toggle('border-transparent', tab !== 'all');
    document.getElementById('groups-tab-all')?.classList.toggle('text-tg-textSecondary', tab !== 'all');
    
    document.getElementById('groups-tab-monitored')?.classList.toggle('border-tg-blue', tab === 'monitored');
    document.getElementById('groups-tab-monitored')?.classList.toggle('text-tg-blue', tab === 'monitored');
    document.getElementById('groups-tab-monitored')?.classList.toggle('border-transparent', tab !== 'monitored');
    document.getElementById('groups-tab-monitored')?.classList.toggle('text-tg-textSecondary', tab !== 'monitored');
    
    if (state.allDialogs) renderDialogsList(state.allDialogs);
}

// ============ Group Settings Modal ============
let currentEditGroup = null;

async function openGroupSettings(groupId, groupName) {
    currentEditGroup = { id: groupId, name: groupName };
    
    const modal = document.getElementById('group-modal');
    if (!modal) return;
    
    // Load current config for this group
    const group = state.groups.find(g => String(g.id) === String(groupId));
    const filters = group?.filters || {};
    const fwd = group?.autoForward || {};
    
    // Update toggle states
    const enableToggle = document.getElementById('group-enable-toggle');
    if (enableToggle) enableToggle.classList.toggle('active', group?.enabled !== false);
    
    const fwdToggle = document.getElementById('fwd-enable-toggle');
    if (fwdToggle) fwdToggle.classList.toggle('active', fwd.enabled === true);
    
    const fwdDeleteToggle = document.getElementById('fwd-delete-toggle');
    if (fwdDeleteToggle) fwdDeleteToggle.classList.toggle('active', fwd.deleteAfterForward === true);

    // Topics
    const topics = group?.topics || {};
    const topicsToggle = document.getElementById('topics-enable-toggle');
    if (topicsToggle) topicsToggle.classList.toggle('active', topics.enabled === true);
    const topicsInput = document.getElementById('topics-ids');
    if (topicsInput) topicsInput.value = (topics.ids || []).join(', ');
    
    const fwdDest = document.getElementById('fwd-destination');
    if (fwdDest) fwdDest.value = fwd.destination || '';
    
    // Populate account pickers
    try {
        const accounts = await api.get('/api/accounts');
        const monitorSelect = document.getElementById('monitor-account');
        const forwardSelect = document.getElementById('forward-account');
        
        const makeLabel = (a) => {
            let label = a.id;
            if (a.name && a.name !== a.id) label = `${a.name} (${a.id})`;
            if (a.username) label += ` @${a.username}`;
            if (a.isDefault) label += ' ⭐';
            return label;
        };
        
        if (monitorSelect) {
            monitorSelect.innerHTML = '<option value="">(Default Account ⭐)</option>' + 
                accounts.map(a => `<option value="${a.id}" ${group?.monitorAccount === a.id ? 'selected' : ''}>${makeLabel(a)}</option>`).join('');
        }
        if (forwardSelect) {
            forwardSelect.innerHTML = '<option value="">(Default Account ⭐)</option>' + 
                accounts.map(a => `<option value="${a.id}" ${group?.forwardAccount === a.id ? 'selected' : ''}>${makeLabel(a)}</option>`).join('');
        }
    } catch (e) { /* accounts API not available */ }
    
    // Populate filter checkboxes
    const filterOptions = document.getElementById('filter-options');
    if (filterOptions) {
        const types = [
            { key: 'photos', label: 'Photos', icon: 'ri-image-line' },
            { key: 'videos', label: 'Videos', icon: 'ri-video-line' },
            { key: 'files', label: 'Files / Documents', icon: 'ri-file-line' },
            { key: 'links', label: 'Links', icon: 'ri-link' },
            { key: 'voice', label: 'Voice Messages', icon: 'ri-mic-line' },
            { key: 'gifs', label: 'GIFs', icon: 'ri-file-gif-line' },
            { key: 'stickers', label: 'Stickers', icon: 'ri-emoji-sticker-line' },
            { key: 'urls', label: 'URLs in Text', icon: 'ri-links-line' },
        ];
        
        filterOptions.innerHTML = types.map(t => {
            const checked = filters[t.key] !== false;
            return `
                <label class="flex items-center justify-between p-3 bg-tg-bg rounded-lg cursor-pointer hover:bg-tg-hover transition-colors">
                    <div class="flex items-center gap-3">
                        <i class="${t.icon} text-tg-textSecondary"></i>
                        <span class="text-white text-sm">${t.label}</span>
                    </div>
                    <div class="tg-toggle ${checked ? 'active' : ''}" data-filter="${t.key}" 
                        onclick="this.classList.toggle('active'); event.preventDefault();"></div>
                </label>
            `;
        }).join('');
    }
    
    // Wire history backfill buttons (re-attach each time the modal opens
    // so the closure captures the current group).
    const progressEl = document.getElementById('history-progress');
    if (progressEl) progressEl.classList.add('hidden');
    document.querySelectorAll('[data-history-limit]').forEach(btn => {
        btn.onclick = async () => {
            const raw = btn.dataset.historyLimit;
            const parsed = parseInt(raw, 10);
            const limit = Number.isFinite(parsed) ? parsed : 100;
            if (limit === 0) {
                const msg = i18nT('group.backfill.all_confirm',
                    'Backfill ALL history for this chat? This may take hours and download a lot of data.');
                if (!confirm(msg)) return;
            } else {
                if (!confirm(`Download the last ${limit} messages of "${groupName}" into the queue?`)) return;
            }
            btn.disabled = true;
            try {
                const r = await api.post('/api/history', { groupId, limit });
                if (progressEl) {
                    progressEl.textContent = `Job ${r.jobId} queued — watch the Engine card for progress.`;
                    progressEl.classList.remove('hidden');
                }
                const label = limit === 0 ? 'all' : `${limit} messages`;
                showToast(`History job started (${label})`, 'success');
            } catch (e) {
                showToast(`History failed: ${e.message}`, 'error');
            } finally {
                btn.disabled = false;
            }
        };
    });

    // Show media tab by default
    switchSettingsTab('media');
    modal.classList.remove('hidden');
}

function closeGroupSettings() {
    const modal = document.getElementById('group-modal');
    if (modal) modal.classList.add('hidden');
    currentEditGroup = null;
}

async function saveGroupSettings() {
    if (!currentEditGroup) return;
    
    const enabled = document.getElementById('group-enable-toggle')?.classList.contains('active') ?? true;
    
    // Collect filters
    const filters = {};
    document.querySelectorAll('#filter-options .tg-toggle[data-filter]').forEach(toggle => {
        filters[toggle.dataset.filter] = toggle.classList.contains('active');
    });
    
    // Collect forward settings
    const fwdEnabled = document.getElementById('fwd-enable-toggle')?.classList.contains('active') ?? false;
    const fwdDelete = document.getElementById('fwd-delete-toggle')?.classList.contains('active') ?? false;
    const fwdDest = document.getElementById('fwd-destination')?.value || '';
    
    // Collect account assignments
    const monitorAccount = document.getElementById('monitor-account')?.value || '';
    const forwardAccount = document.getElementById('forward-account')?.value || '';
    
    // Topics
    const topicsEnabled = document.getElementById('topics-enable-toggle')?.classList.contains('active') ?? false;
    const topicsRaw = document.getElementById('topics-ids')?.value || '';
    const topicIds = topicsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);

    const data = {
        name: currentEditGroup.name,
        enabled,
        filters,
        autoForward: {
            enabled: fwdEnabled,
            destination: fwdDest,
            deleteAfterForward: fwdDelete
        },
        topics: {
            enabled: topicsEnabled,
            // When the user enables the filter and supplies a list, treat it
            // as a whitelist (only those topics are monitored). Empty list
            // with the filter on still passes everything through, matching
            // the Topics-tab help text.
            mode: topicsEnabled && topicIds.length > 0 ? 'whitelist' : 'all',
            ids: topicIds,
        },
        monitorAccount: monitorAccount || null,
        forwardAccount: forwardAccount || null
    };
    
    try {
        await api.put(`/api/groups/${currentEditGroup.id}`, data);
        showToast('Group settings saved!', 'success');
        closeGroupSettings();
        await loadGroups();
        if (state.currentPage === 'groups') renderGroupsConfig();
    } catch (e) {
        showToast('Failed to save: ' + e.message, 'error');
    }
}

function switchSettingsTab(tab) {
    document.getElementById('content-media')?.classList.toggle('hidden', tab !== 'media');
    document.getElementById('content-forward')?.classList.toggle('hidden', tab !== 'forward');
    document.getElementById('content-accounts')?.classList.toggle('hidden', tab !== 'accounts');
    document.getElementById('content-topics')?.classList.toggle('hidden', tab !== 'topics');

    document.getElementById('tab-media')?.classList.toggle('active', tab === 'media');
    document.getElementById('tab-forward')?.classList.toggle('active', tab === 'forward');
    document.getElementById('tab-accounts')?.classList.toggle('active', tab === 'accounts');
    document.getElementById('tab-topics')?.classList.toggle('active', tab === 'topics');
}

function toggleGroupEnabled(event) {
    event.preventDefault();
    event.stopPropagation();
    const toggle = document.getElementById('group-enable-toggle');
    if (toggle) toggle.classList.toggle('active');
}

function toggleFwdEnabled(event) {
    event.preventDefault();
    event.stopPropagation();
    const toggle = document.getElementById('fwd-enable-toggle');
    if (toggle) toggle.classList.toggle('active');
}

function toggleFwdDelete(event) {
    event.preventDefault();
    event.stopPropagation();
    const toggle = document.getElementById('fwd-delete-toggle');
    if (toggle) toggle.classList.toggle('active');
}

async function openDestinationPicker() {
    const target = document.getElementById('fwd-destination');
    if (!target) return;

    const root = document.createElement('div');
    root.innerHTML = `
        <input id="dest-search" type="text" placeholder="Search by name…" class="tg-input w-full text-sm mb-3" autofocus>
        <div id="dest-list" class="text-sm overflow-y-auto" style="max-height: 60vh">
            <div class="text-tg-textSecondary p-2">Loading dialogs…</div>
        </div>`;
    const handle = openSheet({ title: 'Pick a destination', content: root, size: 'md' });
    const list = root.querySelector('#dest-list');
    const search = root.querySelector('#dest-search');

    let dialogs = [];
    try {
        const r = await api.get('/api/dialogs');
        dialogs = r.dialogs || [];
    } catch (e) {
        list.innerHTML = `<div class="text-red-400 p-2">Failed to load dialogs: ${escapeHtml(e.message)}</div>`;
        return;
    }

    const render = () => {
        const q = search.value.trim().toLowerCase();
        const filtered = dialogs.filter(d => !q || (d.name || '').toLowerCase().includes(q) || String(d.id).includes(q));
        const presets = `
            <button data-pick="me" type="button" class="w-full text-left px-3 py-2 rounded hover:bg-tg-hover text-tg-text">
                <span class="text-tg-blue">📥 Saved Messages</span>
                <div class="text-[11px] text-tg-textSecondary">value: <code>me</code></div>
            </button>
            <button data-pick="" type="button" class="w-full text-left px-3 py-2 rounded hover:bg-tg-hover text-tg-text">
                Default storage channel
                <div class="text-[11px] text-tg-textSecondary">leave the field empty</div>
            </button>
            <hr class="border-tg-border my-2">`;
        list.innerHTML = presets + filtered.map(d => `
            <button data-pick="${escapeHtml(String(d.id))}" type="button" class="w-full text-left px-3 py-2 rounded hover:bg-tg-hover text-tg-text">
                <div class="truncate">${escapeHtml(d.name || d.id)}</div>
                <div class="text-[11px] text-tg-textSecondary">${escapeHtml(d.type || 'chat')} · <code>${escapeHtml(String(d.id))}</code></div>
            </button>
        `).join('');
        list.querySelectorAll('button[data-pick]').forEach(btn => {
            btn.addEventListener('click', () => {
                target.value = btn.dataset.pick;
                handle.close();
            });
        });
    };

    render();
    search.addEventListener('input', render);
    setTimeout(() => search.focus(), 60);
}

// ============ Delete File ============
async function confirmDeleteFile() {
    const file = state.files[state.currentFileIndex];
    if (!file) return;
    
    if (!confirm(`Delete "${file.name}"?`)) return;
    
    try {
        await api.delete(`/api/file?path=${encodeURIComponent(file.fullPath)}`);
        state.files.splice(state.currentFileIndex, 1);
        Viewer.closeMediaViewer();
        renderMediaGrid();
        showToast('File deleted', 'success');
    } catch (e) {
        showToast('Failed to delete: ' + e.message, 'error');
    }
}

// ============ Media Tabs ============
function setupMediaTabs() {
    document.querySelectorAll('#media-tabs .tab-item').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#media-tabs .tab-item').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.currentFilter = tab.dataset.type || 'all';
            renderMediaGrid();
        });
    });
}

// ============ Utils ============
function setupLazyLoading() {
    state.imageObserver = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            if (e.isIntersecting) {
                const el = e.target;
                el.src = el.dataset.src;
                if (el.tagName === 'VIDEO') {
                    el.preload = 'metadata';
                    el.onloadeddata = () => el.classList.add('loaded');
                } else {
                    el.onload = () => el.classList.add('loaded');
                }
                el.removeAttribute('data-src');
                state.imageObserver.unobserve(el);
            }
        });
    });
}

function setupEventListeners() {
    // Mobile menu
    document.getElementById('menu-btn')?.addEventListener('click', () => {
        document.getElementById('sidebar')?.classList.add('open');
        document.getElementById('sidebar-overlay')?.classList.remove('hidden');
    });
    
    document.getElementById('sidebar-close')?.addEventListener('click', closeSidebar);
    document.getElementById('sidebar-overlay')?.addEventListener('click', closeSidebar);
    
    // Search
    document.getElementById('search-input')?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        document.querySelectorAll('.group-item').forEach(item => {
            const name = item.textContent.toLowerCase();
            item.style.display = name.includes(query) ? '' : 'none';
        });
    });
    
    // Media tabs
    setupMediaTabs();
}

function setupStoriesPanel() {
    const btn = document.getElementById('stories-btn');
    const oldPanel = document.getElementById('stories-panel');
    if (oldPanel) oldPanel.remove(); // legacy markup; now opened as a sheet
    if (!btn) return;

    btn.addEventListener('click', () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <p class="text-tg-textSecondary text-xs mb-2">Pull active Stories from any username your account can see.</p>
            <div class="flex gap-2 mb-3">
                <input id="ss-username" type="text" class="tg-input flex-1 text-sm" placeholder="@username (or numeric id)">
                <button id="ss-fetch" class="tg-btn-secondary px-4 py-1.5 text-sm">Fetch</button>
            </div>
            <div id="ss-list" class="space-y-1.5"></div>
            <p id="ss-result" class="mt-2 text-xs text-tg-textSecondary"></p>`;
        const handle = openSheet({ title: 'Download Stories', content: root, size: 'md' });
        const userInput = root.querySelector('#ss-username');
        const fetchBtn = root.querySelector('#ss-fetch');
        const list = root.querySelector('#ss-list');
        const result = root.querySelector('#ss-result');
        setTimeout(() => userInput.focus(), 60);

        fetchBtn.addEventListener('click', async () => {
            const username = userInput.value.trim();
            if (!username) { showToast('Enter a username', 'warning'); return; }
            list.innerHTML = '<div class="text-tg-textSecondary text-sm">Loading…</div>';
            result.textContent = '';
            try {
                const r = await api.post('/api/stories/user', { username });
                if (!r.stories.length) {
                    list.innerHTML = `<div class="text-tg-textSecondary text-sm">No active stories visible to your account.</div>`;
                    return;
                }
                list.innerHTML = r.stories.map(s => `
                    <label class="flex items-center justify-between bg-tg-bg/40 rounded p-2 cursor-pointer">
                        <div class="text-sm min-w-0">
                            <span class="text-tg-text">#${s.id}</span>
                            <span class="text-tg-textSecondary">${s.media?.type || 'unknown'}${s.caption ? ` — ${escapeHtml(s.caption.slice(0, 40))}` : ''}</span>
                        </div>
                        <input type="checkbox" data-story-id="${s.id}" checked class="w-4 h-4 accent-tg-blue">
                    </label>
                `).join('') + `
                    <button id="ss-go" type="button" class="tg-btn w-full mt-2 text-sm"><i class="ri-download-line mr-1"></i>Download selected</button>`;
                root.querySelector('#ss-go')?.addEventListener('click', async () => {
                    const ids = Array.from(list.querySelectorAll('input[type=checkbox]:checked'))
                        .map(cb => parseInt(cb.dataset.storyId, 10)).filter(Number.isFinite);
                    if (!ids.length) { showToast('Pick at least one story', 'warning'); return; }
                    try {
                        const dl = await api.post('/api/stories/download', { username, storyIds: ids });
                        result.textContent = `Queued ${dl.queued} of ${dl.requested} stories.`;
                        showToast(`Queued ${dl.queued} stories`, 'success');
                        setTimeout(handle.close, 800);
                    } catch (e) {
                        showToast(`Download failed: ${e.message}`, 'error');
                    }
                });
            } catch (e) {
                list.innerHTML = `<div class="text-red-400 text-sm">${escapeHtml(e.message)}</div>`;
            }
        });
    });
}

function highlightThemeButtons() {
    const cur = getTheme();
    document.querySelectorAll('[data-theme-set]').forEach(b => {
        const active = b.dataset.themeSet === cur;
        b.classList.toggle('ring-2', active);
        b.classList.toggle('ring-tg-blue', active);
        b.classList.toggle('text-tg-blue', active);
    });
}

function setupFab() {
    const fab = document.getElementById('fab');
    if (!fab) return;
    fab.addEventListener('click', () => {
        const list = document.createElement('div');
        list.className = 'flex flex-col';
        const items = [
            { icon: 'ri-link-m', label: 'Paste a Telegram link', sub: 'Download from a t.me/... URL', run: () => document.getElementById('paste-url-btn')?.click() },
            { icon: 'ri-camera-line', label: 'Stories', sub: 'Save someone\'s active Stories', run: () => document.getElementById('stories-btn')?.click() },
            { icon: 'ri-user-add-line', label: 'Add Telegram account', sub: 'Phone → OTP → 2FA wizard', run: () => { window.location.href = '/add-account.html'; } },
            { icon: 'ri-chat-3-line', label: 'Browse chats', sub: 'Pick a chat to monitor or backfill', run: () => navigateTo('groups') },
        ];
        for (const it of items) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'flex items-center gap-3 p-3 rounded-lg hover:bg-tg-hover text-left w-full';
            btn.innerHTML = `
                <div class="w-10 h-10 rounded-full bg-tg-blue/15 flex items-center justify-center text-tg-blue">
                    <i class="${it.icon} text-xl"></i>
                </div>
                <div class="min-w-0 flex-1">
                    <div class="text-tg-text font-medium text-sm">${escapeHtml(it.label)}</div>
                    <div class="text-tg-textSecondary text-xs truncate">${escapeHtml(it.sub)}</div>
                </div>`;
            btn.addEventListener('click', () => {
                handle.close();
                setTimeout(it.run, 80); // let the sheet close before triggering the next UI
            });
            list.appendChild(btn);
        }
        const handle = openSheet({ title: 'Quick actions', content: list, size: 'sm' });
    });
}

function setupPasteUrl() {
    const btn = document.getElementById('paste-url-btn');
    const oldPanel = document.getElementById('paste-url-panel');
    if (oldPanel) oldPanel.remove(); // legacy markup; now opened as a sheet
    if (!btn) return;

    btn.addEventListener('click', () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <p class="text-tg-textSecondary text-xs mb-2">One URL per line. Supports <code>t.me/&lt;chan&gt;/&lt;msg&gt;</code>, <code>/c/&lt;id&gt;/&lt;msg&gt;</code>, forum-topic links and <code>tg://</code>.</p>
            <textarea id="ps-input" rows="4" class="tg-input w-full text-sm font-mono" placeholder="https://t.me/example/12345"></textarea>
            <button id="ps-submit" class="tg-btn w-full mt-3"><i class="ri-download-line mr-2"></i>Download</button>
            <p id="ps-result" class="text-xs text-tg-textSecondary mt-2"></p>`;
        const handle = openSheet({ title: 'Download from Telegram link', content: root, size: 'md' });
        const input = root.querySelector('#ps-input');
        const submit = root.querySelector('#ps-submit');
        const resultEl = root.querySelector('#ps-result');
        setTimeout(() => input.focus(), 60);

        submit.addEventListener('click', async () => {
            const text = input.value.trim();
            if (!text) { showToast('Paste at least one Telegram link', 'warning'); return; }
            submit.disabled = true;
            try {
                const r = await api.post('/api/download/url', { url: text });
                const ok = r.results.filter(x => x.ok).length;
                const fail = r.results.length - ok;
                resultEl.textContent = `${ok} queued, ${fail} failed.`;
                r.results.forEach(x => { if (!x.ok) console.warn('paste-url failed:', x.url, x.error); });
                if (ok > 0) {
                    showToast(`Queued ${ok} download${ok > 1 ? 's' : ''}`, 'success');
                    input.value = '';
                    setTimeout(handle.close, 600);
                } else if (fail > 0) {
                    showToast(`All ${fail} URL(s) failed — check console`, 'error');
                }
            } catch (e) {
                showToast(`Request failed: ${e.message}`, 'error');
            } finally {
                submit.disabled = false;
            }
        });
    });
}

function refreshCurrentPage() {
    if (state.currentPage === 'viewer' && state.currentGroupId) {
        state.page = 1;
        loadGroupFiles(state.currentGroupId);
    } else if (state.currentPage === 'viewer') {
        showAllMedia();
    } else if (state.currentPage === 'groups') {
        renderGroupsConfig();
    } else {
        loadGroups();
    }
}

function setupInfiniteScroll() {
    const sentinel = document.getElementById('load-more-sentinel');
    if (!sentinel) return;
    
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !state.loading && state.hasMore && state.currentGroupId) {
            state.page++;
            loadGroupFiles(state.currentGroupId);
        }
    });
    observer.observe(sentinel);
}

async function loadStats() {
    try {
        const stats = await api.get('/api/stats');
        const diskEl = document.getElementById('disk-usage');
        const filesEl = document.getElementById('total-files');
        if (diskEl) diskEl.textContent = stats.diskUsageFormatted || formatBytes(stats.diskUsage || 0);
        if (filesEl) filesEl.textContent = stats.totalFiles || '0';
    } catch (e) {}
}

// ============ Purge Functions ============

/**
 * Delete a specific group -- files, DB, config, photo
 */
async function purgeGroup(groupId, groupName) {
    if (!confirm(`Delete all data for "${groupName}"?\n\nFiles, database records, and configuration will be permanently removed.`)) return;

    try {
        showToast('Deleting...', 'info');
        const result = await api.delete(`/api/groups/${encodeURIComponent(groupId)}/purge`);
        if (result.success) {
            const d = result.deleted;
            showToast(`Deleted "${d.group}" -- ${d.files} files, ${d.dbRecords} records`, 'success');
            await loadGroups();
            renderGroupsList();
            if (state.currentPage === 'groups') renderGroupsConfig();
            if (state.currentGroupId === groupId) showAllMedia();
            loadStats();
        }
    } catch (e) {
        showToast('Failed to delete: ' + e.message, 'error');
    }
}

/**
 * Delete ALL data -- factory reset
 */
async function purgeAll() {
    if (!confirm('Delete ALL data?\n\nAll files, database records, group configurations, and photos will be permanently removed.')) return;
    if (!confirm('Are you sure? This cannot be undone.')) return;

    try {
        showToast('Deleting all data...', 'info');
        const result = await api.delete('/api/purge/all');
        if (result.success) {
            const d = result.deleted;
            showToast(`Deleted all -- ${d.files} files, ${d.dbRecords} records`, 'success');
            state.groups = [];
            state.downloads = [];
            state.files = [];
            state.allFiles = [];
            renderGroupsList();
            if (state.currentPage === 'groups') renderGroupsConfig();
            if (state.currentPage === 'viewer') showAllMedia();
            loadStats();
        }
    } catch (e) {
        showToast('Failed to delete: ' + e.message, 'error');
    }
}

// Start
init();
