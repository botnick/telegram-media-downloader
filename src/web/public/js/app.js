/**
 * Telegram Media Downloader - Main App
 * Uses ES Modules — Complete Implementation
 */

import { state, getGroupName, updateGroupNameCache, isUnresolvedName } from './store.js';
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
import { openSheet, confirmSheet } from './sheet.js';
import { renderChatRow, renderEmptyState, renderRowSkeletons, renderGallerySkeletons } from './components.js';
import { formatRelativeTime } from './utils.js';
import { attachLongPress, attachPullToRefresh } from './gestures.js';
import { initI18n, setLang, getLang, applyToDOM as applyI18n, t as i18nT, tf as i18nTf } from './i18n.js';
import { showBackfillPage, deepLinkFromModal as backfillDeepLink } from './backfill.js';
import { showQueuePage, initQueue } from './queue.js';

// ============ Render coalescing ============
//
// WebSocket events arrive in bursts — a single backfill run can fire
// dozens of download_progress / download_complete messages within a few
// hundred milliseconds, each of which previously triggered a full
// renderGroupsList(). On a 200-group sidebar that was the difference
// between a buttery scroll and the UI freezing for 300 ms at a time.
//
// scheduleRender() collapses repeated requests into a single rAF tick,
// guaranteed to fire no more than once per ~150 ms window. The Map keys
// each render function so distinct renders don't shadow each other.
const _scheduledRenders = new Map(); // fn → { timer, frame }
const RENDER_COALESCE_MS = 150;

function scheduleRender(fn) {
    if (_scheduledRenders.has(fn)) return;
    const handle = {};
    handle.timer = setTimeout(() => {
        handle.frame = requestAnimationFrame(() => {
            _scheduledRenders.delete(fn);
            try { fn(); } catch (e) { console.error('scheduled render', e); }
        });
    }, RENDER_COALESCE_MS);
    _scheduledRenders.set(fn, handle);
}

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
    // Auto-prune / disk-rotator / rescue sweeper all broadcast file_deleted —
    // drop the matching tile from the open gallery if any, otherwise just
    // refresh stats so disk-usage / file-count chip stay current. Without
    // this the gallery shows ghost thumbnails until the next manual reload.
    const dropFileFromView = (m) => {
        const droppedPath = m?.path;
        const droppedId = m?.id;
        if (Array.isArray(state.files) && (droppedPath || droppedId != null)) {
            const before = state.files.length;
            state.files = state.files.filter(f => {
                if (droppedPath && (f.fullPath === droppedPath || f.path === droppedPath)) return false;
                if (droppedId != null && (f.id === droppedId)) return false;
                return true;
            });
            if (state.files.length !== before && state.currentPage === 'viewer') {
                renderMediaGrid();
            }
        }
        loadStats();
    };
    ws.on('file_deleted', dropFileFromView);
    ws.on('bulk_delete', () => { if (state.currentPage === 'viewer') refreshCurrentPage(); loadStats(); });
    ws.on('config_updated', () => { if (state.currentPage === 'settings') Settings.loadSettings(); });
    // Browser notifications. The runtime spreads `{type, payload}` into the
    // outer envelope, so events arrive at the WS as the inner type. Listen
    // for `download_complete` directly — the previous `monitor_event` guard
    // never fired (the spread overwrote the outer type).
    ws.on('download_complete', (m) => {
        Notifications.notifyDownloadComplete(m?.payload || m || {});
    });

    // Server-side broadcast emitted by /api/groups/refresh-info (and any
    // future name-update path). Merge into the canonical name cache and
    // re-render anything that depends on a name. This is what keeps every
    // open tab in sync without a full reload.
    ws.on('groups_refreshed', (m) => {
        const n = updateGroupNameCache(m.updates);
        if (n > 0) {
            renderGroupsList();
            // If the gallery is currently open on a refreshed group, update
            // the page title in place.
            if (state.currentGroupId) {
                const fresh = getGroupName(state.currentGroupId);
                if (fresh && fresh !== state.currentGroup) {
                    state.currentGroup = fresh;
                    const t = document.getElementById('page-title');
                    if (t) t.textContent = fresh;
                }
            }
        }
    });

    // If a download completes for a group whose name we don't know yet,
    // kick off a refresh-info so the next render gets the real label.
    ws.on('download_complete', (m) => {
        const id = m?.payload?.groupId;
        if (id == null) return;
        const cached = state.groupNameCache?.[String(id)];
        const cfg = (state.groups || []).find(g => String(g.id) === String(id));
        const known = cached || (cfg && !isUnresolvedName(cfg.name, id));
        if (!known && !state._resolvingGroups) {
            state._resolvingGroups = true;
            api.post('/api/groups/refresh-info').then(r => {
                if (r?.updates) updateGroupNameCache(r.updates);
            }).catch(() => {}).finally(() => { state._resolvingGroups = false; });
        }
    });

    // Live "this group is downloading" ring state — driven by the same
    // download_progress / download_complete events the engine card uses.
    // Renders are coalesced via scheduleRender() because download_progress
    // can fire 5–10× per second per active job; rendering the entire
    // sidebar that often was a measurable freeze on slower devices.
    state.activeRings = state.activeRings || new Set();
    function markRing(groupId, on) {
        const id = String(groupId);
        const had = state.activeRings.has(id);
        if (on) state.activeRings.add(id); else state.activeRings.delete(id);
        if (had !== on) scheduleRender(renderGroupsList);
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
                scheduleRender(renderGroupsList);
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

    // First-load name resolve — best-effort, fire-and-forget. Catches the
    // case where the SPA boots before the engine has connected (so any
    // paste-link-only or DB-only groups still show as "Unknown chat").
    if (!state._resolvingGroups) {
        state._resolvingGroups = true;
        api.post('/api/groups/refresh-info').then(r => {
            if (r?.updates) updateGroupNameCache(r.updates);
            if (r?.updated > 0) renderGroupsList();
        }).catch(() => {}).finally(() => { state._resolvingGroups = false; });
    }
    // Routes need to be registered BEFORE router.start() so the initial
    // hash dispatch lands on a real handler.
    registerRoutes();
    setupFab();
    // Wire the Queue store + WS handlers eagerly so its in-memory state
    // (and the bottom-nav badge) tracks live downloads even when the user
    // hasn't visited the page yet.
    initQueue();
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
    
    // View-mode toggle in the header — cycles grid → compact → list. Persists
    // in localStorage so the choice survives reloads. The actual layout is
    // CSS-driven (see .media-grid.view-* in index.html).
    const viewModeBtn = document.getElementById('view-mode-btn');
    if (viewModeBtn) {
        const VIEW_MODES = ['grid', 'compact', 'list'];
        const VIEW_ICON = { grid: 'ri-layout-grid-line', compact: 'ri-grid-line', list: 'ri-list-check-2' };
        const applyViewMode = (mode) => {
            state.viewMode = mode;
            try { localStorage.setItem('tgdl-view-mode', mode); } catch {}
            const grid = document.getElementById('media-grid');
            if (grid) {
                grid.classList.remove('view-grid', 'view-compact', 'view-list');
                grid.classList.add(`view-${mode}`);
            }
            const icon = viewModeBtn.querySelector('i');
            if (icon) icon.className = `${VIEW_ICON[mode] || VIEW_ICON.grid} text-xl text-tg-textSecondary`;
        };
        const stored = (() => { try { return localStorage.getItem('tgdl-view-mode'); } catch { return null; } })();
        applyViewMode(VIEW_MODES.includes(stored) ? stored : 'grid');
        viewModeBtn.addEventListener('click', () => {
            const next = VIEW_MODES[(VIEW_MODES.indexOf(state.viewMode) + 1) % VIEW_MODES.length];
            applyViewMode(next);
        });
    }

    // Settings globals
    window.applyPreset = Settings.applyPreset;
    document.getElementById('save-settings')?.addEventListener('click', Settings.saveSettings);
    document.getElementById('save-api-credentials')?.addEventListener('click', Settings.saveApiCredentials);
    document.getElementById('change-password-btn')?.addEventListener('click', Settings.changePassword);
    document.getElementById('logout-btn')?.addEventListener('click', Settings.signOut);
    document.getElementById('proxy-save')?.addEventListener('click', Settings.saveProxy);
    document.getElementById('proxy-test')?.addEventListener('click', Settings.testProxy);
    document.getElementById('setting-path-btn')?.addEventListener('click', () => {
        showToast(i18nT('settings.download.cli_only_toast', 'Use CLI to change path'));
    });

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

    // Allow callers to override the highlighted nav slot independent of the
    // page section (e.g. `#/engine` is a sub-route of the Settings page but
    // the bottom-nav Engine tab should still light up). Falls back to the
    // page name itself when no override is supplied.
    const navKey = params.navKey || page;

    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${navKey}"]`)?.classList.add('active');

    // Bottom-nav active state
    document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.bottom-nav-item[data-nav="${navKey}"]`)?.classList.add('active');

    document.querySelectorAll('#content-area > div[id^="page-"]').forEach(el => el.classList.add('hidden'));
    document.getElementById(`page-${page}`)?.classList.remove('hidden');

    const mediaTabs = document.getElementById('media-tabs');
    if (mediaTabs) mediaTabs.style.display = page === 'viewer' ? '' : 'none';

    closeSidebar();

    if (page === 'settings') {
        Settings.loadSettings();
        initEngine();
        document.getElementById('page-title').textContent = i18nT('settings.page.title', 'Settings');
        document.getElementById('page-subtitle').textContent = i18nT('settings.page.subtitle', 'System Configuration');
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
        document.getElementById('page-title').textContent = i18nT('groups.page.title', 'Manage Groups');
        document.getElementById('page-subtitle').textContent = i18nT('groups.page.subtitle', 'Configure monitoring and filters');
    } else if (page === 'viewer') {
        if (state.currentGroup) {
            document.getElementById('page-title').textContent = state.currentGroup;
        } else {
            showAllMedia();
        }
    } else if (page === 'backfill') {
        document.getElementById('page-title').textContent = i18nT('backfill.page.title', 'Backfill');
        document.getElementById('page-subtitle').textContent = i18nT('backfill.page.subtitle', 'Pull older messages into the queue');
        // Show the page first; backfill module loads server state then renders.
        showBackfillPage(params).catch(e => console.error('backfill page', e));
    } else if (page === 'queue') {
        document.getElementById('page-title').textContent = i18nT('queue.page.title', 'Queue');
        document.getElementById('page-subtitle').textContent = i18nT('queue.page.subtitle', 'Active + pending + recently finished downloads');
        showQueuePage(params).catch(e => console.error('queue page', e));
    }
}

// Register hash routes. Patterns documented in router.js.
function registerRoutes() {
    router.route('/viewer', () => renderPage('viewer'));
    router.route('/viewer/:groupId', ({ params }) => {
        // Open a specific group's gallery — match the existing openGroup()
        // behaviour so the sidebar selection stays consistent.
        renderPage('viewer');
        // Always resolve through the canonical lookup so deep-linking to a
        // group whose name was only just refreshed still picks it up.
        openGroup(params.groupId, getGroupName(params.groupId));
    });
    router.route('/groups', () => renderPage('groups'));
    router.route('/groups/:groupId', ({ params }) => {
        renderPage('groups');
        openGroupSettings(params.groupId, getGroupName(params.groupId));
    });
    router.route('/engine', () => renderPage('settings', { section: 'engine', navKey: 'engine' }));
    router.route('/settings', () => renderPage('settings'));
    router.route('/settings/:section', ({ params }) => renderPage('settings', { section: params.section }));
    router.route('/backfill', () => renderPage('backfill'));
    router.route('/backfill/:groupId', ({ params }) => renderPage('backfill', { groupId: params.groupId }));
    router.route('/queue', () => renderPage('queue'));
    router.route('/queue/:status', ({ params }) => renderPage('queue', { status: params.status }));
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
            title: i18nT('groups.empty.title', 'No groups yet'),
            body: i18nT('groups.empty.body', 'Add a Telegram chat from the Chats page to start downloading.'),
            actionLabel: i18nT('groups.empty.cta', 'Browse chats'),
            actionHref: '#/groups',
        });
        return;
    }

    state.activeRings = state.activeRings || new Set();
    let needsResolve = false;
    const html = sorted.map(g => {
        const id = String(g.downloadId || g.id || g.name);
        // Route every render through the canonical lookup so a name set by
        // the WS `groups_refreshed` handler propagates without a reload.
        const canonical = getGroupName(id, { fallback: i18nT('groups.unknown_chat', 'Unknown chat') });
        // Did the canonical lookup fall through to the placeholder? If so,
        // surface the friendly "Resolving…" subtitle and trigger a one-shot
        // refresh-info below.
        const stillUnresolved = isUnresolvedName(g.name, id)
            && !state.groupNameCache?.[id];
        if (stillUnresolved) needsResolve = true;
        const subtitle = stillUnresolved
            ? i18nTf('groups.resolving', { count: g.totalFiles || 0 }, `Resolving… · ${g.totalFiles || 0} files`)
            : i18nTf('groups.files_size', { count: g.totalFiles || 0, size: g.sizeFormatted || '0 B' }, `${g.totalFiles || 0} files · ${g.sizeFormatted || '0 B'}`);
        const ring = state.activeRings.has(id) ? 'downloading' : null;
        return renderChatRow({
            id,
            name: canonical,
            subtitle,
            avatarType: g.type,
            avatarRing: ring,
            avatarDot: ring ? 'monitor' : null,
            time: g.lastDownloadAt ? formatRelativeTime(g.lastDownloadAt) : '',
            selected: state.currentGroupId === id,
            cog: true,  // cog button → opens Group Settings modal directly
            // Don't ship the (possibly stale) raw name through the dataset —
            // click handlers re-resolve from the canonical store.
        });
    }).join('');

    // Skip the assignment when nothing changed — the user reported the
    // sidebar was "blinking" because we were rebuilding identical HTML on
    // every WS event. innerHTML reassignment tears down + recreates every
    // node, briefly flashing focus + scroll. This guard is the simplest
    // way to make the list smooth without a real DOM-diff lib.
    if (renderGroupsList._lastHtml !== html) {
        renderGroupsList._lastHtml = html;
        list.innerHTML = html;
    }

    // Fire a one-shot resolve in the background. We dedupe with an in-flight
    // flag so a flurry of WS-driven re-renders doesn't hammer the endpoint.
    if (needsResolve && !state._resolvingGroups) {
        state._resolvingGroups = true;
        api.post('/api/groups/refresh-info').then(r => {
            // Server now returns { updates: [{id, name}] } — cache them so
            // every render path picks up the new name immediately. The WS
            // `groups_refreshed` broadcast covers other open tabs.
            if (r?.updates) updateGroupNameCache(r.updates);
            if (r?.updated > 0) loadGroups();
        }).catch(() => {}).finally(() => { state._resolvingGroups = false; });
    }

    // Event delegation — click opens the group viewer; click on the
    // cog button opens Group Settings instead. Names are re-resolved
    // at click time via getGroupName() so a refreshed name wins over
    // whatever the row was rendered with.
    list.querySelectorAll('.chat-row[data-id]').forEach(el => {
        const id = el.dataset.id;
        const fire = () => openGroup(id, getGroupName(id));
        el.addEventListener('click', (ev) => {
            // Cog button takes precedence — short-circuit before the
            // row navigates to the gallery.
            const cogTarget = ev.target.closest?.('[data-action="settings"]');
            if (cogTarget) {
                ev.stopPropagation();
                ev.preventDefault();
                openGroupSettings(id, getGroupName(id));
                return;
            }
            fire();
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fire();
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
    // Always reconcile with the canonical store so the modal/header never
    // show a stale "Unknown" or numeric id when /api/groups/refresh-info
    // (or the WS `groups_refreshed` broadcast) has already filled it in.
    const canonical = getGroupName(groupId, { fallback: groupName });
    state.currentGroup = canonical || groupId;
    state.page = 1;
    state.hasMore = true;
    state.files = [];

    document.getElementById('page-title').textContent = state.currentGroup;
    document.getElementById('page-subtitle').textContent = i18nT('viewer.subtitle.loading', 'Loading...');
    // Mirror the sidebar avatar into the header so the user sees which
    // chat they're inside. Falls back to a coloured initial when there's
    // no profile photo cached yet.
    updateHeaderAvatar(groupId, state.currentGroup);
    navigateTo('viewer');
    loadGroupFiles(groupId);
}

function updateHeaderAvatar(groupId, displayName) {
    const el = document.getElementById('header-avatar');
    if (!el) return;
    const photo = (state.groups || []).find(g => String(g.id) === String(groupId))?.photoUrl
        || `/photos/${encodeURIComponent(String(groupId))}.jpg`;
    // Render a coloured initial as the immediate fallback; if the photo
    // request 404s, the existing src stays empty and the initial shows.
    const initial = (displayName || '?').trim().charAt(0).toUpperCase() || '?';
    const slot = (Math.abs(parseInt(String(groupId).slice(-3)) || 0) % 6) + 1;
    el.className = `tg-avatar tg-avatar-${slot} w-10 h-10 text-lg flex-shrink-0 relative overflow-hidden`;
    el.innerHTML = `<span>${initial}</span><img src="${photo}" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()">`;
}

function showAllMedia() {
    state.currentGroup = null;
    state.currentGroupId = null;
    state.page = 1;
    state.hasMore = true;
    state.files = [];

    document.getElementById('page-title').textContent = i18nT('viewer.all_media.title', 'All Media');
    document.getElementById('page-subtitle').textContent = i18nT('viewer.all_media.subtitle', 'All downloaded files');
    
    const grid = document.getElementById('media-grid');
    if (grid) grid.innerHTML = '';
    
    // Load files from all groups
    loadAllFiles();
}

async function loadAllFiles() {
    try {
        const downloads = await api.get('/api/downloads');
        // Fan-out: 20 sequential awaits used to pay full RTT × 20 (the
        // wait dominated on a slow link). Promise.all collapses that to
        // one round-trip and still respects per-group failures via the
        // .catch — a single 500 from one group can't sink the page.
        const slice = downloads.slice(0, 20);
        const results = await Promise.all(slice.map(group =>
            api.get(`/api/downloads/${encodeURIComponent(group.id)}?page=1&limit=20`)
                .then(res => {
                    if (!res?.files) return [];
                    // Stamp the canonical name (not the possibly-stale
                    // `group.name` from /api/downloads) so any per-file
                    // breadcrumb the viewer renders stays consistent.
                    const canonical = getGroupName(group.id, { fallback: group.name });
                    return res.files.map(f => ({ ...f, groupName: canonical, groupId: group.id }));
                })
                .catch(() => [])
        ));
        const allFiles = results.flat();

        state.files = allFiles;
        renderMediaGrid();
        document.getElementById('page-subtitle').textContent = i18nTf('viewer.subtitle.files', { count: allFiles.length }, `${allFiles.length} files`);
    } catch (e) {
        showToast(i18nT('viewer.error.load', 'Error loading files'), 'error');
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
        const total = res.total || state.files.length;
        document.getElementById('page-subtitle').textContent = i18nTf('viewer.subtitle.files', { count: total }, `${total} files`);
    } catch (e) {
        showToast(i18nT('viewer.error.load', 'Error loading files'), 'error');
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

    // Walk state.files once, keep each file's index in the unfiltered
    // list as `originalIndex`. The viewer uses state.files[index] so the
    // tile must hand it the index in *that* list — using the filtered
    // index would jump to the wrong file once any filter is applied.
    const filteredWithIndex = [];
    state.files.forEach((file, originalIndex) => {
        if (state.currentFilter === 'all' || file.type === state.currentFilter) {
            filteredWithIndex.push({ file, originalIndex });
        }
    });

    if (!state.selected) state.selected = new Set();

    // Time-group the items into Today / Yesterday / This week / Older.
    // Headers are rendered as grid-column: 1 / -1 children so the existing
    // CSS Grid layout keeps each section as a row of full-width tiles.
    const sections = groupFilesByTime(filteredWithIndex);

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
            // Rescue Mode badges. Rescued tiles win over pending (a row
            // shouldn't carry both, but if it does, "rescued" is the more
            // useful signal). Pending shows a remaining-hours estimate +
            // tooltip with the local-time deadline.
            const rescueBadge = renderRescueBadge(file);
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
                ${rescueBadge}
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

/**
 * Render the small Rescue Mode pill for a gallery tile.
 *
 *   rescuedAt  → "🛟 Rescued" (file's source got deleted, kept forever)
 *   pendingUntil + future → "⏳ Xh" (auto-prune countdown)
 *
 * Returns '' when the file isn't in rescue mode at all. Tooltip on the
 * pending pill shows the localised deadline so users can decide whether
 * to pin the file before it sweeps.
 */
function renderRescueBadge(file) {
    if (file && file.rescuedAt) {
        const label = i18nT('viewer.badge.rescued', 'Rescued');
        return `<div class="badge-rescued" title="${escapeHtml(label)}">🛟 ${escapeHtml(label)}</div>`;
    }
    if (file && file.pendingUntil) {
        const dueMs = Number(file.pendingUntil);
        if (Number.isFinite(dueMs) && dueMs > Date.now()) {
            const remHours = Math.max(1, Math.round((dueMs - Date.now()) / 3600000));
            const label = i18nTf('viewer.badge.pending', { h: remHours }, `${remHours}h`);
            const due = new Date(dueMs);
            const tip = i18nTf('viewer.badge.pending_tooltip', { time: due.toLocaleString() },
                `Will be auto-deleted at ${due.toLocaleString()} unless source is deleted.`);
            return `<div class="badge-pending" title="${escapeHtml(tip)}">⏳ ${escapeHtml(label)}</div>`;
        }
    }
    return '';
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
    document.getElementById('selection-count').textContent = i18nTf('viewer.selection.count', { count }, `${count} selected`);
    if (bar) bar.classList.toggle('hidden', count === 0);
}

// Group files into Telegram-style time sections. Accepts an array of
// {file, originalIndex} entries — the index is the position in the
// caller's unfiltered backing list (state.files), preserved so the
// click handler can pass it directly to openMediaViewer() without the
// filtered-vs-unfiltered mismatch that previously opened the wrong
// file when a media-type filter was active.
function groupFilesByTime(items) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
    const buckets = { today: [], yesterday: [], week: [], older: [] };

    items.forEach(({ file, originalIndex }) => {
        const t = file.modified ? Date.parse(file.modified) : NaN;
        if (!Number.isFinite(t)) { buckets.older.push({ file, originalIndex }); return; }
        if (t >= startOfToday) buckets.today.push({ file, originalIndex });
        else if (t >= startOfYesterday) buckets.yesterday.push({ file, originalIndex });
        else if (t >= startOfWeek) buckets.week.push({ file, originalIndex });
        else buckets.older.push({ file, originalIndex });
    });

    const out = [];
    if (buckets.today.length) out.push([i18nT('viewer.section.today', 'Today'), buckets.today]);
    if (buckets.yesterday.length) out.push([i18nT('viewer.section.yesterday', 'Yesterday'), buckets.yesterday]);
    if (buckets.week.length) out.push([i18nT('viewer.section.week', 'Earlier this week'), buckets.week]);
    if (buckets.older.length) out.push([i18nT('viewer.section.older', 'Older'), buckets.older]);
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
            showToast(i18nTf('viewer.search.failed', { msg: e.message }, `Search failed: ${e.message}`), 'error');
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
        if (!(await confirmSheet({
            title: i18nT('viewer.bulk.title', 'Delete selected files?'),
            message: i18nTf('viewer.bulk.confirm', { count: paths.length }, `Delete ${paths.length} file(s)? This cannot be undone.`),
            confirmLabel: i18nT('common.delete', 'Delete'),
            danger: true,
        }))) return;
        try {
            const r = await api.post('/api/downloads/bulk-delete', { paths });
            showToast(i18nTf('viewer.bulk.deleted', { count: r.unlinked }, `Deleted ${r.unlinked} files`), 'success');
            state.selected.clear();
            // Drop deleted entries from the current view
            const set = new Set(paths);
            state.files = (state.files || []).filter(f => !set.has(f.fullPath));
            if (state.savedFiles) state.savedFiles = state.savedFiles.filter(f => !set.has(f.fullPath));
            updateSelectionBar();
            renderMediaGrid();
        } catch (e) {
            showToast(i18nTf('viewer.bulk.failed', { msg: e.message }, `Delete failed: ${e.message}`), 'error');
        }
    });
}

// ============ Groups Config Page ============
async function renderGroupsConfig() {
    const list = document.getElementById('groups-config-list');
    if (!list) return;
    
    list.innerHTML = `<div class="text-center py-8 text-tg-textSecondary">${escapeHtml(i18nT('groups.loading_dialogs', 'Loading dialogs...'))}</div>`;

    try {
        const res = await api.get('/api/dialogs');
        const dialogs = res.dialogs || res || [];
        state.allDialogs = dialogs;
        renderDialogsList(dialogs);
    } catch (e) {
        list.innerHTML = `<div class="text-center py-8 text-red-400">${escapeHtml(i18nT('groups.load_failed', 'Failed to load dialogs'))}</div>`;
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
        list.innerHTML = `<div class="text-center py-8 text-tg-textSecondary">${escapeHtml(i18nT('groups.none_found', 'No groups found'))}</div>`;
        return;
    }

    list.innerHTML = filtered.map(d => {
        const typeLabel = d.type === 'channel' ? i18nT('groups.type.channel', 'Channel')
            : d.type === 'group' ? i18nT('groups.type.group', 'Group')
            : d.type === 'bot' ? i18nT('groups.type.bot', 'Bot')
            : d.type === 'user' ? i18nT('groups.type.user', 'Direct message') : i18nT('groups.type.dialog', 'Dialog');
        const subParts = [typeLabel];
        if (d.members) subParts.push(i18nTf('groups.members', { count: d.members }, `${d.members} members`));
        if (d.archived) subParts.push(i18nT('groups.archived', 'archived'));

        const statusPill = (d.inConfig && d.enabled)
            ? { label: i18nT('groups.status.active', 'Active'), kind: 'active' }
            : (d.inConfig && !d.enabled)
                ? { label: i18nT('groups.status.paused', 'Paused'), kind: 'paused' }
                : { label: i18nT('groups.status.add', 'Add'), kind: 'add' };

        // Canonical name — for dialogs the d.name is usually authoritative
        // (Telegram-side title) but route through getGroupName so a config
        // override (custom label) wins when present.
        const dispName = getGroupName(d.id, { fallback: d.name || d.title });
        return renderChatRow({
            id: d.id,
            name: dispName,
            avatarType: d.type,
            subtitle: subParts.join(' · '),
            statusPill,
        });
    }).join('');

    // Click anywhere on the row → open the group settings sheet for that
    // dialog. Re-resolve through the canonical store at click time.
    list.querySelectorAll('.chat-row[data-id]').forEach(el => {
        const fire = () => openGroupSettings(el.dataset.id, getGroupName(el.dataset.id));
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
    // Always resolve via the canonical store — callers may pass nothing
    // (deep-link router) or a stale label (sidebar dataset).
    const canonical = getGroupName(groupId, { fallback: groupName });
    currentEditGroup = { id: groupId, name: canonical };
    groupName = canonical;
    
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
        
        const defaultLabel = i18nT('group.accounts.default_option_star', '(Default Account ⭐)');
        if (monitorSelect) {
            monitorSelect.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>` +
                accounts.map(a => `<option value="${a.id}" ${group?.monitorAccount === a.id ? 'selected' : ''}>${makeLabel(a)}</option>`).join('');
        }
        if (forwardSelect) {
            forwardSelect.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>` +
                accounts.map(a => `<option value="${a.id}" ${group?.forwardAccount === a.id ? 'selected' : ''}>${makeLabel(a)}</option>`).join('');
        }
    } catch (e) { /* accounts API not available */ }
    
    // Populate filter checkboxes
    const filterOptions = document.getElementById('filter-options');
    if (filterOptions) {
        const types = [
            { key: 'photos', label: i18nT('group.filter.photos', 'Photos'), icon: 'ri-image-line' },
            { key: 'videos', label: i18nT('group.filter.videos', 'Videos'), icon: 'ri-video-line' },
            { key: 'files', label: i18nT('group.filter.files', 'Files / Documents'), icon: 'ri-file-line' },
            { key: 'links', label: i18nT('group.filter.links', 'Links'), icon: 'ri-link' },
            { key: 'voice', label: i18nT('group.filter.voice', 'Voice Messages'), icon: 'ri-mic-line' },
            { key: 'gifs', label: i18nT('group.filter.gifs', 'GIFs'), icon: 'ri-file-gif-line' },
            { key: 'stickers', label: i18nT('group.filter.stickers', 'Stickers'), icon: 'ri-emoji-sticker-line' },
            { key: 'urls', label: i18nT('group.filter.urls', 'URLs in Text'), icon: 'ri-links-line' },
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
                        onclick="event.preventDefault(); event.stopPropagation(); this.classList.toggle('active');"></div>
                </label>
            `;
        }).join('');
    }
    
    // Wire history backfill quick-shortcut buttons. Clicking a preset
    // closes the modal and deep-links to #/backfill/<id> with the chat
    // preselected and the limit applied — the dedicated Backfill page
    // takes it from there (confirm + start). This keeps the modal as a
    // discoverability handle while moving the real surface elsewhere.
    const progressEl = document.getElementById('history-progress');
    if (progressEl) progressEl.classList.add('hidden');
    document.querySelectorAll('[data-history-limit]').forEach(btn => {
        btn.onclick = () => {
            const raw = btn.dataset.historyLimit;
            const parsed = parseInt(raw, 10);
            const limit = Number.isFinite(parsed) ? parsed : 100;
            closeGroupSettings();
            backfillDeepLink(groupId, limit);
        };
    });

    // Rescue Mode: populate chip group + retention input. Mode defaults to
    // 'auto' (follow global cfg.rescue.enabled). Chip click toggles active
    // class — the value reads back in saveGroupSettings().
    const rescueMode = (group?.rescueMode === 'on' || group?.rescueMode === 'off' || group?.rescueMode === 'auto')
        ? group.rescueMode : 'auto';
    document.querySelectorAll('#setting-rescue-mode .rescue-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.rescueValue === rescueMode);
        btn.onclick = (ev) => {
            ev.preventDefault();
            document.querySelectorAll('#setting-rescue-mode .rescue-chip').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
    });
    const rescueHoursEl = document.getElementById('setting-rescue-hours');
    if (rescueHoursEl) rescueHoursEl.value = group?.rescueRetentionHours || '';

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

    // Rescue Mode read-back. Active chip wins; default to 'auto' if none
    // (shouldn't happen, but defensive). Hours is optional — empty string
    // sends null so the server falls back to the global retention setting.
    const activeRescueChip = document.querySelector('#setting-rescue-mode .rescue-chip.active');
    const rescueMode = activeRescueChip?.dataset.rescueValue || 'auto';
    const rescueHoursRaw = document.getElementById('setting-rescue-hours')?.value;
    const rescueHoursParsed = parseInt(rescueHoursRaw, 10);
    const rescueRetentionHours = Number.isFinite(rescueHoursParsed) && rescueHoursParsed > 0
        ? rescueHoursParsed : null;

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
        forwardAccount: forwardAccount || null,
        rescueMode,
        rescueRetentionHours,
    };
    
    try {
        await api.put(`/api/groups/${currentEditGroup.id}`, data);
        showToast(i18nT('group.modal.saved_toast', 'Group settings saved!'), 'success');
        closeGroupSettings();
        await loadGroups();
        if (state.currentPage === 'groups') renderGroupsConfig();
    } catch (e) {
        showToast(i18nTf('group.modal.save_failed', { msg: e.message }, 'Failed to save: ' + e.message), 'error');
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
        <input id="dest-search" type="text" placeholder="${escapeHtml(i18nT('picker.search_placeholder', 'Search by name…'))}" class="tg-input w-full text-sm mb-3" autofocus>
        <div id="dest-list" class="text-sm overflow-y-auto" style="max-height: 60vh">
            <div class="text-tg-textSecondary p-2">${escapeHtml(i18nT('picker.loading', 'Loading dialogs…'))}</div>
        </div>`;
    const handle = openSheet({ title: i18nT('picker.title', 'Pick a destination'), content: root, size: 'md' });
    const list = root.querySelector('#dest-list');
    const search = root.querySelector('#dest-search');

    let dialogs = [];
    try {
        const r = await api.get('/api/dialogs');
        dialogs = r.dialogs || [];
    } catch (e) {
        list.innerHTML = `<div class="text-red-400 p-2">${escapeHtml(i18nTf('picker.failed', { msg: e.message }, `Failed to load dialogs: ${e.message}`))}</div>`;
        return;
    }

    const render = () => {
        const q = search.value.trim().toLowerCase();
        const filtered = dialogs.filter(d => !q || (d.name || '').toLowerCase().includes(q) || String(d.id).includes(q));
        const presets = `
            <button data-pick="me" type="button" class="w-full text-left px-3 py-2 rounded hover:bg-tg-hover text-tg-text">
                <span class="text-tg-blue">${escapeHtml(i18nT('picker.saved_messages', '📥 Saved Messages'))}</span>
                <div class="text-[11px] text-tg-textSecondary">${escapeHtml(i18nT('picker.saved_messages_help', 'value: '))}<code>me</code></div>
            </button>
            <button data-pick="" type="button" class="w-full text-left px-3 py-2 rounded hover:bg-tg-hover text-tg-text">
                ${escapeHtml(i18nT('picker.default_storage', 'Default storage channel'))}
                <div class="text-[11px] text-tg-textSecondary">${escapeHtml(i18nT('picker.default_storage_help', 'leave the field empty'))}</div>
            </button>
            <hr class="border-tg-border my-2">`;
        list.innerHTML = presets + filtered.map(d => `
            <button data-pick="${escapeHtml(String(d.id))}" type="button" class="w-full text-left px-3 py-2 rounded hover:bg-tg-hover text-tg-text">
                <div class="truncate">${escapeHtml(getGroupName(d.id, { fallback: d.name || d.title }))}</div>
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

    if (!(await confirmSheet({
        title: i18nT('viewer.delete.title', 'Delete file?'),
        message: i18nTf('viewer.delete.confirm', { name: file.name }, `Delete "${file.name}"?`),
        confirmLabel: i18nT('common.delete', 'Delete'),
        danger: true,
    }))) return;

    try {
        await api.delete(`/api/file?path=${encodeURIComponent(file.fullPath)}`);
        state.files.splice(state.currentFileIndex, 1);
        Viewer.closeMediaViewer();
        renderMediaGrid();
        showToast(i18nT('viewer.delete.success', 'File deleted'), 'success');
    } catch (e) {
        showToast(i18nTf('viewer.delete.failed', { msg: e.message }, 'Failed to delete: ' + e.message), 'error');
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
    
    // Sidebar quick-filter — matches the sidebar `.chat-row` markup that
    // renderGroupsList() actually produces. The legacy `.group-item`
    // selector predated the Telegram-style row rewrite and silently
    // matched zero nodes, so the box typed but the list never filtered.
    // We resolve names through getGroupName() so a stale row rendered
    // before /api/groups/refresh-info filled in the canonical label
    // still matches when the user types it.
    document.getElementById('search-input')?.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        document.querySelectorAll('#groups-list .chat-row').forEach(item => {
            const id = item.dataset?.id || '';
            const canonical = id ? getGroupName(id, { fallback: '' }) : '';
            const text = (canonical || item.textContent || '').toLowerCase();
            const idMatch = id && id.toLowerCase().includes(query);
            item.style.display = (!query || text.includes(query) || idMatch) ? '' : 'none';
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
            <p class="text-tg-textSecondary text-xs mb-2">${escapeHtml(i18nT('stories.help', 'Pull active Stories from any username your account can see.'))}</p>
            <div class="flex gap-2 mb-3">
                <input id="ss-username" type="text" class="tg-input flex-1 text-sm" placeholder="${escapeHtml(i18nT('stories.username_placeholder', '@username (or numeric id)'))}">
                <button id="ss-fetch" class="tg-btn-secondary px-4 py-1.5 text-sm">${escapeHtml(i18nT('stories.fetch', 'Fetch'))}</button>
            </div>
            <div id="ss-list" class="space-y-1.5"></div>
            <p id="ss-result" class="mt-2 text-xs text-tg-textSecondary"></p>`;
        const handle = openSheet({ title: i18nT('stories.title', 'Download Stories'), content: root, size: 'md' });
        const userInput = root.querySelector('#ss-username');
        const fetchBtn = root.querySelector('#ss-fetch');
        const list = root.querySelector('#ss-list');
        const result = root.querySelector('#ss-result');
        setTimeout(() => userInput.focus(), 60);

        fetchBtn.addEventListener('click', async () => {
            const username = userInput.value.trim();
            if (!username) { showToast(i18nT('stories.warn_username', 'Enter a username'), 'warning'); return; }
            list.innerHTML = `<div class="text-tg-textSecondary text-sm">${escapeHtml(i18nT('stories.loading', 'Loading…'))}</div>`;
            result.textContent = '';
            try {
                const r = await api.post('/api/stories/user', { username });
                if (!r.stories.length) {
                    list.innerHTML = `<div class="text-tg-textSecondary text-sm">${escapeHtml(i18nT('stories.none_visible', 'No active stories visible to your account.'))}</div>`;
                    return;
                }
                const unknownLbl = i18nT('stories.unknown_type', 'unknown');
                list.innerHTML = r.stories.map(s => `
                    <label class="flex items-center justify-between bg-tg-bg/40 rounded p-2 cursor-pointer">
                        <div class="text-sm min-w-0">
                            <span class="text-tg-text">#${s.id}</span>
                            <span class="text-tg-textSecondary">${escapeHtml(s.media?.type || unknownLbl)}${s.caption ? ` — ${escapeHtml(s.caption.slice(0, 40))}` : ''}</span>
                        </div>
                        <input type="checkbox" data-story-id="${s.id}" checked class="w-4 h-4 accent-tg-blue">
                    </label>
                `).join('') + `
                    <button id="ss-go" type="button" class="tg-btn w-full mt-2 text-sm"><i class="ri-download-line mr-1"></i>${escapeHtml(i18nT('stories.download_selected', 'Download selected'))}</button>`;
                root.querySelector('#ss-go')?.addEventListener('click', async () => {
                    const ids = Array.from(list.querySelectorAll('input[type=checkbox]:checked'))
                        .map(cb => parseInt(cb.dataset.storyId, 10)).filter(Number.isFinite);
                    if (!ids.length) { showToast(i18nT('stories.warn_pick', 'Pick at least one story'), 'warning'); return; }
                    try {
                        const dl = await api.post('/api/stories/download', { username, storyIds: ids });
                        result.textContent = i18nTf('stories.queued_result', { ok: dl.queued, total: dl.requested }, `Queued ${dl.queued} of ${dl.requested} stories.`);
                        showToast(i18nTf('stories.queued_toast', { n: dl.queued }, `Queued ${dl.queued} stories`), 'success');
                        setTimeout(handle.close, 800);
                    } catch (e) {
                        showToast(i18nTf('stories.download_failed', { msg: e.message }, `Download failed: ${e.message}`), 'error');
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
            { icon: 'ri-link-m', label: i18nT('fab.paste_link', 'Paste a Telegram link'), sub: i18nT('fab.paste_link_sub', 'Download from a t.me/... URL'), run: () => document.getElementById('paste-url-btn')?.click() },
            { icon: 'ri-camera-line', label: i18nT('fab.stories', 'Stories'), sub: i18nT('fab.stories_sub', "Save someone's active Stories"), run: () => document.getElementById('stories-btn')?.click() },
            { icon: 'ri-user-add-line', label: i18nT('fab.add_account', 'Add Telegram account'), sub: i18nT('fab.add_account_sub', 'Phone → OTP → 2FA wizard'), run: () => { window.location.href = '/add-account.html'; } },
            { icon: 'ri-chat-3-line', label: i18nT('fab.browse_chats', 'Browse chats'), sub: i18nT('fab.browse_chats_sub', 'Pick a chat to monitor or backfill'), run: () => navigateTo('groups') },
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
        const handle = openSheet({ title: i18nT('fab.actions', 'Quick actions'), content: list, size: 'sm' });
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
            <p class="text-tg-textSecondary text-xs mb-2">${i18nT('link.help_html', 'One URL per line. Supports <code>t.me/&lt;chan&gt;/&lt;msg&gt;</code>, <code>/c/&lt;id&gt;/&lt;msg&gt;</code>, forum-topic links and <code>tg://</code>.')}</p>
            <textarea id="ps-input" rows="4" class="tg-input w-full text-sm font-mono" placeholder="${escapeHtml(i18nT('link.placeholder', 'https://t.me/example/12345'))}"></textarea>
            <button id="ps-submit" class="tg-btn w-full mt-3"><i class="ri-download-line mr-2"></i>${escapeHtml(i18nT('link.download', 'Download'))}</button>
            <p id="ps-result" class="text-xs text-tg-textSecondary mt-2"></p>`;
        const handle = openSheet({ title: i18nT('link.title', 'Download from Telegram link'), content: root, size: 'md' });
        const input = root.querySelector('#ps-input');
        const submit = root.querySelector('#ps-submit');
        const resultEl = root.querySelector('#ps-result');
        setTimeout(() => input.focus(), 60);

        submit.addEventListener('click', async () => {
            const text = input.value.trim();
            if (!text) { showToast(i18nT('link.warn_empty', 'Paste at least one Telegram link'), 'warning'); return; }
            submit.disabled = true;
            try {
                const r = await api.post('/api/download/url', { url: text });
                const ok = r.results.filter(x => x.ok).length;
                const fail = r.results.length - ok;
                resultEl.textContent = i18nTf('link.result', { ok, fail }, `${ok} queued, ${fail} failed.`);
                r.results.forEach(x => { if (!x.ok) console.warn('paste-url failed:', x.url, x.error); });
                if (ok > 0) {
                    const key = ok > 1 ? 'link.queued_many' : 'link.queued_one';
                    showToast(i18nTf(key, { n: ok }, `Queued ${ok} download${ok > 1 ? 's' : ''}`), 'success');
                    input.value = '';
                    setTimeout(handle.close, 600);
                } else if (fail > 0) {
                    showToast(i18nTf('link.all_failed', { n: fail }, `All ${fail} URL(s) failed — check console`), 'error');
                }
            } catch (e) {
                showToast(i18nTf('link.req_failed', { msg: e.message }, `Request failed: ${e.message}`), 'error');
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
    // Re-resolve through the canonical store so the confirm/toast messages
    // match what the rest of the UI shows.
    groupName = getGroupName(groupId, { fallback: groupName });
    if (!(await confirmSheet({
        title: i18nT('purge.group.title', 'Purge group data?'),
        message: i18nTf('purge.group.confirm', { name: groupName }, `Delete all data for "${groupName}"?\n\nFiles, database records, and configuration will be permanently removed.`),
        confirmLabel: i18nT('settings.danger.purge_all', 'Purge All Data'),
        danger: true,
    }))) return;

    try {
        showToast(i18nT('purge.group.deleting', 'Deleting...'), 'info');
        const result = await api.delete(`/api/groups/${encodeURIComponent(groupId)}/purge`);
        if (result.success) {
            const d = result.deleted;
            showToast(i18nTf('purge.group.success', { name: d.group, files: d.files, records: d.dbRecords }, `Deleted "${d.group}" -- ${d.files} files, ${d.dbRecords} records`), 'success');
            await loadGroups();
            renderGroupsList();
            if (state.currentPage === 'groups') renderGroupsConfig();
            // String() coerce: state.currentGroupId can be a number (set by
            // openGroup with a freshly-parsed id) while `groupId` here is
            // the raw value from the click handler — usually a string. The
            // strict-equal check used to slip past, so the gallery would
            // keep showing files for a group that just got purged.
            if (String(state.currentGroupId) === String(groupId)) showAllMedia();
            loadStats();
        }
    } catch (e) {
        showToast(i18nTf('purge.group.failed', { msg: e.message }, 'Failed to delete: ' + e.message), 'error');
    }
}

/**
 * Delete ALL data -- factory reset
 */
async function purgeAll() {
    if (!(await confirmSheet({
        title: i18nT('purge.all.title', 'Purge ALL data?'),
        message: i18nT('purge.all.confirm1', 'Delete ALL data?\n\nAll files, database records, group configurations, and photos will be permanently removed.'),
        confirmLabel: i18nT('settings.danger.purge_all', 'Purge All Data'),
        danger: true,
    }))) return;
    if (!(await confirmSheet({
        title: i18nT('purge.all.title2', 'Are you absolutely sure?'),
        message: i18nT('purge.all.confirm2', 'Are you sure? This cannot be undone.'),
        confirmLabel: i18nT('common.confirm', 'Confirm'),
        danger: true,
    }))) return;

    try {
        showToast(i18nT('purge.all.deleting', 'Deleting all data...'), 'info');
        const result = await api.delete('/api/purge/all');
        if (result.success) {
            const d = result.deleted;
            showToast(i18nTf('purge.all.success', { files: d.files, records: d.dbRecords }, `Deleted all -- ${d.files} files, ${d.dbRecords} records`), 'success');
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
        showToast(i18nTf('purge.group.failed', { msg: e.message }, 'Failed to delete: ' + e.message), 'error');
    }
}

// Start
init();
