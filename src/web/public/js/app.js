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

    // Sticky status bar (engine state + counters + WS link)
    initStatusBar();

    await loadGroups();
    await loadStats();
    
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

    // Appearance toggle
    initTheme();
    document.querySelectorAll('[data-theme-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            setTheme(btn.dataset.themeSet);
            highlightThemeButtons();
        });
    });
    highlightThemeButtons();

    navigateTo('viewer');
}

// ============ Navigation ============
function navigateTo(page) {
    state.currentPage = page;
    
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
    
    // Hide all pages, show selected
    document.querySelectorAll('#content-area > div[id^="page-"]').forEach(el => el.classList.add('hidden'));
    document.getElementById(`page-${page}`)?.classList.remove('hidden');
    
    // Show media tabs only on viewer page
    const mediaTabs = document.getElementById('media-tabs');
    if (mediaTabs) mediaTabs.style.display = page === 'viewer' ? '' : 'none';
    
    closeSidebar();
    
    if (page === 'settings') {
        Settings.loadSettings();
        initEngine();
        document.getElementById('page-title').textContent = 'Settings';
        document.getElementById('page-subtitle').textContent = 'System Configuration';
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

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.add('hidden');
}

// ============ Groups Logic ============
async function loadGroups() {
    try {
        const [groups, downloads] = await Promise.all([
            api.get('/api/groups'),
            api.get('/api/downloads')
        ]);
        state.groups = groups;
        state.downloads = downloads;
        renderGroupsList();
    } catch (e) {
        console.error('Failed to load groups:', e);
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

    list.innerHTML = sorted.map(g => `
        <div class="group-item hover:bg-tg-hover px-3 py-2 cursor-pointer flex items-center gap-3" data-group-id="${escapeHtml(String(g.downloadId || g.id || g.name))}" data-group-name="${escapeHtml(g.name)}">
            ${createAvatar(g.id || g.name, g.name, g.type)}
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                     <h3 class="text-sm font-medium text-tg-text truncate">${escapeHtml(g.name)}</h3>
                </div>
                <p class="text-xs text-tg-textSecondary">${g.totalFiles || 0} files • ${g.sizeFormatted || '0 B'}</p>
            </div>
            <button class="purge-btn w-8 h-8 rounded-full hover:bg-red-500/20 flex items-center justify-center opacity-0 group-item-hover transition-all" 
                data-purge-id="${escapeHtml(String(g.downloadId || g.id || g.name))}" data-purge-name="${escapeHtml(g.name)}" title="Delete group data">
                <i class="ri-delete-bin-line text-red-400 text-sm"></i>
            </button>
        </div>
    `).join('');

    // Event delegation for group clicks
    list.querySelectorAll('.group-item[data-group-id]').forEach(el => {
        el.addEventListener('click', (e) => {
            // Don't navigate when clicking delete button
            if (e.target.closest('.purge-btn')) return;
            openGroup(el.dataset.groupId, el.dataset.groupName);
        });
    });

    // Event delegation for purge buttons
    list.querySelectorAll('.purge-btn[data-purge-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            purgeGroup(btn.dataset.purgeId, btn.dataset.purgeName);
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

    grid.innerHTML = filtered.map((file, i) => {
        const checked = state.selected.has(file.fullPath);
        const checkBadge = state.selectMode
            ? `<div class="select-badge absolute top-1 left-1 w-5 h-5 rounded-full ${checked ? 'bg-tg-blue text-white' : 'bg-black/40 text-transparent'} flex items-center justify-center text-xs"><i class="ri-check-line"></i></div>`
            : '';
        const ringClass = checked ? 'ring-2 ring-tg-blue' : '';
        return `
        <div class="media-item relative aspect-square bg-tg-panel rounded overflow-hidden cursor-pointer ${ringClass}" data-index="${i}" data-path="${escapeHtml(file.fullPath)}">
            ${file.type === 'images' ?
                `<img data-src="/files/${encodeURIComponent(file.fullPath)}?inline=1" class="w-full h-full object-cover" onerror="this.style.display='none'">` :
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

    grid.querySelectorAll('.media-item[data-index]').forEach(el => {
        el.addEventListener('click', (ev) => {
            const idx = parseInt(el.dataset.index, 10);
            if (state.selectMode || ev.shiftKey) {
                toggleSelection(el.dataset.path);
                ev.preventDefault();
                return;
            }
            openMediaViewer(idx);
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
        let btnClass, btnLabel;
        if (d.inConfig && d.enabled) {
            btnClass = 'bg-green-500/20 text-green-400';
            btnLabel = '✅ Active';
        } else if (d.inConfig && !d.enabled) {
            btnClass = 'bg-yellow-500/15 text-yellow-400';
            btnLabel = '⏸ Paused';
        } else {
            btnClass = 'bg-tg-bg text-tg-textSecondary';
            btnLabel = '+ Add';
        }
        const typeLabel = d.type === 'channel' ? 'Channel'
            : d.type === 'group' ? 'Group'
            : d.type === 'bot' ? 'Bot'
            : d.type === 'user' ? 'DM' : 'Dialog';
        const subParts = [typeLabel];
        if (d.members) subParts.push(`${d.members} members`);
        if (d.archived) subParts.push('📦 archived');
        const badge = d.type === 'user'
            ? '<span class="ml-2 text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">DM</span>'
            : '';
        return `
        <div class="bg-tg-panel rounded-xl p-4 flex items-center gap-3 hover:bg-tg-hover transition-colors">
            ${createAvatar(d.id, d.name, d.type)}
            <div class="flex-1 min-w-0">
                <h3 class="text-tg-text font-medium truncate">${escapeHtml(d.name)}${badge}</h3>
                <p class="text-xs text-tg-textSecondary">${subParts.join(' • ')}</p>
            </div>
            <button data-dialog-id="${escapeHtml(String(d.id))}" data-dialog-name="${escapeHtml(d.name)}"
                class="px-3 py-1.5 rounded-lg text-sm ${btnClass} hover:opacity-80 transition">
                ${btnLabel}
            </button>
        </div>`;
    }).join('');

    // Event delegation for dialog config buttons
    list.querySelectorAll('button[data-dialog-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openGroupSettings(btn.dataset.dialogId, btn.dataset.dialogName);
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
            const limit = parseInt(btn.dataset.historyLimit, 10) || 100;
            if (!confirm(`Download the last ${limit} messages of "${groupName}" into the queue?`)) return;
            btn.disabled = true;
            try {
                const r = await api.post('/api/history', { groupId, limit });
                if (progressEl) {
                    progressEl.textContent = `Job ${r.jobId} queued — watch the Engine card for progress.`;
                    progressEl.classList.remove('hidden');
                }
                showToast(`History job started (${limit} messages)`, 'success');
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

function openDestinationPicker() {
    showToast('Use group ID from the Dialogs list');
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
    const panel = document.getElementById('stories-panel');
    const fetch = document.getElementById('stories-fetch');
    const userInput = document.getElementById('stories-username');
    const list = document.getElementById('stories-list');
    const result = document.getElementById('stories-result');
    if (!btn || !panel) return;

    btn.addEventListener('click', () => {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) userInput?.focus();
    });

    fetch?.addEventListener('click', async () => {
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
                    <div class="text-sm">
                        <span class="text-tg-text">#${s.id}</span>
                        <span class="text-tg-textSecondary">${s.media?.type || 'unknown'}${s.caption ? ` — ${escapeHtml(s.caption.slice(0, 40))}` : ''}</span>
                    </div>
                    <input type="checkbox" data-story-id="${s.id}" checked class="w-4 h-4 accent-tg-blue">
                </label>
            `).join('') + `
                <button id="stories-go" class="tg-btn w-full mt-2 text-sm"><i class="ri-download-line mr-1"></i>Download selected</button>
            `;
            document.getElementById('stories-go')?.addEventListener('click', async () => {
                const ids = Array.from(list.querySelectorAll('input[type=checkbox]:checked'))
                    .map(cb => parseInt(cb.dataset.storyId, 10)).filter(Number.isFinite);
                if (!ids.length) { showToast('Pick at least one story', 'warning'); return; }
                try {
                    const dl = await api.post('/api/stories/download', { username, storyIds: ids });
                    result.textContent = `Queued ${dl.queued} of ${dl.requested} stories.`;
                    showToast(`Queued ${dl.queued} stories`, 'success');
                } catch (e) {
                    showToast(`Download failed: ${e.message}`, 'error');
                }
            });
        } catch (e) {
            list.innerHTML = `<div class="text-red-400 text-sm">${escapeHtml(e.message)}</div>`;
        }
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

function setupPasteUrl() {
    const btn = document.getElementById('paste-url-btn');
    const panel = document.getElementById('paste-url-panel');
    const cancel = document.getElementById('paste-url-cancel');
    const submit = document.getElementById('paste-url-submit');
    const input = document.getElementById('paste-url-input');
    const resultEl = document.getElementById('paste-url-result');
    if (!btn || !panel || !submit) return;

    btn.addEventListener('click', () => {
        const wasHidden = panel.classList.toggle('hidden');
        if (!wasHidden) input?.focus();
    });
    cancel?.addEventListener('click', () => panel.classList.add('hidden'));

    submit.addEventListener('click', async () => {
        const text = input.value.trim();
        if (!text) { showToast('Paste at least one Telegram link', 'warning'); return; }
        submit.disabled = true;
        try {
            const r = await api.post('/api/download/url', { url: text });
            const ok = r.results.filter(x => x.ok).length;
            const fail = r.results.length - ok;
            resultEl.textContent = `${ok} queued, ${fail} failed.`;
            r.results.forEach(x => {
                if (!x.ok) console.warn('paste-url failed:', x.url, x.error);
            });
            if (ok > 0) {
                showToast(`Queued ${ok} download${ok > 1 ? 's' : ''}`, 'success');
                input.value = '';
            }
            if (fail > 0 && ok === 0) {
                showToast(`All ${fail} URL(s) failed — check console`, 'error');
            }
        } catch (e) {
            showToast(`Request failed: ${e.message}`, 'error');
        } finally {
            submit.disabled = false;
        }
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
