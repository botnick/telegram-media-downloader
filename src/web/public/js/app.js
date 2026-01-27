/**
 * Telegram Downloader Config GUI
 * Features: Viewer, Groups Config, Settings
 * NO Monitor, NO History
 */

// ============ State ============
const state = {
    currentPage: 'viewer',
    currentGroup: null,
    currentFilter: 'all',
    groups: [],
    downloads: [],
    files: [],
    allFiles: [],
    currentFileIndex: 0,
    config: {},
    page: 1,
    hasMore: true,
    loading: false,
    observer: null,
    imageObserver: null,
    viewMode: 'grid',
    searchQuery: ''
};

// ============ API ============
const api = {
    async get(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    },
    async post(url, data) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    },
    async put(url, data) {
        const res = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    },
    async delete(url) {
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
};

// ============ Initialize ============
async function init() {
    setupLazyLoading();
    setupInfiniteScroll();
    setupEventListeners();
    setupSwipeGestures();
    
    await loadGroups();
    await loadStats();
    navigateTo('viewer');
}

// ============// Helper: Get avatar gradient class based on ID (Telegram style)
function getAvatarClass(id) {
    const colors = [
        'bg-gradient-to-br from-red-500 to-orange-500', 
        'bg-gradient-to-br from-orange-400 to-yellow-500',
        'bg-gradient-to-br from-purple-500 to-pink-500',
        'bg-gradient-to-br from-blue-500 to-cyan-500',
        'bg-gradient-to-br from-green-400 to-emerald-600',
        'bg-gradient-to-br from-indigo-500 to-purple-600',
        'bg-gradient-to-br from-pink-500 to-rose-500',
        'bg-gradient-to-br from-cyan-500 to-blue-600'
    ];
    // Use modulo ID to pick consistent color
    const numId = Math.abs(parseInt(String(id).slice(-5)) || 0);
    return colors[numId % colors.length];
}

// Helper: Get detailed group type
function getGroupType(id) {
    const idStr = String(id);
    if (!idStr.startsWith('-')) return 'Private Chat';
    if (idStr.startsWith('-100')) return 'Channel'; // Most channels are -100
    return 'Group';
}

function getGroupTypeIcon(id) {
    const type = getGroupType(id);
    if (type === 'Private Chat') return '<i class="ri-user-fill"></i>';
    if (type === 'Channel') return '<i class="ri-megaphone-fill"></i>';
    return '<i class="ri-group-fill"></i>';
}

// Shared Avatar HTML Generator
function createAvatar(id, name, type) {
    const gradient = getAvatarClass(id);
    const initial = (name || '?').charAt(0).toUpperCase();
    let typeIcon = 'question-line';
    
    // Determine icon based on type hint or ID inference
    if (type === 'channel' || String(id).startsWith('-100')) typeIcon = 'megaphone-fill';
    else if (type === 'group' || String(id).startsWith('-')) typeIcon = 'group-fill';
    else typeIcon = 'user-fill';

    // Return HTML structure that attempts to load image, falls back to gradient
    return `
        <div class="relative w-12 h-12 flex-shrink-0">
            <img src="/api/groups/${id}/photo" 
                 class="w-full h-full rounded-full object-cover bg-tg-bg border border-white/5" 
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'"
                 loading="lazy"
                 alt="${escapeHtml(name)}">
            
            <div class="absolute inset-0 w-full h-full rounded-full ${gradient} flex items-center justify-center text-white hidden shadow-inner">
                <span class="text-xl font-bold drop-shadow-md pb-0.5">${initial}</span>
            </div>

            <div class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-tg-panel flex items-center justify-center z-10 border border-tg-bg">
                <div class="w-4 h-4 rounded-full bg-tg-bg flex items-center justify-center text-tg-textSecondary text-[10px]">
                    <i class="ri-${typeIcon}"></i>
                </div>
            </div>
        </div>
    `;
}

// ============ Lazy Loading ============
function setupLazyLoading() {
    state.imageObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                if (el.dataset.src) {
                    if (el.tagName === 'IMG') {
                        el.src = el.dataset.src;
                        el.onload = () => el.classList.add('loaded');
                        el.onerror = () => el.parentElement?.classList.add('error');
                    } else if (el.tagName === 'VIDEO') {
                        el.src = el.dataset.src;
                        el.preload = 'metadata';
                        el.onloadeddata = () => { el.currentTime = 0.1; };
                        el.onseeked = () => { el.classList.add('loaded'); };
                    }
                    delete el.dataset.src;
                    state.imageObserver.unobserve(el);
                }
            }
        });
    }, { rootMargin: '200px', threshold: 0.01 });
}

// ============ Infinite Scroll ============
function setupInfiniteScroll() {
    const sentinel = document.getElementById('load-more-sentinel');
    if (!sentinel) return;
    
    state.observer = new IntersectionObserver(async (entries) => {
        if (entries[0].isIntersecting && state.hasMore && !state.loading && state.currentGroup) {
            await loadMoreFiles();
        }
    }, { rootMargin: '100px' });
    
    state.observer.observe(sentinel);
}

async function loadMoreFiles() {
    if (state.loading || !state.hasMore) return;
    
    state.loading = true;
    state.page++;
    document.getElementById('loading')?.classList.remove('hidden');
    
    try {
        const result = await api.get(
            `/api/downloads/${encodeURIComponent(state.currentGroup)}?type=${state.currentFilter}&page=${state.page}&limit=50`
        );
        
        result.files.forEach(f => {
            f.groupName = state.currentGroup;
            f.fullPath = state.currentGroup + '/' + f.path;
        });
        
        if (result.files.length === 0) {
            state.hasMore = false;
        } else {
            state.files = state.files.concat(result.files);
            state.allFiles = state.files;
            appendMediaItems(result.files, state.files.length - result.files.length);
        }
    } catch (error) {
        console.error('Load more failed:', error);
    } finally {
        state.loading = false;
        document.getElementById('loading')?.classList.add('hidden');
    }
}

// ============ Swipe Gestures ============
function setupSwipeGestures() {
    const modal = document.getElementById('modal-swipe');
    if (!modal) return;
    
    let startX = 0, diffX = 0;
    
    modal.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
    }, { passive: true });
    
    modal.addEventListener('touchmove', (e) => {
        diffX = e.touches[0].clientX - startX;
        if (Math.abs(diffX) > 10) {
            modal.style.transform = `translateX(${diffX * 0.5}px)`;
        }
    }, { passive: true });
    
    modal.addEventListener('touchend', () => {
        modal.style.transform = '';
        if (Math.abs(diffX) > 80) {
            diffX > 0 ? navigateMedia(-1) : navigateMedia(1);
        }
        diffX = 0;
    }, { passive: true });
}

// ============ Load Data ============
async function loadGroups() {
    try {
        const [groups, downloads] = await Promise.all([
            api.get('/api/groups'),
            api.get('/api/downloads')
        ]);
        
        state.groups = groups;
        state.downloads = downloads;
        
        renderGroupsList();
    } catch (error) {
        console.error('Failed to load groups:', error);
    }
}

async function loadStats() {
    try {
        const stats = await api.get('/api/stats');
        document.getElementById('disk-usage').textContent = stats.diskUsageFormatted || '0 B';
        
        let total = 0;
        state.downloads.forEach(d => total += d.totalFiles || 0);
        document.getElementById('total-files').textContent = total.toLocaleString();
        
        // Update All Media button count
        const allMediaCount = document.getElementById('all-media-count');
        if (allMediaCount) allMediaCount.textContent = `${total.toLocaleString()} files`;
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// ============ Render Groups List ============
function renderGroupsList() {
    const list = document.getElementById('groups-list');
    if (!list) return; // Not in viewer mode
    
    // Merge Downloads with Configured Groups
    // Goal: Display 1 entry per group, preferring Config data if available
    
    // Map to store unique groups by "Normalized ID or Name"
    const uniqueMap = new Map();
    
    // Helper to normalize keys (Support Unicode/Thai)
    const normalize = (str) => String(str).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

    // 1. Process Configured Groups First
    state.groups.forEach(g => {
        const key = g.id ? String(g.id) : normalize(g.name);
        uniqueMap.set(key, {
            ...g,
            isConfig: true,
            totalFiles: 0,
            sizeFormatted: '0 B',
            type: getGroupType(g.id)
        });
    });

    // 2. Process Downloads (Folders)
    state.downloads.forEach(d => {
        // Try to match with existing config group
        let match = null;
        
        // Match by Name (Normalized)
        const dNameNorm = normalize(d.name);
        
        for (const [key, val] of uniqueMap.entries()) {
            if (normalize(val.name) === dNameNorm) {
                match = val;
                break;
            }
        }
        
        if (match) {
            // Merge stats into existing config entry
            match.totalFiles = (match.totalFiles || 0) + d.totalFiles;
            match.sizeFormatted = d.sizeFormatted; // Use latest size
        } else {
            // New entry (Folder only, no config)
            const id = d.name; // Use name as ID for folder-only groups
            uniqueMap.set(dNameNorm, {
                id: id,
                name: d.name,
                isConfig: false,
                totalFiles: d.totalFiles,
                sizeFormatted: d.sizeFormatted,
                type: 'Folder'
            });
        }
    });

    // Convert back to array
    const mergedGroups = Array.from(uniqueMap.values());
    
    // Render
    list.innerHTML = mergedGroups.map(group => {
        const activeClass = (state.currentGroup && (state.currentGroup === group.name || state.currentGroup === group.id)) 
            ? 'bg-tg-active' 
            : 'hover:bg-tg-hover';
            
        // Use the unified avatar generator
        const avatarId = group.isConfig ? group.id : group.name; 
        const avatarHtml = createAvatar(avatarId, group.name, group.type?.toLowerCase());

        return `
            <div class="${activeClass} px-3 py-2.5 cursor-pointer transition-colors flex items-center gap-3 group"
                 onclick="openGroup('${escapeHtml(group.name.replace(/'/g, "\\'"))}')">
                
                ${avatarHtml}
                
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                        <h3 class="font-medium text-tg-text truncate text-[15px] leading-tight">${escapeHtml(group.name)}</h3>
                        ${group.isConfig ? '<i class="ri-checkbox-circle-fill text-tg-blue text-xs flex-shrink-0" title="Monitored"></i>' : ''}
                    </div>
                    <div class="flex items-center gap-1.5 text-[13px] text-tg-textSecondary mt-0.5">
                        <span>${group.totalFiles.toLocaleString()} files</span>
                        <span class="opacity-50">•</span>
                        <span>${group.sizeFormatted}</span>
                    </div>
                </div>
                
                ${group.isConfig ? `
                    <button class="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all flex-shrink-0" 
                            title="Settings"
                            onclick="event.stopPropagation(); openAutoForward('${escapeHtml(group.name.replace(/'/g, "\\'"))}')">
                        <i class="ri-more-2-fill text-tg-textSecondary text-lg"></i>
                    </button>
                ` : ''}
            </div>
        `;
    }).join('');
}

function openAutoForward(groupName) {
    openGroupSettings(groupName);
    // Switch to Auto Forward tab
    setTimeout(() => {
        const tabBtn = document.querySelector('.tab-btn[data-tab="forward"]');
        if (tabBtn) tabBtn.click();
    }, 100);
}

// ============ Open Group (Viewer) ============
async function openGroup(groupName) {
    state.currentGroup = groupName;
    state.currentFilter = 'all';
    state.page = 1;
    state.hasMore = true;
    state.files = [];
    state.allFiles = [];
    
    // Find group data
    const group = state.groups.find(g => g.name === groupName) || 
                  state.downloads.find(d => d.name === groupName) ||
                  { name: groupName, id: groupName }; // Fallback

    const groupId = group.id || groupName;
    const groupType = group.type || getGroupType(groupId);

    // Update Header
    updateHeader(group, groupId, groupType);
    
    await loadGroupFiles(groupName);
    renderGroupsList();
    resetTabs();
    navigateTo('viewer');
}

function updateHeader(group, id, type) {
    const avatarContainer = document.getElementById('header-avatar');
    if (avatarContainer) {
        // Use unified avatar generator
        // We need to strip the wrapping div from createAvatar because header-avatar IS the container
        // But createAvatar returns a full block.
        // Let's replace the entire innerHTML + className of the header-avatar container
        
        // Actually, let's look at user's HTML.
        // User wants: <div id="header-avatar" ...> [IMG] </div>
        
        // We'll reset the class to base logic + gradient if needed
        const gradient = getAvatarClass(id);
        const name = group.name;
        const initial = name.charAt(0).toUpperCase();
        
        // If we have an image, we try to load it. 
        // Logic: Try generic photo URL. If fail, fall back to gradient.
        
        avatarContainer.className = `tg-avatar w-10 h-10 text-lg flex-shrink-0 relative rounded-full overflow-hidden ${gradient}`;
        
        avatarContainer.innerHTML = `
            <img src="/api/groups/${id}/photo" 
                 class="w-full h-full object-cover" 
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'"
                 loading="lazy">
            <div class="absolute inset-0 w-full h-full flex items-center justify-center text-white hidden">
                ${initial}
            </div>
        `;
        
        // If image loads, the nextSibling (div with initial) is hidden.
        // If image fails, img is hidden, nextSibling is flex.
        // The container has the gradient class, so the background shows through if img is hidden?
        // Wait, if img is hidden, we see the container background. 
        // If img is shown, it covers the background.
        // The inner div with initial also needs to be centered.
    }
    
    document.getElementById('page-title').textContent = group.name; // Clean name
    // Update subtitle with stats if available
    const download = state.downloads.find(d => d.name === group.name);
    if (download) {
        document.getElementById('page-subtitle').textContent = `${download.totalFiles} files • ${download.sizeFormatted}`;
    } else {
         document.getElementById('page-subtitle').textContent = 'Loading...';
    }
}

async function showAllMedia() {
    state.currentGroup = null;
    state.currentFilter = 'all';
    state.files = [];
    state.allFiles = [];
    
    document.getElementById('page-title').textContent = 'All Media';
    document.getElementById('page-subtitle').textContent = 'All downloaded files';
    document.getElementById('header-avatar').className = 'tg-avatar tg-avatar-4 w-10 h-10 text-lg flex-shrink-0';
    document.getElementById('header-avatar').innerHTML = '<i class="ri-gallery-line"></i>';
    
    showSkeletonGrid();
    
    let allFiles = [];
    let totalCount = 0;
    
    for (const download of state.downloads) {
        totalCount += download.totalFiles || 0;
        try {
            // Fetch latest 500 files per group for fast initial load
            const result = await api.get(`/api/downloads/${encodeURIComponent(download.name)}?limit=500`);
            result.files.forEach(f => {
                f.groupName = download.name;
                f.fullPath = download.name + '/' + f.path;
            });
            allFiles = allFiles.concat(result.files);
        } catch (e) {}
    }
    
    allFiles.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    state.files = allFiles;
    state.allFiles = allFiles;
    
    // Show actual total count (from downloads metadata), not just fetched count
    document.getElementById('page-subtitle').textContent = `${totalCount.toLocaleString()} files total`;
    
    // Ensure tabs are visible
    document.getElementById('media-tabs')?.classList.remove('hidden');
    
    renderMediaGrid();
    renderGroupsList();
    resetTabs();
}

async function loadGroupFiles(groupName, filter = 'all') {
    state.loading = true;
    showSkeletonGrid();
    
    try {
        const result = await api.get(`/api/downloads/${encodeURIComponent(groupName)}?type=${filter}&page=1&limit=50`);
        result.files.forEach(f => {
            f.groupName = groupName;
            f.fullPath = groupName + '/' + f.path;
        });
        state.files = result.files;
        state.allFiles = result.files;
        state.hasMore = result.files.length === 50;
        
        document.getElementById('page-subtitle').textContent = `${result.total} files`;
        
        renderMediaGrid();
    } catch (error) {
        console.error('Failed to load files:', error);
        showToast('Failed to load files', 'error');
    } finally {
        state.loading = false;
    }
}

// ============ View Mode Toggle ============
function toggleViewMode() {
    state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid';
    
    const btn = document.getElementById('view-mode-btn');
    const icon = btn?.querySelector('i');
    
    if (state.viewMode === 'list') {
        icon.className = 'ri-list-check text-xl text-tg-textSecondary';
    } else {
        icon.className = 'ri-layout-grid-line text-xl text-tg-textSecondary';
    }
    
    renderMediaGrid();
}

// ============ Render Media ============
function showSkeletonGrid() {
    const grid = document.getElementById('media-grid');
    if (!grid) return;
    
    if (state.viewMode === 'list') {
        grid.innerHTML = Array(8).fill('<div class="skeleton h-16 rounded-lg"></div>').join('');
    } else {
        grid.innerHTML = Array(12).fill('<div class="media-item skeleton rounded-lg"></div>').join('');
    }
}

function renderMediaGrid() {
    const grid = document.getElementById('media-grid');
    const empty = document.getElementById('empty-state');
    if (!grid) return;
    
    let filesToShow = state.allFiles;
    if (state.currentFilter !== 'all') {
        filesToShow = state.allFiles.filter(f => f.type === state.currentFilter);
    }
    state.files = filesToShow;
    
    if (filesToShow.length === 0) {
        grid.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
    }
    
    empty?.classList.add('hidden');
    
    // Performance: Render in batches to avoid blocking UI
    const INITIAL_BATCH = 60;  // Show first batch immediately
    const CHUNK_SIZE = 40;     // Render rest in chunks
    
    const initialFiles = filesToShow.slice(0, INITIAL_BATCH);
    const remainingFiles = filesToShow.slice(INITIAL_BATCH);
    
    if (state.viewMode === 'list') {
        grid.className = 'space-y-2';
        grid.innerHTML = initialFiles.map((file, index) => createListItem(file, index)).join('');
    } else {
        grid.className = 'media-grid';
        grid.innerHTML = initialFiles.map((file, index) => createMediaItem(file, index)).join('');
    }
    
    // Observe initial batch for lazy loading
    grid.querySelectorAll('[data-src]').forEach(el => {
        state.imageObserver.observe(el);
    });
    
    // Render remaining files in background chunks (non-blocking)
    if (remainingFiles.length > 0) {
        let offset = INITIAL_BATCH;
        const renderChunk = () => {
            const chunk = remainingFiles.splice(0, CHUNK_SIZE);
            if (chunk.length === 0) return;
            
            const fragment = document.createDocumentFragment();
            const tempDiv = document.createElement('div');
            
            if (state.viewMode === 'list') {
                tempDiv.innerHTML = chunk.map((file, i) => createListItem(file, offset + i)).join('');
            } else {
                tempDiv.innerHTML = chunk.map((file, i) => createMediaItem(file, offset + i)).join('');
            }
            
            while (tempDiv.firstChild) {
                fragment.appendChild(tempDiv.firstChild);
            }
            
            grid.appendChild(fragment);
            offset += CHUNK_SIZE;
            
            // Observe new images
            grid.querySelectorAll('[data-src]:not([data-observed])').forEach(el => {
                el.dataset.observed = 'true';
                state.imageObserver.observe(el);
            });
            
            // Schedule next chunk
            if (remainingFiles.length > 0) {
                requestAnimationFrame(renderChunk);
            }
        };
        
        // Start chunked rendering after initial paint
        requestAnimationFrame(renderChunk);
    }
}

function appendMediaItems(files, startIndex) {
    const grid = document.getElementById('media-grid');
    if (!grid) return;
    
    const temp = document.createElement('div');
    
    if (state.viewMode === 'list') {
        temp.innerHTML = files.map((file, i) => createListItem(file, startIndex + i)).join('');
    } else {
        temp.innerHTML = files.map((file, i) => createMediaItem(file, startIndex + i)).join('');
    }
    
    while (temp.firstChild) {
        grid.appendChild(temp.firstChild);
    }
    
    grid.querySelectorAll('[data-src]:not(.loaded)').forEach(el => {
        state.imageObserver.observe(el);
    });
}

function createMediaItem(file, index) {
    const url = `/files/${encodeURIComponent(file.fullPath)}`;
    const isImage = file.type === 'images';
    const isVideo = file.type === 'videos';
    
    return `
        <div class="media-item rounded-lg" onclick="openMediaViewer(${index})">
            ${isImage ? `
                <img data-src="${url}" class="w-full h-full object-cover" alt="" loading="lazy">
            ` : isVideo ? `
                <div class="relative w-full h-full bg-tg-bg">
                    <video data-src="${url}" class="w-full h-full object-cover" muted preload="none"></video>
                    <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div class="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center">
                            <i class="ri-play-fill text-xl text-white"></i>
                        </div>
                    </div>
                    <div class="absolute bottom-1 right-1 bg-black/60 px-1.5 py-0.5 rounded text-xs text-white">
                        ${file.sizeFormatted}
                    </div>
                </div>
            ` : `
                <div class="w-full h-full flex flex-col items-center justify-center bg-tg-bg p-2">
                    <i class="${getFileIcon(file.extension)} text-2xl text-tg-textSecondary mb-1"></i>
                    <span class="text-xs text-tg-textSecondary truncate w-full text-center">${escapeHtml(file.name)}</span>
                </div>
            `}
            <div class="media-overlay">
                <i class="ri-zoom-in-line text-xl text-white"></i>
            </div>
        </div>
    `;
}

function createListItem(file, index) {
    const url = `/files/${encodeURIComponent(file.fullPath)}`;
    const isImage = file.type === 'images';
    const isVideo = file.type === 'videos';
    
    return `
        <div class="flex items-center gap-3 p-3 bg-tg-panel rounded-lg hover:bg-tg-hover cursor-pointer transition" onclick="openMediaViewer(${index})">
            <div class="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-tg-bg flex items-center justify-center">
                ${isImage ? `
                    <img data-src="${url}" class="w-full h-full object-cover" loading="lazy">
                ` : isVideo ? `
                    <video src="${url}" class="w-full h-full object-cover" preload="metadata" muted playsinline onloadedmetadata="this.currentTime=1"></video>
                ` : `
                    <i class="${getFileIcon(file.extension)} text-xl text-tg-textSecondary"></i>
                `}
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-tg-text truncate">${escapeHtml(file.name)}</p>
                <p class="text-xs text-tg-textSecondary">${file.sizeFormatted} • ${formatDate(file.modified)}</p>
            </div>
            <a href="${url}" download class="w-10 h-10 rounded-full hover:bg-tg-hover flex items-center justify-center flex-shrink-0" onclick="event.stopPropagation()">
                <i class="ri-download-line text-tg-blue"></i>
            </a>
        </div>
    `;
}

function getFileIcon(ext) {
    const icons = {
        '.pdf': 'ri-file-pdf-line',
        '.doc': 'ri-file-word-line',
        '.docx': 'ri-file-word-line',
        '.xls': 'ri-file-excel-line',
        '.xlsx': 'ri-file-excel-line',
        '.zip': 'ri-file-zip-line',
        '.rar': 'ri-file-zip-line',
        '.mp3': 'ri-music-line',
        '.ogg': 'ri-music-line',
        '.wav': 'ri-music-line',
        '.tgs': 'ri-emotion-line',
        '.webp': 'ri-image-line'
    };
    return icons[ext] || 'ri-file-line';
}

// ============ Media Viewer State ============
let zoomState = { scale: 1, panning: false, pointX: 0, pointY: 0, startX: 0, startY: 0 };
let videoState = { isPlaying: false, isMuted: false, volume: 1, speed: 1.0 };

// ============ Media Viewer ============
function openMediaViewer(index) {
    state.currentFileIndex = index;
    const file = state.files[index];
    if (!file) return;
    
    const modal = document.getElementById('media-modal');
    const imageContainer = document.getElementById('image-container');
    const image = document.getElementById('modal-image');
    const videoContainer = document.getElementById('video-container');
    const video = document.getElementById('modal-video');
    const url = `/files/${encodeURIComponent(file.fullPath)}`;
    
    // Reset Views
    imageContainer.classList.add('hidden');
    videoContainer.classList.add('hidden');
    
    // Reset States
    resetZoom();
    exitFullscreenMode();
    video.pause();
    
    if (file.type === 'images') {
        image.src = url;
        imageContainer.classList.remove('hidden');
        setupImageZoom();
    } else if (file.type === 'videos') {
        video.src = url;
        videoContainer.classList.remove('hidden');
        setupVideoPlayer();
    } else {
        window.open(url, '_blank');
        return;
    }
    
    document.getElementById('modal-filename').textContent = file.name;
    document.getElementById('modal-meta').textContent = `${file.sizeFormatted} • ${formatDate(file.modified)}`;
    document.getElementById('modal-counter').textContent = `${index + 1} / ${state.files.length}`;
    document.getElementById('modal-download').href = url;
    
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    
    renderPreviewStrip(index);
    preloadAdjacent(index);
}

// ============ Image Zoom Logic ============
function setupImageZoom() {
    const img = document.getElementById('modal-image');
    const container = document.getElementById('image-container');
    
    img.onmousedown = (e) => {
        if (zoomState.scale > 1) {
            e.preventDefault();
            zoomState.panning = true;
            zoomState.startX = e.clientX - zoomState.pointX;
            zoomState.startY = e.clientY - zoomState.pointY;
            img.classList.add('cursor-grabbing');
        }
    };

    img.onmouseup = () => {
        zoomState.panning = false;
        img.classList.remove('cursor-grabbing');
    };

    img.onmousemove = (e) => {
        if (!zoomState.panning) return;
        e.preventDefault();
        zoomState.pointX = e.clientX - zoomState.startX;
        zoomState.pointY = e.clientY - zoomState.startY;
        updateTransform();
    };

    container.onwheel = (e) => {
        e.preventDefault();
        const xs = (e.clientX - zoomState.pointX) / zoomState.scale;
        const ys = (e.clientY - zoomState.pointY) / zoomState.scale;
        const delta = -e.deltaY;
        
        (delta > 0) ? (zoomState.scale *= 1.2) : (zoomState.scale /= 1.2);
        
        // Limits
        if (zoomState.scale < 1) zoomState.scale = 1;
        if (zoomState.scale > 5) zoomState.scale = 5;
        
        if (zoomState.scale === 1) {
            zoomState.pointX = 0;
            zoomState.pointY = 0;
        } else {
            zoomState.pointX = e.clientX - xs * zoomState.scale;
            zoomState.pointY = e.clientY - ys * zoomState.scale;
        }

        updateTransform();
    };
}

function updateTransform() {
    const img = document.getElementById('modal-image');
    img.style.transform = `translate(${zoomState.pointX}px, ${zoomState.pointY}px) scale(${zoomState.scale})`;
}

function resetZoom() {
    zoomState = { scale: 1, panning: false, pointX: 0, pointY: 0, startX: 0, startY: 0 };
    updateTransform();
}

// ============ Custom Video Player ============
function setupVideoPlayer() {
    const video = document.getElementById('modal-video');
    const playBtn = document.getElementById('video-play-btn');
    const progressContainer = document.getElementById('video-progress-container');
    const volumeInput = document.getElementById('video-volume');
    const muteBtn = document.getElementById('video-mute-btn');
    const pipBtn = document.getElementById('video-pip-btn');
    const speedBtn = document.getElementById('video-settings-btn');
    const speedMenu = document.getElementById('video-speed-menu');
    const fullscreenBtn = document.getElementById('video-fullscreen-btn');

    // Reset controls
    updatePlayIcon(false);
    updateProgress(0);
    video.volume = videoState.volume;
    video.playbackRate = videoState.speed;
    speedMenu.classList.add('hidden');

    // Events
    playBtn.onclick = toggleVideoPlay;
    video.onclick = toggleVideoPlay;
    video.onplay = () => updatePlayIcon(true);
    video.onpause = () => updatePlayIcon(false);
    
    video.ontimeupdate = () => {
        const percent = (video.currentTime / video.duration) * 100;
        updateProgress(percent);
        document.getElementById('video-current-time').textContent = formatTime(video.currentTime);
        document.getElementById('video-duration').textContent = formatTime(video.duration || 0);
    };

    progressContainer.onclick = (e) => {
        const rect = progressContainer.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        video.currentTime = pos * video.duration;
    };

    volumeInput.oninput = (e) => {
        video.volume = e.target.value;
        videoState.volume = video.volume;
        updateVolumeIcon(video.volume);
    };

    muteBtn.onclick = () => {
        video.muted = !video.muted;
        updateVolumeIcon(video.muted ? 0 : video.volume);
    };

    pipBtn.onclick = async () => {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
    };

    // Speed Menu
    speedBtn.closest('div').classList.add('relative'); // Ensure positioning context
    speedBtn.onclick = (e) => {
        e.stopPropagation();
        speedMenu.classList.toggle('hidden');
        // Simple animation
        if (!speedMenu.classList.contains('hidden')) {
            speedMenu.classList.remove('scale-95', 'opacity-0');
        } else {
            speedMenu.classList.add('scale-95', 'opacity-0');
        }
    };

    document.querySelectorAll('.speed-opt').forEach(opt => {
        opt.onclick = () => {
            const speed = parseFloat(opt.dataset.speed);
            video.playbackRate = speed;
            videoState.speed = speed;
            speedMenu.classList.add('hidden');
            
            // Update speed button label
            speedBtn.textContent = speed === 1 ? '1x' : speed + 'x';
            
            // Update active state in menu
            document.querySelectorAll('.speed-opt').forEach(o => {
                o.classList.remove('text-tg-blue');
                o.querySelector('i')?.remove();
            });
            opt.classList.add('text-tg-blue');
            opt.insertAdjacentHTML('beforeend', '<i class="ri-check-line"></i>');
        };
    });
    
    // Close menu on click outside
    document.addEventListener('click', (e) => {
        if (!speedMenu.contains(e.target) && e.target !== speedBtn && !speedBtn.contains(e.target)) {
            speedMenu.classList.add('hidden');
        }
    });

    fullscreenBtn.onclick = toggleVideoFullscreen;
}

function toggleVideoPlay() {
    const video = document.getElementById('modal-video');
    video.paused ? video.play() : video.pause();
}

function updatePlayIcon(isPlaying) {
    const icon = document.getElementById('video-play-btn').querySelector('i');
    icon.className = isPlaying ? 'ri-pause-fill text-2xl' : 'ri-play-fill text-2xl';
}

function updateProgress(percent) {
    document.getElementById('video-progress-fill').style.width = `${percent}%`;
}

function updateVolumeIcon(vol) {
    const icon = document.getElementById('video-mute-btn').querySelector('i');
    if (vol === 0) icon.className = 'ri-volume-mute-line text-xl';
    else if (vol < 0.5) icon.className = 'ri-volume-down-line text-xl';
    else icon.className = 'ri-volume-up-line text-xl';
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function toggleVideoFullscreen() {
    const container = document.getElementById('video-container');
    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => console.log(err));
    } else {
        document.exitFullscreen();
    }
}

// ============ Global Fullscreen (Modal) ============
function toggleFullscreen() {
    const modal = document.getElementById('media-modal');
    const isFullscreen = modal.classList.contains('fullscreen-mode');
    
    if (isFullscreen) {
        exitFullscreenMode();
    } else {
        enterFullscreenMode();
    }
}

function enterFullscreenMode() {
    const modal = document.getElementById('media-modal');
    modal.classList.add('fullscreen-mode');
    
    // Hide controls
    document.getElementById('modal-top-bar').style.opacity = '0';
    document.getElementById('modal-bottom-controls').style.transform = 'translateY(100%)';
    document.getElementById('modal-prev').style.opacity = '0';
    document.getElementById('modal-next').style.opacity = '0';
    document.getElementById('modal-swipe').classList.replace('p-0', 'p-0'); // Already 0 in new layout
    
    // Show toast hint
    showToast('Click image to exit fullscreen');
}

function exitFullscreenMode() {
    const modal = document.getElementById('media-modal');
    modal.classList.remove('fullscreen-mode');
    
    // Show controls
    document.getElementById('modal-top-bar').style.opacity = '1';
    document.getElementById('modal-bottom-controls').style.transform = 'translateY(0)';
    document.getElementById('modal-prev').style.opacity = '1';
    document.getElementById('modal-next').style.opacity = '1';
}

function renderPreviewStrip(currentIndex) {
    const strip = document.getElementById('preview-strip');
    const container = document.getElementById('preview-strip-container');
    if (!strip) return;
    
    // Get nearby files (10 before and 10 after for smoother scrolling)
    const start = Math.max(0, currentIndex - 10);
    const end = Math.min(state.files.length, currentIndex + 11);
    const nearbyFiles = state.files.slice(start, end);
    
    strip.innerHTML = nearbyFiles.map((file, i) => {
        const actualIndex = start + i;
        const url = `/files/${encodeURIComponent(file.fullPath)}`;
        const isActive = actualIndex === currentIndex;
        const isImage = file.type === 'images';
        const isVideo = file.type === 'videos';
        
        return `
            <div class="flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border-2 ${isActive ? 'border-tg-blue scale-110 shadow-lg' : 'border-transparent opacity-70 hover:opacity-100 hover:scale-105'}"
                 onclick="event.stopPropagation(); openMediaViewer(${actualIndex})"
                 data-index="${actualIndex}" data-type="${file.type}" data-url="${url}">
                ${isImage ? `
                    <img src="${url}" class="w-full h-full object-cover" loading="lazy">
                ` : isVideo ? `
                    <div class="w-full h-full bg-tg-panel flex items-center justify-center relative video-thumb" data-video-url="${url}">
                        <i class="ri-play-fill text-white text-lg z-10"></i>
                    </div>
                ` : `
                    <div class="w-full h-full bg-tg-panel flex items-center justify-center">
                        <i class="ri-file-line text-tg-textSecondary"></i>
                    </div>
                `}
            </div>
        `;
    }).join('');
    
    // Generate video thumbnails async
    setTimeout(() => {
        document.querySelectorAll('.video-thumb').forEach(async (el) => {
            const videoUrl = el.dataset.videoUrl;
            if (!videoUrl) return;
            
            try {
                const thumb = await generateVideoThumbnail(videoUrl);
                if (thumb) {
                    el.style.backgroundImage = `url(${thumb})`;
                    el.style.backgroundSize = 'cover';
                    el.style.backgroundPosition = 'center';
                }
            } catch (e) {
                // Keep fallback icon
            }
        });
    }, 100);
    
    // Scroll to center
    setTimeout(() => {
        const activeThumb = strip.querySelector('.border-tg-blue');
        if (activeThumb) {
            activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }, 50);
}

// Generate video thumbnail using canvas
const thumbCache = new Map();
async function generateVideoThumbnail(videoUrl) {
    if (thumbCache.has(videoUrl)) return thumbCache.get(videoUrl);
    
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.preload = 'metadata';
        
        video.onloadeddata = () => {
            video.currentTime = Math.min(1, video.duration * 0.1); // Seek to 10% or 1 sec
        };
        
        video.onseeked = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 120;
                canvas.height = 120;
                const ctx = canvas.getContext('2d');
                
                // Calculate center crop
                const size = Math.min(video.videoWidth, video.videoHeight);
                const sx = (video.videoWidth - size) / 2;
                const sy = (video.videoHeight - size) / 2;
                
                ctx.drawImage(video, sx, sy, size, size, 0, 0, 120, 120);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                thumbCache.set(videoUrl, dataUrl);
                resolve(dataUrl);
            } catch (e) {
                resolve(null);
            }
        };
        
        video.onerror = () => resolve(null);
        
        // Timeout fallback
        setTimeout(() => resolve(null), 3000);
        
        video.src = videoUrl;
    });
}

function preloadAdjacent(index) {
    [-1, 1, 2].forEach(offset => {
        const i = index + offset;
        if (i >= 0 && i < state.files.length) {
            const file = state.files[i];
            if (file.type === 'images') {
                const img = new Image();
                img.src = `/files/${encodeURIComponent(file.fullPath)}`;
            }
        }
    });
}

function closeMediaViewer() {
    const modal = document.getElementById('media-modal');
    const video = document.getElementById('modal-video');
    
    video?.pause();
    if (video) video.src = '';
    modal?.classList.add('hidden');
    document.body.style.overflow = '';
}

function navigateMedia(direction) {
    const newIndex = state.currentFileIndex + direction;
    if (newIndex >= 0 && newIndex < state.files.length) {
        openMediaViewer(newIndex);
    }
}

// ============ Page Navigation ============
function navigateTo(page) {
    // Update nav
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active');
        n.querySelector('i')?.classList.remove('text-tg-blue');
        n.querySelector('i')?.classList.add('text-tg-textSecondary');
    });
    const activeNav = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (activeNav) {
        activeNav.classList.add('active');
        activeNav.querySelector('i')?.classList.add('text-tg-blue');
        activeNav.querySelector('i')?.classList.remove('text-tg-textSecondary');
    }
    
    // Hide all pages
    ['viewer', 'groups', 'settings'].forEach(p => {
        document.getElementById(`page-${p}`)?.classList.add('hidden');
    });
    
    // Show target page
    document.getElementById(`page-${page}`)?.classList.remove('hidden');
    
    // Show/hide media tabs
    document.getElementById('media-tabs')?.classList.toggle('hidden', page !== 'viewer');
    
    // Update header
    const headers = {
        viewer: { title: 'Viewer', subtitle: 'View downloaded files' },
        groups: { title: 'Groups', subtitle: 'Configure download groups' },
        settings: { title: 'Settings', subtitle: 'App configuration' }
    };
    
    const h = headers[page] || headers.viewer;
    if (!state.currentGroup || page !== 'viewer') {
        document.getElementById('page-title').textContent = h.title;
        document.getElementById('page-subtitle').textContent = h.subtitle;
        document.getElementById('header-avatar').className = 'tg-avatar tg-avatar-4 w-10 h-10 text-lg flex-shrink-0';
        document.getElementById('header-avatar').innerHTML = `<i class="ri-${page === 'viewer' ? 'gallery' : page === 'groups' ? 'group' : 'settings-3'}-line"></i>`;
    }
    
    // Load page data
    if (page === 'groups') loadAllDialogs();
    if (page === 'settings') loadSettings();
    if (page === 'viewer' && !state.currentGroup && state.files.length === 0) showAllMedia();
    
    state.currentPage = page;
    closeSidebar();
}

function resetTabs() {
    document.querySelectorAll('#media-tabs .tab-item').forEach(t => t.classList.remove('active'));
    document.querySelector('#media-tabs .tab-item[data-type="all"]')?.classList.add('active');
    state.currentFilter = 'all';
}

function refreshCurrentPage() {
    if (state.currentPage === 'viewer') {
        if (state.currentGroup) loadGroupFiles(state.currentGroup, state.currentFilter);
        else showAllMedia();
    } else if (state.currentPage === 'groups') loadAllDialogs();
    else if (state.currentPage === 'settings') loadSettings();
    
    showToast('Refreshed');
}

// ============ Sidebar ============
function openSidebar() {
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-overlay')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.add('hidden');
    if (document.getElementById('media-modal')?.classList.contains('hidden') !== false) {
        document.body.style.overflow = '';
    }
}

// ============ Group Settings Modal ============
let currentEditingGroup = null;
let currentGroupSettings = null; // Temp state

function openGroupSettings(groupName) {
    const group = state.groups.find(g => g.name === groupName);
    if (!group) return;
    
    currentEditingGroup = group;
    // Deep copy settings to temp state
    currentGroupSettings = {
        enabled: group.enabled,
        filters: { ...group.filters },
        autoForward: { 
            enabled: false, 
            destination: '', 
            deleteAfterForward: false,
            ...(group.autoForward || {}) 
        }
    };
    
    // Reset Tab
    switchSettingsTab('media');
    
    // 1. Setup Enable Toggle
    updateToggle('group-enable-toggle', currentGroupSettings.enabled);
    
    // 2. Setup Filters
    const container = document.getElementById('filter-options');
    container.innerHTML = '';
    
    const filters = [
        { key: 'photos', label: '📷 Photos' },
        { key: 'videos', label: '🎬 Videos' },
        { key: 'files', label: '📁 Files' },
        { key: 'links', label: '🔗 Links' },
        { key: 'voice', label: '🎤 Voice' },
        { key: 'gifs', label: '🎞️ GIFs' },
        { key: 'stickers', label: '😊 Stickers' }
    ];
    
    filters.forEach(f => {
        const isEnabled = currentGroupSettings.filters[f.key] !== false;
        container.innerHTML += `
            <div class="flex items-center justify-between p-3 bg-tg-panel rounded-lg cursor-pointer hover:bg-tg-hover transition-colors"
                 onclick="toggleFilter('${f.key}')">
                <span class="text-tg-text text-sm">${f.label}</span>
                <div class="w-5 h-5 rounded-md border ${isEnabled ? 'bg-tg-blue border-tg-blue' : 'border-tg-textSecondary'} flex items-center justify-center">
                    ${isEnabled ? '<i class="ri-check-line text-white text-sm"></i>' : ''}
                </div>
            </div>
        `;
    });

    // 3. Setup Auto Forward
    updateToggle('fwd-enable-toggle', currentGroupSettings.autoForward.enabled);
    updateToggle('fwd-delete-toggle', currentGroupSettings.autoForward.deleteAfterForward);
    document.getElementById('fwd-destination').value = currentGroupSettings.autoForward.destination || '';
    
    // Toggle visibility based on enabled state
    const fwdSettings = document.getElementById('fwd-settings');
    fwdSettings.style.opacity = currentGroupSettings.autoForward.enabled ? '1' : '0.5';
    fwdSettings.style.pointerEvents = currentGroupSettings.autoForward.enabled ? 'auto' : 'none';
    
    document.getElementById('group-modal').classList.remove('hidden');
}

function closeGroupSettings() {
    document.getElementById('group-modal').classList.add('hidden');
    currentEditingGroup = null;
    currentGroupSettings = null;
}

function switchSettingsTab(tab) {
    // UI Update
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    
    document.getElementById('content-media').classList.add('hidden');
    document.getElementById('content-forward').classList.add('hidden');
    document.getElementById(`content-${tab}`).classList.remove('hidden');
}

function updateToggle(id, active) {
    const el = document.getElementById(id);
    if (active) el.classList.add('active');
    else el.classList.remove('active');
}

function toggleGroupEnabled(e) {
    if (e) e.stopPropagation();
    currentGroupSettings.enabled = !currentGroupSettings.enabled;
    updateToggle('group-enable-toggle', currentGroupSettings.enabled);
}

function toggleFwdEnabled(e) {
    if (e) e.stopPropagation();
    const enabled = !currentGroupSettings.autoForward.enabled;
    currentGroupSettings.autoForward.enabled = enabled;
    updateToggle('fwd-enable-toggle', enabled);
    
    const settingsDiv = document.getElementById('fwd-settings');
    settingsDiv.style.opacity = enabled ? '1' : '0.5';
    settingsDiv.style.pointerEvents = enabled ? 'auto' : 'none';
}

function toggleFwdDelete(e) {
    if (e) e.stopPropagation();
    currentGroupSettings.autoForward.deleteAfterForward = !currentGroupSettings.autoForward.deleteAfterForward;
    updateToggle('fwd-delete-toggle', currentGroupSettings.autoForward.deleteAfterForward);
}

function toggleFilter(key) {
    const current = currentGroupSettings.filters[key] !== false;
    currentGroupSettings.filters[key] = !current;
    
    // Re-render filters
    // Ideally we would just toggle class, but re-render is safer for sync
    const container = document.getElementById('filter-options');
    // Find index based on key order
    const filters = ['photos', 'videos', 'files', 'links', 'voice', 'gifs', 'stickers'];
    const index = filters.indexOf(key);
    
    if (index >= 0 && container.children[index]) {
        const div = container.children[index];
        const checkbox = div.querySelector('div');
        const isEnabled = currentGroupSettings.filters[key];
        
        checkbox.className = `w-5 h-5 rounded-md border ${isEnabled ? 'bg-tg-blue border-tg-blue' : 'border-tg-textSecondary'} flex items-center justify-center`;
        checkbox.innerHTML = isEnabled ? '<i class="ri-check-line text-white text-sm"></i>' : '';
    }
}

async function saveGroupSettings() {
    if (!currentEditingGroup) return;
    
    try {
        // Collect inputs
        currentGroupSettings.autoForward.destination = document.getElementById('fwd-destination').value.trim();
        if (currentGroupSettings.autoForward.destination === '') currentGroupSettings.autoForward.destination = null;

        await api.put(`/api/groups/${currentEditingGroup.id}`, {
            enabled: currentGroupSettings.enabled,
            filters: currentGroupSettings.filters,
            autoForward: currentGroupSettings.autoForward
        });
        
        showToast('Settings saved');
        closeGroupSettings();
        await loadGroups();
    } catch (e) {
        showToast('Failed to save settings', 'error');
        console.error(e);
    }
}

// ============ Groups Config Page ============
let groupsTabMode = 'all'; // 'all' or 'monitored'
let allDialogsCache = []; // Cache for all dialogs

function switchGroupsTab(mode) {
    groupsTabMode = mode;
    
    // Update tab UI
    const allTab = document.getElementById('groups-tab-all');
    const monitoredTab = document.getElementById('groups-tab-monitored');
    const searchBox = document.getElementById('groups-search-box');
    const searchInput = document.getElementById('groups-search');
    
    // Clear search when switching tabs
    if (searchInput) searchInput.value = '';
    
    if (mode === 'all') {
        allTab.classList.add('border-tg-blue', 'text-tg-blue');
        allTab.classList.remove('border-transparent', 'text-tg-textSecondary');
        monitoredTab.classList.remove('border-tg-blue', 'text-tg-blue');
        monitoredTab.classList.add('border-transparent', 'text-tg-textSecondary');
        if (searchBox) searchBox.classList.remove('hidden');
        loadAllDialogs();
    } else {
        monitoredTab.classList.add('border-tg-blue', 'text-tg-blue');
        monitoredTab.classList.remove('border-transparent', 'text-tg-textSecondary');
        allTab.classList.remove('border-tg-blue', 'text-tg-blue');
        allTab.classList.add('border-transparent', 'text-tg-textSecondary');
        if (searchBox) searchBox.classList.add('hidden');
        loadGroupsConfig();
    }
}

async function loadAllDialogs() {
    const container = document.getElementById('groups-config-list');
    if (!container) return;
    
    container.innerHTML = `<div class="flex justify-center py-8"><div class="w-8 h-8 border-2 border-tg-blue border-t-transparent rounded-full animate-spin"></div></div>`;
    
    try {
        const result = await api.get('/api/dialogs');
        if (!result.success) throw new Error(result.error);
        
        allDialogsCache = result.dialogs;
        renderAllDialogs(result.dialogs);
    } catch (e) {
        container.innerHTML = `<div class="text-center text-red-400 py-8"><i class="ri-error-warning-line text-3xl mb-2"></i><p>Failed to load dialogs</p><p class="text-sm opacity-70">${e.message}</p></div>`;
    }
}

function filterDialogs(query) {
    if (!allDialogsCache.length) return;
    
    const q = query.toLowerCase().trim();
    if (!q) {
        renderAllDialogs(allDialogsCache);
        return;
    }
    
    const filtered = allDialogsCache.filter(d => 
        d.name.toLowerCase().includes(q) || 
        (d.username && d.username.toLowerCase().includes(q))
    );
    renderAllDialogs(filtered);
}

function renderAllDialogs(dialogs) {
    const container = document.getElementById('groups-config-list');
    if (!container || !dialogs) return;
    
    let html = '';
    
    if (dialogs.length === 0) {
        html = `<div class="text-center text-tg-textSecondary py-8">
            <i class="ri-group-line text-4xl mb-2 opacity-50"></i>
            <p>No groups/channels found</p>
        </div>`;
    }
    
    html += dialogs.map(d => {
        const typeIcon = d.type === 'channel' ? 'ri-megaphone-fill' : 'ri-group-fill';
        const typeLabel = d.type === 'channel' ? 'Channel' : 'Group';
        const avatarHtml = createAvatar(d.id, d.name, typeLabel);
        
        return `
            <div class="bg-tg-panel rounded-xl p-4 transition-all hover:bg-tg-hover/50">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3 overflow-hidden cursor-pointer flex-1" onclick="openGroupSettingsById('${d.id}', '${escapeHtml(d.name)}')">
                        ${avatarHtml}
                        <div class="min-w-0">
                            <h3 class="font-medium text-tg-text truncate">${escapeHtml(d.name)}</h3>
                            <p class="text-xs text-tg-textSecondary flex items-center gap-1">
                                <i class="${typeIcon} text-[10px]"></i> ${typeLabel}
                                ${d.enabled ? '<span class="text-tg-green ml-2">● Monitoring</span>' : ''}
                            </p>
                        </div>
                    </div>
                    <div class="tg-toggle ${d.enabled ? 'active' : ''}" 
                         data-group-id="${d.id}" 
                         data-group-name="${escapeHtml(d.name)}"
                         onclick="quickToggleMonitoring(this, event)"></div>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = html;
}

async function quickToggleMonitoring(el, e) {
    if (e) e.stopPropagation();
    
    const groupId = el.dataset.groupId;
    const groupName = el.dataset.groupName;
    const isCurrentlyActive = el.classList.contains('active');
    const newEnabled = !isCurrentlyActive;
    
    // Optimistic UI update
    el.classList.toggle('active');
    
    try {
        await api.put(`/api/groups/${groupId}`, { 
            name: groupName,
            enabled: newEnabled 
        });
        showToast(newEnabled ? 'Monitoring enabled' : 'Monitoring disabled');
        
        // Refresh groups list for sidebar
        loadGroups();
    } catch (err) {
        // Revert on error
        el.classList.toggle('active');
        showToast('Failed to update', 'error');
    }
}

async function openGroupSettingsById(groupId, groupName) {
    // Find in dialogs cache or create minimal object
    const dialog = allDialogsCache.find(d => d.id === groupId) || {
        id: groupId,
        name: groupName,
        enabled: false,
        filters: { photos: true, videos: true, files: true, links: true, voice: false, gifs: false },
        autoForward: { enabled: false, destination: null, deleteAfterForward: false }
    };
    
    currentEditingGroup = dialog;
    currentGroupSettings = {
        enabled: dialog.enabled,
        filters: { ...dialog.filters },
        autoForward: { ...dialog.autoForward }
    };
    
    // Populate modal
    document.getElementById('group-name').textContent = dialog.name;
    updateToggle('group-enable-toggle', currentGroupSettings.enabled);
    
    // Render filter options
    const filterContainer = document.getElementById('filter-options');
    const filterDefs = [
        { key: 'photos', label: 'Photos', icon: 'ri-image-line' },
        { key: 'videos', label: 'Videos', icon: 'ri-video-line' },
        { key: 'files', label: 'Files', icon: 'ri-file-line' },
        { key: 'links', label: 'Links', icon: 'ri-link' },
        { key: 'voice', label: 'Voice', icon: 'ri-mic-line' },
        { key: 'gifs', label: 'GIFs', icon: 'ri-film-line' },
        { key: 'stickers', label: 'Stickers', icon: 'ri-emotion-line' }
    ];
    
    filterContainer.innerHTML = filterDefs.map(f => {
        const isEnabled = currentGroupSettings.filters[f.key] !== false;
        return `
            <div onclick="toggleFilter('${f.key}')" class="flex items-center justify-between p-2 rounded-lg cursor-pointer hover:bg-tg-hover transition-colors">
                <span class="text-tg-text text-sm">${f.label}</span>
                <div class="w-5 h-5 rounded-md border ${isEnabled ? 'bg-tg-blue border-tg-blue' : 'border-tg-textSecondary'} flex items-center justify-center">
                    ${isEnabled ? '<i class="ri-check-line text-white text-sm"></i>' : ''}
                </div>
            </div>
        `;
    }).join('');
    
    // Auto Forward
    updateToggle('fwd-enable-toggle', currentGroupSettings.autoForward.enabled);
    updateToggle('fwd-delete-toggle', currentGroupSettings.autoForward.deleteAfterForward);
    document.getElementById('fwd-destination').value = currentGroupSettings.autoForward.destination || '';
    
    const fwdSettings = document.getElementById('fwd-settings');
    fwdSettings.style.opacity = currentGroupSettings.autoForward.enabled ? '1' : '0.5';
    fwdSettings.style.pointerEvents = currentGroupSettings.autoForward.enabled ? 'auto' : 'none';
    
    document.getElementById('group-modal').classList.remove('hidden');
}

async function loadGroupsConfig() {
    const container = document.getElementById('groups-config-list');
    if (!container) return;
    
    let html = '';
    
    // Filter only monitored groups
    const monitoredGroups = state.groups.filter(g => g.enabled);
    
    if (monitoredGroups.length === 0) {
        html = `<div class="text-center text-tg-textSecondary p-8 bg-tg-panel rounded-xl border border-dashed border-tg-border">
            <i class="ri-group-line text-4xl mb-2 opacity-50"></i>
            <p>No groups being monitored.</p>
            <p class="text-sm mt-1">Switch to "All Dialogs" tab to enable groups.</p>
        </div>`;
    }

    html += monitoredGroups.map(group => {
        const download = state.downloads.find(d => d.name === group.name);
        const filters = group.filters || {};
        const groupType = getGroupType(group.id);
        const typeIcon = getGroupTypeIcon(group.id);
        
        // Use real photo with fallback
        const avatarHtml = createAvatar(group.id, group.name, groupType);
        
        return `
            <div class="bg-tg-panel rounded-xl p-4 transition-transform hover:scale-[1.01] duration-200">
                <div class="flex items-center justify-between mb-4 cursor-pointer" onclick="openGroupSettings('${escapeHtml(group.name)}')">
                    <div class="flex items-center gap-3 overflow-hidden">
                        ${avatarHtml}
                        <div class="min-w-0">
                            <h3 class="font-medium text-tg-text truncate group-hover:text-tg-blue transition-colors text-lg">${escapeHtml(group.name)}</h3>
                            <p class="text-xs text-tg-textSecondary truncate">${groupType} • ID: ${group.id}</p>
                        </div>
                    </div>
                    <div class="tg-toggle ${group.enabled ? 'active' : ''}" data-group-id="${group.id}" onclick="toggleAndSaveGroup(this, event)"></div>
                </div>
                
                <div class="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    ${['images:Photos', 'videos:Videos', 'files:Files', 'audio:Audio', 'gifs:GIFs', 'stickers:Stickers']
                        .map(f => {
                            const [key, label] = f.split(':');
                            const isActive = filters[key] !== false;
                            return `
                                <button class="px-3 py-2 text-xs rounded-lg transition border ${isActive ? 'bg-tg-blue/10 border-tg-blue/30 text-tg-blue' : 'bg-tg-bg border-transparent text-tg-textSecondary opacity-60 hover:opacity-100'}" 
                                        data-group-id="${group.id}" data-filter="${key}"
                                        onclick="toggleGroupFilter(this)">
                                    ${label}
                                </button>
                            `;
                        }).join('')}
                </div>
                
                ${download ? `
                    <div class="mt-3 pt-3 border-t border-tg-border text-xs text-tg-textSecondary flex justify-between items-center">
                        <span><i class="ri-hard-drive-2-line mr-1"></i> ${download.totalFiles} files</span>
                        <span>${download.sizeFormatted}</span>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
    
    container.innerHTML = html;
}

// Add Group Modal Logic
async function openAddGroupModal() {
    // Reuse the destination picker style for consistency
    const modal = document.createElement('div');
    modal.id = 'add-group-modal';
    modal.className = 'fixed inset-0 z-[70] flex items-center justify-center p-4 modal-backdrop';
    modal.innerHTML = `
        <div class="bg-tg-sidebar w-full max-w-sm rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[80vh]">
            <div class="bg-tg-panel p-4 border-b border-tg-border flex items-center justify-between">
                <h3 class="text-white font-medium">Add Group to Monitor</h3>
                <button onclick="document.getElementById('add-group-modal').remove()" class="w-8 h-8 rounded-full hover:bg-tg-hover flex items-center justify-center transition-colors">
                    <i class="ri-close-line text-tg-textSecondary text-xl"></i>
                </button>
            </div>
            
            <div class="p-3 border-b border-tg-border">
                <div class="relative">
                    <i class="ri-search-line absolute left-3 top-1/2 transform -translate-y-1/2 text-tg-textSecondary"></i>
                    <input type="text" id="add-group-search" 
                        class="w-full bg-tg-bg border-none rounded-lg pl-10 pr-4 py-2 text-tg-text focus:ring-1 focus:ring-tg-blue outline-none" 
                        placeholder="Search chats...">
                </div>
            </div>

            <input type="hidden" id="selected-add-id">
            <input type="hidden" id="selected-add-name">
            <input type="hidden" id="selected-add-type">

            <div class="overflow-y-auto flex-1 custom-scrollbar p-2 space-y-1" id="add-group-list">
                <div class="flex items-center justify-center h-20">
                    <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-white"></div>
                </div>
            </div>
            
            <div class="p-3 bg-tg-panel border-t border-tg-border">
                <button onclick="confirmAddGroup()" id="btn-confirm-add" disabled 
                    class="w-full bg-tg-blue disabled:opacity-50 disabled:cursor-not-allowed text-white py-2 rounded-lg font-medium transition-opacity">
                    Add Selected Group
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    try {
        const res = await api.get('/api/dialogs');
        if (res.success) {
            // Filter out already added groups
            const existingIds = state.groups.map(g => String(g.id));
            const available = res.dialogs.filter(d => !existingIds.includes(String(d.id)));
            
            renderAddGroupList(available);
            
            const searchInput = document.getElementById('add-group-search');
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase();
                const filtered = available.filter(d => d.name.toLowerCase().includes(query));
                renderAddGroupList(filtered);
            });
        }
    } catch (e) {
        document.getElementById('add-group-list').innerHTML = `<div class="text-center text-red-400 p-4">Failed to load dialogs</div>`;
    }
}

function renderAddGroupList(list) {
    const container = document.getElementById('add-group-list');
    if (!container) return;
    
    if (list.length === 0) {
        container.innerHTML = `<div class="text-center text-tg-textSecondary p-4 text-sm">No available groups found</div>`;
        return;
    }
    
    container.innerHTML = list.map(d => {
        let typeIcon = 'question-line';
        if (d.type === 'channel') typeIcon = 'megaphone-fill';
        else if (d.type === 'group') typeIcon = 'group-fill';
        else if (d.type === 'user') typeIcon = 'user-fill';
        
        return `
        <button onclick="selectGroupToAdd('${d.id}', '${escapeHtml(d.name).replace(/'/g, "\\'")}', '${d.type}', this)" 
                class="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-tg-hover text-left transition-colors group-item">
            ${createAvatar(d.id, d.name, d.type)}
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <p class="text-white text-sm font-medium truncate">${escapeHtml(d.name)}</p>
                    <span class="text-[10px] uppercase px-1.5 py-0.5 rounded bg-white/5 text-tg-textSecondary">${d.type}</span>
                </div>
                <p class="text-xs text-tg-textSecondary truncate">ID: ${d.id}</p>
            </div>
            <div class="w-5 h-5 rounded-full border border-tg-textSecondary flex items-center justify-center check-circle">
                <i class="ri-check-line text-white text-xs hidden"></i>
            </div>
        </button>
        `;
    }).join('');
}

function selectGroupToAdd(id, name, type, el) {
    // UI selection visual
    document.querySelectorAll('.group-item').forEach(b => {
        b.classList.remove('bg-tg-blue/20', 'border-tg-blue');
        b.querySelector('.check-circle').className = 'w-5 h-5 rounded-full border border-tg-textSecondary flex items-center justify-center check-circle';
        b.querySelector('.check-circle i').classList.add('hidden');
    });
    
    el.classList.add('bg-tg-blue/20');
    const circle = el.querySelector('.check-circle');
    circle.className = 'w-5 h-5 rounded-full bg-tg-blue border-tg-blue flex items-center justify-center check-circle';
    circle.querySelector('i').classList.remove('hidden');
    
    document.getElementById('selected-add-id').value = id;
    document.getElementById('selected-add-name').value = name;
    document.getElementById('selected-add-type').value = type;
    document.getElementById('btn-confirm-add').disabled = false;
}

async function confirmAddGroup() {
    const id = document.getElementById('selected-add-id').value;
    const name = document.getElementById('selected-add-name').value;
    const type = document.getElementById('selected-add-type').value;
    
    if (!id) return;
    
    try {
        const btn = document.getElementById('btn-confirm-add');
        btn.innerHTML = '<div class="animate-spin rounded-full h-5 w-5 border-b-2 border-white mx-auto"></div>';
        
        await api.post('/api/groups', { id, name, type });
        
        document.getElementById('add-group-modal').remove();
        showToast('Group added successfully');
        await loadGroups(); // Reload list
    } catch (e) {
        showToast('Failed to add group', 'error');
        document.getElementById('btn-confirm-add').innerHTML = 'Add Selected Group';
    }
}

async function toggleAndSaveGroup(el) {
    el.classList.toggle('active');
    const groupId = el.dataset.groupId;
    const enabled = el.classList.contains('active');
    
    try {
        await api.put(`/api/groups/${groupId}`, { enabled });
        showToast(enabled ? 'Group enabled' : 'Group disabled');
        await loadGroups();
    } catch (e) {
        showToast('Failed to update', 'error');
        el.classList.toggle('active');
    }
}

async function toggleGroupFilter(el) {
    const groupId = el.dataset.groupId;
    const filterKey = el.dataset.filter;
    const isActive = el.classList.contains('bg-tg-blue/20');
    
    const group = state.groups.find(g => String(g.id) === groupId);
    if (!group) return;
    
    const filters = { ...group.filters, [filterKey]: !isActive };
    
    try {
        await api.put(`/api/groups/${groupId}`, { filters });
        
        if (isActive) {
            el.classList.remove('bg-tg-blue/20', 'text-tg-blue');
            el.classList.add('bg-tg-bg', 'text-tg-textSecondary');
        } else {
            el.classList.add('bg-tg-blue/20', 'text-tg-blue');
            el.classList.remove('bg-tg-bg', 'text-tg-textSecondary');
        }
        
        showToast('Filter updated');
        await loadGroups();
    } catch (e) {
        showToast('Failed to update', 'error');
    }
}

// ============ Settings Page ============
// ============ Settings Page ============
async function loadSettings() {
    try {
        const config = await api.get('/api/config');
        state.config = config;
        
        // Download
        const concurrent = config.download?.concurrent || 3;
        document.getElementById('setting-concurrent').value = concurrent;
        document.getElementById('concurrent-value').textContent = concurrent;
        
        const retries = config.download?.retries || 5;
        document.getElementById('setting-retries').value = retries;
        document.getElementById('retries-value').textContent = retries;
        
        document.getElementById('setting-path').value = config.download?.path || './data/downloads';
        
        // Rate Limits
        const rpm = config.rateLimits?.requestsPerMinute || 15;
        document.getElementById('setting-rpm').value = rpm;
        document.getElementById('rpm-value').textContent = rpm;
        
        const polling = config.pollingInterval || 10;
        document.getElementById('setting-polling').value = polling;
        document.getElementById('polling-value').textContent = polling + 's';
        
        // Disk
        document.getElementById('setting-max-disk').value = config.diskManagement?.maxTotalSize || '';
        document.getElementById('setting-max-video').value = config.diskManagement?.maxVideoSize || '';
        document.getElementById('setting-max-image').value = config.diskManagement?.maxImageSize || '';
    } catch (e) {
        showToast('Failed to load settings', 'error');
    }
}

function applyPreset(type) {
    const presets = {
        safe: { concurrent: 1, retries: 5, rpm: 5, polling: 30 },
        balanced: { concurrent: 3, retries: 5, rpm: 15, polling: 10 },
        fast: { concurrent: 5, retries: 10, rpm: 30, polling: 5 }
    };
    
    const p = presets[type];
    if (!p) return;
    
    document.getElementById('setting-concurrent').value = p.concurrent;
    document.getElementById('concurrent-value').textContent = p.concurrent;
    
    document.getElementById('setting-retries').value = p.retries;
    document.getElementById('retries-value').textContent = p.retries;
    
    document.getElementById('setting-rpm').value = p.rpm;
    document.getElementById('rpm-value').textContent = p.rpm;
    
    document.getElementById('setting-polling').value = p.polling;
    document.getElementById('polling-value').textContent = p.polling + 's';
    
    showToast(`Applied ${type} preset`);
}

async function saveSettings() {
    const data = {
        download: {
            concurrent: parseInt(document.getElementById('setting-concurrent').value) || 3,
            retries: parseInt(document.getElementById('setting-retries').value) || 5,
            path: document.getElementById('setting-path').value || './data/downloads'
        },
        rateLimits: {
            requestsPerMinute: parseInt(document.getElementById('setting-rpm').value) || 15,
            delayMs: state.config.rateLimits?.delayMs || { min: 500, max: 2000 }
        },
        pollingInterval: parseInt(document.getElementById('setting-polling').value) || 10,
        diskManagement: {
            maxTotalSize: document.getElementById('setting-max-disk').value || null,
            maxVideoSize: document.getElementById('setting-max-video').value || null,
            maxImageSize: document.getElementById('setting-max-image').value || null
        }
    };
    
    try {
        await api.post('/api/config', data);
        showToast('Settings saved');
    } catch (e) {
        showToast('Failed to save', 'error');
    }
}

// ============ Utilities ============
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

function escapeAttr(text) {
    return (text || '').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function formatDate(date) {
    return new Date(date).toLocaleString('th-TH', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    document.getElementById('toast-icon').className = type === 'success' 
        ? 'ri-check-line text-tg-green' 
        : 'ri-error-warning-line text-red-400';
    document.getElementById('toast-message').textContent = message;
    
    toast?.classList.remove('hidden');
    setTimeout(() => toast?.classList.add('hidden'), 2000);
}

// ============ Delete File ============
function confirmDeleteFile() {
    const file = state.files[state.currentFileIndex];
    if (!file) return;
    
    // Create confirmation modal
    const modal = document.createElement('div');
    modal.id = 'delete-confirm-modal';
    modal.className = 'fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4';
    modal.innerHTML = `
        <div class="bg-tg-panel rounded-2xl p-6 max-w-sm w-full text-center">
            <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                <i class="ri-delete-bin-line text-3xl text-red-500"></i>
            </div>
            <h3 class="text-lg font-medium text-white mb-2">Delete File?</h3>
            <p class="text-tg-textSecondary text-sm mb-6">Are you sure you want to delete<br><span class="text-white">${escapeHtml(file.name)}</span>?</p>
            <div class="flex gap-3">
                <button onclick="closeDeleteConfirm()" class="flex-1 py-2.5 px-4 rounded-lg bg-tg-bg hover:bg-tg-hover text-white font-medium transition">
                    Cancel
                </button>
                <button onclick="deleteFile()" class="flex-1 py-2.5 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium transition">
                    Delete
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function closeDeleteConfirm() {
    document.getElementById('delete-confirm-modal')?.remove();
}

async function deleteFile() {
    const file = state.files[state.currentFileIndex];
    if (!file) return;
    
    const filePath = file.fullPath || file.path;
    
    try {
        const result = await api.delete(`/api/file?path=${encodeURIComponent(filePath)}`);
        
        if (result.success) {
            closeDeleteConfirm();
            showToast('File deleted successfully');
            
            // Remove from arrays
            const indexInAll = state.allFiles.findIndex(f => (f.fullPath || f.path) === filePath);
            if (indexInAll > -1) state.allFiles.splice(indexInAll, 1);
            
            const indexInFiles = state.files.findIndex(f => (f.fullPath || f.path) === filePath);
            if (indexInFiles > -1) state.files.splice(indexInFiles, 1);
            
            // Navigate or close modal
            if (state.files.length === 0) {
                closeMediaViewer();
                renderMediaGrid();
            } else {
                // Move to next or previous file
                if (state.currentFileIndex >= state.files.length) {
                    state.currentFileIndex = state.files.length - 1;
                }
                // Re-render the current viewer with new file
                openMediaViewer(state.currentFileIndex);
                renderMediaGrid();
            }
        } else {
            showToast(result.error || 'Delete failed', 'error');
        }
    } catch (e) {
        closeDeleteConfirm();
        showToast('Failed to delete file', 'error');
        console.error(e);
    }
}

// ============ Event Listeners ============
function setupEventListeners() {
    // Media type tabs
    document.querySelectorAll('#media-tabs .tab-item').forEach(tab => {
        tab.addEventListener('click', async () => {
            document.querySelectorAll('#media-tabs .tab-item').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            state.currentFilter = tab.dataset.type;
            state.page = 1;
            state.hasMore = true;
            
            if (state.currentGroup) {
                await loadGroupFiles(state.currentGroup, state.currentFilter);
            } else {
                renderMediaGrid();
            }
        });
    });
    
    // Mobile menu
    document.getElementById('menu-btn')?.addEventListener('click', openSidebar);
    document.getElementById('sidebar-close')?.addEventListener('click', closeSidebar);
    document.getElementById('sidebar-overlay')?.addEventListener('click', closeSidebar);
    
    // View mode toggle
    document.getElementById('view-mode-btn')?.addEventListener('click', toggleViewMode);
    
    // Modal controls
    document.getElementById('modal-close')?.addEventListener('click', closeMediaViewer);
    document.getElementById('modal-prev')?.addEventListener('click', () => navigateMedia(-1));
    document.getElementById('modal-next')?.addEventListener('click', () => navigateMedia(1));
    document.getElementById('modal-fullscreen-btn')?.addEventListener('click', toggleFullscreen);
    
    // Toggle fullscreen on image/video click
    document.getElementById('modal-image')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFullscreen();
    });
    
    // Keyboard
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('media-modal');
        if (!modal?.classList.contains('hidden')) {
            if (e.key === 'Escape') {
                if (modal.classList.contains('fullscreen-mode')) exitFullscreenMode();
                else closeMediaViewer();
            }
            if (e.key === 'ArrowLeft') navigateMedia(-1);
            if (e.key === 'ArrowRight') navigateMedia(1);
            if (e.key === 'f') toggleFullscreen();
        }
    });
    
    // Group modal
    document.getElementById('group-modal-close')?.addEventListener('click', closeGroupSettings);
    document.getElementById('group-modal-save')?.addEventListener('click', saveGroupSettings);
    
    // Settings
    document.getElementById('save-settings')?.addEventListener('click', saveSettings);
    
    // Click outside modals
    document.getElementById('media-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'media-modal' || e.target.id === 'modal-swipe') closeMediaViewer();
    });
    document.getElementById('group-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'group-modal') closeGroupSettings();
    });
    
    // Search
    document.getElementById('search-input')?.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        renderGroupsList();
    });
}

// ============ Destination Picker ============
let destinationDialogs = [];

async function openDestinationPicker() {
    const modal = document.createElement('div');
    modal.id = 'dest-picker-modal';
    modal.className = 'fixed inset-0 z-[60] flex items-center justify-center p-4 modal-backdrop';
    modal.innerHTML = `
        <div class="bg-tg-sidebar w-full max-w-sm rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[80vh]">
            <div class="bg-tg-panel p-4 border-b border-tg-border flex items-center justify-between">
                <h3 class="text-white font-medium">Select Destination</h3>
                <button onclick="closeDestinationPicker()" class="w-8 h-8 rounded-full hover:bg-tg-hover flex items-center justify-center transition-colors">
                    <i class="ri-close-line text-tg-textSecondary text-xl"></i>
                </button>
            </div>
            
            <div class="p-3 border-b border-tg-border">
                <div class="relative">
                    <i class="ri-search-line absolute left-3 top-1/2 transform -translate-y-1/2 text-tg-textSecondary"></i>
                    <input type="text" id="dest-search" 
                        class="w-full bg-tg-bg border-none rounded-lg pl-10 pr-4 py-2 text-tg-text focus:ring-1 focus:ring-tg-blue outline-none" 
                        placeholder="Search chats...">
                </div>
            </div>

            <div class="overflow-y-auto flex-1 custom-scrollbar p-2 space-y-1" id="dest-list">
                <div class="flex items-center justify-center h-20">
                    <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-white"></div>
                </div>
            </div>
            
            <div class="p-3 bg-tg-panel border-t border-tg-border">
               <div class="flex flex-col gap-2">
                    <button onclick="selectDestination('me')" class="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-tg-hover text-left transition-colors">
                        <div class="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                            <i class="ri-save-line text-lg"></i>
                        </div>
                        <div>
                            <p class="text-white text-sm font-medium">Saved Messages</p>
                            <p class="text-xs text-tg-textSecondary">Forward to your saved messages</p>
                        </div>
                    </button>
                </div> 
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Fetch dialogs
    try {
        const res = await api.get('/api/dialogs');
        if (res.success) {
            destinationDialogs = res.dialogs;
            renderDestinationList(destinationDialogs);
            
            // Search listener
            document.getElementById('dest-search').addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase();
                const filtered = destinationDialogs.filter(d => d.name.toLowerCase().includes(query));
                renderDestinationList(filtered);
            });
        }
    } catch (e) {
        document.getElementById('dest-list').innerHTML = `<div class="text-center text-red-400 p-4">Failed to load dialogs</div>`;
    }
}

function renderDestinationList(list) {
    const container = document.getElementById('dest-list');
    if (!container) return;
    
    if (list.length === 0) {
        container.innerHTML = `<div class="text-center text-tg-textSecondary p-4 text-sm">No chats found</div>`;
        return;
    }
    
    container.innerHTML = list.map(d => {
        // Determine icon based on type
        let typeIcon = 'question-line';
        if (d.type === 'channel') typeIcon = 'megaphone-fill';
        else if (d.type === 'group') typeIcon = 'group-fill';
        else if (d.type === 'user') typeIcon = 'user-fill';
        
        // Avatar HTML: Try real photo, fallback to icon
        const avatarHtml = `
            <div class="relative w-10 h-10 flex-shrink-0">
                <img src="/api/groups/${d.id}/photo" 
                     class="w-full h-full rounded-full object-cover bg-tg-bg" 
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'"
                     loading="lazy">
                <div class="absolute inset-0 w-full h-full rounded-full bg-tg-bg flex items-center justify-center text-tg-textSecondary hidden">
                    <i class="ri-${typeIcon} text-lg"></i>
                </div>
            </div>
        `;

        return `
        <button onclick="selectDestination('${d.id}')" class="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-tg-hover text-left transition-colors group">
            ${avatarHtml}
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <p class="text-white text-sm font-medium truncate">${escapeHtml(d.name)}</p>
                    ${d.type === 'user' ? '' : `<span class="text-[10px] uppercase px-1.5 py-0.5 rounded bg-white/5 text-tg-textSecondary">${d.type}</span>`}
                </div>
                <p class="text-xs text-tg-textSecondary truncate">ID: ${d.id}</p>
            </div>
        </button>
        `;
    }).join('');
}

function closeDestinationPicker() {
    const modal = document.getElementById('dest-picker-modal');
    if (modal) modal.remove();
}

function selectDestination(value) {
    document.getElementById('fwd-destination').value = value;
    closeDestinationPicker();
}

// ============ Start ============
document.addEventListener('DOMContentLoaded', init);
