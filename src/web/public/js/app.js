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
import { attachPullToRefresh } from './gestures.js';
import { setupGallerySelect, exitSelectMode, repaintSelection, selectAllVisible } from './gallery-select.js';
import { initI18n, setLang, getLang, applyToDOM as applyI18n, t as i18nT, tf as i18nTf } from './i18n.js';
import { showBackfillPage, deepLinkFromModal as backfillDeepLink, stopBackfillPage } from './backfill.js';
import * as Fonts from './fonts.js';
import { showQueuePage, initQueue } from './queue.js';
import { initHeaderMobile, pushLogToNotify } from './header-mobile.js';
import { setupGalleryContextMenu } from './gallery-context.js';
import { setupDragDropLink } from './dragdrop-link.js';
import { setupMiniPlayer, shrinkToMini, dismiss as dismissMiniPlayer } from './mini-player.js';
import { wireChangelogTrigger } from './changelog-viewer.js';
import * as WakeLock from './wake-lock.js';

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
    // Resolve the session role BEFORE the SPA registers any UI — it drives
    // the body[data-role] CSS gate (admin-only DOM) and the router redirect
    // for guest sessions trying to deep-link into admin routes. Falls back
    // to admin on any failure so a transient network blip never accidentally
    // hides UI for a real admin.
    try {
        const ac = await api.get('/api/auth_check');
        state.role = ac?.role || null;
    } catch {
        state.role = null;
    }
    document.body.dataset.role = state.role || '';
    // Mirror to a window global for router.js (which can't import store
    // without creating a cycle).
    try { window.__tgdlRole = state.role; } catch {}
    // Header role pill — only shown for guest sessions to keep the chrome
    // unchanged for the existing single-admin-user case.
    const rolePill = document.getElementById('role-pill');
    if (rolePill) {
        if (state.role === 'guest') {
            rolePill.textContent = 'Guest';
            rolePill.classList.remove('hidden', 'role-admin');
            rolePill.classList.add('role-guest');
            rolePill.dataset.i18n = 'header.role.guest';
        } else {
            rolePill.classList.add('hidden');
        }
    }

    setupEventListeners();
    setupLazyLoading();
    setupInfiniteScroll();

    Viewer.setupViewerEvents();

    // Expose to window for HTML onclick handlers — pulled UP from after
    // the await chain below because inline `onclick="navigateTo('…')"` on
    // the sidebar nav-items would throw `ReferenceError: navigateTo is
    // not defined` whenever loadGroups() / loadStats() / refresh-info
    // rejected before the original assignment ran. Setting them here means
    // the bindings are live as soon as the module finishes its synchronous
    // bootstrap, regardless of any later network failure. Keep this list
    // in sync with `_setupSidebarGroupsCollapse` and `setupFab` further down.
    window.navigateTo = navigateTo;
    window.openGroup = openGroup;
    window.showAllMedia = showAllMedia;
    window.openMediaViewer = Viewer.openMediaViewer;
    window.Viewer = Viewer;
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
    // Mini-player public surface — viewer.js can opt into the dock-on-
    // close behaviour by calling `window.tgdlShrinkToMini()` from the
    // modal close path. Kept on `window` (instead of imported) so the
    // viewer module stays free of a back-edge cycle to app.js.
    window.tgdlShrinkToMini = shrinkToMini;
    window.tgdlDismissMiniPlayer = dismissMiniPlayer;

    // Live updates from the server (engine state, downloads, purges).
    ws.connect();
    ws.on('*', handleEngineWsMessage);
    // Realtime log channel — every server-side `log()` call broadcasts
    // a `log` message. The notification bell only surfaces warn / error
    // entries; the maintenance Logs page subscribes to all of them.
    ws.on('log', (m) => { try { pushLogToNotify(m); } catch {} });
    ws.on('group_purged', () => loadGroups());
    ws.on('purge_all', () => { loadGroups(); loadStats(); });
    // Auto-prune / disk-rotator / rescue sweeper all broadcast file_deleted —
    // drop the matching tile from the open gallery if any, otherwise just
    // refresh stats so disk-usage / file-count chip stay current. We do
    // this in two surgical moves to avoid a full grid re-render (which on
    // a thousand-tile gallery is a visible jank): mutate state.files +
    // remove the single matching DOM node by data-path. The originalIndex
    // attribute on remaining tiles stays valid because we never re-index
    // after removal — the viewer's index lookup falls back to filename
    // resolution if it ever becomes stale.
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
                _removeTileFromGrid({ path: droppedPath, id: droppedId });
                _renderedFileCount = state.files.length;
            }
        }
        loadStats();
    };
    ws.on('file_deleted', dropFileFromView);
    ws.on('bulk_delete', () => { if (state.currentPage === 'viewer') refreshCurrentPage(); loadStats(); });
    ws.on('config_updated', () => { if (state.currentPage === 'settings') Settings.loadSettings(); });
    // NSFW review tool — server fires `nsfw_progress` every batch and
    // `nsfw_done` when the scan finishes. We refresh the Maintenance
    // status line if the user is looking at it (so the progress bar
    // moves), and toast + browser-notify on completion regardless of
    // page so the admin doesn't miss a long background scan.
    ws.on('nsfw_progress', () => {
        if (state.currentPage === 'settings') {
            import('./nsfw-ui.js').then(m => m.refreshNsfwStatus()).catch(() => {});
        }
    });
    ws.on('nsfw_done', (m) => {
        if (state.currentPage === 'settings') {
            import('./nsfw-ui.js').then(m2 => m2.refreshNsfwStatus()).catch(() => {});
        }
        const candidates = m?.candidates ?? 0;
        const msg = candidates > 0
            ? i18nTf('maintenance.nsfw.done_with_candidates',
                { n: candidates }, `Scan done — ${candidates} possibly not 18+`)
            : i18nT('maintenance.nsfw.done_clean', 'Scan done — library is clean.');
        showToast(msg, 'info', 8000);
        try { Notifications.notifyGeneric?.('NSFW scan finished', msg); } catch {}
    });
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
    // Endpoint is now fire-and-forget — the response is `{started:true}`,
    // not a name list. The canonical update path is the `groups_refreshed`
    // WS broadcast wired above (line 190); keeping the call here just
    // triggers it. 409 ALREADY_RUNNING is expected when several rows
    // come in at once; the in-flight job will broadcast for everyone.
    ws.on('download_complete', (m) => {
        const id = m?.payload?.groupId;
        if (id == null) return;
        const cached = state.groupNameCache?.[String(id)];
        const cfg = (state.groups || []).find(g => String(g.id) === String(id));
        const known = cached || (cfg && !isUnresolvedName(cfg.name, id));
        if (!known && !state._resolvingGroups) {
            state._resolvingGroups = true;
            api.post('/api/groups/refresh-info')
                .catch(() => {})
                .finally(() => { state._resolvingGroups = false; });
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
        // Wake-lock follows the active-rings count: any active ring → keep
        // the screen awake; queue drained → release. Feature-detected
        // inside wake-lock.js so unsupported browsers no-op silently.
        state.activeJobsCount = state.activeRings.size;
        WakeLock.acquireIfActive(state.activeJobsCount);
        WakeLock.releaseIfIdle(state.activeJobsCount);
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

    // Admin-only modules: skip for guests so we don't fire 403s into the
    // console for endpoints they're never meant to reach. Each gated
    // module touches one or more admin endpoints (status bar = engine
    // state + queue counters; onboarding = monitor hint; group-name
    // resolver = POST /api/groups/refresh-info).
    const isAdmin = state.role === 'admin';
    if (isAdmin) {
        initStatusBar();
        initOnboarding();
        ws.on('config_updated', refreshOnboarding);
        ws.on('monitor_state', refreshOnboarding);
    }

    // Global keyboard shortcuts (press ? for the cheatsheet).
    initShortcuts();

    // Mobile-friendly header chrome: overflow ⋮ menu (collapses paste-link /
    // stories / view-mode / refresh on <640 px viewports) + notification
    // bell that surfaces server-side warn/error events without making the
    // operator open the maintenance Logs page.
    initHeaderMobile();

    // v2.6 polish — right-click context menu on gallery tiles, drag-drop
    // t.me URL onto the dashboard, mini-player handle, in-app changelog
    // viewer, screen wake-lock during downloads. Each module feature-
    // detects so unsupported browsers silently no-op.
    setupGalleryContextMenu();
    setupDragDropLink();
    setupMiniPlayer();
    wireChangelogTrigger();
    // Wake-lock visibility refresh — browser auto-releases on tab hide,
    // re-acquire when the tab comes back if jobs are still in flight.
    WakeLock.attachVisibilityRefresh(() => state.activeJobsCount || 0);

    await loadGroups();
    await loadStats();

    // First-load name resolve — admin-only because it POSTs and forces a
    // refresh side-effect. Guests see whatever names landed in the DB on
    // the last admin-side resolve. Endpoint is fire-and-forget; the
    // `groups_refreshed` broadcast handler above merges the resolved
    // names into the canonical cache when the job finishes.
    if (isAdmin && !state._resolvingGroups) {
        state._resolvingGroups = true;
        api.post('/api/groups/refresh-info')
            .catch(() => {})
            .finally(() => { state._resolvingGroups = false; });
    }
    // Routes need to be registered BEFORE router.start() so the initial
    // hash dispatch lands on a real handler.
    registerRoutes();
    setupFab();
    _setupSidebarGroupsCollapse();
    _setupSidebarMaintenanceCollapse();
    // Wire the Queue store + WS handlers eagerly so its in-memory state
    // (and the bottom-nav badge) tracks live downloads even when the user
    // hasn't visited the page yet. Queue is admin-only — guests never see
    // the page or the badge, so skip the snapshot fetch.
    if (isAdmin) initQueue();
    router.start();

    // Window bindings that depend on functions defined LATER in the
    // module. Pulled out from the main `window.*` block above (which
    // covers everything declared before init()) — these all live in the
    // setupFab / Settings / Viewer / etc. closures further down. Safe to
    // assign post-await because no inline onclick reaches them before
    // the operator clicks something.
    window.toggleFwdDelete = toggleFwdDelete;
    window.openDestinationPicker = openDestinationPicker;
    window.filterDialogs = filterDialogs;
    window.filterSidebarGroups = filterSidebarGroups;
    window.showToast = showToast;
    window.purgeGroup = purgeGroup;
    window.purgeAll = purgeAll;

    // View-mode picker in the header — dropdown with Grid / Compact / List
    // options (replaces the v2.3.0 cycle button so users can pick directly
    // instead of clicking through). All three modes share the same tile
    // markup; layout is pure CSS (`media-grid.view-<mode>` in index.html),
    // so switching is instant — no re-render, no scroll-position drift.
    const viewModeBtn = document.getElementById('view-mode-btn');
    const viewModeMenu = document.getElementById('view-mode-menu');
    if (viewModeBtn && viewModeMenu) {
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
            // Refresh the menu's active state so the checkmark follows.
            viewModeMenu.querySelectorAll('[data-vm]').forEach(b => {
                b.dataset.active = b.dataset.vm === mode ? '1' : '0';
            });
        };
        const stored = (() => { try { return localStorage.getItem('tgdl-view-mode'); } catch { return null; } })();
        applyViewMode(VIEW_MODES.includes(stored) ? stored : 'grid');

        const closeMenu = () => {
            viewModeMenu.classList.remove('open');
            viewModeBtn.setAttribute('aria-expanded', 'false');
        };
        viewModeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = viewModeMenu.classList.toggle('open');
            viewModeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        viewModeMenu.querySelectorAll('[data-vm]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                applyViewMode(btn.dataset.vm);
                closeMenu();
            });
        });
        // Click outside / Esc closes the menu — kept on `document` so any
        // click that wasn't on the menu itself collapses it.
        document.addEventListener('click', (e) => {
            if (!viewModeMenu.classList.contains('open')) return;
            if (viewModeMenu.contains(e.target) || viewModeBtn.contains(e.target)) return;
            closeMenu();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && viewModeMenu.classList.contains('open')) closeMenu();
        });
    }

    // Settings globals
    window.applyPreset = Settings.applyPreset;
    // Manual Save button removed in v2.6 — auto-save handles every edit
    // 800 ms after the last change, with the inline pill + notification
    // bell entry for confirmation. The legacy `Settings.saveSettings`
    // export stays callable for tests + power users who reach for the
    // console, just no longer wired to a button.
    document.getElementById('save-api-credentials')?.addEventListener('click', Settings.saveApiCredentials);
    document.getElementById('change-password-btn')?.addEventListener('click', Settings.changePassword);
    document.getElementById('logout-btn')?.addEventListener('click', Settings.signOut);
    // Sidebar footer sign-out — gated behind confirmSheet because the
    // button sits in always-visible chrome and is one accidental tap away
    // from booting the operator. The deeper Settings button stays no-confirm
    // (deliberate path = deliberate intent).
    document.getElementById('sidebar-logout-btn')?.addEventListener('click', async () => {
        const ok = await confirmSheet({
            title: i18nT('sidebar.signout.confirm_title', 'Sign out of the dashboard?'),
            message: i18nT('sidebar.signout.confirm_body', "You'll need to log in again on the next visit. Telegram accounts and downloads stay put."),
            confirmLabel: i18nT('sidebar.signout', 'Sign out'),
            danger: true,
        });
        if (ok) Settings.signOut();
    });
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
    // Desktop-grade gallery picker: drag-to-select (lasso), Ctrl/Cmd
    // toggle, Shift range, Ctrl+A select-all, Esc exit, Delete bulk-delete.
    // Wires once — handlers are bound on `document` + the grid in capture
    // phase so they take precedence over app.js's per-tile delegation.
    setupGallerySelect({
        onChange: () => updateSelectionBar(),
        deleteSelected: () => {
            const btn = document.getElementById('selection-delete');
            if (btn) btn.click();
        },
    });
    setupToggleA11y();

    // Initialise i18n + the language picker. The fall-through is English so
    // a missing-key during a translation roll-out still renders something.
    await initI18n();
    const langSelect = document.getElementById('setting-language');
    if (langSelect) {
        langSelect.value = getLang();
        langSelect.addEventListener('change', () => setLang(langSelect.value));
    }

    // Font picker — populated from the registry in fonts.js (static
    // import at the top of this file so the SW can cache it like any
    // other module). Boot-time <script> in index.html already applied
    // the saved font BEFORE first paint to avoid FOUC; this just
    // wires the <select> so user changes take effect live. Wrapped in
    // a try so a font-module load failure can't abort the rest of
    // init.
    try {
        const fontSelect = document.getElementById('setting-font');
        if (fontSelect && Fonts.populateSelect) {
            Fonts.populateSelect(fontSelect);
            fontSelect.addEventListener('change', () => Fonts.applyFont(fontSelect.value));
        }
    } catch (e) {
        console.warn('font picker init failed:', e);
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
    // Per-page teardown: stop background tickers/listeners owned by the
    // page we're leaving so they don't keep running invisible.
    if (state.currentPage === 'backfill' && page !== 'backfill') {
        try { stopBackfillPage(); } catch {}
    }
    state.currentPage = page;
    document.body.dataset.page = page;
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

    // Reset the header avatar before each non-viewer render so a previously-
    // selected group's photo doesn't bleed across pages. The viewer page
    // either re-applies its own avatar (when a group is selected) or
    // reverts to the gallery glyph via `showAllMedia()`.
    if (page !== 'viewer') updateHeaderAvatar(null, null);
    setHeaderPageIcon(page);
    setActiveMaintenanceTab(page);

    if (page === 'settings') {
        Settings.loadSettings();
        // Auto-save: every Setting input is watched and a debounced
        // POST /api/config flushes 800 ms after the last edit. Manual
        // Save button still works as an early-flush escape hatch. Guests
        // can't write config so we skip the binding for them entirely.
        if (state.role === 'admin') Settings.setupAutoSave();
        // Engine controls live in the admin-only System section; guests
        // never see the card, and `initEngine` polls /api/monitor/status
        // (admin-gated) so skip it for them.
        if (state.role === 'admin') initEngine();
        document.getElementById('page-title').textContent = i18nT('settings.page.title', 'Settings');
        document.getElementById('page-subtitle').textContent = i18nT('settings.page.subtitle', 'System Configuration');
        // Optional deep-link: #/settings/<section> scrolls to that section.
        // Prefer #settings-<anchor> (unique by construction on the chip-nav
        // wrappers) over a [data-settings-section] match — the latter can
        // also live on inner cards (legacy attrs like rescue, video-player)
        // and querySelector returns the first match, which may not be the
        // section heading we want to scroll to.
        if (params.section) {
            setTimeout(() => {
                const el = document.getElementById(`settings-${params.section}`)
                       || document.querySelector(`[data-settings-section="${params.section}"]`)
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
    } else if (page === 'maintenance') {
        // Hub page — single sidebar entry that lists every maintenance
        // tool as a card. Cleans up the sidebar (used to be 5+ rows of
        // sub-pages, now one). Power users keep the per-feature deep
        // links: /maintenance/duplicates etc. still resolve to their
        // dedicated pages directly.
        document.getElementById('page-title').textContent = i18nT('maintenance.hub.title', 'Maintenance');
        document.getElementById('page-subtitle').textContent = i18nT('maintenance.hub.subtitle', 'Catalogue, thumbnails, NSFW review, logs, backup destinations');
        import('./maintenance-hub.js').then(m => m.init()).catch(e => console.error('maintenance-hub', e));
    } else if (page === 'maintenance-duplicates') {
        document.getElementById('page-title').textContent = i18nT('maintenance.duplicates.title', 'Find duplicate files');
        document.getElementById('page-subtitle').textContent = i18nT('maintenance.duplicates.subtitle', 'Hash every file and reclaim space from byte-identical copies');
        import('./maintenance-duplicates.js').then(m => m.init()).catch(e => console.error('maintenance-duplicates', e));
    } else if (page === 'maintenance-thumbs') {
        document.getElementById('page-title').textContent = i18nT('maintenance.thumbs.page_title', 'Build thumbnails');
        document.getElementById('page-subtitle').textContent = i18nT('maintenance.thumbs.subtitle', 'Generate WebP previews for older files');
        import('./maintenance-thumbs.js').then(m => m.init()).catch(e => console.error('maintenance-thumbs', e));
    } else if (page === 'maintenance-nsfw') {
        document.getElementById('page-title').textContent = i18nT('maintenance.nsfw.page_title', 'NSFW review');
        document.getElementById('page-subtitle').textContent = i18nT('maintenance.nsfw.subtitle', "Five-tier classifier review — keep what's confidently 18+, delete what's confidently not, eyeball the borderline cases.");
        import('./maintenance-nsfw.js').then(m => m.init()).catch(e => console.error('maintenance-nsfw', e));
    } else if (page === 'maintenance-logs') {
        document.getElementById('page-title').textContent = i18nT('maintenance.logs.page_title', 'Log viewer');
        document.getElementById('page-subtitle').textContent = i18nT('maintenance.logs.subtitle', 'Realtime tail of every backend log source');
        import('./maintenance-logs.js').then(m => m.init()).catch(e => console.error('maintenance-logs', e));
    } else if (page === 'maintenance-backup') {
        document.getElementById('page-title').textContent = i18nT('maintenance.backup.page_title', 'Backup destinations');
        document.getElementById('page-subtitle').textContent = i18nT('maintenance.backup.subtitle', 'Mirror new downloads to S3 / SFTP / local NAS storage');
        import('./maintenance-backup.js').then(m => m.init()).catch(e => console.error('maintenance-backup', e));
    } else if (page === 'maintenance-ai') {
        document.getElementById('page-title').textContent = i18nT('maintenance.ai.title', 'AI Search & Smart Organisation');
        document.getElementById('page-subtitle').textContent = i18nT('maintenance.ai.subtitle', 'Local-only image embeddings, face clustering, perceptual dedup, and auto-tagging.');
        import('./maintenance-ai.js').then(m => m.init()).catch(e => console.error('maintenance-ai', e));
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
    router.route('/settings/:section', ({ params }) => {
        // Already on the Settings page → just scroll to the section. A full
        // renderPage() would re-run loadSettings()/initEngine() and re-paint
        // the page, which on chip-tap shows up as a flicker / "reload feel"
        // and can land on the wrong card if the IntersectionObserver fires
        // mid-rebuild. Bypass the re-render and reuse the same lookup chain
        // as the deep-link handler in renderPage().
        if (state.currentPage === 'settings') {
            state.currentRouteParams = { ...(state.currentRouteParams || {}), section: params.section };
            const el = document.getElementById(`settings-${params.section}`)
                   || document.querySelector(`[data-settings-section="${params.section}"]`)
                   || document.querySelector(`#setting-${params.section}, .${params.section}-section`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Light up the matching chip immediately rather than waiting for
            // the IntersectionObserver to catch up after the smooth-scroll —
            // gives instant visual feedback even on slow scrolls.
            document.querySelectorAll('.settings-chip').forEach(c => {
                c.setAttribute('aria-selected', c.dataset.chip === params.section ? 'true' : 'false');
            });
            return;
        }
        renderPage('settings', { section: params.section });
    });
    router.route('/backfill', () => renderPage('backfill'));
    router.route('/backfill/:groupId', ({ params }) => renderPage('backfill', { groupId: params.groupId }));
    router.route('/queue', () => renderPage('queue'));
    router.route('/queue/:status', ({ params }) => renderPage('queue', { status: params.status }));
    router.route('/stories', () => {
        renderPage('viewer');
        document.getElementById('stories-btn')?.click();
    });
    router.route('/account/add', () => { window.location.href = '/add-account.html'; });
    router.route('/maintenance', () => renderPage('maintenance'));
    router.route('/maintenance/duplicates', () => renderPage('maintenance-duplicates'));
    router.route('/maintenance/thumbs', () => renderPage('maintenance-thumbs'));
    router.route('/maintenance/nsfw', () => renderPage('maintenance-nsfw'));
    router.route('/maintenance/logs', () => renderPage('maintenance-logs'));
    router.route('/maintenance/backup', () => renderPage('maintenance-backup'));
    router.route('/maintenance/ai', () => renderPage('maintenance-ai'));
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
        // Re-apply any active sidebar filter so a WS-driven re-render
        // doesn't blow away the user's typed query.
        _reapplySidebarFilter();
    }

    // Fire a one-shot resolve in the background. Endpoint is fire-and-
    // forget; the `groups_refreshed` WS handler covers the cache merge
    // for every open tab. The dedupe flag prevents a flurry of WS-driven
    // re-renders from hammering the endpoint, while a 409 from a sibling
    // client is no-op'd on the server side.
    if (needsResolve && !state._resolvingGroups) {
        state._resolvingGroups = true;
        api.post('/api/groups/refresh-info')
            .catch(() => {})
            .finally(() => { state._resolvingGroups = false; });
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
    // Reset the type filter when entering a new gallery view — user
    // was reporting "media not complete" because a previous Photos /
    // Videos tab choice survived the navigation and silently filtered
    // out everything else for the new group.
    resetGalleryFilter();

    document.getElementById('page-title').textContent = state.currentGroup;
    document.getElementById('page-subtitle').textContent = i18nT('viewer.subtitle.loading', 'Loading...');
    // Mirror the sidebar avatar into the header so the user sees which
    // chat they're inside. Falls back to a coloured initial when there's
    // no profile photo cached yet.
    updateHeaderAvatar(groupId, state.currentGroup);
    navigateTo('viewer');
    loadGroupFiles(groupId);
}

// Per-page icon for the header avatar slot when no group is selected.
// Picks an icon + a stable colour slot so each page reads as itself
// instead of all sharing the gallery glyph from the viewer page.
const PAGE_HEADER_ICON = {
    viewer:                   'ri-gallery-line',
    groups:                   'ri-group-line',
    backfill:                 'ri-history-line',
    queue:                    'ri-list-check-2',
    settings:                 'ri-settings-3-line',
    'maintenance':            'ri-tools-line',
    'maintenance-duplicates': 'ri-file-copy-2-line',
    'maintenance-thumbs':     'ri-image-line',
    'maintenance-nsfw':       'ri-shield-check-line',
    'maintenance-logs':       'ri-terminal-box-line',
    'maintenance-backup':     'ri-cloud-line',
    'maintenance-ai':         'ri-sparkling-2-line',
};

// Repaint the active state on the maintenance tab strip. CSS hides the
// strip when not on a per-feature maintenance page, but we still set
// the data-active attr to reflect the current page so the active style
// is correct the moment the strip becomes visible.
function setActiveMaintenanceTab(page) {
    const root = document.getElementById('maintenance-tabs');
    if (!root) return;
    const tabs = root.querySelectorAll('.maintenance-tab[data-mt-page]');
    tabs.forEach((t) => {
        const isActive = t.dataset.mtPage === page;
        t.dataset.active = isActive ? '1' : '0';
        if (isActive) t.setAttribute('aria-selected', 'true');
        else t.removeAttribute('aria-selected');
    });
}

function setHeaderPageIcon(page) {
    const el = document.getElementById('header-avatar');
    if (!el) return;
    const icon = PAGE_HEADER_ICON[page] || 'ri-gallery-line';
    el.className = 'tg-avatar tg-avatar-1 w-10 h-10 text-lg flex-shrink-0 flex items-center justify-center text-white';
    el.innerHTML = `<i class="${icon}"></i>`;
}

function updateHeaderAvatar(groupId, displayName) {
    const el = document.getElementById('header-avatar');
    if (!el) return;
    // No groupId → All Media / non-group view → render a generic
    // gallery glyph instead of leaving the previous group's photo
    // floating in the header. Without this, switching from Group A
    // to All Media kept Group A's avatar in the header until the
    // user navigated to another group, which the user (rightly)
    // called a bug.
    if (!groupId) {
        el.className = 'tg-avatar tg-avatar-1 w-10 h-10 text-lg flex-shrink-0 flex items-center justify-center text-white';
        el.innerHTML = '<i class="ri-gallery-line"></i>';
        return;
    }
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
    resetGalleryFilter();

    document.getElementById('page-title').textContent = i18nT('viewer.all_media.title', 'All Media');
    document.getElementById('page-subtitle').textContent = i18nT('viewer.all_media.subtitle', 'All downloaded files');
    // Header avatar back to the generic gallery glyph — switching from
    // a per-group view used to leave that chat's avatar in the header.
    updateHeaderAvatar(null, null);

    const grid = document.getElementById('media-grid');
    if (grid) grid.innerHTML = '';

    // Make sure the viewer page section is actually visible BEFORE we
    // start the fetch — clicking "All Media" while the user is on
    // Settings / Engine / Queue would otherwise silently load files
    // into a hidden DOM. Guard against re-entry: renderPage('viewer')
    // is also a caller of showAllMedia, so an unconditional
    // navigateTo() here would build an infinite loop
    // (sidebar click → showAllMedia → navigateTo → renderPage('viewer')
    //  → showAllMedia → navigateTo → …).
    if (state.currentPage !== 'viewer') {
        navigateTo('viewer');
        return;   // renderPage will re-enter us with the page visible
    }

    // Load files from all groups
    loadAllFiles();
}

// Per-page batch size for the All-Media + group infinite-scroll path.
// Bumped 50 → 100 in v2.3.24 — fewer round trips before the next batch
// arrives, smoother feel on a long scroll. The pre-fetch margin
// (`rootMargin` on the IntersectionObserver below) means the next
// batch is in flight LONG before the user can run out of rows.
//
// Mobile uses a smaller page (50) because the gallery grid renders 4-6
// tiles per row on small viewports — half the rows than desktop's 8-col,
// so 100 tiles takes 17 rows of DOM. Combined with the lazy <img>/<video>
// loaders 50 keeps scroll buttery on mid-range Android.
const _isMobileViewport = () => {
    try { return window.matchMedia('(max-width: 768px)').matches; }
    catch { return false; }
};
const FILES_PER_PAGE = _isMobileViewport() ? 50 : 100;

async function loadAllFiles() {
    state.loading = true;
    const grid = document.getElementById('media-grid');
    if (state.page === 1 && grid) grid.innerHTML = renderGallerySkeletons(12);

    try {
        const type = state.currentFilter && state.currentFilter !== 'all' ? state.currentFilter : 'all';
        const pinQs = state.pinnedFilter ? '&pinned=1' : '';
        const pinFirstQs = (localStorage.getItem('tgdl-pinned-first') === '1') ? '&pinnedFirst=1' : '';
        const res = await api.get(`/api/downloads/all?page=${state.page}&limit=${FILES_PER_PAGE}&type=${encodeURIComponent(type)}${pinQs}${pinFirstQs}`);
        const newFiles = res?.files || [];

        let appendFromIndex = 0;
        if (state.page === 1) {
            state.files = newFiles;
        } else {
            appendFromIndex = state.files.length;
            state.files = state.files.concat(newFiles);
        }
        // Off-by-one safety: hasMore ALSO requires that the running total
        // is still below the server-reported total. Otherwise a perfectly-
        // packed last page (length === FILES_PER_PAGE) keeps firing a
        // 0-row request forever.
        const total = Number(res?.total) || state.files.length;
        state.hasMore = newFiles.length === FILES_PER_PAGE && state.files.length < total;

        // Append-only render on page 2+; full render on page 1. Append
        // is O(N_new) instead of O(N_total) so a 1000-tile gallery scroll
        // stays smooth right to the end of the list.
        if (state.page > 1) renderMediaGrid({ append: true, fromIndex: appendFromIndex });
        else renderMediaGrid();
        document.getElementById('page-subtitle').textContent = i18nTf(
            'viewer.subtitle.files',
            { count: total },
            `${total} files`,
        );
    } catch (e) {
        showToast(i18nT('viewer.error.load', 'Error loading files'), 'error');
    } finally {
        state.loading = false;
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
        const type = state.currentFilter && state.currentFilter !== 'all' ? state.currentFilter : 'all';
        const pinQs = state.pinnedFilter ? '&pinned=1' : '';
        const pinFirstQs = (localStorage.getItem('tgdl-pinned-first') === '1') ? '&pinnedFirst=1' : '';
        const res = await api.get(`/api/downloads/${encodeURIComponent(groupId)}?page=${state.page}&limit=${FILES_PER_PAGE}&type=${encodeURIComponent(type)}${pinQs}${pinFirstQs}`);
        const newFiles = res.files || [];

        let appendFromIndex = 0;
        if (state.page === 1) {
            state.files = newFiles;
        } else {
            appendFromIndex = state.files.length;
            state.files = state.files.concat(newFiles);
        }

        // Off-by-one safety same as loadAllFiles — short last page no
        // longer keeps pagination armed forever.
        const total = Number(res.total) || state.files.length;
        state.hasMore = newFiles.length === FILES_PER_PAGE && state.files.length < total;
        if (state.page > 1) renderMediaGrid({ append: true, fromIndex: appendFromIndex });
        else renderMediaGrid();
        document.getElementById('page-subtitle').textContent = i18nTf('viewer.subtitle.files', { count: total }, `${total} files`);
    } catch (e) {
        showToast(i18nT('viewer.error.load', 'Error loading files'), 'error');
    } finally {
        state.loading = false;
    }
}

// Track how many state.files entries are already painted as tiles in the
// DOM. Append-only on infinite scroll: page-2+ loads add only the new
// tail to the grid via insertAdjacentHTML rather than re-rendering the
// whole thing. Reset on every full re-render (filter/group change).
let _renderedFileCount = 0;

function renderMediaGrid(opts = {}) {
    const grid = document.getElementById('media-grid');
    const empty = document.getElementById('empty-state');
    if (!grid) return;

    const append = opts.append === true;
    const fromIndex = append ? (opts.fromIndex ?? _renderedFileCount) : 0;

    if (state.files.length === 0) {
        grid.innerHTML = '';
        _renderedFileCount = 0;
        renderGalleryEmptyState();
        return;
    }
    if (empty) empty.classList.add('hidden');

    if (!state.selected) state.selected = new Set();

    // Walk only the slice we need (full list on full render, tail on
    // append). Each file's index in the UNFILTERED list (`originalIndex`)
    // is preserved so the viewer's `state.files[idx]` lookup stays
    // correct under filter.
    const slice = state.files.slice(fromIndex);
    const filteredWithIndex = [];
    slice.forEach((file, sliceIdx) => {
        if (state.currentFilter === 'all' || file.type === state.currentFilter) {
            filteredWithIndex.push({ file, originalIndex: fromIndex + sliceIdx });
        }
    });

    // On append, skip the time-section banding entirely — the existing
    // headers up the page stay correct visually, and re-bucketing the
    // tail in isolation can't produce sensible relative labels anyway.
    const sections = append
        ? [['', filteredWithIndex]]
        : groupFilesByTime(filteredWithIndex);

    const html = sections.map(([label, items]) => {
        // Sticky inside a CSS Grid was clipping the trailing media tiles
        // and stacking multiple headers at the top of the scrollport
        // (each header sticks until the next pushes it). Plain inline
        // header keeps each section's title aligned with its row without
        // hijacking the scroll geometry.
        const headerHtml = label
            ? `<h4 class="grid-section-header" style="grid-column: 1 / -1; padding: 16px 4px 8px; color: var(--tg-textSecondary, #8B9BAA); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(label)}</h4>`
            : '';
        const tiles = items.map(({ file, originalIndex }) => {
            // CSS-driven selection visuals: `.media-grid.in-select-mode`
            // reveals the badge on every tile, and `.media-item.is-selected`
            // flips it to "checked". Both classes are toggled in place by
            // gallery-select.js — no re-render needed for selection
            // changes, which is what keeps the lasso smooth on a long
            // gallery.
            const checked = state.selected?.has(file.fullPath);
            const selectedCls = checked ? 'is-selected' : '';
            const checkBadge = `<div class="select-badge"><i class="ri-check-line"></i></div>`;
            // Rescue Mode badges. Rescued tiles win over pending (a row
            // shouldn't carry both, but if it does, "rescued" is the more
            // useful signal). Pending shows a remaining-hours estimate +
            // tooltip with the local-time deadline.
            const rescueBadge = renderRescueBadge(file);
            // Server-side WebP thumbnails. One ~10-30 KB image per tile
            // — replaces both the previous full-resolution image source
            // and the mobile-vs-desktop branching. Width snaps to one of
            // the allowed sizes (240 covers grid + compact); the server
            // caches the result so subsequent scrolls are pure HTTP-304s.
            // Falls back to a typed-icon placeholder if the source isn't
            // thumbnailable (audio / document / dead source).
            const thumbW = _isMobileViewport() ? 240 : 320;
            const thumbUrl = file.id != null
                ? `/api/thumbs/${encodeURIComponent(file.id)}?w=${thumbW}`
                : null;
            // Onerror falls back to displaying nothing (the panel
            // background shows through), which is the desired graceful
            // degradation for a missing/dead file.
            // CSS skeleton starts img at opacity:0 and fades to 1 on `.loaded`.
            // Native loading="lazy" bypasses the IntersectionObserver path that
            // adds the class, so flip it from the inline handlers — otherwise
            // a successfully-loaded thumb stays invisible behind opacity:0.
            const imgFallback = `<img loading="lazy" decoding="async" class="w-full h-full object-cover" alt="" `
                + (thumbUrl ? `src="${escapeHtml(thumbUrl)}"` : '')
                + ` onload="this.classList.add('loaded')"`
                + ` onerror="this.classList.add('loaded');this.style.display='none'">`;
            const docFallback = `<div class="w-full h-full flex flex-col items-center justify-center">
                <i class="${getFileIcon(file.extension)} text-3xl text-tg-textSecondary"></i>
            </div>`;
            // Inner thumb content — the visual changes per file type (img,
            // video w/ play overlay, doc icon). Wrapped in `.tile-thumb`
            // so list-mode CSS can size it as a 56 px square cell.
            const thumbInner = file.type === 'images'
                ? imgFallback
                : file.type === 'videos'
                    ? `<div class="relative w-full h-full bg-black">
                        ${thumbUrl ? imgFallback : ''}
                        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div class="w-10 h-10 rounded-full bg-black/55 flex items-center justify-center">
                                <i class="ri-play-fill text-white text-xl ml-0.5"></i>
                            </div>
                        </div>
                       </div>`
                    : docFallback;
            // Filename-under-tile fallback for non-image-non-video types
            // in GRID/COMPACT modes (where doc icon needs context). CSS
            // hides this in list mode (which has its own tile-name).
            const gridDocLabel = (file.type !== 'images' && file.type !== 'videos')
                ? `<span class="absolute inset-x-0 bottom-0 text-[11px] text-tg-textSecondary truncate text-center px-2 py-1 bg-black/40">${escapeHtml(file.name || '')}</span>`
                : '';
            // List-mode metadata. `tile-text/size/date` are display:none in
            // grid+compact (CSS), display:flex/grid in list. Group name +
            // file extension in the sub line, full size + date in their
            // own columns. Date format = locale short.
            const groupLine = file.groupName || file.groupId || '';
            const sizeLine = file.sizeFormatted || (file.size ? formatBytes(file.size) : '');
            const dateLine = file.modified ? formatRelativeTime(file.modified) : '';
            // Pin chip — appears on hover, golden when pinned. data-tile-pin
            // is what the gallery delegation handler keys off below.
            const pinnedCls = file.pinned ? 'is-pinned' : '';
            const pinTitle = file.pinned
                ? i18nT('favorites.unpin', 'Unpin')
                : i18nT('favorites.pin', 'Pin');
            const pinChip = file.id != null
                ? `<button type="button" class="pin-chip" data-tile-pin title="${escapeHtml(pinTitle)}" aria-label="${escapeHtml(pinTitle)}">
                       <i class="ri-pushpin-2-fill"></i>
                   </button>`
                : '';
            return `
            <div class="media-item relative ${selectedCls} ${pinnedCls}" data-index="${originalIndex}" data-path="${escapeHtml(file.fullPath)}"${file.id != null ? ` data-id="${file.id}"` : ''} tabindex="0">
                <div class="tile-thumb relative w-full h-full overflow-hidden">
                    ${thumbInner}
                    ${gridDocLabel}
                </div>
                ${pinChip}
                <div class="tile-text">
                    <div class="tile-name" title="${escapeHtml(file.name || '')}">${escapeHtml(file.name || '')}</div>
                    <div class="tile-sub">${escapeHtml(groupLine)}</div>
                </div>
                <div class="tile-size">${escapeHtml(sizeLine)}</div>
                <div class="tile-date" title="${file.modified ? new Date(file.modified).toLocaleString() : ''}">${escapeHtml(dateLine)}</div>
                <div class="tile-actions">
                    <button type="button" class="w-7 h-7 rounded-md hover:bg-tg-hover flex items-center justify-center text-tg-textSecondary"
                            data-tile-open title="${escapeHtml(i18nT('viewer.open', 'Open'))}" aria-label="${escapeHtml(i18nT('viewer.open', 'Open'))}">
                        <i class="ri-eye-line"></i>
                    </button>
                </div>
                ${checkBadge}
                ${rescueBadge}
            </div>`;
        }).join('');
        return headerHtml + tiles;
    }).join('');

    if (append) {
        // Tail-append. insertAdjacentHTML doesn't re-parse the existing
        // children — O(N_appended) instead of O(N_total) per scroll page,
        // which is the difference between buttery scroll and stutter on
        // a 1000-tile gallery.
        grid.insertAdjacentHTML('beforeend', html);
    } else {
        grid.innerHTML = html;
    }
    _renderedFileCount = state.files.length;

    // Click handling lives on the grid itself via event delegation
    // (wired once below). Per-tile addEventListener was the second-
    // biggest cost on a full re-render — eliminating it keeps tab
    // switches snappy on a thousand-tile grid.
    _wireMediaGridDelegation(grid);
    _attachLazyObservers(grid);
    // Re-apply select-mode class + repaint .is-selected on tiles after
    // any full or append render so the visual state survives mutations
    // (e.g. infinite scroll, filter switch, file_deleted).
    repaintSelection();
}

let _gridDelegated = false;
function _wireMediaGridDelegation(grid) {
    if (_gridDelegated) return;
    _gridDelegated = true;
    grid.addEventListener('click', async (ev) => {
        // Pin chip — toggles pinned state via the API and flips the
        // visual class in place. Stops propagation so clicking the
        // chip doesn't also open the viewer.
        const pinBtn = ev.target.closest('[data-tile-pin]');
        if (pinBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const tile = pinBtn.closest('.media-item[data-index]');
            const idx = tile ? parseInt(tile.dataset.index, 10) : -1;
            const file = state.files[idx];
            if (!file || file.id == null) return;
            const next = !file.pinned;
            try {
                await api.post(`/api/downloads/${encodeURIComponent(file.id)}/pin`, { pinned: next });
                file.pinned = next;
                tile?.classList.toggle('is-pinned', next);
            } catch (e) {
                showToast(e?.message || 'Pin failed', 'error');
            }
            return;
        }
        const el = ev.target.closest('.media-item[data-index]');
        if (!el) return;
        const idx = parseInt(el.dataset.index, 10);
        if (state.selectMode || ev.shiftKey) {
            toggleSelection(el.dataset.path);
            ev.preventDefault();
            return;
        }
        Viewer.openMediaViewer(idx);
    });
}

// Lazy <img>/<video> observer hookup — runs after every render (full or
// append) so newly-added tiles are picked up by the same IntersectionObserver
// that swaps `data-src` → `src` when the tile scrolls into view. Idempotent
// — `observer.observe(el)` is a no-op for an already-observed node.
function _attachLazyObservers(grid) {
    if (!state.imageObserver) return;
    grid.querySelectorAll('img[data-src], video[data-src]').forEach(el => state.imageObserver.observe(el));
}

// Remove a single tile from the grid in place. Saves the full
// renderMediaGrid() pass when a WS file_deleted lands — important on a
// big gallery, where re-painting 1000 tiles to drop one shows up as a
// visible scroll-stutter. Falls through to a no-op if no tile matches
// (the tile was already removed, or the gallery doesn't have it cached).
function _removeTileFromGrid({ path, id }) {
    const grid = document.getElementById('media-grid');
    if (!grid) return;
    let el = null;
    if (path) {
        // CSS.escape is required because file paths can carry quotes /
        // brackets / colons that would otherwise break the selector.
        el = grid.querySelector(`.media-item[data-path="${CSS.escape(path)}"]`);
    }
    if (!el && id != null) {
        el = grid.querySelector(`.media-item[data-id="${CSS.escape(String(id))}"]`);
    }
    if (el) el.remove();
    // Surface the empty-state when the last tile disappears.
    if (state.files.length === 0) renderGalleryEmptyState();
}

/**
 * Render the gallery empty-state with actionable guidance. The default
 * copy ("No media files") doesn't tell the operator WHY the gallery is
 * empty — so they'd file "ทำไมบางกลุ่มไม่เจอ media" tickets.
 *
 *   - On a specific group view: hint that this group has no DB rows yet,
 *     suggest backfill (admin) or filter check.
 *   - On All Media with zero rows: hint that nothing has been downloaded,
 *     suggest opening Settings → Telegram Accounts (likely no account).
 *   - In select-mode-active (filtered) view: defer to the existing copy.
 */
function renderGalleryEmptyState() {
    const empty = document.getElementById('empty-state');
    if (!empty) return;
    const titleEl = document.getElementById('empty-state-title');
    const bodyEl  = document.getElementById('empty-state-body');
    const iconEl  = document.getElementById('empty-state-icon');
    const actionsEl = document.getElementById('empty-state-actions');
    const isAdmin = state.role === 'admin';
    const groupId = state.currentGroupId;

    let title, body, icon, actions = [];
    if (groupId) {
        icon = 'ri-folder-open-line';
        title = i18nT('viewer.empty.group_title', 'No downloaded media for this group yet');
        body = isAdmin
            ? i18nT('viewer.empty.group_body_admin', 'Either nothing has been downloaded yet or the catalogue is out of sync. Run a Backfill to pull older messages, double-check the media filters in Group Settings, or re-index from disk if files exist on disk but not in the database.')
            : i18nT('viewer.empty.group_body_guest', 'Either nothing has been downloaded yet or the catalogue is empty for this chat. Ask an admin to run a Backfill.');
        if (isAdmin) {
            actions = [
                { label: i18nT('viewer.empty.action.backfill', 'Run Backfill'), icon: 'ri-history-line', onClick: () => window.navigateTo?.('backfill') },
                { label: i18nT('viewer.empty.action.group_settings', 'Group Settings'), icon: 'ri-equalizer-line', onClick: () => window.openGroupSettings?.(groupId) },
                { label: i18nT('viewer.empty.action.reindex', 'Re-index from disk'), icon: 'ri-refresh-line', onClick: () => window.navigateTo?.('maintenance/duplicates') },
            ];
        }
    } else {
        icon = 'ri-image-line';
        title = i18nT('viewer.empty', 'No media files');
        body = isAdmin
            ? i18nT('viewer.empty.all_body_admin', 'Nothing has been downloaded yet. Add a Telegram account and enable a chat under Groups, or paste a t.me/ link to download a single message.')
            : i18nT('viewer.empty.all_body_guest', 'Nothing has been downloaded yet. Ask an admin to add a Telegram account and enable some chats.');
        if (isAdmin) {
            actions = [
                { label: i18nT('viewer.empty.action.add_account', 'Add account'), icon: 'ri-user-add-line', onClick: () => window.navigateTo?.('settings/accounts') },
                { label: i18nT('viewer.empty.action.groups', 'Manage groups'), icon: 'ri-group-line', onClick: () => window.navigateTo?.('groups') },
            ];
        }
    }

    if (iconEl) iconEl.className = `${icon} text-5xl text-tg-textSecondary mb-4`;
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) {
        bodyEl.textContent = body;
        bodyEl.classList.toggle('hidden', !body);
    }
    if (actionsEl) {
        actionsEl.innerHTML = actions.map((a, i) => `
            <button type="button" data-action-idx="${i}"
                class="tg-btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5">
                <i class="${a.icon}"></i><span>${a.label}</span>
            </button>
        `).join('');
        actionsEl.classList.toggle('hidden', actions.length === 0);
        // Re-bind click handlers — innerHTML wipes them.
        actionsEl.querySelectorAll('button[data-action-idx]').forEach((btn) => {
            const idx = Number(btn.dataset.actionIdx);
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                try { actions[idx]?.onClick?.(); } catch {}
            });
        });
    }
    empty.classList.remove('hidden');
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

// In-place selection toggle. Used by long-press (touch) and the
// fallback select-mode click in app.js's grid delegation. Desktop
// gestures (Ctrl/Shift/lasso/Ctrl+A) live in gallery-select.js and
// flip the same state without going through here. No grid re-render —
// just toggle `.is-selected` on the matching tile.
function toggleSelection(path) {
    if (!state.selected) state.selected = new Set();
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    const grid = document.getElementById('media-grid');
    const tile = grid?.querySelector(`.media-item[data-path="${CSS.escape(path)}"]`);
    if (tile) tile.classList.toggle('is-selected', state.selected.has(path));
    updateSelectionBar();
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

    // Long-press → enter select-mode + toggle + arm continue-select drag
    // is handled inside gallery-select.js (single owner of touch + mouse
    // gestures). The previous attachLongPress duplicate here was removed
    // in v2.3.38 to avoid double-fire (both handlers would have toggled
    // the same tile).

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
    // Toolbar wiring for the gallery — selection-mode toggle + selection-bar
    // controls (Select all / Clear / Delete). The free-text media search was
    // dropped in v2.3.47 (rarely used; the chat sidebar already filters
    // groups, and the URL link picker handles "find this exact message").
    const selectBtn = document.getElementById('select-mode-btn');
    const selDel = document.getElementById('selection-delete');
    const selClear = document.getElementById('selection-clear');
    const selAll = document.getElementById('selection-all');

    selectBtn?.addEventListener('click', () => {
        if (state.selectMode) {
            // Off → wipe selection + repaint via the shared helper so
            // the in-place class toggles match the boot-time wiring.
            exitSelectMode();
        } else {
            state.selectMode = true;
            selectBtn.classList.add('bg-tg-blue', 'text-white');
            const grid = document.getElementById('media-grid');
            if (grid) grid.classList.add('in-select-mode');
        }
        updateSelectionBar();
    });

    selClear?.addEventListener('click', () => {
        if (state.selected) state.selected.clear();
        // Drop the visual checked-state in place — way cheaper than
        // a full grid re-render.
        const grid = document.getElementById('media-grid');
        grid?.querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
        updateSelectionBar();
    });

    selAll?.addEventListener('click', () => {
        // Mirrors Ctrl/⌘+A — surfaces the keyboard shortcut as a tappable
        // button so mobile/touch users get the same affordance.
        selectAllVisible();
        updateSelectionBar();
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
        // Fire-and-forget — at N=5000 the unlink loop runs minutes. Drop
        // selected paths from the local view immediately so the user sees
        // the gallery shrink; the canonical refresh happens via the
        // existing `bulk_delete` WS broadcast (already wired further up).
        // Final toast comes from `dedup_delete_done` (shared tracker).
        const set = new Set(paths);
        try {
            const r = await api.post('/api/downloads/bulk-delete', { paths });
            if (!r?.started && !r?.success) throw new Error('Failed to start');
            state.selected.clear();
            state.files = (state.files || []).filter(f => !set.has(f.fullPath));
            if (state.savedFiles) state.savedFiles = state.savedFiles.filter(f => !set.has(f.fullPath));
            updateSelectionBar();
            renderMediaGrid();
        } catch (e) {
            if (e?.data?.code === 'ALREADY_RUNNING') {
                showToast(i18nT('jobs.already_running',
                    'Already running on another tab — waiting for it to finish.'), 'info');
                return;
            }
            showToast(i18nTf('viewer.bulk.failed', { msg: e.message }, `Delete failed: ${e.message}`), 'error');
        }
    });

    // Selection-bar: Download ZIP. Pulls every selected tile's DB id
    // (skipping rows that don't have one — e.g. legacy entries from
    // before id was surfaced on /api/downloads/:groupId) and POSTs the
    // list to the streaming bulk-zip endpoint. Server replies with a
    // ZIP attachment that the browser saves directly.
    const selZip = document.getElementById('selection-zip');
    selZip?.addEventListener('click', async () => {
        if (!state.selected || !state.selected.size) return;
        const ids = [];
        const paths = Array.from(state.selected);
        for (const p of paths) {
            const f = (state.files || []).find(x => x.fullPath === p);
            if (f && f.id != null) ids.push(f.id);
        }
        if (ids.length === 0) {
            showToast(i18nT('viewer.selection.zip_no_ids',
                'Selected files have no DB id — re-open the page to refresh and try again.'), 'error');
            return;
        }
        try {
            const r = await fetch('/api/downloads/bulk-zip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            });
            if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${r.status}`);
            }
            // Stream the body to a Blob → object URL → save-as. For really
            // big archives the browser will write to disk as it goes.
            const cd = r.headers.get('content-disposition') || '';
            const m = /filename="([^"]+)"/.exec(cd);
            const fileName = m ? m[1] : 'tgdl-bulk.zip';
            const blob = await r.blob();
            const u = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = u; a.download = fileName;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(u), 60_000);
            showToast(i18nT('viewer.selection.zip_done', 'ZIP downloaded'), 'success');
        } catch (e) {
            showToast(i18nT('viewer.selection.zip_failed', 'ZIP download failed') + ' — ' + (e?.message || ''), 'error');
        }
    });

    // Selection-bar: Pin / Unpin. Toggles every selected tile's pinned
    // flag in one go. Empty selection = no-op. Mixed-state selection
    // (some pinned, some not) flips them ALL to pinned for clarity.
    const selPin = document.getElementById('selection-pin');
    selPin?.addEventListener('click', async () => {
        if (!state.selected || !state.selected.size) return;
        const items = [];
        for (const p of state.selected) {
            const f = (state.files || []).find(x => x.fullPath === p);
            if (f && f.id != null) items.push(f);
        }
        if (!items.length) return;
        const allPinned = items.every(f => f.pinned);
        const next = !allPinned;
        let ok = 0, failed = 0;
        for (const f of items) {
            try {
                await api.post(`/api/downloads/${encodeURIComponent(f.id)}/pin`, { pinned: next });
                f.pinned = next;
                const tile = document.querySelector(`.media-item[data-id="${CSS.escape(String(f.id))}"]`);
                tile?.classList.toggle('is-pinned', next);
                ok++;
            } catch { failed++; }
        }
        showToast(
            next
                ? i18nTf('favorites.bulk_pinned', { count: ok }, `Pinned ${ok} item(s)`)
                : i18nTf('favorites.bulk_unpinned', { count: ok }, `Unpinned ${ok} item(s)`),
            failed === 0 ? 'success' : 'info'
        );
    });

    // Listen for the shared dedup_delete tracker's done event so a
    // bulk-delete started from the duplicate-finder OR another tab still
    // surfaces a result toast on the gallery page.
    _wireGalleryDedupDone();
}

let _galleryDedupWired = false;
function _wireGalleryDedupDone() {
    if (_galleryDedupWired) return;
    _galleryDedupWired = true;
    ws.on('dedup_delete_done', (m) => {
        if (m?.error) return;
        const removed = m?.unlinked ?? m?.removed ?? 0;
        if (removed > 0) {
            showToast(i18nTf('viewer.bulk.deleted',
                { count: removed }, `Deleted ${removed} files`), 'success');
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
        // "No Telegram account configured yet" is not an error — it's a
        // first-run state. Surface a friendly empty-state pointing at the
        // Add Account flow instead of a red failure message.
        if (e?.data?.error === 'no_account') {
            list.innerHTML = renderEmptyState({
                icon: 'ri-user-add-line',
                title: i18nT('groups.no_account.title', 'No Telegram account yet'),
                body: i18nT('groups.no_account.body', 'Add your Telegram account to load chats and start downloading.'),
                actionLabel: i18nT('groups.no_account.cta', 'Add account'),
                actionHref: '/add-account.html',
            });
            return;
        }
        list.innerHTML = `<div class="text-center py-8 text-red-400">${escapeHtml(i18nT('groups.load_failed', 'Failed to load dialogs'))}</div>`;
    }
}

function renderDialogsList(dialogs) {
    const list = document.getElementById('groups-config-list');
    if (!list) return;
    
    const tab = state.groupsTab || 'all';
    const filtered = tab === 'monitored'
        ? dialogs.filter(d => d.inConfig || d.enabled)
        : tab === 'unmonitored'
            ? dialogs.filter(d => !d.inConfig && !d.enabled)
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

// Sidebar groups filter — DOM-only, no re-render. Hides non-matching
// .chat-row tiles in #groups-list and lets renderGroupsList()'s
// _lastHtml cache stay valid so an incoming WS event doesn't blow away
// the user's filter state mid-typing.
function filterSidebarGroups(rawQuery) {
    const list = document.getElementById('groups-list');
    if (!list) return;
    const q = String(rawQuery || '').trim().toLowerCase();
    const rows = list.querySelectorAll('.chat-row');
    if (!q) {
        rows.forEach(r => r.classList.remove('hidden'));
        return;
    }
    rows.forEach(r => {
        const name = (r.querySelector('.row-title-name')?.textContent || '').toLowerCase();
        const id = (r.dataset.id || '').toLowerCase();
        r.classList.toggle('hidden', !(name.includes(q) || id.includes(q)));
    });
}

// Re-apply the sidebar filter after every renderGroupsList() so a fresh
// sweep of HTML doesn't undo the user's typed query. Cheap because the
// row count is bounded (sidebar usually <100 groups).
function _reapplySidebarFilter() {
    const input = document.getElementById('sidebar-groups-search');
    if (input && input.value) filterSidebarGroups(input.value);
}

// Collapse / expand the sidebar's Maintenance subsection. Same pattern
// as the Downloaded-Groups collapse below — preference persists in
// localStorage so the operator's last state sticks across reloads.
function _setupSidebarMaintenanceCollapse() {
    const btn = document.getElementById('maintenance-section-toggle');
    const body = document.getElementById('maintenance-nav-body');
    if (!btn || !body) return;
    const KEY = 'tgdl.sidebar.maintenance.collapsed';
    const apply = (collapsed) => {
        body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    apply(localStorage.getItem(KEY) === '1');
    btn.addEventListener('click', () => {
        const next = body.getAttribute('aria-hidden') !== 'true';
        try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private mode */ }
        apply(next);
    });
}

// Collapse / expand the "Downloaded Groups" body. Persists across reloads
// in localStorage so the user's preference sticks.
function _setupSidebarGroupsCollapse() {
    const btn = document.getElementById('downloaded-groups-toggle');
    const body = document.getElementById('downloaded-groups-body');
    const chev = document.getElementById('downloaded-groups-chevron');
    if (!btn || !body) return;
    const KEY = 'tgdl.sidebar.groups.collapsed';
    const apply = (collapsed) => {
        body.classList.toggle('hidden', collapsed);
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        if (chev) chev.style.transform = collapsed ? 'rotate(180deg)' : '';
    };
    apply(localStorage.getItem(KEY) === '1');
    btn.addEventListener('click', () => {
        const next = !body.classList.contains('hidden');
        try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private mode */ }
        apply(next);
    });
}

function switchGroupsTab(tab) {
    state.groupsTab = tab;

    // Single source of truth: the tab id maps 1:1 to the filter slug. This
    // collapses the previous per-button if-toggle ladder into a loop, so
    // adding a future tab only requires adding it to this array.
    const tabs = ['all', 'monitored', 'unmonitored'];
    for (const t of tabs) {
        const el = document.getElementById(`groups-tab-${t}`);
        if (!el) continue;
        const active = tab === t;
        el.classList.toggle('border-tg-blue', active);
        el.classList.toggle('text-tg-blue', active);
        el.classList.toggle('border-transparent', !active);
        el.classList.toggle('text-tg-textSecondary', !active);
    }

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
        if (e?.data?.error === 'no_account') {
            list.innerHTML = `<div class="p-3 text-sm text-tg-textSecondary">${escapeHtml(i18nT('picker.no_account', 'Add a Telegram account first to pick a forward destination.'))} <a href="/add-account.html" class="text-tg-blue hover:underline">${escapeHtml(i18nT('groups.no_account.cta', 'Add account'))}</a></div>`;
            return;
        }
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

// Reset the All / Photos / Videos / Files / Audio tab back to "All"
// and re-paint the tab UI to match. Called whenever we enter a fresh
// gallery view (All Media or per-group) so a stale tab choice from
// the previous view doesn't silently filter the new content.
function resetGalleryFilter() {
    state.currentFilter = 'all';
    document.querySelectorAll('#media-tabs .tab-item').forEach(t => {
        t.classList.toggle('active', (t.dataset.type || 'all') === 'all');
    });
}

// ============ Media Tabs ============
function setupMediaTabs() {
    document.querySelectorAll('#media-tabs .tab-item').forEach(tab => {
        tab.addEventListener('click', () => {
            // The pinned toggle is a chip, NOT a type tab — it stacks with
            // the type filter instead of replacing it. Handle it separately.
            if (tab.dataset.pinnedToggle !== undefined) {
                const next = tab.getAttribute('aria-pressed') !== 'true';
                tab.setAttribute('aria-pressed', next ? 'true' : 'false');
                state.pinnedFilter = next;
                state.page = 1;
                state.hasMore = true;
                state.files = [];
                if (state.currentPage === 'viewer') {
                    if (state.currentGroupId) loadGroupFiles(state.currentGroupId);
                    else loadAllFiles();
                } else {
                    renderMediaGrid();
                }
                return;
            }
            document.querySelectorAll('#media-tabs .tab-item').forEach(t => {
                if (t.dataset.pinnedToggle !== undefined) return; // leave the chip alone
                t.classList.remove('active');
            });
            tab.classList.add('active');
            state.currentFilter = tab.dataset.type || 'all';
            // Server-side filter: reset pagination + re-fetch with the new
            // ?type=. Without this, switching tabs would only filter what
            // we've already paginated client-side, hiding everything past
            // the first page (the "Photos shows 30" symptom).
            state.page = 1;
            state.hasMore = true;
            state.files = [];
            if (state.currentPage === 'viewer') {
                if (state.currentGroupId) loadGroupFiles(state.currentGroupId);
                else loadAllFiles();
            } else {
                renderMediaGrid();
            }
        });
    });
}

// ============ Utils ============
function setupLazyLoading() {
    state.imageObserver = new IntersectionObserver((entries) => {
        entries.forEach(e => {
            if (!e.isIntersecting) return;
            const el = e.target;
            // Reveal regardless of success/failure: a broken/404 thumb still
            // needs to drop out of the opacity:0 skeleton state, otherwise
            // the tile stays permanently invisible.
            const reveal = () => el.classList.add('loaded');
            if (el.tagName === 'VIDEO') {
                el.preload = 'metadata';
                el.onloadeddata = reveal;
                el.onerror = reveal;
            } else {
                el.onload = reveal;
                el.onerror = reveal;
            }
            el.src = el.dataset.src;
            el.removeAttribute('data-src');
            // Cached images can fire `load` synchronously when `src` is
            // set, before we even get here — without this, a re-rendered
            // grid full of cache hits would stay invisible forever.
            if (el.tagName === 'IMG' && el.complete) reveal();
            state.imageObserver.unobserve(el);
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

    // `rootMargin: '1200px'` makes the IntersectionObserver fire when
    // the sentinel is still ~1200 px BELOW the visible area, so the
    // next batch is requested long before the user actually runs out
    // of rows. Combined with FILES_PER_PAGE = 100, the gallery feels
    // smooth even on a fast flick scroll: by the time the user nears
    // the end of the current batch, the next 100 files have usually
    // already arrived.
    const observer = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting || state.loading || !state.hasMore) return;
        // currentGroupId === null on the All-Media surface — page through
        // /api/downloads/all instead of the per-group endpoint.
        if (state.currentPage !== 'viewer') return;
        state.page++;
        if (state.currentGroupId) loadGroupFiles(state.currentGroupId);
        else loadAllFiles();
    }, { rootMargin: '1200px 0px 1200px 0px' });
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
//
// Both purgeGroup() and purgeAll() are fire-and-forget — at 10k files
// the rm-rf takes minutes, well past Cloudflare's 100 s tunnel timeout.
// DELETE returns 200 with {started:true} immediately; the final result
// toast + UI refresh come from `group_purge_done` / `purge_all_done` WS
// events (subscribed once below). A 409 ALREADY_RUNNING means a sibling
// client started the same purge — we toast "started elsewhere" and let
// the WS event clean up state when it lands.

let _purgeWsWired = false;
function _wirePurgeWs() {
    if (_purgeWsWired) return;
    _purgeWsWired = true;

    ws.on('group_purge_done', (m) => {
        if (m?.error) {
            showToast(i18nTf('purge.group.failed', { msg: m.error }, 'Failed to delete: ' + m.error), 'error');
            return;
        }
        const d = m?.deleted || {};
        showToast(i18nTf('purge.group.success',
            { name: d.group, files: d.files, records: d.dbRecords },
            `Deleted "${d.group}" -- ${d.files} files, ${d.dbRecords} records`), 'success');
        const purgedId = m?.groupId;
        if (purgedId && String(state.currentGroupId) === String(purgedId)) {
            showAllMedia();
        }
        loadStats();
    });

    ws.on('purge_all_done', (m) => {
        if (m?.error) {
            showToast(i18nTf('purge.group.failed', { msg: m.error }, 'Failed to delete: ' + m.error), 'error');
            return;
        }
        const d = m?.deleted || {};
        showToast(i18nTf('purge.all.success',
            { files: d.files, records: d.dbRecords },
            `Deleted all -- ${d.files} files, ${d.dbRecords} records`), 'success');
        state.groups = [];
        state.downloads = [];
        state.files = [];
        state.allFiles = [];
        renderGroupsList();
        if (state.currentPage === 'groups') renderGroupsConfig();
        if (state.currentPage === 'viewer') showAllMedia();
        loadStats();
    });
}

/**
 * Delete a specific group -- files, DB, config, photo
 */
async function purgeGroup(groupId, groupName) {
    _wirePurgeWs();
    groupName = getGroupName(groupId, { fallback: groupName });
    if (!(await confirmSheet({
        title: i18nT('purge.group.title', 'Purge group data?'),
        message: i18nTf('purge.group.confirm', { name: groupName }, `Delete all data for "${groupName}"?\n\nFiles, database records, and configuration will be permanently removed.`),
        confirmLabel: i18nT('settings.danger.purge_all', 'Purge All Data'),
        danger: true,
    }))) return;

    try {
        showToast(i18nT('purge.group.deleting', 'Deleting...'), 'info');
        const r = await api.delete(`/api/groups/${encodeURIComponent(groupId)}/purge`);
        if (!r?.started && !r?.success) throw new Error('Failed to start');
        // Final toast + state refresh come from `group_purge_done` WS event.
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(i18nTf('purge.group.failed', { msg: e.message }, 'Failed to delete: ' + e.message), 'error');
    }
}

/**
 * Delete ALL data -- factory reset
 */
async function purgeAll() {
    _wirePurgeWs();
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
        const r = await api.delete('/api/purge/all');
        if (!r?.started && !r?.success) throw new Error('Failed to start');
        // Final toast + state reset come from `purge_all_done` WS event.
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(i18nTf('purge.group.failed', { msg: e.message }, 'Failed to delete: ' + e.message), 'error');
    }
}

// Start
init();
