/**
 * Telegram Media Downloader - Main App
 * Uses ES Modules — Complete Implementation
 */

import { state, getGroupName, updateGroupNameCache, isUnresolvedName } from './store.js';
import { api } from './api.js';
import { escapeHtml, getFileIcon, showToast, formatBytes } from './utils.js';
import { getThumbUrl, isPeerRow, initFileToken } from './media-url.js';
import * as Viewer from './viewer.js';
import { initEngine, handleEngineWsMessage } from './engine.js';
import { ws } from './ws.js';
import { initTheme, getTheme, setTheme } from './theme.js';
import { initStatusBar } from './statusbar.js';
import * as Notifications from './notifications.js';
import { initOnboarding, refreshOnboarding } from './onboarding.js';
import { initOnboardingDismiss } from './onboarding-dismiss.js';
import {
    getLatest as getMonitorStatusLatest,
    subscribe as subscribeMonitorStatus,
} from './monitor-status.js';
import { initReauthModal } from './reauth-modal.js';
import { initShortcuts } from './shortcuts.js';
import * as router from './router.js';
import * as Nav from './nav.js';
import { getGroup as getToolGroup } from './tools-catalog.js';
import { openSheet, confirmSheet } from './sheet.js';
import {
    renderChatRow,
    renderEmptyState,
    renderRowSkeletons,
    renderGallerySkeletons,
} from './components.js';
import { formatRelativeTime, formatDuration } from './utils.js';
import { attachPullToRefresh } from './gestures.js';
import {
    setupGallerySelect,
    exitSelectMode,
    repaintSelection,
    selectAllVisible,
    bulkDeleteTargets,
} from './gallery-select.js';
import {
    configureGalleryWindow,
    resetGalleryWindow,
    rerenderGalleryWindow,
    appendPositions,
    hasPendingBelow,
    extendBottom,
    removeFileIndex,
} from './gallery-virtual.js';
import {
    initI18n,
    setLang,
    getLang,
    applyToDOM as applyI18n,
    t as i18nT,
    tf as i18nTf,
} from './i18n.js';
import * as Fonts from './fonts.js';
import { showQueuePage, initQueue } from './queue.js';
import { initHeaderMobile, pushLogToNotify } from './header-mobile.js';
import { setupDragDropLink } from './dragdrop-link.js';
import { setupMiniPlayer, shrinkToMini, dismiss as dismissMiniPlayer } from './mini-player.js';
import { wireChangelogTrigger } from './changelog-viewer.js';
import * as WakeLock from './wake-lock.js';
import {
    setupGalleryToolbar,
    syncGalleryToolbar,
    resetGallerySearch,
    clearGallerySearch,
    setSearchResultCount,
    formatResultCount,
    isPinnedFirst,
    pinnedQs,
    getPinnedMode,
} from './gallery-toolbar.js';

// ============ Lazy page modules ============
//
// settings.js (~3.3k lines + its own imports) and backfill.js only matter
// once their page opens, so they're no longer part of the boot import
// graph. The first navigation (or a click on one of the few always-present
// controls that need them, e.g. sidebar Sign out) imports them; after boot
// they're also warmed up in idle time so that first use is instant.
// Relative dynamic imports get the server's `?v=` stamp like static ones.
let _settingsModule = null;
function loadSettingsModule() {
    if (!_settingsModule) {
        _settingsModule = import('./settings.js').catch((e) => {
            _settingsModule = null;
            throw e;
        });
    }
    return _settingsModule;
}
// Wrap a settings.js export as an event handler / global that loads the
// module on first call. Keeps `this` + arguments intact.
function settingsCall(name) {
    return function (...args) {
        return loadSettingsModule().then((m) => m[name].apply(this, args));
    };
}

let _backfillModule = null;
let _backfillLoaded = null; // resolved module, for synchronous teardown
function loadBackfillModule() {
    if (!_backfillModule) {
        _backfillModule = import('./backfill.js')
            .then((m) => {
                _backfillLoaded = m;
                return m;
            })
            .catch((e) => {
                _backfillModule = null;
                throw e;
            });
    }
    return _backfillModule;
}

// The one-step backfill sheet for a chat (Group Settings, empty chat
// gallery, chat header). `limit` preselects a preset (0 = all history).
function openBackfillFor(groupId, limit) {
    if (!groupId) return;
    loadBackfillModule()
        .then((m) => m.openBackfillSheet(groupId, limit == null ? {} : { limit }))
        .catch((e) => console.error('backfill sheet', e));
}

// Chat-only header actions (Backfill this chat) follow the open view.
function _syncChatHeaderActions() {
    const inChat = state.currentPage === 'viewer' && !!state.currentGroupId;
    document.body.classList.toggle('in-chat', inChat);
    // Inside a chat the header's avatar + name open its details (admins).
    const head = document.getElementById('header-avatar')?.parentElement;
    if (!head) return;
    const on = inChat && state.role === 'admin';
    head.classList.toggle('chat-head-link', on);
    if (on) {
        head.setAttribute('role', 'button');
        head.tabIndex = 0;
        head.setAttribute(
            'aria-label',
            i18nTf(
                'chat.details.open_for',
                { name: state.currentGroup || '' },
                `Chat settings: ${state.currentGroup || ''}`,
            ),
        );
    } else {
        head.removeAttribute('role');
        head.removeAttribute('tabindex');
        head.removeAttribute('aria-label');
    }
}

// Ways into a chat's details page from its gallery: a settings button
// next to "Backfill this chat" (phones: a ⋮ menu row) and a tap on the
// chat's avatar / name in the header. Added from here rather than in
// index.html so the header markup itself stays as it is.
function _setupChatDetailsEntry() {
    const open = () => {
        if (state.currentGroupId) openGroupSettings(state.currentGroupId);
    };
    const label = i18nT('chat.details.open', 'Chat settings');
    const bf = document.getElementById('backfill-chat-btn');
    if (bf && !document.getElementById('chat-details-btn')) {
        bf.insertAdjacentHTML(
            'beforebegin',
            `<button id="chat-details-btn" type="button" data-admin-only data-chat-only
                class="hidden sm:flex w-10 h-10 min-w-[44px] min-h-[44px] rounded-full hover:bg-tg-hover items-center justify-center"
                data-i18n-aria-label="chat.details.open" aria-label="${escapeHtml(label)}"
                data-i18n-title="chat.details.open" title="${escapeHtml(label)}">
                <i class="ri-settings-3-line text-xl text-tg-textSecondary" aria-hidden="true"></i>
            </button>`,
        );
        document.getElementById('chat-details-btn')?.addEventListener('click', open);
    }
    const row = document.querySelector('#header-overflow-menu [data-overflow="backfill-chat"]');
    if (row && !document.querySelector('[data-overflow="chat-details"]')) {
        row.insertAdjacentHTML(
            'beforebegin',
            `<button type="button" data-overflow="chat-details" data-admin-only data-chat-only role="menuitem">
                <i class="ri-settings-3-line"></i>
                <span class="vm-label" data-i18n="chat.details.open">${escapeHtml(label)}</span>
            </button>`,
        );
        document
            .querySelector('#header-overflow-menu [data-overflow="chat-details"]')
            ?.addEventListener('click', open);
    }
    const head = document.getElementById('header-avatar')?.parentElement;
    if (head) {
        head.addEventListener('click', (e) => {
            if (head.classList.contains('chat-head-link') && !e.target.closest('#role-pill'))
                open();
        });
        head.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && head.classList.contains('chat-head-link')) {
                e.preventDefault();
                open();
            }
        });
    }
}

// The Telegram account wizard (js/account-wizard.js) is a sheet. Links to
// #/account/add inside the dashboard open it where you are; the route
// itself (old links, a typed URL) still works — see registerRoutes().
function openAccountWizard() {
    return import('./account-wizard.js')
        .then((m) => m.openAccountWizard())
        .catch((e) => console.error('account wizard', e));
}
function _setupAccountWizardLinks() {
    document.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (!e.target.closest?.('a[href="#/account/add"]')) return;
        e.preventDefault();
        openAccountWizard();
    });
}

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
            try {
                fn();
            } catch (e) {
                console.error('scheduled render', e);
            }
        });
    }, RENDER_COALESCE_MS);
    _scheduledRenders.set(fn, handle);
}

// ============ Initialization ============
async function init() {
    // Install the in-SPA reauth modal BEFORE the first network call so
    // a 401 on /api/auth_check (or any subsequent admin endpoint) shows
    // a modal instead of a hard window.location redirect — the latter
    // wiped the SPA state and reloaded into /viewer regardless of where
    // the user was. The modal exposes window.__tgdlReauth which api.js
    // checks on every 401.
    try {
        initReauthModal();
    } catch (e) {
        console.warn('reauth-modal init failed', e);
    }

    // Resolve the session role BEFORE the SPA registers any UI — it drives
    // the body[data-role] CSS gate (admin-only DOM) and the router redirect
    // for guest sessions trying to deep-link into admin routes. Falls back
    // to admin on any failure so a transient network blip never accidentally
    // hides UI for a real admin (a guest fallback would block their own
    // dashboard until next reload).
    try {
        const ac = await api.get('/api/auth_check');
        state.role = ac?.role || 'admin';
    } catch {
        state.role = 'admin';
    }
    initFileToken();
    // Successful re-auth from the modal: refresh state.role + body
    // attribute so admin-only items become visible again WITHOUT a
    // page reload.
    try {
        window.addEventListener('tgdl:reauth-success', async () => {
            try {
                const ac = await api.get('/api/auth_check');
                state.role = ac?.role || 'admin';
                document.body.dataset.role = state.role;
                window.__tgdlRole = state.role;
            } catch {
                /* keep the fallback role */
            }
        });
    } catch {
        /* ignore */
    }
    document.body.dataset.role = state.role || '';
    // Mirror to a window global for router.js (which can't import store
    // without creating a cycle).
    try {
        window.__tgdlRole = state.role;
    } catch {}
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
    window.closeSidebar = closeSidebar;
    window.confirmDeleteFile = confirmDeleteFile;
    window.openBackfillSheet = openBackfillFor;
    document
        .getElementById('backfill-chat-btn')
        ?.addEventListener('click', () => openBackfillFor(state.currentGroupId));
    _setupChatDetailsEntry();
    _setupAccountWizardLinks();
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
    ws.on('log', (m) => {
        try {
            pushLogToNotify(m);
        } catch {}
    });
    ws.on('group_purged', () => loadGroups());
    ws.on('purge_all', () => loadGroups());
    // Footer counters ride the server's debounced `stats_update` push
    // (fired after every download_complete / file_deleted / bulk_delete /
    // purge / config change). Refetching /api/stats per file event, as
    // this module used to, flooded the server during backfills and
    // auto-prune sweeps. Re-sync once after a reconnect.
    ws.on('stats_update', (m) => _applyStats(m?.stats || m?.payload || null));
    ws.on('__ws_open', () => loadStats());
    // Auto-prune / disk-rotator / rescue sweeper all broadcast file_deleted —
    // drop the matching tile from the open gallery if any, otherwise just
    // refresh stats so disk-usage / file-count chip stay current. Surgical
    // (no full grid re-render, which on a thousand-tile gallery is a
    // visible jank): splice state.files in place and let the gallery
    // window drop the position + re-index the `data-index` of later tiles
    // so the viewer keeps opening the right file.
    const dropFileFromView = (m) => {
        const droppedPath = m?.path;
        const droppedId = m?.id;
        if (Array.isArray(state.files) && (droppedPath || droppedId != null)) {
            const isGallery = state.files === _galleryFilesRef;
            for (let i = state.files.length - 1; i >= 0; i--) {
                const f = state.files[i];
                // Prefer the row id: rows that share one file (download-time
                // dedup) share its path, and only this row went away.
                const hit =
                    droppedId != null
                        ? f.id === droppedId && (f.peer_id || 'self') === 'self'
                        : f.fullPath === droppedPath || f.path === droppedPath;
                if (!hit) continue;
                state.files.splice(i, 1);
                if (isGallery) removeFileIndex(i);
            }
            if (isGallery) {
                _renderedFileCount = state.files.length;
                if (state.files.length === 0) renderGalleryEmptyState();
            }
        }
    };
    ws.on('file_deleted', dropFileFromView);
    // Federated gallery live-refresh (Layer 1, v2.12+). Server broadcasts
    // peer_catalog_update on every peer_downloads insert / update / delete
    // (see src/core/cluster/ws-channel.js). When the operator's gallery
    // scope is anything but 'local' AND they're on the viewer page, refetch
    // the current page so peer changes appear without a manual reload.
    // Sidebar peer-groups list also re-pulls so newly-added peer groups
    // appear without waiting for the next /api/groups round-trip.
    ws.on('peer_catalog_update', () => {
        const scope = state.galleryScope;
        if (scope && scope !== 'local' && state.currentPage === 'viewer') {
            refreshCurrentPage();
        }
    });
    ws.on('peer_groups_update', () => {
        loadGroups();
    });
    ws.on('bulk_delete', () => {
        if (state.currentPage === 'viewer') refreshCurrentPage();
    });
    // Rescue Mode aggregate — fires once after every sweep. The per-row
    // `file_deleted` events above already kept the gallery + stats in
    // sync; the aggregate is just a friendly toast so the operator sees
    // the count without having to spot the size delta in the footer.
    // Quiet on empty sweeps (most ticks find nothing).
    ws.on('rescue_sweep_done', (m) => {
        const count = Number(m?.count) || 0;
        if (count <= 0) return;
        showToast(
            i18nTf('toast.rescue_swept', { count }, `Rescue: ${count} file(s) auto-pruned.`),
            'info',
        );
    });
    ws.on('config_updated', () => {
        if (state.currentPage === 'settings') settingsCall('loadSettings')();
        // Refresh the in-memory group cache so other pages (Backfill,
        // Sidebar, Manage Groups) see new/removed entries without a hard
        // reload. Stale `state.groups` was causing "History failed: Group
        // not configured" right after adding a group via Manage Groups,
        // because the Backfill page kept sending an id the new config
        // accepted but the old client snapshot didn't list anymore.
        loadGroups().catch(() => {});
    });
    // NSFW review tool — server fires `nsfw_progress` every batch and
    // `nsfw_done` when the scan finishes. We refresh the Maintenance
    // status line if the user is looking at it (so the progress bar
    // moves), and toast + browser-notify on completion regardless of
    // page so the admin doesn't miss a long background scan.
    ws.on('nsfw_progress', () => {
        if (state.currentPage === 'settings') {
            import('./nsfw-ui.js').then((m) => m.refreshNsfwStatus()).catch(() => {});
        }
    });
    ws.on('nsfw_done', (m) => {
        if (state.currentPage === 'settings') {
            import('./nsfw-ui.js').then((m2) => m2.refreshNsfwStatus()).catch(() => {});
        }
        const candidates = m?.candidates ?? 0;
        const msg =
            candidates > 0
                ? i18nTf(
                      'maintenance.nsfw.done_with_candidates',
                      { n: candidates },
                      `Scan done — ${candidates} possibly not 18+`,
                  )
                : i18nT('maintenance.nsfw.done_clean', 'Scan done — library is clean.');
        showToast(msg, 'info', 8000);
        try {
            Notifications.notifyGeneric?.('NSFW scan finished', msg);
        } catch {}
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
                    _setPageRaw('title', fresh);
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
        const cached = state.groupNameCache?.get?.(String(id));
        const cfg = (state.groups || []).find((g) => String(g.id) === String(id));
        const known = cached || (cfg && !isUnresolvedName(cfg.name, id));
        if (!known && !state._resolvingGroups && state.role === 'admin') {
            state._resolvingGroups = true;
            api.post('/api/groups/refresh-info')
                .catch(() => {})
                .finally(() => {
                    state._resolvingGroups = false;
                });
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
        if (on) state.activeRings.add(id);
        else state.activeRings.delete(id);
        if (had !== on) scheduleRender(renderGroupsList);
        // Wake-lock follows the active-rings count: any active ring → keep
        // the screen awake; queue drained → release. Feature-detected
        // inside wake-lock.js so unsupported browsers no-op silently.
        state.activeJobsCount = state.activeRings.size;
        WakeLock.acquireIfActive(state.activeJobsCount);
        WakeLock.releaseIfIdle(state.activeJobsCount);
    }
    ws.on('download_progress', (m) => {
        if (m.payload?.groupId) markRing(m.payload.groupId, true);
    });
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
    initStatusBar();
    if (isAdmin) {
        initOnboarding();
        // Must initialise AFTER initOnboarding so our monitor-status
        // subscriber lands later in the Set and runs after the banner
        // re-render — see onboarding-dismiss.js for why.
        initOnboardingDismiss();
        ws.on('config_updated', refreshOnboarding);
        ws.on('monitor_state', refreshOnboarding);
    }

    // Global keyboard shortcuts (press ? for the cheatsheet), and the
    // Go anywhere palette on Ctrl/Cmd+K + the header / sidebar buttons.
    initShortcuts();
    Nav.initNav();

    // Mobile-friendly header chrome: overflow ⋮ menu (collapses paste-link /
    // stories / view-mode / refresh on <640 px viewports) + notification
    // bell that surfaces server-side warn/error events without making the
    // operator open the maintenance Logs page.
    initHeaderMobile();

    // v2.6 polish — right-click context menu on gallery tiles, drag-drop
    // t.me URL onto the dashboard, mini-player handle, in-app changelog
    // viewer, screen wake-lock during downloads. Each module feature-
    // detects so unsupported browsers silently no-op.
    setupDragDropLink();
    setupMiniPlayer();
    wireChangelogTrigger();
    // Wake-lock visibility refresh — browser auto-releases on tab hide,
    // re-acquire when the tab comes back if jobs are still in flight.
    WakeLock.attachVisibilityRefresh(() => state.activeJobsCount || 0);

    // Groups feed the sidebar and the per-group route titles, so the first
    // route waits for them. Stats (footer counters; may scan the disk on a
    // cold cache) don't shape the first page and no longer delay it.
    await loadGroups();
    loadStats();

    // Federated gallery scope (Layer 1, v2.12+) — boot one-shot. Reads
    // /api/cluster/peers, hides the chip if no peers paired, otherwise
    // restores the operator's last-saved scope from localStorage and
    // wires the chip click handler. Admin-only: the endpoint 401s for
    // guests, the chip itself is `data-admin-only`. Only a saved non-local
    // scope changes the first gallery query, so only then does the first
    // route wait for the peer lookup.
    if (isAdmin) {
        const scopeReady = initGalleryScope().catch((e) => {
            console.warn('gallery scope init failed', e);
        });
        let savedScope = null;
        try {
            savedScope = localStorage.getItem('tgdl-gallery-scope');
        } catch {}
        if (savedScope && savedScope !== 'local') await scopeReady;
    }

    // First-load name resolve — admin-only because it POSTs and forces a
    // refresh side-effect. Guests see whatever names landed in the DB on
    // the last admin-side resolve. Endpoint is fire-and-forget; the
    // `groups_refreshed` broadcast handler above merges the resolved
    // names into the canonical cache when the job finishes.
    if (isAdmin && !state._resolvingGroups) {
        state._resolvingGroups = true;
        api.post('/api/groups/refresh-info')
            .catch(() => {})
            .finally(() => {
                state._resolvingGroups = false;
            });
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
    initMaintenanceTabs();
    // Warm the lazily-loaded page modules once the first route is up, so
    // the first Settings / Backfill visit doesn't wait on a fetch + parse.
    const warmPageModules = () => {
        loadSettingsModule().catch(() => {});
        if (isAdmin) loadBackfillModule().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(warmPageModules, { timeout: 5000 });
    } else {
        setTimeout(warmPageModules, 2000);
    }

    // Window bindings that depend on functions defined LATER in the
    // module. Pulled out from the main `window.*` block above (which
    // covers everything declared before init()) — these all live in the
    // setupFab / Settings / Viewer / etc. closures further down. Safe to
    // assign post-await because no inline onclick reaches them before
    // the operator clicks something.
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
        const VIEW_ICON = {
            grid: 'ri-layout-grid-line',
            compact: 'ri-grid-line',
            list: 'ri-list-check-2',
        };
        const applyViewMode = (mode) => {
            state.viewMode = mode;
            try {
                localStorage.setItem('tgdl-view-mode', mode);
            } catch {}
            const grid = document.getElementById('media-grid');
            if (grid) {
                grid.classList.remove('view-grid', 'view-compact', 'view-list');
                grid.classList.add(`view-${mode}`);
            }
            const icon = viewModeBtn.querySelector('i');
            if (icon)
                icon.className = `${VIEW_ICON[mode] || VIEW_ICON.grid} text-xl text-tg-textSecondary`;
            // Refresh the menu's active state so the checkmark follows.
            viewModeMenu.querySelectorAll('[data-vm]').forEach((b) => {
                b.dataset.active = b.dataset.vm === mode ? '1' : '0';
            });
        };
        const stored = (() => {
            try {
                return localStorage.getItem('tgdl-view-mode');
            } catch {
                return null;
            }
        })();
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
        viewModeMenu.querySelectorAll('[data-vm]').forEach((btn) => {
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
    window.applyPreset = settingsCall('applyPreset');
    // Manual Save button removed in v2.6 — auto-save handles every edit
    // 800 ms after the last change, with the inline pill + notification
    // bell entry for confirmation. The legacy `Settings.saveSettings`
    // export stays callable for tests + power users who reach for the
    // console, just no longer wired to a button.
    document
        .getElementById('save-api-credentials')
        ?.addEventListener('click', settingsCall('saveApiCredentials'));
    document
        .getElementById('change-password-btn')
        ?.addEventListener('click', settingsCall('changePassword'));
    document.getElementById('logout-btn')?.addEventListener('click', settingsCall('signOut'));
    // Sidebar footer sign-out — gated behind confirmSheet because the
    // button sits in always-visible chrome and is one accidental tap away
    // from booting the operator. The deeper Settings button stays no-confirm
    // (deliberate path = deliberate intent).
    document.getElementById('sidebar-logout-btn')?.addEventListener('click', async () => {
        const ok = await confirmSheet({
            title: i18nT('sidebar.signout.confirm_title', 'Sign out of the dashboard?'),
            message: i18nT(
                'sidebar.signout.confirm_body',
                "You'll need to log in again on the next visit. Telegram accounts and downloads stay put.",
            ),
            confirmLabel: i18nT('sidebar.signout', 'Sign out'),
            danger: true,
        });
        if (ok) settingsCall('signOut')();
    });
    document.getElementById('proxy-save')?.addEventListener('click', settingsCall('saveProxy'));
    document.getElementById('proxy-test')?.addEventListener('click', settingsCall('testProxy'));
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
        onSelectMode: () => updateSelectionBar(),
        // Every loaded file of the view, not only the tiles the DOM window
        // holds right now.
        allPaths: () => _selectableFiles().map((f) => f.fullPath),
        deleteSelected: () => {
            const btn = document.getElementById('selection-delete');
            if (btn) btn.click();
        },
    });
    _setupSelectHint();
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
    document.querySelectorAll('[data-theme-set]').forEach((btn) => {
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
        try {
            _backfillLoaded?.stopBackfillPage();
        } catch {}
    }
    // Cluster page polls /api/cluster/peers every 30 s — stop it when the
    // page goes away (init() restarts it on the next visit). The module is
    // already loaded, so this import resolves from the module map.
    if (state.currentPage === 'maintenance-cluster' && page !== 'maintenance-cluster') {
        import('./maintenance-cluster.js').then((m) => m.destroy?.()).catch(() => {});
    }
    const prevPage = state.currentPage;
    // Leaving a chat's details page: send an edit that's still waiting.
    if (prevPage === 'chat' && page !== 'chat') {
        _chatDetailsModule?.then((m) => m.leaveChatDetails()).catch(() => {});
    }
    if (page === 'chat') {
        // The page's container is created by js/chat-details.js; make sure
        // it's there before the show/hide pass below.
        if (!document.getElementById('page-chat')) {
            const el = document.createElement('div');
            el.id = 'page-chat';
            el.className = 'hidden';
            document.getElementById('content-area')?.appendChild(el);
        }
    }
    const contentArea = document.getElementById('content-area');
    // #content-area is shared by every page. Remember where the gallery
    // was so coming back to the Library lands on the same tile, and
    // start every other page at the top instead of at whatever offset
    // the previous page was scrolled to.
    if (contentArea && prevPage !== page) {
        if (prevPage === 'viewer') _viewerScrollTop = contentArea.scrollTop;
        if (prevPage === 'groups') _groupsScrollTop = contentArea.scrollTop;
        contentArea.scrollTop = 0;
    }
    state.currentPage = page;
    document.body.dataset.page = page;
    _syncChatHeaderActions();
    updateSelectionBar();
    state.currentRouteParams = params;

    // The nav place (Library / Chats / Queue / Settings) the page belongs
    // to — js/nav.js. Callers may override it (e.g. `#/engine`).
    const navKey = Nav.navPlace(params.navKey || page);

    document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${navKey}"]`)?.classList.add('active');

    // Bottom-nav active state
    document.querySelectorAll('.bottom-nav-item').forEach((el) => el.classList.remove('active'));
    document.querySelector(`.bottom-nav-item[data-nav="${navKey}"]`)?.classList.add('active');

    document
        .querySelectorAll('#content-area > div[id^="page-"]')
        .forEach((el) => el.classList.add('hidden'));
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
    Nav.syncShell(page);

    if (page === 'settings') {
        // Auto-save: every Setting input is watched and a debounced
        // POST /api/config flushes 800 ms after the last edit. Manual
        // Save button still works as an early-flush escape hatch. Guests
        // can't write config so we skip the binding for them entirely.
        loadSettingsModule()
            .then((Settings) => {
                Settings.loadSettings();
                if (state.role === 'admin') Settings.setupAutoSave();
            })
            .catch((e) => console.error('settings page', e));
        import('./settings-search.js')
            .then((m) => m.initSettingsSearch())
            .catch((e) => console.error('settings search', e));
        if (state.role === 'admin') {
            import('./tools-hub.js')
                .then((m) => m.initToolsCard())
                .catch((e) => console.error('tools card', e));
        }
        // Engine controls live in the admin-only System section; guests
        // never see the card, and `initEngine` polls /api/monitor/status
        // (admin-gated) so skip it for them.
        if (state.role === 'admin') initEngine();
        _setPageText('title', 'settings.page.title', 'Settings');
        _setPageText('subtitle', 'settings.page.subtitle', 'System Configuration');
        // Optional deep-link: #/settings/<section> scrolls to that section
        // (#settings-<anchor> first — see Nav.scrollToSettingsSection).
        if (params.section) {
            setTimeout(() => Nav.scrollToSettingsSection(params.section, { smooth: false }), 80);
        }
    } else if (page === 'groups') {
        renderGroupsConfig({ restoreScroll: prevPage === 'chat' });
        _setPageText('title', 'groups.page.title', 'Manage Groups');
        _setPageText('subtitle', 'groups.page.subtitle', 'Configure monitoring and filters');
    } else if (page === 'chat') {
        const name = getGroupName(params.groupId);
        _setPageRaw('title', name);
        _setPageText('subtitle', 'chat.details.subtitle', 'Chat settings');
        updateHeaderAvatar(params.groupId, name);
        loadChatDetailsModule()
            .then((m) => {
                if (state.currentPage !== 'chat') return;
                m.showChatDetails({
                    ...params,
                    // The page learned the chat's real name (not configured,
                    // nothing downloaded yet): put it in the header too.
                    onName: (n) => {
                        if (state.currentPage !== 'chat') return;
                        _setPageRaw('title', n);
                        updateHeaderAvatar(params.groupId, n);
                    },
                });
            })
            .catch((e) => console.error('chat details', e));
    } else if (page === 'viewer') {
        if (state.currentGroup && !params.allMedia) {
            _setPageRaw('title', state.currentGroup);
            // Back in a chat's gallery from another page: its avatar, not
            // the generic gallery glyph setHeaderPageIcon() just put there.
            updateHeaderAvatar(state.currentGroupId, state.currentGroup);
            // Returning to an already-loaded group gallery: keep the grid
            // and put the scroll + file count back.
            if (prevPage !== 'viewer' && _galleryLoadedFor(_galleryViewKey())) {
                _restoreGalleryChrome();
            }
        } else {
            const opts = _allMediaOpts;
            _allMediaOpts = null;
            showAllMedia(opts || undefined);
        }
    } else if (page === 'backfill') {
        _setPageText('title', 'backfill.page.title', 'Backfill');
        _setPageText('subtitle', 'backfill.page.subtitle', 'Pull older messages into the queue');
        // Show the page first; backfill module loads server state then renders.
        loadBackfillModule()
            .then((m) => m.showBackfillPage(params))
            .catch((e) => console.error('backfill page', e));
    } else if (page === 'queue') {
        _setPageText('title', 'queue.page.title', 'Queue');
        _setPageText(
            'subtitle',
            'queue.page.subtitle',
            'Active + pending + recently finished downloads',
        );
        showQueuePage(params).catch((e) => console.error('queue page', e));
    } else if (page === 'maintenance') {
        // A Tools group page (#/settings/tools/<group>) — js/tools-hub.js.
        const group = getToolGroup(params.group);
        if (group) _setPageText('title', group.title[0], group.title[1]);
        _setPageText('subtitle', 'tools.title', 'Tools');
        import('./tools-hub.js')
            .then((m) => m.showGroupPage(params))
            .catch((e) => console.error('tools group', e));
    } else if (page === 'maintenance-duplicates') {
        _setPageText('title', 'maintenance.duplicates.title', 'Find duplicate files');
        _setPageText(
            'subtitle',
            'maintenance.duplicates.subtitle',
            'Hash every file and reclaim space from byte-identical copies',
        );
        import('./maintenance-duplicates.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-duplicates', e));
    } else if (page === 'maintenance-thumbs') {
        _setPageText('title', 'maintenance.thumbs.page_title', 'Build thumbnails');
        _setPageText(
            'subtitle',
            'maintenance.thumbs.subtitle',
            'Generate WebP previews for older files',
        );
        import('./maintenance-thumbs.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-thumbs', e));
    } else if (page === 'maintenance-seekbar') {
        _setPageText('title', 'maintenance.seekbar.page_title', 'Seekbar previews');
        _setPageText(
            'subtitle',
            'maintenance.seekbar.subtitle',
            'Generate WebP sprite sheets for video hover-preview thumbnails.',
        );
        import('./maintenance-seekbar.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-seekbar', e));
    } else if (page === 'maintenance-video') {
        _setPageText('title', 'maintenance.video.page_title', 'Optimise videos for streaming');
        _setPageText(
            'subtitle',
            'maintenance.video.subtitle',
            'Rewrite MP4s with `+faststart` so the HTML5 player can seek + play audio without buffering the whole file.',
        );
        import('./maintenance-video.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-video', e));
    } else if (page === 'maintenance-nsfw') {
        _setPageText('title', 'maintenance.nsfw.page_title', 'NSFW review');
        _setPageText(
            'subtitle',
            'maintenance.nsfw.subtitle',
            "Five-tier classifier review — keep what's confidently 18+, delete what's confidently not, eyeball the borderline cases.",
        );
        import('./maintenance-nsfw.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-nsfw', e));
    } else if (page === 'maintenance-ai') {
        _setPageText('title', 'maintenance.ai.page_title', 'AI Face Clustering');
        _setPageText(
            'subtitle',
            'maintenance.ai.subtitle',
            'Face clustering groups people across your library — all running locally.',
        );
        import('./maintenance-ai.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-ai', e));
    } else if (page === 'maintenance-logs') {
        _setPageText('title', 'maintenance.logs.page_title', 'Log viewer');
        _setPageText(
            'subtitle',
            'maintenance.logs.subtitle',
            'Realtime tail of every backend log source',
        );
        import('./maintenance-logs.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-logs', e));
    } else if (page === 'maintenance-backup') {
        _setPageText('title', 'maintenance.backup.page_title', 'Backup destinations');
        _setPageText(
            'subtitle',
            'maintenance.backup.subtitle',
            'Mirror new downloads to S3 / SFTP / local NAS storage',
        );
        import('./maintenance-backup.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-backup', e));
    } else if (page === 'maintenance-cluster') {
        _setPageText('title', 'maintenance.cluster.page_title', 'Cluster');
        _setPageText(
            'subtitle',
            'maintenance.cluster.subtitle',
            'Federate multiple instances. Files, downloads, and dedup span every paired peer.',
        );
        import('./maintenance-cluster.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-cluster', e));
    } else if (page === 'maintenance-recovery') {
        _setPageText('title', 'maintenance.recovery.page_title', 'Recovery cleanup');
        _setPageText(
            'subtitle',
            'maintenance.recovery.subtitle',
            'Resolve, disable, or delete groups that no loaded account can access.',
        );
        import('./maintenance-recovery.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-recovery', e));
    } else if (page === 'maintenance-updates') {
        _setPageText('title', 'update.history.title', 'Update history');
        _setPageText(
            'subtitle',
            'update.history.help',
            'Audit log of every Install update click — the structured error code makes repeat failures easy to diagnose.',
        );
        import('./maintenance-updates.js')
            .then((m) => m.init())
            .catch((e) => console.error('maintenance-updates', e));
    }
}

// Register hash routes. Patterns documented in router.js.
function registerRoutes() {
    // Tools pages + the old #/maintenance hashes (js/nav.js). First, so
    // `/settings/tools/...` wins over `/settings/:section` below.
    Nav.registerNavRoutes(router, renderPage);
    // #/viewer is All Media; a chat's gallery is #/viewer/<id>.
    router.route('/viewer', () => renderPage('viewer', { allMedia: true }));
    router.route('/viewer/:groupId', ({ params, query }) => {
        const id = params.groupId;
        // Back / forward to the chat that's already loaded: keep its grid,
        // filters and scroll position.
        if (
            String(state.currentGroupId) === String(id) &&
            (state.viewerPeerScope || null) === (query.peer || null) &&
            _galleryLoadedFor(_galleryViewKey())
        ) {
            renderPage('viewer');
            return;
        }
        state.viewerPeerScope = query.peer || null;
        // Resolve through the canonical lookup so deep-linking to a group
        // whose name was only just refreshed still picks it up.
        _showGroup(id, getGroupName(id));
    });
    router.route('/groups', () => renderPage('groups'));
    router.route('/groups/:groupId', ({ params }) => {
        // Chat details page. `from` (the page we're coming from, unset on
        // a deep link) lets its Back button step back instead of pushing.
        const from = document.body.dataset.page || null;
        renderPage('chat', {
            groupId: params.groupId,
            navKey: 'groups',
            from,
            fromGroup: from === 'viewer' ? state.currentGroupId || null : null,
        });
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
            state.currentRouteParams = {
                ...(state.currentRouteParams || {}),
                section: params.section,
            };
            // Also lights up the matching chip straight away.
            Nav.scrollToSettingsSection(params.section);
            return;
        }
        renderPage('settings', { section: params.section });
    });
    router.route('/backfill', () => renderPage('backfill'));
    router.route('/backfill/:groupId', ({ params }) =>
        renderPage('backfill', { groupId: params.groupId }),
    );
    router.route('/queue', () => renderPage('queue'));
    router.route('/queue/:status', ({ params }) => renderPage('queue', { status: params.status }));
    router.route('/stories', () => {
        // /stories is a one-shot trigger that opens the Stories sheet
        // ON TOP of the Viewer. The actual page is the gallery; the
        // sheet handles its own lifecycle. Use replace: true so the
        // hash doesn't sit in the back-stack (otherwise the back button
        // re-fires this handler and re-opens the sheet long after the
        // user moved on).
        renderPage('viewer');
        // Drop the /stories hash so back-button doesn't re-trigger. Done
        // BEFORE opening the sheet: the sheet pushes its own (Back-to-
        // close) history entry, which this replace must not clobber.
        try {
            history.replaceState(
                null,
                '',
                state.currentGroupId != null
                    ? `#/viewer/${encodeURIComponent(String(state.currentGroupId))}`
                    : '#/viewer',
            );
        } catch {
            /* ignore */
        }
        const btn = document.getElementById('stories-btn');
        if (btn) {
            btn.click();
        }
    });
    router.route('/account/add', () => {
        // In-app sheet over Settings → Accounts (add-account.html still
        // works for old links).
        import('./account-wizard.js')
            .then((m) =>
                m.openAccountWizardFromRoute(() => renderPage('settings', { section: 'accounts' })),
            )
            .catch((e) => {
                console.error('account wizard', e);
                window.location.href = '/add-account.html';
            });
    });
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

// Section config for the categorized sidebar. Order = render order.
const _SIDEBAR_SECTIONS = [
    { key: 'channel', icon: 'ri-megaphone-line', label: 'Channels' },
    { key: 'group', icon: 'ri-group-line', label: 'Groups' },
    { key: 'user', icon: 'ri-user-line', label: 'DMs' },
    { key: 'bot', icon: 'ri-robot-2-line', label: 'Bots' },
    { key: 'folder', icon: 'ri-folder-3-line', label: 'Folders' },
];

function _classifyGroupType(g) {
    const t = String(g.type || '').toLowerCase();
    if (t === 'channel') return 'channel';
    if (t === 'group' || t === 'supergroup') return 'group';
    if (t === 'user') return 'user';
    if (t === 'bot') return 'bot';
    if (t === 'folder') return 'folder';
    if (t === 'config') {
        const cfgGroup = (state.groups || []).find((cg) => String(cg.id) === String(g.id));
        const ct = String(cfgGroup?.type || '').toLowerCase();
        if (ct === 'channel') return 'channel';
        if (ct === 'group' || ct === 'supergroup') return 'group';
        if (ct === 'user') return 'user';
        if (ct === 'bot') return 'bot';
    }
    return 'folder';
}

function _buildGroupRow(g) {
    const id = String(g.downloadId || g.id || g.name);
    const canonical = getGroupName(id, {
        fallback: i18nT('groups.unknown_chat', 'Unknown chat'),
    });
    const stillUnresolved = isUnresolvedName(g.name, id) && !state.groupNameCache?.get?.(id);
    if (stillUnresolved) renderGroupsList._needsResolve = true;
    const isForeign = !!g.peerId;
    const subtitle = isForeign
        ? i18nTf(
              'sidebar.group.peer_badge',
              { peer: g.peerName || g.peerId.slice(0, 12) },
              `from ${g.peerName || g.peerId.slice(0, 12)}`,
          )
        : stillUnresolved
          ? i18nTf(
                'groups.resolving',
                { count: g.totalFiles || 0 },
                `Resolving… · ${g.totalFiles || 0} files`,
            )
          : i18nTf(
                'groups.files_size',
                { count: g.totalFiles || 0, size: g.sizeFormatted || '0 B' },
                `${g.totalFiles || 0} files · ${g.sizeFormatted || '0 B'}`,
            );
    const ring = !isForeign && state.activeRings.has(id) ? 'downloading' : null;
    const cfgGroup = isForeign ? null : (state.groups || []).find((cg) => String(cg.id) === id);
    const monitorEnabled =
        state.role === 'admin' && cfgGroup && !cfgGroup.suspended
            ? cfgGroup.enabled !== false
            : null;
    const sidebarPill =
        cfgGroup?.suspended === true
            ? { label: i18nT('groups.status.suspended', 'Suspended'), kind: 'suspended' }
            : null;
    return renderChatRow({
        id,
        name: canonical,
        subtitle,
        avatarType: g._sectionType || g.type,
        avatarRing: ring,
        avatarDot: ring ? 'monitor' : null,
        time: g.lastDownloadAt ? formatRelativeTime(g.lastDownloadAt) : '',
        selected: state.currentGroupId === id,
        statusPill: sidebarPill,
        cog: !isForeign && state.role === 'admin',
        monitorEnabled,
        peerId: g.peerId || null,
        peerName: g.peerName || null,
    });
}

function _renderSectionHeader(sec, monitored, total, collapsed) {
    const chevron = collapsed ? 'ri-arrow-right-s-line' : 'ri-arrow-down-s-line';
    const countLabel = `${monitored}/${total}`;
    return `<button type="button" class="sidebar-section-header w-full px-3 py-1.5 text-[11px] text-tg-textSecondary uppercase tracking-wide flex items-center gap-1.5 hover:bg-tg-hover/40 transition-colors select-none"
                    data-section="${sec.key}" aria-expanded="${!collapsed}">
        <i class="${chevron} text-sm transition-transform sidebar-section-chevron"></i>
        <i class="${sec.icon} text-sm"></i>
        <span class="flex-1 text-left">${sec.label}</span>
        <span class="text-[10px] font-mono tabular-nums ${monitored > 0 ? 'text-tg-green' : ''}">${countLabel}</span>
    </button>`;
}

const _sidebarSectionKey = (k) => `tgdl.sidebar.section.${k}`;
function _isSidebarSectionCollapsed(k) {
    return localStorage.getItem(_sidebarSectionKey(k)) === '1';
}

// One delegated listener pair on #groups-list, wired once. The rows keep
// their DOM whenever the rendered HTML is unchanged, so attaching
// per-row handlers on every render stacked them: after N config_updated
// events one tap ran openGroup N times and the monitor toggle sent N PUTs.
//
// Click opens the group viewer; the cog opens Group Settings; the ▶/⏸
// button toggles monitoring. Names are re-resolved at click time via
// getGroupName() so a refreshed name wins over whatever the row was
// rendered with. Federated foreign rows carry data-peer-id; clicking one
// opens the per-group view filtered to that peer via the one-shot
// `state.viewerPeerScope` field. We DO NOT overwrite the chip's scope
// (state.galleryScope) — otherwise, navigating back to All Media after
// viewing a peer-owned group would persist the per-peer narrowing.
let _groupsListWired = false;
function _wireGroupsListDelegation(list) {
    if (_groupsListWired) return;
    _groupsListWired = true;
    const openRow = (row) => {
        const id = row.dataset.id;
        // Foreign-group click → narrow the per-group view to this peer
        // for the duration of the view (read by _galleryScopeQs on every
        // page fetch so pagination keeps the filter). Own group → null,
        // so the per-group view honours the chip's scope.
        state.viewerPeerScope = row.dataset.peerId || null;
        openGroup(id, getGroupName(id));
    };
    list.addEventListener('click', async (ev) => {
        const header = ev.target.closest?.('.sidebar-section-header');
        if (header && list.contains(header)) {
            ev.stopPropagation();
            const key = header.dataset.section;
            localStorage.setItem(
                _sidebarSectionKey(key),
                _isSidebarSectionCollapsed(key) ? '' : '1',
            );
            renderGroupsList();
            return;
        }
        const row = ev.target.closest?.('.chat-row[data-id]');
        if (!row || !list.contains(row)) return;
        const id = row.dataset.id;
        // Monitor toggle (▶/⏸) — short-circuit before the row navigates.
        // PUTs `{enabled: !current}` to the existing /api/groups/:id
        // endpoint; the WS `config_updated` broadcast triggers
        // renderGroupsList() so the icon swaps live.
        const monTarget = ev.target.closest?.('[data-action="monitor-toggle"]');
        if (monTarget) {
            ev.stopPropagation();
            ev.preventDefault();
            // A PUT for this button is already in flight — ignore the
            // repeat tap instead of racing a second toggle.
            if (monTarget.dataset.busy === '1') return;
            monTarget.dataset.busy = '1';
            const current = monTarget.dataset.current === '1';
            const next = !current;
            // Optimistic UI — flip the icon + dataset before the PUT
            // returns so the click feels instant.
            monTarget.dataset.current = next ? '1' : '0';
            const ic = monTarget.querySelector('i');
            if (ic) {
                ic.className = `${next ? 'ri-pause-circle-line' : 'ri-play-circle-line'} text-base`;
            }
            monTarget.classList.toggle('text-tg-green', next);
            monTarget.classList.toggle('text-tg-textSecondary', !next);
            try {
                await api.put(`/api/groups/${encodeURIComponent(id)}`, { enabled: next });
                // Update the in-memory `state.groups` so the next
                // renderGroupsList() pass paints the right state even
                // before the WS reply lands.
                const cfg = (state.groups || []).find((g) => String(g.id) === id);
                if (cfg) cfg.enabled = next;
            } catch (err) {
                // Roll back the optimistic flip on failure.
                monTarget.dataset.current = current ? '1' : '0';
                if (ic) {
                    ic.className = `${current ? 'ri-pause-circle-line' : 'ri-play-circle-line'} text-base`;
                }
                monTarget.classList.toggle('text-tg-green', current);
                monTarget.classList.toggle('text-tg-textSecondary', !current);
                showToast(err?.data?.error || err?.message || 'Failed', 'error');
            } finally {
                delete monTarget.dataset.busy;
            }
            return;
        }
        // Cog button takes precedence — short-circuit before the row
        // navigates to the gallery.
        if (ev.target.closest?.('[data-action="settings"]')) {
            ev.stopPropagation();
            ev.preventDefault();
            openGroupSettings(id, getGroupName(id));
            return;
        }
        openRow(row);
    });
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Only when the row itself has focus — Enter/Space on the inner
        // cog / monitor buttons keeps its native button behaviour.
        const row = e.target.closest?.('.chat-row[data-id]');
        if (!row || e.target !== row || !list.contains(row)) return;
        e.preventDefault();
        openRow(row);
    });
}

function renderGroupsList() {
    const list = document.getElementById('groups-list');
    if (!list) return;

    const map = new Map();
    state.groups.forEach((g) => {
        map.set(String(g.id), {
            ...g,
            downloadId: String(g.id),
            totalFiles: 0,
            sizeFormatted: '0 B',
            type: g.type || 'config',
        });
    });
    state.downloads.forEach((d) => {
        const key = String(d.id);
        if (map.has(key)) {
            const existing = map.get(key);
            existing.totalFiles = d.totalFiles;
            existing.sizeFormatted = d.sizeFormatted;
            existing.downloadId = d.id;
        } else {
            map.set(key, {
                name: d.name,
                id: d.id,
                downloadId: d.id,
                totalFiles: d.totalFiles,
                sizeFormatted: d.sizeFormatted,
                type: d.type || 'folder',
            });
        }
    });

    const allGroups = Array.from(map.values());
    _wireGroupsListDelegation(list);
    if (allGroups.length === 0) {
        renderGroupsList._lastHtml = null;
        list.innerHTML = renderEmptyState({
            icon: 'ri-chat-3-line',
            title: i18nT('groups.empty.title', 'No groups yet'),
            body: i18nT(
                'groups.empty.body',
                'Add a Telegram chat from the Chats page to start downloading.',
            ),
            actionLabel: i18nT('groups.empty.cta', 'Browse chats'),
            actionHref: '#/groups',
        });
        return;
    }

    state.activeRings = state.activeRings || new Set();
    renderGroupsList._needsResolve = false;

    // Classify into sections
    const buckets = {};
    for (const sec of _SIDEBAR_SECTIONS) buckets[sec.key] = [];
    for (const g of allGroups) {
        const cat = _classifyGroupType(g);
        g._sectionType = cat;
        if (!buckets[cat]) buckets[cat] = [];
        buckets[cat].push(g);
    }

    // Sort within each section: monitored first, then by totalFiles desc
    const _monitorScore = (g) => {
        const cfg = (state.groups || []).find((cg) => String(cg.id) === String(g.id));
        if (!cfg) return 2; // download-only → after paused
        if (cfg.suspended) return 3;
        return cfg.enabled !== false ? 0 : 1;
    };
    for (const key of Object.keys(buckets)) {
        buckets[key].sort(
            (a, b) =>
                _monitorScore(a) - _monitorScore(b) || (b.totalFiles || 0) - (a.totalFiles || 0),
        );
    }

    const _isCollapsed = _isSidebarSectionCollapsed;

    // Build HTML section by section
    const parts = [];
    for (const sec of _SIDEBAR_SECTIONS) {
        const items = buckets[sec.key];
        if (!items || items.length === 0) continue;
        const monitored = items.filter((g) => _monitorScore(g) === 0).length;
        const collapsed = _isCollapsed(sec.key);
        parts.push(_renderSectionHeader(sec, monitored, items.length, collapsed));

        const monItems = items.filter((g) => _monitorScore(g) === 0);
        const otherItems = items.filter((g) => _monitorScore(g) > 0);
        const hiddenAttr = collapsed ? ' hidden' : '';
        for (const g of monItems) {
            const row = _buildGroupRow(g);
            parts.push(
                collapsed ? row.replace('class="chat-row', `class="chat-row${hiddenAttr}`) : row,
            );
        }
        if (monItems.length > 0 && otherItems.length > 0) {
            parts.push(
                `<div class="sidebar-section-sep mx-3 my-1 border-t border-dashed border-tg-border/40"${hiddenAttr}></div>`,
            );
        }
        for (const g of otherItems) {
            const row = _buildGroupRow(g);
            parts.push(
                collapsed ? row.replace('class="chat-row', `class="chat-row${hiddenAttr}`) : row,
            );
        }
    }

    const html = parts.join('');

    if (renderGroupsList._lastHtml !== html) {
        renderGroupsList._lastHtml = html;
        list.innerHTML = html;
        _reapplySidebarFilter();
    }

    const needsResolve = renderGroupsList._needsResolve;
    if (needsResolve && !state._resolvingGroups && state.role === 'admin') {
        state._resolvingGroups = true;
        api.post('/api/groups/refresh-info')
            .catch(() => {})
            .finally(() => {
                state._resolvingGroups = false;
            });
    }
}

function normalize(str) {
    return String(str || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

// ============ Open Group / Show All ============
// Open a chat's gallery. Goes through the hash (#/viewer/<id>, plus
// ?peer= for a peer's chat) so the chat has its own URL: reload, Back
// and shared links land on it. The route runs _showGroup().
function openGroup(groupId, groupName) {
    const peer = state.viewerPeerScope ? `?peer=${encodeURIComponent(state.viewerPeerScope)}` : '';
    const target = `viewer/${encodeURIComponent(String(groupId))}${peer}`;
    // Clicking the chat that's already open reloads it.
    if (location.hash === `#/${target}`) _showGroup(groupId, groupName);
    else navigateTo(target);
}

function _showGroup(groupId, groupName) {
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

    renderPage('viewer');
    _setPageRaw('title', state.currentGroup);
    _setPageText('subtitle', 'viewer.subtitle.loading', 'Loading...');
    // Mirror the sidebar avatar into the header so the user sees which
    // chat they're inside (after renderPage, which sets the page glyph).
    // Falls back to a coloured initial when there's no profile photo yet.
    updateHeaderAvatar(groupId, state.currentGroup);
    loadGroupFiles(groupId);
}

// Per-page icon for the header avatar slot when no group is selected.
// Picks an icon + a stable colour slot so each page reads as itself
// instead of all sharing the gallery glyph from the viewer page.
const PAGE_HEADER_ICON = {
    viewer: 'ri-gallery-line',
    groups: 'ri-group-line',
    backfill: 'ri-history-line',
    queue: 'ri-list-check-2',
    settings: 'ri-settings-3-line',
    maintenance: 'ri-tools-line',
    'maintenance-duplicates': 'ri-file-copy-2-line',
    'maintenance-thumbs': 'ri-image-line',
    'maintenance-seekbar': 'ri-movie-line',
    'maintenance-video': 'ri-film-line',
    'maintenance-nsfw': 'ri-shield-check-line',
    'maintenance-ai': 'ri-sparkling-2-line',
    'maintenance-logs': 'ri-terminal-box-line',
    'maintenance-backup': 'ri-cloud-line',
    'maintenance-cluster': 'ri-broadcast-line',
    'maintenance-recovery': 'ri-first-aid-kit-line',
    'maintenance-updates': 'ri-download-cloud-2-line',
};

// Sync the scroll-left / scroll-right fade classes on the tab strip.
function _syncTabScrollFades(scrollEl) {
    const atLeft = scrollEl.scrollLeft <= 2;
    const atRight = scrollEl.scrollLeft >= scrollEl.scrollWidth - scrollEl.clientWidth - 2;
    scrollEl.classList.toggle('scroll-left', !atLeft);
    scrollEl.classList.toggle('scroll-right', !atRight);
}

// Wire scroll-fade hints, wheel→horizontal, and ResizeObserver for the tab strip.
function initMaintenanceTabs() {
    const scrollEl = document.querySelector('.maintenance-tabs-scroll');
    if (!scrollEl) return;
    scrollEl.addEventListener('scroll', () => _syncTabScrollFades(scrollEl), { passive: true });
    new ResizeObserver(() => _syncTabScrollFades(scrollEl)).observe(scrollEl);
    // Desktop: vertical wheel → horizontal scroll (trackpad native deltaX passes through).
    scrollEl.addEventListener(
        'wheel',
        (e) => {
            if (Math.abs(e.deltaX) > 4) return;
            e.preventDefault();
            scrollEl.scrollLeft += e.deltaY;
        },
        { passive: false },
    );
    _syncTabScrollFades(scrollEl);
}

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
        if (isActive) {
            t.setAttribute('aria-selected', 'true');
            // Scroll the active tab into view within the strip (without moving the page).
            const scrollEl = t.closest('.maintenance-tabs-scroll');
            if (scrollEl) {
                requestAnimationFrame(() => {
                    const pad = 8;
                    const tLeft = t.offsetLeft - scrollEl.offsetLeft;
                    const tRight = tLeft + t.offsetWidth;
                    if (tLeft - pad < scrollEl.scrollLeft) {
                        scrollEl.scrollLeft = tLeft - pad;
                    } else if (tRight + pad > scrollEl.scrollLeft + scrollEl.clientWidth) {
                        scrollEl.scrollLeft = tRight + pad - scrollEl.clientWidth;
                    }
                    _syncTabScrollFades(scrollEl);
                });
            }
        } else {
            t.removeAttribute('aria-selected');
        }
    });
}

function setHeaderPageIcon(page) {
    const el = document.getElementById('header-avatar');
    if (!el) return;
    const icon = PAGE_HEADER_ICON[page] || 'ri-gallery-line';
    el.className =
        'tg-avatar tg-avatar-1 w-10 h-10 text-lg flex-shrink-0 flex items-center justify-center text-white';
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
        el.className =
            'tg-avatar tg-avatar-1 w-10 h-10 text-lg flex-shrink-0 flex items-center justify-center text-white';
        el.innerHTML = '<i class="ri-gallery-line"></i>';
        return;
    }
    const photo =
        (state.groups || []).find((g) => String(g.id) === String(groupId))?.photoUrl ||
        `/photos/${encodeURIComponent(String(groupId))}.jpg`;
    // Render a coloured initial as the immediate fallback; if the photo
    // request 404s, the existing src stays empty and the initial shows.
    const initial = (displayName || '?').trim().charAt(0).toUpperCase() || '?';
    const slot = (Math.abs(parseInt(String(groupId).slice(-3)) || 0) % 6) + 1;
    el.className = `tg-avatar tg-avatar-${slot} w-10 h-10 text-lg flex-shrink-0 relative overflow-hidden`;
    el.innerHTML = `<span>${initial}</span><img src="${photo}" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()">`;
}

// What the gallery grid currently shows. Set when page 1 of a view lands;
// any change to group / type filter / pinned / scope / search query
// produces a different key, and AI-search results (which replace the
// list) clear it.
let _loadedViewKey = null;
let _galleryTotal = null;
let _viewerScrollTop = 0;
// Bumped by every page-1 gallery load; a response whose sequence is no
// longer current (the user typed another letter, switched tab/chat) is
// dropped instead of painting over the newer view.
let _galleryLoadSeq = 0;

function _galleryViewKey() {
    return [
        state.currentGroupId || '',
        state.currentFilter || 'all',
        state.pinnedFilter ? 1 : 0,
        isPinnedFirst() ? 1 : 0,
        _galleryScopeQs(),
        state.searchQuery || '',
    ].join('|');
}

// Page title / subtitle in the header. A translated string keeps its i18n
// key on the element, so the language loading (or switching) after the
// first render re-translates it instead of falling back to the markup's
// "Viewer"; a dynamic text (a chat's name, "12 files") drops the key.
function _setPageText(which, key, fallback) {
    const el = document.getElementById(`page-${which}`);
    if (!el) return;
    el.dataset.i18n = key;
    el.dataset.i18nFallback = fallback;
    el.textContent = i18nT(key, fallback);
}
function _setPageRaw(which, text) {
    const el = document.getElementById(`page-${which}`);
    if (!el) return;
    el.removeAttribute('data-i18n');
    el.removeAttribute('data-i18n-fallback');
    el.textContent = text;
}

// Header subtitle for the gallery: "N files", or "N results" while the
// toolbar holds a search query.
function _setGallerySubtitle(total) {
    if (total == null) return;
    _setPageRaw(
        'subtitle',
        state.searchQuery
            ? formatResultCount(total)
            : i18nTf('viewer.subtitle.files', { count: total }, `${total} files`),
    );
}

// URL for one page of the current gallery view: the chat / All Media feed,
// or the search endpoint while the toolbar holds a query. Both honour the
// type tab, the pinned mode and the federation scope.
function _galleryPageUrl(groupId, opts = {}) {
    const type = state.currentFilter && state.currentFilter !== 'all' ? state.currentFilter : 'all';
    const common = `page=${opts.page ?? state.page}&limit=${opts.limit ?? FILES_PER_PAGE}&type=${encodeURIComponent(type)}${pinnedQs()}${_galleryScopeQs()}`;
    if (state.searchQuery) {
        const g = groupId ? `&groupId=${encodeURIComponent(groupId)}` : '';
        return `/api/downloads/search?q=${encodeURIComponent(state.searchQuery)}&order=newest&${common}${g}`;
    }
    return groupId
        ? `/api/downloads/${encodeURIComponent(groupId)}?${common}`
        : `/api/downloads/all?${common}`;
}

// Refetch page 1 of whatever the gallery shows (filter / search change).
function _reloadGallery() {
    state.page = 1;
    state.hasMore = true;
    state.files = [];
    if (state.currentPage === 'viewer') {
        if (state.currentGroupId) loadGroupFiles(state.currentGroupId);
        else loadAllFiles();
    } else {
        renderMediaGrid();
    }
}

// True when the grid already holds `key`'s files — and `state.files` is
// still the gallery's list (the Queue page / review mode / search swap it
// for their own).
function _galleryLoadedFor(key) {
    return (
        _loadedViewKey === key &&
        Array.isArray(state.files) &&
        state.files.length > 0 &&
        state.files === _galleryFilesRef
    );
}

// Put back the bits of gallery chrome other pages overwrite (the subtitle
// file count) and the scroll position the user left at.
function _restoreGalleryChrome() {
    _setGallerySubtitle(_galleryTotal);
    const contentArea = document.getElementById('content-area');
    if (contentArea) contentArea.scrollTop = _viewerScrollTop;
    _recheckLoadMore();
}

// `opts.keepFilters` carries the type tab + search query over from a chat
// ("Search all media" in the no-results state).
// `opts.force` re-fetches even when the All Media grid is already loaded
// (pull-to-refresh, purge). Plain calls — the Library tab, the sidebar
// "All Media" row, the #/viewer route — keep the loaded grid, its type
// filter and the scroll position when nothing that shapes the list
// (group, filter, pinned, scope) changed; they used to throw 10k+ tiles
// away and refetch from page 1 on every return.
let _allMediaOpts = null; // showAllMedia() options carried across the hash change
function showAllMedia(opts) {
    // In a chat (#/viewer/<id>): switch the URL to #/viewer first; its
    // route comes back here with the same options.
    if (state.currentPage === 'viewer' && /^#\/viewer\/./.test(location.hash)) {
        _allMediaOpts = opts || null;
        navigateTo('viewer');
        return;
    }
    const force = opts?.force === true;
    const wasAllMedia = state.currentGroupId == null && !state.viewerPeerScope;
    state.currentGroup = null;
    state.currentGroupId = null;
    // Clear any per-view peer narrowing left over from a sidebar
    // foreign-group click. Without this, "All Media" after viewing a
    // peer-owned group would still be filtered to that peer.
    state.viewerPeerScope = null;
    _syncChatHeaderActions();
    const reuse = !force && wasAllMedia && _galleryLoadedFor(_galleryViewKey());
    if (!reuse) {
        state.page = 1;
        state.hasMore = true;
        state.files = [];
        // Coming from a chat: All Media starts unfiltered. Refreshing All
        // Media itself (pull-to-refresh, purge) keeps the active type tab
        // and search query.
        if (!wasAllMedia && !opts?.keepFilters) resetGalleryFilter();
    }
    syncGalleryToolbar();

    _setPageText('title', 'viewer.all_media.title', 'All Media');
    _setPageText('subtitle', 'viewer.all_media.subtitle', 'All downloaded files');
    // Header avatar back to the generic gallery glyph — switching from
    // a per-group view used to leave that chat's avatar in the header.
    updateHeaderAvatar(null, null);

    if (reuse) {
        if (state.currentPage !== 'viewer') {
            navigateTo('viewer');
            return; // renderPage re-enters us with the page visible
        }
        _restoreGalleryChrome();
        return;
    }

    const grid = document.getElementById('media-grid');
    if (grid) _clearGalleryGrid(grid);

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
        return; // renderPage will re-enter us with the page visible
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
    try {
        return window.matchMedia('(max-width: 768px)').matches;
    } catch {
        return false;
    }
};
const FILES_PER_PAGE = _isMobileViewport() ? 50 : 100;

// Build the federated-gallery query suffix (?include=&peerId=) for the
// next gallery fetch. Returns '' for local-only / non-cluster installs
// so the existing local endpoints stay byte-identical for the non-
// federated default. Logic order:
//   1. If `state.viewerPeerScope` is set (sidebar foreign-group click
//      narrows the per-group view to that peer), use it. Persists
//      across pagination so page 2+ keep the same peerId. Cleared
//      when leaving the per-group view (showAllMedia / new group click
//      that isn't a foreign row).
//   2. Otherwise honour `state.galleryScope` (the chip selection).
// See media-url.js for the matching tile + viewer URL routing.
function _galleryScopeQs() {
    const viewerScope = state.viewerPeerScope;
    if (viewerScope) {
        return `&include=peers&peerId=${encodeURIComponent(viewerScope)}`;
    }
    const s = state.galleryScope;
    if (!s || s === 'local') return '';
    if (s === 'all') return '&include=peers';
    return `&include=peers&peerId=${encodeURIComponent(s)}`;
}

// Federated gallery scope chip — opt-in toggle in the gallery header
// row that lets the operator switch between local-only / all-peers /
// per-peer views. State persists in localStorage so reload comes back
// to the same scope. Hidden entirely when no peers are paired so
// non-cluster operators see no UI clutter. See plan: Layer 1.
async function initGalleryScope() {
    const chip = document.getElementById('gallery-scope-chip');
    const menu = document.getElementById('gallery-scope-menu');
    if (!chip || !menu) return;
    let peers = [];
    try {
        const r = await api.get('/api/cluster/peers');
        peers = Array.isArray(r?.peers) ? r.peers : [];
    } catch {
        // Cluster module not initialised / 401 — leave the chip hidden.
        peers = [];
    }
    state.clusterPeers = peers;
    if (!peers.length) {
        chip.classList.add('hidden');
        return;
    }
    chip.classList.remove('hidden');
    state.galleryScope = localStorage.getItem('tgdl-gallery-scope') || 'local';
    _renderGalleryScopeLabel();
    chip.addEventListener('click', () => {
        const expanded = chip.getAttribute('aria-expanded') === 'true';
        if (expanded) {
            menu.classList.add('hidden');
            chip.setAttribute('aria-expanded', 'false');
            return;
        }
        _renderGalleryScopeMenu();
        // #media-tabs is the positioned parent; on phones the chip sits in
        // the second row (under the search box), so anchor to the chip.
        menu.style.top = `${chip.offsetTop + chip.offsetHeight + 6}px`;
        menu.style.marginTop = '0';
        menu.classList.remove('hidden');
        chip.setAttribute('aria-expanded', 'true');
        // Click-outside dismisses. Use `once` so the listener auto-cleans.
        setTimeout(() => {
            const onDocClick = (e) => {
                if (!menu.contains(e.target) && !chip.contains(e.target)) {
                    menu.classList.add('hidden');
                    chip.setAttribute('aria-expanded', 'false');
                    document.removeEventListener('click', onDocClick);
                }
            };
            document.addEventListener('click', onDocClick);
        }, 0);
    });
    chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            chip.click();
        }
    });
}

function _renderGalleryScopeLabel() {
    const labelEl = document.getElementById('gallery-scope-label');
    if (!labelEl) return;
    const s = state.galleryScope;
    if (s === 'all') {
        labelEl.textContent = i18nT('gallery.scope.all_peers', 'All peers');
    } else if (s === 'local' || !s) {
        labelEl.textContent = i18nT('gallery.scope.this_peer', 'This peer');
    } else {
        const peer = (state.clusterPeers || []).find((p) => String(p.peerId) === String(s));
        const name = peer?.name || (s.length > 12 ? s.slice(0, 12) + '…' : s);
        labelEl.textContent = name;
    }
}

function _renderGalleryScopeMenu() {
    const menu = document.getElementById('gallery-scope-menu');
    if (!menu) return;
    const peers = state.clusterPeers || [];
    const opts = [
        {
            value: 'local',
            icon: 'ri-home-4-line',
            label: i18nT('gallery.scope.this_peer', 'This peer'),
        },
        {
            value: 'all',
            icon: 'ri-broadcast-line',
            label: i18nT('gallery.scope.all_peers', 'All peers'),
        },
        ...peers.map((p) => ({
            value: p.peerId,
            icon:
                p.status === 'online'
                    ? 'ri-circle-fill text-green-400 text-[8px]'
                    : 'ri-circle-line text-tg-textSecondary text-[8px]',
            label: p.name || p.peerId.slice(0, 12),
            offline: p.status !== 'online',
        })),
    ];
    const cur = state.galleryScope || 'local';
    menu.innerHTML = opts
        .map((o) => {
            const active = String(o.value) === String(cur) ? 'data-active="1"' : '';
            const offlineSuffix = o.offline
                ? ` <span class="text-[10px] text-tg-textSecondary ml-1">${escapeHtml(i18nT('gallery.scope.offline', '(offline)'))}</span>`
                : '';
            return `<button type="button" class="gallery-scope-option w-full text-left px-3 py-1.5 text-sm hover:bg-tg-hover flex items-center gap-2"
                            data-value="${escapeHtml(String(o.value))}" ${active}>
                <i class="${o.icon}" aria-hidden="true"></i>
                <span class="truncate flex-1">${escapeHtml(o.label)}${offlineSuffix}</span>
                ${active ? '<i class="ri-check-line text-tg-blue" aria-hidden="true"></i>' : ''}
            </button>`;
        })
        .join('');
    menu.querySelectorAll('.gallery-scope-option').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.value;
            if (!next || next === state.galleryScope) {
                menu.classList.add('hidden');
                document
                    .getElementById('gallery-scope-chip')
                    ?.setAttribute('aria-expanded', 'false');
                return;
            }
            state.galleryScope = next;
            // Manually picking a chip option overrides any per-view
            // peer narrowing left over from a sidebar foreign-group
            // click — otherwise the chip change would be invisible.
            state.viewerPeerScope = null;
            try {
                localStorage.setItem('tgdl-gallery-scope', next);
            } catch {}
            _renderGalleryScopeLabel();
            menu.classList.add('hidden');
            document.getElementById('gallery-scope-chip')?.setAttribute('aria-expanded', 'false');
            // Re-fetch the current view with the new scope. page resets
            // because pagination is per-scope.
            state.page = 1;
            state.hasMore = true;
            state.files = [];
            // Re-apply the footer so peer counts pick up the new scope.
            if (_lastStats) _applyStats(_lastStats);
            else loadStats();
            if (state.currentPage === 'viewer') {
                if (state.currentGroupId) loadGroupFiles(state.currentGroupId);
                else loadAllFiles();
            }
        });
    });
}

function loadAllFiles() {
    return _loadGalleryPage(null);
}

// ============ Media Loading ============
function loadGroupFiles(groupId) {
    return _loadGalleryPage(groupId);
}

// One page of the gallery — a chat (groupId) or All Media (null), or the
// search results for either while the toolbar holds a query.
async function _loadGalleryPage(groupId) {
    state.loading = true;
    const seq = state.page === 1 ? ++_galleryLoadSeq : _galleryLoadSeq;

    // Show 12 skeleton tiles for the very first page so users don't stare
    // at an empty grid for the duration of the network round-trip. Page 2+
    // adds rows so we don't replace what's already there.
    if (state.page === 1) {
        const grid = document.getElementById('media-grid');
        if (grid) _clearGalleryGrid(grid, renderGallerySkeletons(12));
        const contentArea = document.getElementById('content-area');
        if (contentArea) contentArea.scrollTop = 0;
        document.getElementById('empty-state')?.classList.add('hidden');
    }

    try {
        const viewKey = _galleryViewKey();
        const res = await api.get(_galleryPageUrl(groupId));
        // A newer page-1 load (another search letter, tab, chat) started
        // while this one was in flight — its result is stale.
        if (seq !== _galleryLoadSeq) return;
        const newFiles = res?.files || [];

        let appendFromIndex = 0;
        if (state.page === 1) {
            _loadedViewKey = viewKey;
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
        _galleryTotal = total;
        _setGallerySubtitle(total);
        if (state.searchQuery) setSearchResultCount(total);
    } catch (e) {
        if (seq === _galleryLoadSeq) {
            showToast(i18nT('viewer.error.load', 'Error loading files'), 'error');
        }
    } finally {
        if (seq === _galleryLoadSeq) state.loading = false;
    }
}

// Track how many state.files entries have been handed to the gallery
// window (rendered or queued below it). Append-only on infinite scroll:
// page-2+ loads only add the new tail. Reset on every full re-render
// (filter/group change).
let _renderedFileCount = 0;

// Off-screen tile content unloader. `content-visibility: auto` skips
// layout/paint for off-screen tiles, but the `<img>` element + decoded
// bitmap stay in memory regardless. This IntersectionObserver detaches
// the children of `.tile-thumb` for tiles that are far from the viewport
// (stashed in a WeakMap so they survive DOM moves) and reattaches them
// when the tile comes back near. The empty `<div class="tile-thumb">`
// outer node stays so layout + `aspect-ratio` are unaffected; only the
// heavy thumbnail bitmap is freed. Rooted on #content-area — the real
// scroller — so the 1500 px buffer actually applies (with the viewport
// as root the scroller clipped it to ~0 and tiles popped in blank).
let _tileWindowObserver = null;
const _tileStash = new WeakMap();
function _ensureTileWindowObserver() {
    if (_tileWindowObserver) return _tileWindowObserver;
    _tileWindowObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const tile = entry.target;
                if (entry.isIntersecting) _restoreTile(tile);
                else _evictTile(tile);
            }
        },
        // Generous buffer so a fast-flick scroll doesn't flash empty
        // tiles. 1500 px ≈ 8-12 rows in grid mode at typical viewports.
        {
            root: document.getElementById('content-area'),
            rootMargin: '1500px 0px 1500px 0px',
            threshold: 0,
        },
    );
    return _tileWindowObserver;
}

function _evictTile(tile) {
    if (!tile || _tileStash.has(tile)) return;
    const thumb = tile.querySelector('.tile-thumb');
    if (!thumb) return;
    const fragment = document.createDocumentFragment();
    while (thumb.firstChild) fragment.appendChild(thumb.firstChild);
    _tileStash.set(tile, fragment);
}

function _restoreTile(tile) {
    if (!tile) return;
    const fragment = _tileStash.get(tile);
    if (!fragment) return;
    const thumb = tile.querySelector('.tile-thumb');
    if (thumb && !thumb.firstChild) thumb.appendChild(fragment);
    _tileStash.delete(tile);
}

// Sticky inside a CSS Grid was clipping the trailing media tiles and
// stacking multiple headers at the top of the scrollport (each header
// sticks until the next pushes it). Plain inline header keeps each
// section's title aligned with its row without hijacking the scroll
// geometry. Spans the full row (gallery-virtual.js relies on that for
// its row math).
function _gallerySectionHeaderHtml(label) {
    return `<h4 class="grid-section-header" style="grid-column: 1 / -1; padding: 16px 4px 8px; color: var(--tg-textSecondary, #8B9BAA); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(label)}</h4>`;
}

// One gallery tile. `originalIndex` is the position in `state.files`
// (the viewer's backing list) so a click opens the right file even
// under a type filter.
function _galleryTileHtml(file, originalIndex) {
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
    // Server-side WebP thumbnails. One ~6-12 KB image per tile
    // — replaces both the previous full-resolution image source
    // and the mobile-vs-desktop branching. v2.x collapsed the
    // cache to a single canonical 320-px width (see thumbs.js
    // ALLOWED_WIDTHS); every viewport asks for the same URL so
    // the cache hits 100% of the time. Server snaps any `?w=`
    // value to 320 via clampWidth() so legacy bookmarked tabs
    // still get a valid response.
    // Falls back to a typed-icon placeholder if the source isn't
    // thumbnailable (audio / document / dead source).
    // Federated rows (file.peer_id !== 'self') route through
    // the cluster thumb proxy via getThumbUrl(); see media-url.js.
    const thumbUrl = getThumbUrl(file, 320);
    // Onerror falls back to displaying nothing (the panel
    // background shows through), which is the desired graceful
    // degradation for a missing/dead file.
    // CSS skeleton starts img at opacity:0 and fades to 1 on `.loaded`.
    // Native loading="lazy" + delegated `load`/`error`
    // listeners on `#media-grid` (see `_wireMediaGridDelegation`)
    // pop the skeleton open. We used to inline `onload` /
    // `onerror` per-tile, but every inline handler closure
    // adds DOM-parse overhead and ~100 bytes of GC pressure
    // per row — at 5000 tiles that compounds into measurable
    // scroll lag. The delegated listeners run in capture
    // phase so the visual outcome stays identical (fade-in
    // on success, hide on failure).
    const imgFallback =
        `<img loading="lazy" decoding="async" class="w-full h-full object-cover" alt=""` +
        (thumbUrl ? ` src="${escapeHtml(thumbUrl)}"` : '') +
        '>';
    const docFallback = `<div class="w-full h-full flex flex-col items-center justify-center">
<i class="${getFileIcon(file.extension)} text-3xl text-tg-textSecondary"></i>
            </div>`;
    // Inner thumb content — the visual changes per file type (img,
    // video w/ play overlay, doc icon). Wrapped in `.tile-thumb`
    // so list-mode CSS can size it as a 56 px square cell.
    const durLabel = file.type === 'videos' && file.duration ? formatDuration(file.duration) : '';
    const durBadge = durLabel ? `<span class="video-duration">${durLabel}</span>` : '';
    const thumbInner =
        file.type === 'images'
            ? imgFallback
            : file.type === 'videos'
              ? `<div class="relative w-full h-full bg-black">
        ${thumbUrl ? imgFallback : ''}
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="w-10 h-10 rounded-full bg-black/55 flex items-center justify-center">
                <i class="ri-play-fill text-white text-xl ml-0.5"></i>
            </div>
        </div>
        ${durBadge}
       </div>`
              : docFallback;
    // Filename-under-tile fallback for non-image-non-video types
    // in GRID/COMPACT modes (where doc icon needs context). CSS
    // hides this in list mode (which has its own tile-name).
    const gridDocLabel =
        file.type !== 'images' && file.type !== 'videos'
            ? `<span class="absolute inset-x-0 bottom-0 text-[11px] text-tg-textSecondary truncate text-center px-2 py-1 bg-black/40">${escapeHtml(file.name || '')}</span>`
            : '';
    // List-mode metadata. `tile-text/size/date` are display:none in
    // grid+compact (CSS), display:flex/grid in list. Group name +
    // file extension in the sub line, full size + date in their
    // own columns. Date format = locale short.
    // Federated rows (file.peer_id !== 'self') get a "from {peer}"
    // pill appended after the group name so the operator can
    // tell at a glance which dashboard owns the file. The pill
    // is also visible in grid mode via the `tile-peer-badge`
    // overlay positioned bottom-right.
    const isPeerTile = isPeerRow(file);
    const peerName = isPeerTile ? file.peer_name || '' : '';
    const peerBadgeOverlay = isPeerTile
        ? `<div class="tile-peer-badge" title="${escapeHtml(
              i18nTf('gallery.peer_badge', { peer: peerName }, `from ${peerName}`),
          )}"><i class="ri-broadcast-line"></i><span>${escapeHtml(
              peerName || i18nT('gallery.scope.this_peer', 'peer'),
          )}</span></div>`
        : '';
    const peerSubInline =
        isPeerTile && peerName
            ? ` · <span class="text-tg-blue">${escapeHtml(
                  i18nTf('gallery.peer_badge', { peer: peerName }, `from ${peerName}`),
              )}</span>`
            : '';
    const groupLine = file.groupName || file.groupId || '';
    const sizeLine = file.sizeFormatted || (file.size ? formatBytes(file.size) : '');
    const dateLine = file.modified ? formatRelativeTime(file.modified) : '';
    // Pin chip — appears on hover, golden when pinned. data-tile-pin
    // is what the gallery delegation handler keys off below.
    const pinnedCls = file.pinned ? 'is-pinned' : '';
    const pinTitle = file.pinned
        ? i18nT('favorites.unpin', 'Unpin')
        : i18nT('favorites.pin', 'Pin');
    const pinIcon = file.pinned ? 'ri-pushpin-2-fill' : 'ri-pushpin-2-line';
    const pinChip =
        file.id != null && state.role === 'admin'
            ? `<button type="button" class="pin-chip" data-tile-pin title="${escapeHtml(pinTitle)}" aria-label="${escapeHtml(pinTitle)}">
       <i class="${pinIcon}"></i>
   </button>`
            : '';
    return `
            <div class="media-item relative ${selectedCls} ${pinnedCls}${isPeerTile ? ' is-peer-tile' : ''}" data-index="${originalIndex}" data-path="${escapeHtml(file.fullPath)}"${file.id != null ? ` data-id="${file.id}"` : ''}${isPeerTile ? ` data-peer-id="${escapeHtml(file.peer_id)}"` : ''} tabindex="0">
<div class="tile-thumb relative w-full h-full overflow-hidden">
    ${thumbInner}
    ${gridDocLabel}
    ${peerBadgeOverlay}
</div>
${pinChip}
<div class="tile-text">
    <div class="tile-name" title="${escapeHtml(file.name || '')}">${escapeHtml(file.name || '')}</div>
    <div class="tile-sub">${escapeHtml(groupLine)}${peerSubInline}</div>
</div>
<div class="tile-size">${escapeHtml(sizeLine)}</div>
<div class="tile-date" title="${file.modified ? new Date(file.modified).toLocaleString() : ''}">${escapeHtml(dateLine)}</div>
<div class="tile-actions">
    <button type="button" class="w-7 h-7 rounded-md hover:bg-tg-hover flex items-center justify-center text-tg-textSecondary"
            data-tile-open title="${escapeHtml(i18nT('viewer.open', 'Open'))}" aria-label="${escapeHtml(i18nT('viewer.open', 'Open'))}">
        <i class="ri-eye-line"></i>
    </button>
    <button type="button" class="w-7 h-7 rounded-md hover:bg-tg-hover flex items-center justify-center text-tg-textSecondary"
            data-tile-similar data-id="${file.id}"
            title="${escapeHtml(i18nT('viewer.find_similar', 'Find similar photos'))}"
            aria-label="${escapeHtml(i18nT('viewer.find_similar', 'Find similar photos'))}">
        <i class="ri-search-eye-line"></i>
    </button>
</div>
${checkBadge}
${rescueBadge}
            </div>`;
}

// The gallery DOM is a bounded window over the full list (see
// gallery-virtual.js). Wired lazily on first render.
let _galleryWindowWired = false;
function _ensureGalleryWindow(grid) {
    if (_galleryWindowWired) return;
    _galleryWindowWired = true;
    configureGalleryWindow({
        grid,
        scroller: document.getElementById('content-area'),
        renderItem: (idx) => _galleryTileHtml(state.files[idx] || {}, idx),
        renderHeader: (label) => _gallerySectionHeaderHtml(label),
        onInserted: _onGalleryTilesInserted,
        onRemoved: _onGalleryTilesRemoved,
    });
}

// New tiles entered the DOM (full render, page append, or rows the
// window re-inserted on scroll): wire them into the thumbnail-eviction
// + lazy-media observers, and flag cache-hit images as loaded.
function _onGalleryTilesInserted(nodes) {
    const obs = _ensureTileWindowObserver();
    const imgs = [];
    for (const el of nodes) {
        if (!el.classList?.contains('media-item')) continue;
        obs.observe(el);
        if (state.imageObserver) {
            for (const m of el.querySelectorAll('img[data-src], video[data-src]')) {
                state.imageObserver.observe(m);
            }
        }
        const img = el.querySelector('img');
        if (img) imgs.push(img);
    }
    if (!imgs.length) return;
    // Race fix — when an image is already in the HTTP cache, the browser
    // can fire `load` before the delegated capture-phase listener sees
    // it, the tile never gets `.loaded`, and the CSS rule
    // `.media-item img { opacity: 0 }` keeps the thumb invisible. Sweep
    // one frame later and flag every <img> whose `complete` flag is
    // already true. naturalWidth=0 means the request 404'd from cache →
    // fall back to `display:none` just like the delegated error path.
    requestAnimationFrame(() => {
        for (const img of imgs) {
            if (!img.complete) continue;
            if (img.naturalWidth > 0) {
                img.classList.add('loaded');
            } else if (img.getAttribute('src')) {
                img.classList.add('loaded');
                img.style.display = 'none';
            }
        }
    });
}

// Tiles left the DOM (window trim / re-render) — stop observing them so
// the observers never pin detached nodes.
function _onGalleryTilesRemoved(nodes) {
    for (const el of nodes) {
        _tileWindowObserver?.unobserve(el);
        _tileStash.delete(el);
        if (state.imageObserver) {
            for (const m of el.querySelectorAll?.('img, video') || []) {
                state.imageObserver.unobserve(m);
            }
        }
    }
}

// Clear the grid through the window module so its bookkeeping (spacer,
// positions) never drifts from the DOM, then optionally paint loading
// skeletons.
function _clearGalleryGrid(grid, skeletonHtml = '') {
    _ensureGalleryWindow(grid);
    resetGalleryWindow([], new Map());
    _galleryFilesRef = null;
    if (skeletonHtml) grid.innerHTML = skeletonHtml;
}

// `state.files` array the grid currently renders. Other surfaces (queue
// single-file viewer, review mode, AI search) swap `state.files` for
// their own list; comparing identity tells us the grid is stale.
let _galleryFilesRef = null;

function renderMediaGrid(opts = {}) {
    const grid = document.getElementById('media-grid');
    const empty = document.getElementById('empty-state');
    if (!grid) return;
    _ensureGalleryWindow(grid);

    const append = opts.append === true;
    const fromIndex = append ? (opts.fromIndex ?? _renderedFileCount) : 0;

    if (state.files.length === 0) {
        resetGalleryWindow([], new Map());
        _renderedFileCount = 0;
        _galleryFilesRef = state.files;
        renderGalleryEmptyState();
        return;
    }
    if (empty) empty.classList.add('hidden');

    if (!state.selected) state.selected = new Set();

    const matches = (file) => state.currentFilter === 'all' || file.type === state.currentFilter;
    if (append) {
        // Page 2+: hand only the new tail to the window. No time-section
        // banding — re-bucketing the tail in isolation can't produce
        // sensible relative labels, and the headers up the page stay
        // correct visually.
        const indices = [];
        for (let i = fromIndex; i < state.files.length; i++) {
            if (matches(state.files[i])) indices.push(i);
        }
        appendPositions(indices);
    } else {
        // Full render. Each file keeps its index in the UNFILTERED list
        // (`originalIndex`) so the viewer's `state.files[idx]` lookup stays
        // correct under filter. Sections become (position → label) headers.
        const filteredWithIndex = [];
        state.files.forEach((file, originalIndex) => {
            if (matches(file)) filteredWithIndex.push({ file, originalIndex });
        });
        const order = [];
        const headers = new Map();
        for (const [label, items] of groupFilesByTime(filteredWithIndex)) {
            if (label && items.length) headers.set(order.length, label);
            for (const it of items) order.push(it.originalIndex);
        }
        if (opts.keepScroll) rerenderGalleryWindow(order, headers);
        else resetGalleryWindow(order, headers);
    }
    _renderedFileCount = state.files.length;
    _galleryFilesRef = state.files;

    // Click handling lives on the grid itself via event delegation
    // (wired once below). Per-tile addEventListener was the second-
    // biggest cost on a full re-render — eliminating it keeps tab
    // switches snappy on a thousand-tile grid.
    _wireMediaGridDelegation(grid);
    // Re-apply select-mode class + repaint .is-selected on tiles after
    // any full or append render so the visual state survives mutations
    // (e.g. infinite scroll, filter switch, file_deleted).
    repaintSelection();
    // A short page may leave the load-more sentinel inside the prefetch
    // margin, where the IntersectionObserver never fires again.
    _recheckLoadMore();
    _maybeShowSelectHint();
    // The "N of M selected" wording depends on how much is loaded.
    if (state.selected?.size || state.selectMode) updateSelectionBar();
}

let _gridDelegated = false;
function _wireMediaGridDelegation(grid) {
    if (_gridDelegated) return;
    _gridDelegated = true;
    // Delegated `load` / `error` listeners replace the per-`<img>` inline
    // handlers we used to render. Native events bubble, so capture-phase
    // delegation here catches every tile's image fade-in without baking
    // a closure into each element's HTML.
    grid.addEventListener(
        'load',
        (ev) => {
            const img = ev.target;
            if (img && img.tagName === 'IMG' && img.closest('.media-item')) {
                img.classList.add('loaded');
            }
        },
        true,
    );
    grid.addEventListener(
        'error',
        (ev) => {
            const img = ev.target;
            if (img && img.tagName === 'IMG' && img.closest('.media-item')) {
                img.classList.add('loaded');
                img.style.display = 'none';
            }
        },
        true,
    );
    grid.addEventListener('click', async (ev) => {
        // Pin chip — toggles pinned state via the API and flips the
        // visual class in place. Stops propagation so clicking the
        // chip doesn't also open the viewer.
        // "Find similar" chip — runs /api/ai/search/similar against
        // this tile's id and replaces the gallery with the result set.
        // Same behaviour as the dual-mode search-bar Enter path.
        const simBtn = ev.target.closest('[data-tile-similar]');
        if (simBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            const id = Number(simBtn.dataset.id);
            if (!Number.isFinite(id) || id <= 0) return;
            await _runSimilarSearch(id);
            return;
        }
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
                await api.post(`/api/downloads/${encodeURIComponent(file.id)}/pin`, {
                    pinned: next,
                });
                file.pinned = next;
                tile?.classList.toggle('is-pinned', next);
                const ico = pinBtn.querySelector('i');
                if (ico) {
                    ico.classList.replace(
                        next ? 'ri-pushpin-2-line' : 'ri-pushpin-2-fill',
                        next ? 'ri-pushpin-2-fill' : 'ri-pushpin-2-line',
                    );
                }
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
    const bodyEl = document.getElementById('empty-state-body');
    const iconEl = document.getElementById('empty-state-icon');
    const actionsEl = document.getElementById('empty-state-actions');
    const isAdmin = state.role === 'admin';
    const groupId = state.currentGroupId;

    let title,
        body,
        icon,
        actions = [];
    // What narrows the list right now ("Photos · Pinned only"). Pinned
    // first only re-orders, so it never explains an empty result.
    const activeFilters = [];
    if ((state.currentFilter || 'all') !== 'all') {
        const tab = document.querySelector(
            `#media-tabs .tab-item[data-type="${state.currentFilter}"]`,
        );
        activeFilters.push(tab?.textContent.trim() || state.currentFilter);
    }
    if (getPinnedMode() === 'only')
        activeFilters.push(i18nT('gallery.filter.state_only', 'Pinned only'));
    const clearFiltersAction = {
        label: i18nT('gallery.filter.clear_filters', 'Clear filters'),
        icon: 'ri-filter-off-line',
        onClick: () => {
            state.pinnedFilter = false;
            state.currentFilter = 'all';
            _paintTypeTabs();
            syncGalleryToolbar();
            _reloadGallery();
        },
    };
    if (state.searchQuery) {
        icon = 'ri-search-line';
        title = i18nTf(
            'gallery.search.empty_title',
            { q: state.searchQuery },
            `No results for “${state.searchQuery}”`,
        );
        body = i18nT(
            'gallery.search.empty_body',
            'Search looks at file names and chat names. Check the spelling or try a shorter word.',
        );
        if (activeFilters.length) {
            body += ` ${i18nTf('gallery.search.empty_filters', { filters: activeFilters.join(' · ') }, `Filters are on too: ${activeFilters.join(' · ')}.`)}`;
        }
        actions.push({
            label: i18nT('gallery.search.clear', 'Clear search'),
            icon: 'ri-close-circle-line',
            onClick: () => clearGallerySearch(),
        });
        if (groupId) {
            actions.push({
                label: i18nT('gallery.search.everywhere', 'Search all media'),
                icon: 'ri-gallery-line',
                onClick: () => showAllMedia({ keepFilters: true }),
            });
        }
        if (activeFilters.length) actions.push(clearFiltersAction);
    } else if (activeFilters.length) {
        icon = 'ri-filter-off-line';
        title = i18nT('gallery.filter.empty_title', 'Nothing matches these filters');
        body = i18nTf(
            'gallery.filter.empty_body',
            { filters: activeFilters.join(' · ') },
            `Filters on: ${activeFilters.join(' · ')}. Clear them to see everything.`,
        );
        actions.push(clearFiltersAction);
    } else if (groupId) {
        icon = 'ri-folder-open-line';
        title = i18nT('viewer.empty.group_title', 'No downloaded media for this group yet');
        body = isAdmin
            ? i18nT(
                  'viewer.empty.group_body_admin',
                  'Either nothing has been downloaded yet or the catalogue is out of sync. Run a Backfill to pull older messages, double-check the media filters in Group Settings, or re-index from disk if files exist on disk but not in the database.',
              )
            : i18nT(
                  'viewer.empty.group_body_guest',
                  'Either nothing has been downloaded yet or the catalogue is empty for this chat. Ask an admin to run a Backfill.',
              );
        if (isAdmin) {
            actions = [
                {
                    label: i18nT('viewer.empty.action.backfill', 'Run Backfill'),
                    icon: 'ri-history-line',
                    onClick: () => openBackfillFor(groupId),
                },
                {
                    label: i18nT('chat.details.open', 'Chat settings'),
                    icon: 'ri-settings-3-line',
                    onClick: () => openGroupSettings(groupId),
                },
                {
                    label: i18nT('viewer.empty.action.reindex', 'Re-index from disk'),
                    icon: 'ri-refresh-line',
                    onClick: () => window.navigateTo?.('settings/tools/library/duplicates'),
                },
            ];
        }
    } else {
        icon = 'ri-image-line';
        title = i18nT('viewer.empty', 'No media files');
        body = isAdmin
            ? i18nT(
                  'viewer.empty.all_body_admin',
                  'Nothing has been downloaded yet. Add a Telegram account and enable a chat under Groups, or paste a t.me/ link to download a single message.',
              )
            : i18nT(
                  'viewer.empty.all_body_guest',
                  'Nothing has been downloaded yet. Ask an admin to add a Telegram account and enable some chats.',
              );
        if (isAdmin) {
            actions = [
                {
                    label: i18nT('viewer.empty.action.add_account', 'Add account'),
                    icon: 'ri-user-add-line',
                    onClick: () => openAccountWizard(),
                },
                {
                    label: i18nT('viewer.empty.action.groups', 'Manage groups'),
                    icon: 'ri-group-line',
                    onClick: () => window.navigateTo?.('groups'),
                },
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
        actionsEl.innerHTML = actions
            .map(
                (a, i) => `
            <button type="button" data-action-idx="${i}"
                class="tg-btn-secondary text-sm px-4 min-h-[44px] flex items-center gap-2">
                <i class="${a.icon}" aria-hidden="true"></i><span>${escapeHtml(a.label)}</span>
            </button>
        `,
            )
            .join('');
        actionsEl.classList.toggle('hidden', actions.length === 0);
        // Re-bind click handlers — innerHTML wipes them.
        actionsEl.querySelectorAll('button[data-action-idx]').forEach((btn) => {
            const idx = Number(btn.dataset.actionIdx);
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                try {
                    actions[idx]?.onClick?.();
                } catch {}
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
            const tip = i18nTf(
                'viewer.badge.pending_tooltip',
                { time: due.toLocaleString() },
                `Will be auto-deleted at ${due.toLocaleString()} unless source is deleted.`,
            );
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

// Files of the current gallery view that can be selected (type tab applied).
function _selectableFiles() {
    const files = Array.isArray(state.files) ? state.files : [];
    const f = state.currentFilter || 'all';
    return f === 'all' ? files : files.filter((x) => x.type === f);
}

// "Select all N" beyond the loaded pages is offered up to this many files;
// past it the list is too big to hold and act on in one go.
const SELECT_ALL_MAX = 5000;

// One bar for everything selection: shown while select mode is on (so
// "0 selected" still explains itself and offers Done) and whenever files
// are selected. Buttons that need a selection are disabled at 0.
function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    const count = state.selected ? state.selected.size : 0;
    const onGallery = state.currentPage === 'viewer';
    const show = onGallery && (count > 0 || !!state.selectMode);
    const countEl = document.getElementById('selection-count');
    const loaded = _selectableFiles().length;
    const total = Number(_galleryTotal) || loaded;
    if (countEl) {
        if (count === 0) {
            countEl.textContent = window.matchMedia?.('(pointer: coarse)').matches
                ? i18nT('viewer.selection.prompt', 'Tap items to select')
                : i18nT('viewer.selection.prompt_click', 'Click to select');
        } else if (count >= loaded && total > count) {
            countEl.textContent = i18nTf(
                'viewer.selection.count_of',
                { count: count.toLocaleString(), total: total.toLocaleString() },
                `${count.toLocaleString()} of ${total.toLocaleString()} selected`,
            );
        } else {
            countEl.textContent = i18nTf(
                'viewer.selection.count',
                { count: count.toLocaleString() },
                `${count.toLocaleString()} selected`,
            );
        }
    }
    // "Select all 1,234" — every loaded file is selected but the view has
    // more on the server.
    const allMatching = document.getElementById('selection-all-matching');
    if (allMatching) {
        const offer = count > 0 && count >= loaded && total > loaded && total <= SELECT_ALL_MAX;
        allMatching.classList.toggle('hidden', !offer);
        if (offer && !allMatching.disabled) {
            allMatching.textContent = i18nTf(
                'viewer.selection.select_all_n',
                { count: total.toLocaleString() },
                `Select all ${total.toLocaleString()}`,
            );
        }
    }
    document
        .getElementById('selection-all')
        ?.classList.toggle('hidden', count > 0 && count >= loaded);
    for (const id of ['selection-clear', 'selection-zip', 'selection-pin', 'selection-delete']) {
        const b = document.getElementById(id);
        if (b) b.disabled = count === 0;
    }
    if (bar) bar.classList.toggle('hidden', !show);
    if (state.selectMode) _dismissSelectHint();
}

// Load every file of the current view (up to SELECT_ALL_MAX) so "Select
// all N" really selects all of them, not just the pages scrolled so far.
async function _selectEveryMatchingFile() {
    const btn = document.getElementById('selection-all-matching');
    const total = Number(_galleryTotal) || 0;
    if (!total || total > SELECT_ALL_MAX) return;
    const viewKey = _galleryViewKey();
    const groupId = state.currentGroupId;
    const LIMIT = 200;
    const out = [];
    const seen = new Set();
    if (btn) btn.disabled = true;
    try {
        for (let p = 1; p <= Math.ceil(total / LIMIT); p++) {
            if (btn) {
                btn.textContent = i18nTf(
                    'viewer.selection.loading_all',
                    { n: out.length.toLocaleString(), total: total.toLocaleString() },
                    `Loading ${out.length.toLocaleString()} / ${total.toLocaleString()}…`,
                );
            }
            const res = await api.get(_galleryPageUrl(groupId, { page: p, limit: LIMIT }));
            // The user switched view meanwhile — drop it.
            if (_galleryViewKey() !== viewKey || state.currentPage !== 'viewer') return;
            const rows = res?.files || [];
            for (const f of rows) {
                const k = `${f.peer_id || 'self'}|${f.id}|${f.fullPath}`;
                if (seen.has(k)) continue;
                seen.add(k);
                out.push(f);
            }
            if (rows.length < LIMIT) break;
        }
        state.files = out;
        state.hasMore = false;
        _galleryTotal = Math.max(total, out.length);
        renderMediaGrid({ keepScroll: true });
        selectAllVisible();
    } catch (e) {
        showToast(e?.message || i18nT('viewer.error.load', 'Error loading files'), 'error');
    } finally {
        if (btn) btn.disabled = false;
        updateSelectionBar();
    }
}

// First-visit tip on touch screens: selecting several files is behind a
// long-press, which nobody finds by accident. Dismissed with "Got it" or
// automatically once select mode has been used; remembered per browser.
const SELECT_HINT_KEY = 'tgdl-hint-select-seen';
function _selectHintSeen() {
    try {
        return localStorage.getItem(SELECT_HINT_KEY) === '1';
    } catch {
        return true;
    }
}
function _dismissSelectHint() {
    const el = document.getElementById('select-hint');
    if (el && !el.classList.contains('hidden')) el.classList.add('hidden');
    try {
        if (localStorage.getItem(SELECT_HINT_KEY) !== '1')
            localStorage.setItem(SELECT_HINT_KEY, '1');
    } catch {}
}
function _maybeShowSelectHint() {
    const el = document.getElementById('select-hint');
    if (!el || _selectHintSeen()) return;
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    const show =
        touch &&
        state.currentPage === 'viewer' &&
        !state.selectMode &&
        _selectableFiles().length > 1;
    el.classList.toggle('hidden', !show);
}
function _setupSelectHint() {
    document.getElementById('select-hint-dismiss')?.addEventListener('click', _dismissSelectHint);
    document.getElementById('select-hint-try')?.addEventListener('click', () => {
        _dismissSelectHint();
        document.getElementById('select-mode-btn')?.click();
    });
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
        if (!Number.isFinite(t)) {
            buckets.older.push({ file, originalIndex });
            return;
        }
        if (t >= startOfToday) buckets.today.push({ file, originalIndex });
        else if (t >= startOfYesterday) buckets.yesterday.push({ file, originalIndex });
        else if (t >= startOfWeek) buckets.week.push({ file, originalIndex });
        else buckets.older.push({ file, originalIndex });
    });

    const out = [];
    if (buckets.today.length) out.push([i18nT('viewer.section.today', 'Today'), buckets.today]);
    if (buckets.yesterday.length)
        out.push([i18nT('viewer.section.yesterday', 'Yesterday'), buckets.yesterday]);
    if (buckets.week.length)
        out.push([i18nT('viewer.section.week', 'Earlier this week'), buckets.week]);
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
        const sync = () =>
            el.setAttribute('aria-checked', el.classList.contains('active') ? 'true' : 'false');
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
                await new Promise((r) => setTimeout(r, 400));
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

    document.getElementById('selection-exit')?.addEventListener('click', () => {
        exitSelectMode();
        updateSelectionBar();
    });
    document
        .getElementById('selection-all-matching')
        ?.addEventListener('click', () => _selectEveryMatchingFile());

    selClear?.addEventListener('click', () => {
        if (state.selected) state.selected.clear();
        // Drop the visual checked-state in place — way cheaper than
        // a full grid re-render.
        const grid = document.getElementById('media-grid');
        grid?.querySelectorAll('.is-selected').forEach((el) => el.classList.remove('is-selected'));
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
        if (
            !(await confirmSheet({
                title: i18nT('viewer.bulk.title', 'Delete selected files?'),
                message: i18nTf(
                    'viewer.bulk.confirm',
                    { count: paths.length },
                    `Delete ${paths.length} file(s)? This cannot be undone.`,
                ),
                confirmLabel: i18nT('common.delete', 'Delete'),
                danger: true,
            }))
        )
            return;
        // Fire-and-forget — at N=5000 the unlink loop runs minutes. Drop
        // selected paths from the local view immediately so the user sees
        // the gallery shrink; the canonical refresh happens via the
        // existing `bulk_delete` WS broadcast (already wired further up).
        // Final toast comes from `dedup_delete_done` (shared tracker).
        const set = new Set(paths);
        // Own tiles go by DB id — every tile sharing a selected path; only
        // peer tiles / rows without an id still travel as paths.
        const body = bulkDeleteTargets(paths, state.files);
        try {
            const r = await api.post('/api/downloads/bulk-delete', body);
            if (!r?.started && !r?.success) throw new Error('Failed to start');
            state.selected.clear();
            state.files = (state.files || []).filter((f) => !set.has(f.fullPath));
            if (state.savedFiles)
                state.savedFiles = state.savedFiles.filter((f) => !set.has(f.fullPath));
            updateSelectionBar();
            renderMediaGrid({ keepScroll: true });
        } catch (e) {
            if (e?.data?.code === 'ALREADY_RUNNING') {
                showToast(
                    i18nT(
                        'jobs.already_running',
                        'Already running on another tab — waiting for it to finish.',
                    ),
                    'info',
                );
                return;
            }
            showToast(
                i18nTf('viewer.bulk.failed', { msg: e.message }, `Delete failed: ${e.message}`),
                'error',
            );
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
            const f = (state.files || []).find((x) => x.fullPath === p);
            if (f && f.id != null) ids.push(f.id);
        }
        if (ids.length === 0) {
            showToast(
                i18nT(
                    'viewer.selection.zip_no_ids',
                    'Selected files have no DB id — re-open the page to refresh and try again.',
                ),
                'error',
            );
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
            a.href = u;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(u), 60_000);
            showToast(i18nT('viewer.selection.zip_done', 'ZIP downloaded'), 'success');
        } catch (e) {
            showToast(
                i18nT('viewer.selection.zip_failed', 'ZIP download failed') +
                    ' — ' +
                    (e?.message || ''),
                'error',
            );
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
            const f = (state.files || []).find((x) => x.fullPath === p);
            if (f && f.id != null) items.push(f);
        }
        if (!items.length) return;
        const allPinned = items.every((f) => f.pinned);
        const next = !allPinned;
        let ok = 0,
            failed = 0;
        // One request per batch (POST /api/downloads/pin) instead of one
        // per file — a 500-file selection used to fire 500 requests.
        const BATCH = 1000;
        for (let i = 0; i < items.length; i += BATCH) {
            const part = items.slice(i, i + BATCH);
            try {
                const r = await api.post('/api/downloads/pin', {
                    ids: part.map((f) => f.id),
                    pinned: next,
                });
                const done = new Set((r?.ids || []).map(String));
                for (const f of part) {
                    if (!done.has(String(f.id))) {
                        failed++;
                        continue;
                    }
                    f.pinned = next;
                    document
                        .querySelector(`.media-item[data-id="${CSS.escape(String(f.id))}"]`)
                        ?.classList.toggle('is-pinned', next);
                    ok++;
                }
            } catch {
                failed += part.length;
            }
        }
        showToast(
            next
                ? i18nTf('favorites.bulk_pinned', { count: ok }, `Pinned ${ok} item(s)`)
                : i18nTf('favorites.bulk_unpinned', { count: ok }, `Unpinned ${ok} item(s)`),
            failed === 0 ? 'success' : 'info',
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
            showToast(
                i18nTf('viewer.bulk.deleted', { count: removed }, `Deleted ${removed} files`),
                'success',
            );
        }
    });
}

// ============ Groups Config Page ============
// The Chats rows come from js/add-sheet.js — the same rows (Monitor
// switch, Backfill…, tap for the chat's details) as the + sheet.
let _addSheetModule = null;
let _addSheetLoaded = null;
function loadAddSheetModule() {
    if (!_addSheetModule) {
        _addSheetModule = import('./add-sheet.js')
            .then((m) => {
                _addSheetLoaded = m;
                return m;
            })
            .catch((e) => {
                _addSheetModule = null;
                throw e;
            });
    }
    return _addSheetModule;
}

let _groupsScrollTop = 0;

function _paintDialogs() {
    const q = document.getElementById('groups-search')?.value || '';
    if (q.trim()) filterDialogs(q);
    else renderDialogsList(state.allDialogs || []);
}

async function renderGroupsConfig({ restoreScroll = false } = {}) {
    const list = document.getElementById('groups-config-list');
    if (!list) return;
    const scroller = document.getElementById('content-area');

    // Back from a chat's page (or a refresh): paint the list we already
    // have — search text and scroll position intact — and update it
    // quietly, instead of blanking it to "Loading dialogs…".
    const cached = Array.isArray(state.allDialogs) && state.allDialogs.length > 0;
    if (cached) {
        await loadAddSheetModule().catch(() => {});
        _paintDialogs();
        if (restoreScroll && scroller) scroller.scrollTop = _groupsScrollTop;
    } else {
        list.classList.remove('cr-list');
        list.innerHTML = `<div class="text-center py-8 text-tg-textSecondary">${escapeHtml(i18nT('groups.loading_dialogs', 'Loading dialogs...'))}</div>`;
    }

    try {
        const [res] = await Promise.all([api.get('/api/dialogs'), loadAddSheetModule()]);
        const dialogs = res.dialogs || res || [];
        // Stash the account directory for chip rendering in renderDialogsList.
        // Only meaningful when 2+ accounts are linked — otherwise chips would
        // be visual noise (they all carry the same single label).
        state.dialogsAccounts = Array.isArray(res.accounts) ? res.accounts : [];
        state.allDialogs = dialogs;
        if (state.currentPage !== 'groups') return;
        const top = scroller?.scrollTop;
        _paintDialogs();
        if (cached && scroller && top != null) scroller.scrollTop = top;
    } catch (e) {
        if (cached) return; // keep showing what we had
        // "No Telegram account configured yet" is not an error — it's a
        // first-run state. Surface a friendly empty-state pointing at the
        // Add Account flow instead of a red failure message.
        if (e?.data?.error === 'no_account') {
            list.innerHTML = renderEmptyState({
                icon: 'ri-user-add-line',
                title: i18nT('groups.no_account.title', 'No Telegram account yet'),
                body: i18nT(
                    'groups.no_account.body',
                    'Add your Telegram account to load chats and start downloading.',
                ),
                actionLabel: i18nT('groups.no_account.cta', 'Add account'),
                actionHref: '#/account/add',
            });
            return;
        }
        list.innerHTML = `<div class="text-center py-8 text-red-400">${escapeHtml(i18nT('groups.load_failed', 'Failed to load dialogs'))}</div>`;
    }
}

function renderDialogsList(dialogs) {
    const list = document.getElementById('groups-config-list');
    if (!list) return;
    const rows = _addSheetLoaded;
    if (!rows) {
        loadAddSheetModule()
            .then(() => renderDialogsList(dialogs))
            .catch((e) => console.error('chat rows', e));
        return;
    }

    const tab = state.groupsTab || 'all';
    const filtered =
        tab === 'monitored'
            ? dialogs.filter((d) => d.inConfig || d.enabled)
            : tab === 'unmonitored'
              ? dialogs.filter((d) => !d.inConfig && !d.enabled)
              : dialogs;

    if (filtered.length === 0) {
        list.removeAttribute('role');
        list.classList.remove('cr-list');
        list.innerHTML = `<div class="text-center py-8 text-tg-textSecondary">${escapeHtml(i18nT('groups.none_found', 'No groups found'))}</div>`;
        return;
    }

    // Build an `accountId -> short label` map once per render. Skip chip
    // rendering entirely when 0–1 accounts are linked — a single-account
    // install would just see "[Default]" on every row, pure noise.
    const accountsList = state.dialogsAccounts || [];
    const showChips = accountsList.length >= 2;
    const accountLabelById = new Map();
    if (showChips) {
        for (const a of accountsList) {
            const label = a.username ? `@${a.username}` : a.phone || a.name || a.id;
            const title =
                [a.name, a.phone, a.username ? `@${a.username}` : ''].filter(Boolean).join(' · ') ||
                a.id;
            accountLabelById.set(a.id, { label, title });
        }
    }

    list.setAttribute('role', 'list');
    list.classList.add('cr-list');
    list.innerHTML = filtered
        .map((d) => {
            let accountChips = null;
            if (showChips && Array.isArray(d.accountIds) && d.accountIds.length > 0) {
                accountChips = d.accountIds.map((id) => {
                    const meta = accountLabelById.get(id);
                    return { id, label: meta?.label || id, title: meta?.title || id };
                });
            }
            return rows.renderChatResultRow(d, { accountChips });
        })
        .join('');
    // Row taps open the chat's details page; the switch and Backfill…
    // act in place (one delegated listener, wired once).
    rows.wireChatResultRows(list, {
        getChat: (id) => (state.allDialogs || []).find((d) => String(d.id) === String(id)),
    });
}

function filterDialogs(query) {
    if (!state.allDialogs) return;
    const q = query.toLowerCase();
    const filtered = state.allDialogs.filter(
        (d) => (d.name || '').toLowerCase().includes(q) || String(d.id).includes(q),
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
    const q = String(rawQuery || '')
        .trim()
        .toLowerCase();
    const rows = list.querySelectorAll('.chat-row');
    const seps = list.querySelectorAll('.sidebar-section-sep');
    const headers = list.querySelectorAll('.sidebar-section-header');
    if (!q) {
        // Restore collapse state when search is cleared
        headers.forEach((h) => {
            h.classList.remove('hidden');
            const collapsed = h.getAttribute('aria-expanded') === 'false';
            let sibling = h.nextElementSibling;
            while (sibling && !sibling.classList.contains('sidebar-section-header')) {
                if (
                    sibling.classList.contains('chat-row') ||
                    sibling.classList.contains('sidebar-section-sep')
                ) {
                    sibling.classList.toggle('hidden', collapsed);
                }
                sibling = sibling.nextElementSibling;
            }
        });
        return;
    }
    // Search active: show ALL matching rows regardless of collapse state
    rows.forEach((r) => {
        const name = (r.querySelector('.row-title-name')?.textContent || '').toLowerCase();
        const id = (r.dataset.id || '').toLowerCase();
        r.classList.toggle('hidden', !(name.includes(q) || id.includes(q)));
    });
    // Hide section headers + separators that have no visible rows
    headers.forEach((h) => {
        let sibling = h.nextElementSibling;
        let hasVisible = false;
        while (sibling && !sibling.classList.contains('sidebar-section-header')) {
            if (sibling.classList.contains('chat-row') && !sibling.classList.contains('hidden')) {
                hasVisible = true;
            }
            sibling = sibling.nextElementSibling;
        }
        h.classList.toggle('hidden', !hasVisible);
    });
    // Hide separators within sections that have no visible rows
    seps.forEach((s) => {
        let prev = s.previousElementSibling;
        let next = s.nextElementSibling;
        const prevVisible =
            prev && prev.classList.contains('chat-row') && !prev.classList.contains('hidden');
        const nextVisible =
            next && next.classList.contains('chat-row') && !next.classList.contains('hidden');
        s.classList.toggle('hidden', !prevVisible || !nextVisible);
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
        try {
            localStorage.setItem(KEY, next ? '1' : '0');
        } catch {
            /* private mode */
        }
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
        try {
            localStorage.setItem(KEY, next ? '1' : '0');
        } catch {
            /* private mode */
        }
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

// ============ Chat details (was: Group Settings modal) ============
//
// The three-tab modal is now the chat details page at #/groups/<id>
// (js/chat-details.js, loaded on first use). These keep the old window
// entry points working — the sidebar cog, the Chats rows, the empty
// gallery and any custom build / console snippet that still calls them.

let _chatDetailsModule = null;
function loadChatDetailsModule() {
    if (!_chatDetailsModule) {
        _chatDetailsModule = import('./chat-details.js').catch((e) => {
            _chatDetailsModule = null;
            throw e;
        });
    }
    return _chatDetailsModule;
}

function openGroupSettings(groupId) {
    if (groupId == null || groupId === '') return;
    navigateTo(`groups/${encodeURIComponent(String(groupId))}`);
}

// Nothing to close any more — the page saves as you go. Kept for callers
// like the backfill sheet's "Backfill page" link.
function closeGroupSettings() {}

function saveGroupSettings() {
    return loadChatDetailsModule().then((m) => m.saveChatDetailsNow());
}

function openDestinationPicker() {
    return loadChatDetailsModule().then((m) => m.openDestinationPicker());
}

// ============ Delete File ============
async function confirmDeleteFile() {
    const file = state.files[state.currentFileIndex];
    if (!file) return;

    if (
        !(await confirmSheet({
            title: i18nT('viewer.delete.title', 'Delete file?'),
            message: i18nTf('viewer.delete.confirm', { name: file.name }, `Delete "${file.name}"?`),
            confirmLabel: i18nT('common.delete', 'Delete'),
            danger: true,
        }))
    )
        return;

    try {
        const idQuery =
            file.id != null && (file.peer_id || 'self') === 'self'
                ? `&id=${encodeURIComponent(file.id)}`
                : '';
        await api.delete(`/api/file?path=${encodeURIComponent(file.fullPath)}${idQuery}`);
        // The server broadcasts `file_deleted` BEFORE this response lands,
        // so dropFileFromView() may already have spliced the file out —
        // splicing `currentFileIndex` again removed the NEXT file. Locate
        // the file by identity (id first: rows that share one file share
        // its path) and only remove it if it's still there.
        const isGallery = state.files === _galleryFilesRef;
        let idx = state.files.indexOf(file);
        if (idx < 0) {
            idx = state.files.findIndex((f) =>
                file.id != null ? f.id === file.id : f.fullPath === file.fullPath,
            );
        }
        if (idx >= 0) {
            state.files.splice(idx, 1);
            if (isGallery) {
                // Drop just that tile — a full re-render would throw away
                // the window + scroll position on a deep-scrolled gallery.
                removeFileIndex(idx);
                _renderedFileCount = state.files.length;
            }
        }
        if (state.files.length === 0) {
            Viewer.closeMediaViewer();
            if (isGallery) renderGalleryEmptyState();
        } else {
            // Stay in the viewer on the item that took the deleted one's
            // place (the previous one when it was the last).
            const from = idx >= 0 ? idx : state.currentFileIndex;
            Viewer.openMediaViewer(Math.min(Math.max(0, from), state.files.length - 1));
        }
        showToast(i18nT('viewer.delete.success', 'File deleted'), 'success');
    } catch (e) {
        showToast(
            i18nTf('viewer.delete.failed', { msg: e.message }, 'Failed to delete: ' + e.message),
            'error',
        );
    }
}

// Reset the All / Photos / Videos / Files / Audio tab back to "All" and
// drop the search query, then re-paint the tab UI to match. Called
// whenever we enter a fresh gallery view (All Media or per-group) so a
// stale tab choice or query from the previous view doesn't silently
// filter the new content. The pinned mode (Sort & filter) is a
// preference and stays.
function resetGalleryFilter() {
    state.currentFilter = 'all';
    _paintTypeTabs();
    resetGallerySearch();
}

function _paintTypeTabs() {
    const cur = state.currentFilter || 'all';
    document.querySelectorAll('#media-tabs .tab-item[data-type]').forEach((t) => {
        const on = (t.dataset.type || 'all') === cur;
        t.classList.toggle('active', on);
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

// Switch the type filter (tab click or the Sort & filter sheet). The
// filter is applied server-side: reset pagination + re-fetch with the new
// ?type=. Filtering client-side hid everything past the first page (the
// "Photos shows 30" symptom).
function setGalleryType(type) {
    state.currentFilter = type || 'all';
    _paintTypeTabs();
    _reloadGallery();
}

// ============ Media Tabs ============
function setupMediaTabs() {
    document.querySelectorAll('#media-tabs .tab-item[data-type]').forEach((tab) => {
        tab.setAttribute('role', 'button');
        tab.tabIndex = 0;
        tab.addEventListener('click', () => setGalleryType(tab.dataset.type || 'all'));
        tab.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                tab.click();
            }
        });
    });
    _paintTypeTabs();
    setupGalleryToolbar({ reload: _reloadGallery, setType: setGalleryType });
}

// ============ Utils ============
function setupLazyLoading() {
    state.imageObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((e) => {
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
        },
        { root: document.getElementById('content-area'), rootMargin: '600px 0px' },
    );
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
    // Media tabs
    setupMediaTabs();
}

// v2.16 — "Find similar" from a single tile. Routes via
// `/api/ai/search/similar` with the seed download id; results replace
// the gallery the same way the text-search path does.
async function _runSimilarSearch(downloadId) {
    try {
        const r = await api.post('/api/ai/search/similar', { downloadId, limit: 60 });
        if (!r || !r.success) {
            const code = r?.code || '';
            if (code === 'AI_DISABLED') {
                showToast(
                    i18nT(
                        'maintenance.ai.search_disabled',
                        'AI search is disabled — enable it in Maintenance → AI.',
                    ),
                    'warning',
                );
                return;
            }
            throw new Error(r?.error || 'similar search failed');
        }
        const results = Array.isArray(r.results) ? r.results : [];
        if (!results.length) {
            showToast(
                i18nT(
                    'maintenance.ai.no_results',
                    'No similar photos found — run an index scan first.',
                ),
                'info',
            );
            return;
        }
        const mapped = results.map((row) => ({
            id: row.download_id || row.id,
            group_id: row.group_id,
            group_name: row.group_name,
            file_name: row.file_name,
            file_path: row.file_path,
            file_type: row.file_type,
            file_size: row.file_size,
            created_at: row.created_at,
            _aiScore: typeof row.score === 'number' ? row.score : null,
            fullPath: row.file_path,
        }));
        state.files = mapped;
        _loadedViewKey = null;
        // Result set is complete — don't let infinite scroll append the
        // next page of the previous view underneath it.
        state.hasMore = false;
        try {
            renderMediaGrid();
        } catch (e) {
            console.warn('renderMediaGrid after similar search:', e);
        }
        _setPageRaw(
            'title',
            `🔍 ${i18nT('viewer.find_similar', 'Similar')} — ${mapped.length} ${i18nT('common.results', 'results')}`,
        );
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
}

// v2.16 — semantic search on the gallery. Triggered by Enter from
// `#search-input`. POSTs to `/api/ai/search`, replaces `state.files`
// with the result list, re-renders the gallery, and updates the
// header to show the active query. AI-disabled / no-results states
// fall through to a toast — operator stays on the current view.
async function _runSemanticSearch(q) {
    if (!q) return;
    showToast(i18nT('maintenance.ai.searching', `Searching: ${q}`), 'info');
    try {
        const r = await api.post('/api/ai/search', { q, limit: 60 });
        if (!r || !r.success) {
            const code = r?.code || '';
            if (code === 'AI_DISABLED') {
                showToast(
                    i18nT(
                        'maintenance.ai.search_disabled',
                        'AI search is disabled — enable it in Maintenance → AI.',
                    ),
                    'warning',
                );
                return;
            }
            throw new Error(r?.error || 'search failed');
        }
        const results = Array.isArray(r.results) ? r.results : [];
        if (!results.length) {
            showToast(
                i18nT(
                    'maintenance.ai.no_results',
                    'No results — try another query or run an index scan first.',
                ),
                'info',
            );
            return;
        }
        // Map API rows to gallery-tile shape. The `/api/ai/search`
        // response carries the same columns as `/api/downloads` rows
        // (joined from `downloads` table inside vector-store.topK), so
        // a shallow remap is enough — `renderMediaGrid` reads the same
        // fields either way.
        const mapped = results.map((row) => ({
            id: row.download_id || row.id,
            group_id: row.group_id,
            group_name: row.group_name,
            file_name: row.file_name,
            file_path: row.file_path,
            file_type: row.file_type,
            file_size: row.file_size,
            created_at: row.created_at,
            // surface relevance score on the tile via a small overlay
            _aiScore: typeof row.score === 'number' ? row.score : null,
            // The viewer treats `fullPath` as the canonical resource
            // — copy from file_path so click-to-open works.
            fullPath: row.file_path,
        }));
        state.files = mapped;
        _loadedViewKey = null;
        // Result set is complete — don't let infinite scroll append the
        // next page of the previous view underneath it.
        state.hasMore = false;
        try {
            renderMediaGrid();
        } catch (e) {
            console.warn('renderMediaGrid after AI search:', e);
        }
        // Update the page title so the operator knows they're in
        // search-results mode.
        _setPageRaw('title', `🔍 "${q}" — ${mapped.length} ${i18nT('common.results', 'results')}`);
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
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
        const handle = openSheet({
            title: i18nT('stories.title', 'Download Stories'),
            content: root,
            size: 'md',
        });
        const userInput = root.querySelector('#ss-username');
        const fetchBtn = root.querySelector('#ss-fetch');
        const list = root.querySelector('#ss-list');
        const result = root.querySelector('#ss-result');
        setTimeout(() => userInput.focus(), 60);

        fetchBtn.addEventListener('click', async () => {
            const username = userInput.value.trim();
            if (!username) {
                showToast(i18nT('stories.warn_username', 'Enter a username'), 'warning');
                return;
            }
            list.innerHTML = `<div class="text-tg-textSecondary text-sm">${escapeHtml(i18nT('stories.loading', 'Loading…'))}</div>`;
            result.textContent = '';
            try {
                const r = await api.post('/api/stories/user', { username });
                if (!r.stories.length) {
                    list.innerHTML = `<div class="text-tg-textSecondary text-sm">${escapeHtml(i18nT('stories.none_visible', 'No active stories visible to your account.'))}</div>`;
                    return;
                }
                const unknownLbl = i18nT('stories.unknown_type', 'unknown');
                list.innerHTML =
                    r.stories
                        .map(
                            (s) => `
                    <label class="flex items-center justify-between bg-tg-bg/40 rounded p-2 cursor-pointer">
                        <div class="text-sm min-w-0">
                            <span class="text-tg-text">#${s.id}</span>
                            <span class="text-tg-textSecondary">${escapeHtml(s.media?.type || unknownLbl)}${s.caption ? ` — ${escapeHtml(s.caption.slice(0, 40))}` : ''}</span>
                        </div>
                        <input type="checkbox" data-story-id="${s.id}" checked class="w-4 h-4 accent-tg-blue">
                    </label>
                `,
                        )
                        .join('') +
                    `
                    <button id="ss-go" type="button" class="tg-btn w-full mt-2 text-sm"><i class="ri-download-line mr-1"></i>${escapeHtml(i18nT('stories.download_selected', 'Download selected'))}</button>`;
                root.querySelector('#ss-go')?.addEventListener('click', async () => {
                    const ids = Array.from(list.querySelectorAll('input[type=checkbox]:checked'))
                        .map((cb) => parseInt(cb.dataset.storyId, 10))
                        .filter(Number.isFinite);
                    if (!ids.length) {
                        showToast(i18nT('stories.warn_pick', 'Pick at least one story'), 'warning');
                        return;
                    }
                    try {
                        const dl = await api.post('/api/stories/download', {
                            username,
                            storyIds: ids,
                        });
                        result.textContent = i18nTf(
                            'stories.queued_result',
                            { ok: dl.queued, total: dl.requested },
                            `Queued ${dl.queued} of ${dl.requested} stories.`,
                        );
                        showToast(
                            i18nTf(
                                'stories.queued_toast',
                                { n: dl.queued },
                                `Queued ${dl.queued} stories`,
                            ),
                            'success',
                        );
                        setTimeout(handle.close, 800);
                    } catch (e) {
                        showToast(
                            i18nTf(
                                'stories.download_failed',
                                { msg: e.message },
                                `Download failed: ${e.message}`,
                            ),
                            'error',
                        );
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
    document.querySelectorAll('[data-theme-set]').forEach((b) => {
        const active = b.dataset.themeSet === cur;
        b.classList.toggle('ring-2', active);
        b.classList.toggle('ring-tg-blue', active);
        b.classList.toggle('text-tg-blue', active);
    });
}

function setupFab() {
    const fab = document.getElementById('fab');
    if (!fab) return;

    // Hide the FAB while the operator hasn't pasted API credentials yet
    // — every action in the sheet needs at least apiId/apiHash to be
    // useful, so showing it just teases a menu of dead buttons. The
    // onboarding banner is already steering the user to Settings →
    // Telegram API at that stage; FAB stays out of the way until step 1
    // is done. Subscribes to the shared monitor-status push so a fresh
    // install snaps to "visible" the moment creds land.
    const applyVisibility = (status) => {
        const hint = status?.hint || null;
        fab.style.display = hint === 'configure-api' ? 'none' : '';
    };
    applyVisibility(getMonitorStatusLatest());
    subscribeMonitorStatus(applyVisibility);

    // The + button opens the Add sheet (js/add-sheet.js): find a chat by
    // name / @username / t.me link, monitor or backfill it, download a
    // message link — plus the old quick actions (paste links, Stories,
    // add an account, browse chats) under "More".
    const openAdd = () =>
        loadAddSheetModule()
            .then((m) => m.openAddSheet())
            .catch((e) => console.error('add sheet', e));
    fab.addEventListener('click', openAdd);
    // Wider screens have no FAB: the Chats page's "Add chat or link".
    document.getElementById('groups-add-btn')?.addEventListener('click', openAdd);
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
        const handle = openSheet({
            title: i18nT('link.title', 'Download from Telegram link'),
            content: root,
            size: 'md',
        });
        const input = root.querySelector('#ps-input');
        const submit = root.querySelector('#ps-submit');
        const resultEl = root.querySelector('#ps-result');
        setTimeout(() => input.focus(), 60);

        submit.addEventListener('click', async () => {
            const text = input.value.trim();
            if (!text) {
                showToast(i18nT('link.warn_empty', 'Paste at least one Telegram link'), 'warning');
                return;
            }
            submit.disabled = true;
            try {
                const r = await api.post('/api/download/url', { url: text });
                const ok = r.results.filter((x) => x.ok).length;
                const fail = r.results.length - ok;
                resultEl.textContent = i18nTf(
                    'link.result',
                    { ok, fail },
                    `${ok} queued, ${fail} failed.`,
                );
                r.results.forEach((x) => {
                    if (!x.ok) console.warn('paste-url failed:', x.url, x.error);
                });
                if (ok > 0) {
                    const key = ok > 1 ? 'link.queued_many' : 'link.queued_one';
                    showToast(
                        i18nTf(key, { n: ok }, `Queued ${ok} download${ok > 1 ? 's' : ''}`),
                        'success',
                    );
                    input.value = '';
                    setTimeout(handle.close, 600);
                } else if (fail > 0) {
                    showToast(
                        i18nTf(
                            'link.all_failed',
                            { n: fail },
                            `All ${fail} URL(s) failed — check console`,
                        ),
                        'error',
                    );
                }
            } catch (e) {
                showToast(
                    i18nTf('link.req_failed', { msg: e.message }, `Request failed: ${e.message}`),
                    'error',
                );
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
        showAllMedia({ force: true });
    } else if (state.currentPage === 'groups') {
        renderGroupsConfig();
    } else {
        loadGroups();
    }
}

const LOAD_MORE_MARGIN_PX = 1200;

function setupInfiniteScroll() {
    const sentinel = document.getElementById('load-more-sentinel');
    if (!sentinel) return;

    // `rootMargin: '1200px'` makes the IntersectionObserver fire when
    // the sentinel is still ~1200 px BELOW the visible area, so the
    // next batch is requested long before the user actually runs out
    // of rows. The root must be #content-area — the element that
    // actually scrolls. With the viewport as root the scroller clipped
    // the margin to ~0 and the next page only loaded once the sentinel
    // was already on screen.
    const observer = new IntersectionObserver(
        (entries) => {
            if (entries[0].isIntersecting) _galleryNearBottom();
        },
        {
            root: document.getElementById('content-area'),
            rootMargin: `${LOAD_MORE_MARGIN_PX}px 0px ${LOAD_MORE_MARGIN_PX}px 0px`,
        },
    );
    observer.observe(sentinel);
}

// The bottom of the gallery is near the viewport: first re-render rows the
// DOM window trimmed earlier (already in memory), otherwise fetch the next
// page. currentGroupId === null on the All-Media surface — page through
// /api/downloads/all instead of the per-group endpoint.
function _galleryNearBottom() {
    if (state.currentPage !== 'viewer' || state.loading) return;
    if (hasPendingBelow()) {
        extendBottom();
        _recheckLoadMore();
        return;
    }
    if (!state.hasMore) return;
    state.page++;
    if (state.currentGroupId) loadGroupFiles(state.currentGroupId);
    else loadAllFiles();
}

// IntersectionObserver only reports *changes*. When a page (or a chunk
// re-rendered from memory) is too short to push the sentinel back out of
// the prefetch margin, no further callback fires and paging stalls — so
// re-check the geometry once per frame after every render.
let _recheckLoadMoreQueued = false;
function _recheckLoadMore() {
    if (_recheckLoadMoreQueued) return;
    _recheckLoadMoreQueued = true;
    requestAnimationFrame(() => {
        _recheckLoadMoreQueued = false;
        const sentinel = document.getElementById('load-more-sentinel');
        const root = document.getElementById('content-area');
        if (!sentinel || !root || sentinel.getClientRects().length === 0) return;
        const r = root.getBoundingClientRect();
        const b = sentinel.getBoundingClientRect();
        if (b.top < r.bottom + LOAD_MORE_MARGIN_PX && b.bottom > r.top - LOAD_MORE_MARGIN_PX) {
            _galleryNearBottom();
        }
    });
}

// Latest /api/stats payload (HTTP or `stats_update` push) — kept so a
// gallery-scope change can re-render the footer without a refetch.
let _lastStats = null;
let _statsInFlight = null;

// One-shot fetch (boot, WS reconnect, explicit refresh). Concurrent calls
// share the in-flight request instead of stacking.
function loadStats() {
    if (_statsInFlight) return _statsInFlight;
    _statsInFlight = api
        .get('/api/stats')
        .then((stats) => _applyStats(stats))
        .catch(() => {})
        .finally(() => {
            _statsInFlight = null;
        });
    return _statsInFlight;
}

function _applyStats(stats) {
    if (!stats || typeof stats !== 'object') return;
    _lastStats = stats;
    const diskEl = document.getElementById('disk-usage');
    const filesEl = document.getElementById('total-files');
    if (diskEl) diskEl.textContent = stats.diskUsageFormatted || formatBytes(stats.diskUsage || 0);
    // Federated footer total. When the gallery scope is 'all' or a
    // specific peer, the footer file count should reflect what the
    // user is currently looking at — otherwise "1234 files" + a
    // gallery showing 5,000 tiles read as a contradiction.
    // peerStats is empty on non-cluster installs and for guest
    // sessions, so the local-only path stays unchanged.
    if (filesEl) {
        const local = Number(stats.totalFiles) || 0;
        const peers = Array.isArray(stats.peerStats) ? stats.peerStats : [];
        const peerTotal = peers.reduce((s, p) => s + (Number(p.totalFiles) || 0), 0);
        const scope = state.galleryScope || 'local';
        if (scope === 'all' && peerTotal > 0) {
            filesEl.textContent = i18nTf(
                'footer.files.merged',
                { local, peers: peerTotal },
                `${local} + ${peerTotal} peers`,
            );
            filesEl.title = peers
                .map(
                    (p) =>
                        `${p.peerName}: ${p.totalFiles} ${p.totalSizeFormatted ? `(${p.totalSizeFormatted})` : ''}${p.online ? '' : ' (offline)'}`,
                )
                .join('\n');
        } else if (scope !== 'local' && scope !== 'all') {
            const p = peers.find((x) => String(x.peerId) === String(scope));
            filesEl.textContent = String(p?.totalFiles ?? 0);
            filesEl.title = p ? `${p.peerName}${p.online ? '' : ' (offline)'}` : '';
        } else {
            filesEl.textContent = String(local);
            filesEl.title = '';
        }
    }
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
            showToast(
                i18nTf('purge.group.failed', { msg: m.error }, 'Failed to delete: ' + m.error),
                'error',
            );
            return;
        }
        const d = m?.deleted || {};
        showToast(
            i18nTf(
                'purge.group.success',
                { name: d.group, files: d.files, records: d.dbRecords },
                `Deleted "${d.group}" -- ${d.files} files, ${d.dbRecords} records`,
            ),
            'success',
        );
        const purgedId = m?.groupId;
        if (purgedId && String(state.currentGroupId) === String(purgedId)) {
            showAllMedia({ force: true });
        }
        loadStats();
    });

    ws.on('purge_all_done', (m) => {
        if (m?.error) {
            showToast(
                i18nTf('purge.group.failed', { msg: m.error }, 'Failed to delete: ' + m.error),
                'error',
            );
            return;
        }
        const d = m?.deleted || {};
        showToast(
            i18nTf(
                'purge.all.success',
                { files: d.files, records: d.dbRecords },
                `Deleted all -- ${d.files} files, ${d.dbRecords} records`,
            ),
            'success',
        );
        state.groups = [];
        state.downloads = [];
        state.files = [];
        state.allFiles = [];
        renderGroupsList();
        if (state.currentPage === 'groups') renderGroupsConfig();
        if (state.currentPage === 'viewer') showAllMedia({ force: true });
        loadStats();
    });
}

/**
 * Delete a specific group -- files, DB, config, photo
 */
async function purgeGroup(groupId, groupName) {
    _wirePurgeWs();
    groupName = getGroupName(groupId, { fallback: groupName });
    if (
        !(await confirmSheet({
            title: i18nT('purge.group.title', 'Purge group data?'),
            message: i18nTf(
                'purge.group.confirm',
                { name: groupName },
                `Delete all data for "${groupName}"?\n\nFiles, database records, and configuration will be permanently removed.`,
            ),
            confirmLabel: i18nT('settings.danger.purge_all', 'Purge All Data'),
            danger: true,
        }))
    )
        return;

    try {
        showToast(i18nT('purge.group.deleting', 'Deleting...'), 'info');
        const r = await api.delete(`/api/groups/${encodeURIComponent(groupId)}/purge`);
        if (!r?.started && !r?.success) throw new Error('Failed to start');
        // Final toast + state refresh come from `group_purge_done` WS event.
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT(
                    'jobs.already_running',
                    'Already running on another tab — waiting for it to finish.',
                ),
                'info',
            );
            return;
        }
        showToast(
            i18nTf('purge.group.failed', { msg: e.message }, 'Failed to delete: ' + e.message),
            'error',
        );
    }
}

/**
 * Delete ALL data -- factory reset
 */
async function purgeAll() {
    _wirePurgeWs();
    if (
        !(await confirmSheet({
            title: i18nT('purge.all.title', 'Purge ALL data?'),
            message: i18nT(
                'purge.all.confirm1',
                'Delete ALL data?\n\nAll files, database records, group configurations, and photos will be permanently removed.',
            ),
            confirmLabel: i18nT('settings.danger.purge_all', 'Purge All Data'),
            danger: true,
        }))
    )
        return;
    if (
        !(await confirmSheet({
            title: i18nT('purge.all.title2', 'Are you absolutely sure?'),
            message: i18nT('purge.all.confirm2', 'Are you sure? This cannot be undone.'),
            confirmLabel: i18nT('common.confirm', 'Confirm'),
            danger: true,
        }))
    )
        return;

    try {
        showToast(i18nT('purge.all.deleting', 'Deleting all data...'), 'info');
        const r = await api.delete('/api/purge/all');
        if (!r?.started && !r?.success) throw new Error('Failed to start');
        // Final toast + state reset come from `purge_all_done` WS event.
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT(
                    'jobs.already_running',
                    'Already running on another tab — waiting for it to finish.',
                ),
                'info',
            );
            return;
        }
        showToast(
            i18nTf('purge.group.failed', { msg: e.message }, 'Failed to delete: ' + e.message),
            'error',
        );
    }
}

// Start
init();
