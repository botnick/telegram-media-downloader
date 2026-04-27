// IDM-style download Queue page.
//
// Owns:
//   - An in-memory store keyed by job.key (chatId_messageId). Boots from
//     GET /api/queue/snapshot, then patches itself live from WS events
//     (download_start / _progress / _complete / _error / queue_changed).
//   - A virtualised table — only the ~12 visible rows + 5-row buffer are
//     ever in the DOM, so a 1000-job queue stays at ~1 ms per render.
//   - Per-row + global controls (POST /api/queue/...).
//   - Filter chips, free-text search, sort, status pill counts.
//
// Wiring: app.js calls initQueue() at boot (so WS handlers + the bottom-
// nav badge stay in sync even when the page isn't visible) and
// showQueuePage(params) on every #/queue navigation.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml, formatBytes, getFileIcon } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { getGroupName } from './store.js';
import { confirmSheet } from './sheet.js';

// ============ Constants ============
const ROW_HEIGHT = 56;          // px — keeps the math trivial
const OVERSCAN = 5;             // rows above + below the viewport
const RENDER_COALESCE_MS = 60;  // collapse WS bursts into one rAF tick

// Filter chip definitions. Order matters — also drives the keyboard tab order.
const STATUS_FILTERS = [
    { id: 'all',     i18n: 'queue.chip.all',     fallback: 'All',     match: () => true },
    { id: 'active',  i18n: 'queue.chip.active',  fallback: 'Active',  match: (j) => j.status === 'active' },
    { id: 'queued',  i18n: 'queue.chip.queued',  fallback: 'Queued',  match: (j) => j.status === 'queued' },
    { id: 'paused',  i18n: 'queue.chip.paused',  fallback: 'Paused',  match: (j) => j.status === 'paused' },
    { id: 'failed',  i18n: 'queue.chip.failed',  fallback: 'Failed',  match: (j) => j.status === 'failed' },
    { id: 'done',    i18n: 'queue.chip.done',    fallback: 'Done',    match: (j) => j.status === 'done' },
];

// ============ Store ============
//
// Single source of truth — Map keyed by job.key. Each entry mirrors the
// snapshot row shape and is mutated in place by WS handlers.
const store = new Map();
// O(1) status counts for the chips. Patched by upsert/remove so the
// header chip render is always cheap.
const statusCounts = new Map();
let globalPaused = false;
let engineRunning = false;
let maxSpeedConfig = null;

// View state — survives across navigations to the same page.
const view = {
    filter: 'all',
    sort: 'addedAt',     // 'addedAt' | 'size' | 'progress' | 'group' | 'filename'
    sortDir: 'desc',
    search: '',
    scrollTop: 0,
    booted: false,
    visible: false,
};

// Render scheduling — collapse WS bursts into one rAF tick.
let _renderScheduled = false;
function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    setTimeout(() => {
        _renderScheduled = false;
        requestAnimationFrame(() => {
            if (view.visible) renderRows();
            renderChips();
            renderAggregate();
            updateNavBadge();
        });
    }, RENDER_COALESCE_MS);
}

function bumpStatus(status, delta) {
    if (!status) return;
    const cur = statusCounts.get(status) || 0;
    const next = Math.max(0, cur + delta);
    if (next === 0) statusCounts.delete(status); else statusCounts.set(status, next);
}

function upsert(entry) {
    if (!entry || !entry.key) return;
    const prev = store.get(entry.key);
    if (prev) {
        if (prev.status !== entry.status) {
            bumpStatus(prev.status, -1);
            bumpStatus(entry.status, 1);
        }
        Object.assign(prev, entry);
    } else {
        store.set(entry.key, { ...entry });
        bumpStatus(entry.status, 1);
    }
}

function remove(key) {
    const prev = store.get(key);
    if (!prev) return;
    bumpStatus(prev.status, -1);
    store.delete(key);
}

function patchProgress(payload) {
    if (!payload?.key) return;
    const prev = store.get(payload.key);
    const total = payload.total || prev?.total || prev?.fileSize || 0;
    const received = payload.received || 0;
    const bps = payload.bps || 0;
    const eta = (bps > 0 && total > received) ? Math.round((total - received) / bps) : null;
    const next = {
        key: payload.key,
        groupId: String(payload.groupId || prev?.groupId || ''),
        groupName: payload.groupName || prev?.groupName || null,
        mediaType: payload.mediaType || prev?.mediaType || null,
        messageId: payload.messageId ?? prev?.messageId ?? null,
        fileName: payload.fileName || prev?.fileName || null,
        fileSize: total || prev?.fileSize || 0,
        progress: payload.progress ?? prev?.progress ?? 0,
        received,
        total,
        bps,
        eta,
        status: 'active',
        addedAt: prev?.addedAt || Date.now(),
    };
    upsert(next);
}

// ============ Bootstrap ============
async function loadSnapshot() {
    try {
        const snap = await api.get('/api/queue/snapshot');
        // Wipe local state and rebuild from the authoritative server snapshot.
        store.clear();
        statusCounts.clear();
        globalPaused = !!snap.globalPaused;
        engineRunning = !!snap.engineRunning;
        maxSpeedConfig = snap.maxSpeed ?? null;
        for (const j of snap.active || []) upsert({ ...j });
        for (const j of snap.queued || []) upsert({ ...j });
        for (const j of snap.recent || []) upsert({ ...j });
        view.booted = true;
        scheduleRender();
    } catch (e) {
        if (e.status !== 401) {
            showToast(i18nTf('queue.toast.snapshot_failed', { msg: e.message }, `Failed to load queue: ${e.message}`), 'error');
        }
    }
}

// ============ WS handlers ============
function handleWs(msg) {
    if (msg.type === 'monitor_state') {
        engineRunning = msg.state === 'running';
        if (msg.state === 'stopped' || msg.state === 'error') {
            // Drop active/queued; keep recent done/failed history.
            for (const [k, v] of store) {
                if (v.status === 'active' || v.status === 'queued' || v.status === 'paused') remove(k);
            }
        }
        scheduleRender();
        return;
    }
    if (msg.type === 'queue_changed') {
        const p = msg.payload || {};
        if (p.op === 'pause-all') { globalPaused = true; scheduleRender(); return; }
        if (p.op === 'resume-all') { globalPaused = false; scheduleRender(); return; }
        if (p.op === 'cancel-all') {
            for (const [k, v] of store) {
                if (v.status === 'queued' || v.status === 'paused') remove(k);
            }
            scheduleRender();
            return;
        }
        if (p.op === 'clear-finished') {
            for (const [k, v] of store) if (v.status === 'done' || v.status === 'failed') remove(k);
            scheduleRender();
            return;
        }
        if (!p.key) { scheduleRender(); return; }
        const cur = store.get(p.key);
        if (p.op === 'pause' && cur) { cur.status = 'paused'; bumpStatus('queued', -1); bumpStatus('active', -1); bumpStatus('paused', 1); }
        else if (p.op === 'resume' && cur) { cur.status = cur.received ? 'active' : 'queued'; bumpStatus('paused', -1); bumpStatus(cur.status, 1); }
        else if (p.op === 'cancel') { remove(p.key); }
        else if (p.op === 'retry' && cur) { cur.status = 'queued'; cur.error = null; cur.progress = 0; cur.received = 0; cur.bps = 0; cur.eta = null; bumpStatus('failed', -1); bumpStatus('queued', 1); }
        scheduleRender();
        return;
    }
    if (msg.type === 'download_start' && msg.payload?.key) {
        const p = msg.payload;
        const prev = store.get(p.key);
        upsert({
            key: p.key,
            groupId: String(p.groupId || ''),
            groupName: p.groupName || prev?.groupName || null,
            mediaType: p.mediaType || null,
            messageId: p.messageId ?? null,
            fileName: p.fileName || prev?.fileName || null,
            fileSize: p.fileSize || prev?.fileSize || 0,
            progress: 0,
            received: 0,
            total: p.fileSize || prev?.fileSize || 0,
            bps: 0,
            eta: null,
            status: 'active',
            addedAt: p.addedAt || prev?.addedAt || Date.now(),
        });
        scheduleRender();
        return;
    }
    if (msg.type === 'download_progress' && msg.payload?.key) {
        patchProgress(msg.payload);
        scheduleRender();
        return;
    }
    if (msg.type === 'download_complete' && msg.payload?.key) {
        const p = msg.payload;
        upsert({
            key: p.key,
            groupId: String(p.groupId || ''),
            groupName: p.groupName || null,
            mediaType: p.mediaType || null,
            messageId: p.messageId ?? null,
            fileName: p.fileName || (p.filePath ? p.filePath.split(/[\\/]/).pop() : null),
            fileSize: p.fileSize || 0,
            progress: 100,
            received: p.fileSize || 0,
            total: p.fileSize || 0,
            bps: 0,
            eta: 0,
            status: 'done',
            addedAt: p.addedAt || Date.now(),
            finishedAt: Date.now(),
            filePath: p.filePath || null,
        });
        scheduleRender();
        return;
    }
    if (msg.type === 'download_error' && msg.payload?.job?.key) {
        const j = msg.payload.job;
        upsert({
            key: j.key,
            groupId: String(j.groupId || ''),
            groupName: j.groupName || null,
            mediaType: j.mediaType || null,
            messageId: j.messageId ?? null,
            fileName: j.fileName || null,
            fileSize: j.fileSize || 0,
            progress: 0,
            received: 0,
            total: j.fileSize || 0,
            bps: 0,
            eta: null,
            status: 'failed',
            error: msg.payload.error || 'Download failed',
            addedAt: j.addedAt || Date.now(),
            finishedAt: Date.now(),
        });
        scheduleRender();
        return;
    }
    if (msg.type === 'queue_length') {
        // No-op: snapshot patches keep the store accurate, the chip count
        // is already O(1) via statusCounts.
    }
}

// ============ Filtering / sorting / search ============
let _filteredCache = null;
let _filteredCacheTag = '';

function getFilteredSorted() {
    const tag = `${view.filter}|${view.sort}|${view.sortDir}|${view.search}|${store.size}`;
    if (tag === _filteredCacheTag && _filteredCache) return _filteredCache;
    const filterFn = (STATUS_FILTERS.find(f => f.id === view.filter) || STATUS_FILTERS[0]).match;
    const q = view.search.trim().toLowerCase();
    const out = [];
    for (const job of store.values()) {
        if (!filterFn(job)) continue;
        if (q) {
            const name = (job.fileName || '').toLowerCase();
            const group = (getGroupName(job.groupId, { fallback: job.groupName || '' }) || '').toLowerCase();
            if (!name.includes(q) && !group.includes(q)) continue;
        }
        out.push(job);
    }
    const dir = view.sortDir === 'asc' ? 1 : -1;
    const get = (j) => {
        switch (view.sort) {
            case 'size':     return j.fileSize || 0;
            case 'progress': return j.progress || 0;
            case 'group':    return getGroupName(j.groupId, { fallback: j.groupName || '' }) || '';
            case 'filename': return j.fileName || '';
            default:         return j.addedAt || 0;
        }
    };
    out.sort((a, b) => {
        const av = get(a); const bv = get(b);
        if (typeof av === 'string') return av.localeCompare(bv) * dir;
        return ((av || 0) - (bv || 0)) * dir;
    });
    _filteredCache = out;
    _filteredCacheTag = tag;
    return out;
}

function invalidateFilterCache() { _filteredCacheTag = ''; }

// ============ Render ============
function renderChips() {
    const host = document.getElementById('queue-chips');
    if (!host) return;
    const total = store.size;
    const counts = {
        all: total,
        active: statusCounts.get('active') || 0,
        queued: statusCounts.get('queued') || 0,
        paused: statusCounts.get('paused') || 0,
        failed: statusCounts.get('failed') || 0,
        done: statusCounts.get('done') || 0,
    };
    host.innerHTML = STATUS_FILTERS.map(f => {
        const active = view.filter === f.id;
        const cls = active
            ? 'bg-tg-blue/20 text-tg-blue border-tg-blue/40'
            : 'bg-tg-bg/40 text-tg-textSecondary border-transparent hover:text-tg-text';
        return `<button type="button" data-chip="${f.id}"
            class="px-2.5 py-1 text-xs rounded-full border ${cls} flex items-center gap-1.5">
            <span>${escapeHtml(i18nT(f.i18n, f.fallback))}</span>
            <span class="tabular-nums opacity-80">${counts[f.id] ?? 0}</span>
        </button>`;
    }).join('');
    host.querySelectorAll('[data-chip]').forEach(btn => {
        btn.addEventListener('click', () => {
            view.filter = btn.dataset.chip;
            invalidateFilterCache();
            // Update the URL without re-dispatching the route handler so
            // back/forward still work but we don't churn the page.
            const target = view.filter === 'all' ? '#/queue' : `#/queue/${encodeURIComponent(view.filter)}`;
            if (location.hash !== target) history.replaceState(null, '', target);
            renderChips();
            renderRows();
        });
    });
}

function renderRows() {
    const viewport = document.getElementById('queue-viewport');
    const spacer = document.getElementById('queue-spacer');
    const rowsHost = document.getElementById('queue-rows');
    const empty = document.getElementById('queue-empty');
    if (!viewport || !spacer || !rowsHost) return;

    const rows = getFilteredSorted();
    if (rows.length === 0) {
        spacer.style.height = '0px';
        rowsHost.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');

    spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    const scrollTop = viewport.scrollTop;
    const visible = Math.ceil(viewport.clientHeight / ROW_HEIGHT);
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, start + visible + OVERSCAN * 2);
    const slice = rows.slice(start, end);

    rowsHost.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
    rowsHost.innerHTML = slice.map(j => renderRow(j)).join('');

    // Wire per-row action buttons via event delegation. Doing it on the
    // host (rather than per-button addEventListener) keeps the cost
    // O(1) per re-render even with 100+ visible rows.
    rowsHost.onclick = (ev) => {
        const btn = ev.target.closest('[data-row-action]');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const key = btn.closest('[data-key]')?.dataset.key;
        if (!key) return;
        const action = btn.dataset.rowAction;
        runRowAction(action, key);
    };
}

function renderRow(j) {
    const name = j.fileName || (j.messageId ? `#${j.messageId}` : i18nT('queue.row.unnamed', 'Unnamed file'));
    const groupName = getGroupName(j.groupId, { fallback: j.groupName || j.groupId || '?' });
    const ext = (name.split('.').pop() || '').toLowerCase();
    const icon = j.mediaType === 'video' || j.mediaType === 'videos' ? 'ri-video-line'
        : j.mediaType === 'image' || j.mediaType === 'photos' ? 'ri-image-line'
        : j.mediaType === 'audio' || j.mediaType === 'voice' ? 'ri-music-line'
        : getFileIcon(ext);
    const pct = Math.max(0, Math.min(100, j.progress || 0));
    const sizeStr = j.fileSize ? formatBytes(j.fileSize) : '—';
    const speedStr = (j.status === 'active' && j.bps) ? `${formatBytes(j.bps)}/s` : '—';
    const etaStr = (j.status === 'active' && j.eta != null) ? formatEta(j.eta) : '—';

    const pillCls = {
        active:  'bg-tg-blue/20 text-tg-blue',
        queued:  'bg-gray-700/40 text-gray-300',
        paused:  'bg-tg-orange/20 text-tg-orange',
        failed:  'bg-red-500/20 text-red-400',
        done:    'bg-tg-green/20 text-tg-green',
    }[j.status] || 'bg-gray-700/40 text-gray-300';
    const pillLabel = i18nT(`queue.status.${j.status}`, j.status);

    // Per-row action set is status-dependent. Active/queued: pause, cancel.
    // Paused: resume, cancel. Failed: retry, dismiss. Done: dismiss.
    const actions = [];
    if (j.status === 'active' || j.status === 'queued') {
        actions.push(actionBtn('pause', 'ri-pause-line', i18nT('queue.action.pause', 'Pause')));
        actions.push(actionBtn('cancel', 'ri-close-line', i18nT('queue.action.cancel', 'Cancel'), 'text-red-400'));
    } else if (j.status === 'paused') {
        actions.push(actionBtn('resume', 'ri-play-line', i18nT('queue.action.resume', 'Resume')));
        actions.push(actionBtn('cancel', 'ri-close-line', i18nT('queue.action.cancel', 'Cancel'), 'text-red-400'));
    } else if (j.status === 'failed') {
        actions.push(actionBtn('retry', 'ri-refresh-line', i18nT('queue.action.retry', 'Retry')));
        actions.push(actionBtn('dismiss', 'ri-delete-bin-line', i18nT('queue.action.dismiss', 'Dismiss')));
    } else if (j.status === 'done') {
        actions.push(actionBtn('dismiss', 'ri-delete-bin-line', i18nT('queue.action.dismiss', 'Dismiss')));
    }

    return `
        <div data-key="${escapeHtml(j.key)}"
             class="grid grid-cols-[40px_minmax(0,2.5fr)_90px_minmax(140px,1.4fr)_80px_70px_90px_120px] items-center gap-2 px-3 border-b border-tg-border/40 hover:bg-tg-hover/40"
             style="height: ${ROW_HEIGHT}px;">
            <div class="w-9 h-9 rounded bg-tg-bg/40 flex items-center justify-center text-tg-textSecondary">
                <i class="${icon}"></i>
            </div>
            <div class="min-w-0">
                <div class="text-sm text-tg-text truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="text-[11px] text-tg-textSecondary truncate">${escapeHtml(groupName)}${j.error ? ' · ' + escapeHtml(j.error) : ''}</div>
            </div>
            <div class="text-xs text-tg-textSecondary text-right tabular-nums">${escapeHtml(sizeStr)}</div>
            <div class="min-w-0">
                <div class="h-1.5 bg-tg-bg/60 rounded overflow-hidden">
                    <div class="h-full ${j.status === 'failed' ? 'bg-red-500' : j.status === 'done' ? 'bg-tg-green' : 'bg-tg-blue'} transition-all" style="width: ${pct}%"></div>
                </div>
                <div class="text-[10px] text-tg-textSecondary tabular-nums mt-0.5">${pct}%</div>
            </div>
            <div class="text-xs text-tg-textSecondary text-right tabular-nums">${escapeHtml(speedStr)}</div>
            <div class="text-xs text-tg-textSecondary text-right tabular-nums">${escapeHtml(etaStr)}</div>
            <div><span class="text-[11px] px-2 py-0.5 rounded-full ${pillCls}">${escapeHtml(pillLabel)}</span></div>
            <div class="flex items-center justify-end gap-1">${actions.join('')}</div>
        </div>`;
}

function actionBtn(action, icon, label, extraCls = '') {
    return `<button type="button" data-row-action="${action}"
        class="w-7 h-7 rounded flex items-center justify-center text-tg-textSecondary hover:text-tg-text hover:bg-tg-bg/60 ${extraCls}"
        title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><i class="${icon}"></i></button>`;
}

function formatEta(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
}

function renderAggregate() {
    const host = document.getElementById('queue-aggregate');
    if (!host) return;
    let active = 0, queued = 0, totalBps = 0;
    for (const j of store.values()) {
        if (j.status === 'active') { active++; totalBps += j.bps || 0; }
        else if (j.status === 'queued') queued++;
    }
    const speed = totalBps ? `${formatBytes(totalBps)}/s` : '0 B/s';
    host.innerHTML = `
        <span><i class="ri-loader-2-line text-tg-blue"></i> ${i18nTf('queue.agg.active', { n: active }, `${active} active`)}</span>
        <span><i class="ri-time-line"></i> ${i18nTf('queue.agg.queued', { n: queued }, `${queued} queued`)}</span>
        <span><i class="ri-flashlight-line"></i> ${escapeHtml(speed)}</span>
        ${globalPaused ? `<span class="text-tg-orange">· ${escapeHtml(i18nT('queue.agg.paused_global', 'Globally paused'))}</span>` : ''}
        ${!engineRunning ? `<span class="text-tg-textSecondary">· ${escapeHtml(i18nT('queue.agg.engine_stopped', 'Engine stopped'))}</span>` : ''}
    `;
}

function updateNavBadge() {
    const badge = document.getElementById('queue-nav-badge');
    if (!badge) return;
    const n = (statusCounts.get('active') || 0) + (statusCounts.get('queued') || 0);
    if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// ============ Per-row + global actions ============
async function runRowAction(action, key) {
    try {
        if (action === 'pause') {
            await api.post(`/api/queue/${encodeURIComponent(key)}/pause`);
        } else if (action === 'resume') {
            await api.post(`/api/queue/${encodeURIComponent(key)}/resume`);
        } else if (action === 'cancel') {
            await api.post(`/api/queue/${encodeURIComponent(key)}/cancel`);
            remove(key);
            scheduleRender();
        } else if (action === 'retry') {
            await api.post(`/api/queue/${encodeURIComponent(key)}/retry`);
        } else if (action === 'dismiss') {
            // Local-only — drop from the recent tail. Server-side
            // clear-finished is the bulk equivalent.
            remove(key);
            scheduleRender();
        }
    } catch (e) {
        showToast(i18nTf('queue.toast.action_failed', { msg: e.message }, `Action failed: ${e.message}`), 'error');
    }
}

async function runGlobalAction(action) {
    try {
        if (action === 'pause-all') {
            await api.post('/api/queue/pause-all');
            showToast(i18nT('queue.toast.paused_all', 'Paused all downloads'), 'info');
        } else if (action === 'resume-all') {
            await api.post('/api/queue/resume-all');
            showToast(i18nT('queue.toast.resumed_all', 'Resumed all downloads'), 'success');
        } else if (action === 'cancel-all') {
            if (!(await confirmSheet({
                title: i18nT('queue.action.cancel_all', 'Cancel queued'),
                message: i18nT('queue.confirm.cancel_all', 'Cancel every queued download? Active jobs continue.'),
                confirmLabel: i18nT('queue.action.cancel_all', 'Cancel queued'),
                danger: true,
            }))) return;
            await api.post('/api/queue/cancel-all');
            showToast(i18nT('queue.toast.cancelled_all', 'Queued downloads cancelled'), 'info');
        } else if (action === 'clear-finished') {
            await api.post('/api/queue/clear-finished');
            for (const [k, v] of store) {
                if (v.status === 'done' || v.status === 'failed') remove(k);
            }
            scheduleRender();
            showToast(i18nT('queue.toast.cleared_finished', 'Cleared finished'), 'success');
        }
    } catch (e) {
        showToast(i18nTf('queue.toast.action_failed', { msg: e.message }, `Action failed: ${e.message}`), 'error');
    }
}

// ============ Throttle slider ============
function bindThrottleSlider() {
    const slider = document.getElementById('queue-throttle');
    const value = document.getElementById('queue-throttle-value');
    if (!slider || !value) return;
    if (slider.dataset.wired === '1') return;
    slider.dataset.wired = '1';
    // Initial value from server config (bytes/s).
    const initial = parseInt(maxSpeedConfig, 10) || 0;
    slider.value = String(Math.min(parseInt(slider.max, 10) || 10485760, initial));
    syncThrottleLabel(slider.value);

    let saveTimer = null;
    slider.addEventListener('input', () => {
        syncThrottleLabel(slider.value);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try {
                const bytes = parseInt(slider.value, 10) || 0;
                await api.post('/api/config', { download: { maxSpeed: bytes || null } });
                maxSpeedConfig = bytes || null;
                showToast(i18nT('queue.toast.throttle_saved', 'Speed limit updated'), 'success');
            } catch (e) {
                showToast(i18nTf('queue.toast.throttle_failed', { msg: e.message }, `Failed to update: ${e.message}`), 'error');
            }
        }, 400);
    });

    function syncThrottleLabel(raw) {
        const bytes = parseInt(raw, 10) || 0;
        if (!bytes) {
            value.textContent = i18nT('queue.throttle.unlimited', 'Unlimited');
        } else {
            value.textContent = `${formatBytes(bytes)}/s`;
        }
    }
}

// ============ Page lifecycle ============
let _wired = false;

export function initQueue() {
    if (_wired) return;
    _wired = true;
    ws.on('*', handleWs);
    // Load the snapshot eagerly so the bottom-nav badge is accurate
    // before the user ever opens the page.
    loadSnapshot();
}

export async function showQueuePage(params = {}) {
    view.visible = true;
    if (params?.status && STATUS_FILTERS.some(f => f.id === params.status)) {
        view.filter = params.status;
        invalidateFilterCache();
    }
    if (!view.booted) await loadSnapshot();
    wireOnce();
    bindThrottleSlider();
    renderChips();
    renderAggregate();
    renderRows();
    updateNavBadge();
}

let _toolbarWired = false;
function wireOnce() {
    if (_toolbarWired) return;
    _toolbarWired = true;
    document.getElementById('queue-search')?.addEventListener('input', (e) => {
        view.search = e.target.value || '';
        invalidateFilterCache();
        renderRows();
    });
    document.getElementById('queue-sort')?.addEventListener('change', (e) => {
        view.sort = e.target.value || 'addedAt';
        invalidateFilterCache();
        renderRows();
    });
    document.getElementById('queue-pause-all')?.addEventListener('click', () => runGlobalAction('pause-all'));
    document.getElementById('queue-resume-all')?.addEventListener('click', () => runGlobalAction('resume-all'));
    document.getElementById('queue-cancel-all')?.addEventListener('click', () => runGlobalAction('cancel-all'));
    document.getElementById('queue-clear-finished')?.addEventListener('click', () => runGlobalAction('clear-finished'));

    // Re-render rows on scroll for the virtualiser. Throttled via rAF
    // so a fast scroll wheel never queues more than one render frame.
    const viewport = document.getElementById('queue-viewport');
    if (viewport) {
        let scrollFrame = 0;
        viewport.addEventListener('scroll', () => {
            if (scrollFrame) return;
            scrollFrame = requestAnimationFrame(() => {
                scrollFrame = 0;
                view.scrollTop = viewport.scrollTop;
                renderRows();
            });
        }, { passive: true });
    }

    // Hide the page when navigating away — the WS handlers keep mutating
    // the store, but we skip rendering until the user comes back.
    const observer = new MutationObserver(() => {
        const el = document.getElementById('page-queue');
        if (!el) return;
        view.visible = !el.classList.contains('hidden');
    });
    const queuePage = document.getElementById('page-queue');
    if (queuePage) observer.observe(queuePage, { attributes: true, attributeFilter: ['class'] });
}
