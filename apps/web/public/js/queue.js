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
//
// Append-only rendering: we paint INITIAL_RENDER rows up front, then add
// PAGE_SIZE more whenever the user scrolls past the load-more sentinel.
// WS progress events for already-rendered rows patch the matching DOM
// node in place (no full re-render), so a 1000-job queue with dozens of
// concurrent downloads stays smooth.
//
// Why append-only over virtualization:
//   - Predictable scroll: rows never jump (no scroll-position drift when
//     the underlying list mutates mid-frame).
//   - In-place patches keep progress bars buttery — the only DOM op per
//     WS event is `el.style.width = '47%'`, no layout thrash.
//   - "Loading more…" animation matches user mental model — gradual fill
//     instead of "everything appears at once on heavy filter change".
const INITIAL_RENDER = 50;
const PAGE_SIZE = 50;
const RENDER_COALESCE_MS = 60;  // collapse WS bursts into one rAF tick

// Filter chip definitions. Order matters — also drives the keyboard tab order.
// `dupe` is a cross-cutting filter (any status, but only rows the
// downloader flagged as duplicates) — surfaces the rows that produced no
// new bytes on disk, so the operator can see "what got skipped today".
const STATUS_FILTERS = [
    { id: 'all',     i18n: 'queue.chip.all',     fallback: 'All',     match: () => true },
    { id: 'active',  i18n: 'queue.chip.active',  fallback: 'Active',  match: (j) => j.status === 'active' },
    { id: 'queued',  i18n: 'queue.chip.queued',  fallback: 'Queued',  match: (j) => j.status === 'queued' },
    { id: 'paused',  i18n: 'queue.chip.paused',  fallback: 'Paused',  match: (j) => j.status === 'paused' },
    { id: 'failed',  i18n: 'queue.chip.failed',  fallback: 'Failed',  match: (j) => j.status === 'failed' },
    { id: 'done',    i18n: 'queue.chip.done',    fallback: 'Done',    match: (j) => j.status === 'done' },
    { id: 'dupe',    i18n: 'queue.chip.dupe',    fallback: 'Duplicate', match: (j) => j.deduped === true },
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
    rendered: 0,         // how many rows of the filtered list are in the DOM
};
let _loadMoreObserver = null;
// Keys whose rows landed in the DOM since the last full re-render. We
// cap this so an indefinite-scroll session doesn't grow the Set forever.
const _renderedKeys = new Set();

// Render scheduling — collapse WS bursts into one rAF tick. Two paths:
//   - `scheduleRender()`         → cheap, patches the rendered window
//                                  rows in place + refreshes chips +
//                                  aggregate. Used for live progress
//                                  ticks.
//   - `scheduleStructuralRender()` → full re-render of the rendered
//                                    window. Used when the SHAPE of the
//                                    list changes (filter, sort, search,
//                                    or a brand-new job that may not
//                                    appear in the current order).
let _renderScheduled = false;
let _renderStructural = false;
function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    setTimeout(() => {
        const structural = _renderStructural;
        _renderScheduled = false;
        _renderStructural = false;
        requestAnimationFrame(() => {
            if (view.visible) {
                if (structural) renderRows();
                else patchRenderedRows();
            }
            renderChips();
            renderAggregate();
            updateNavBadge();
        });
    }, RENDER_COALESCE_MS);
}
function scheduleStructuralRender() {
    _renderStructural = true;
    scheduleRender();
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
        scheduleStructuralRender();
    } catch (e) {
        if (e.status !== 401) {
            showToast(i18nTf('queue.toast.snapshot_failed', { msg: e.message }, `Failed to load queue: ${e.message}`), 'error');
        }
    }
}

// ============ WS handlers ============
//
// Render-path rules of thumb:
//   - structural change (add/remove a row, mass status flip)  → scheduleStructuralRender()
//   - per-row update (progress, speed, single status change)   → scheduleRender() (in-place patch)
function handleWs(msg) {
    if (msg.type === 'monitor_state') {
        engineRunning = msg.state === 'running';
        if (msg.state === 'stopped' || msg.state === 'error') {
            // Drop active/queued; keep recent done/failed history.
            for (const [k, v] of store) {
                if (v.status === 'active' || v.status === 'queued' || v.status === 'paused') remove(k);
            }
            scheduleStructuralRender();
        } else {
            scheduleRender();
        }
        return;
    }
    if (msg.type === 'queue_changed') {
        const p = msg.payload || {};
        if (p.op === 'pause-all') { globalPaused = true; scheduleStructuralRender(); return; }
        if (p.op === 'resume-all') { globalPaused = false; scheduleStructuralRender(); return; }
        if (p.op === 'cancel-all') {
            for (const [k, v] of store) {
                if (v.status === 'queued' || v.status === 'paused') remove(k);
            }
            scheduleStructuralRender();
            return;
        }
        if (p.op === 'clear-finished') {
            for (const [k, v] of store) if (v.status === 'done' || v.status === 'failed') remove(k);
            scheduleStructuralRender();
            return;
        }
        if (!p.key) { scheduleRender(); return; }
        const cur = store.get(p.key);
        if (p.op === 'pause' && cur) { cur.status = 'paused'; bumpStatus('queued', -1); bumpStatus('active', -1); bumpStatus('paused', 1); }
        else if (p.op === 'resume' && cur) { cur.status = cur.received ? 'active' : 'queued'; bumpStatus('paused', -1); bumpStatus(cur.status, 1); }
        else if (p.op === 'cancel') { remove(p.key); scheduleStructuralRender(); return; }
        else if (p.op === 'retry' && cur) { cur.status = 'queued'; cur.error = null; cur.progress = 0; cur.received = 0; cur.bps = 0; cur.eta = null; bumpStatus('failed', -1); bumpStatus('queued', 1); }
        // Single-row status flip — patcher detects + replaces just that row.
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
        // New job added → may not be in the rendered window yet → structural.
        scheduleStructuralRender();
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
            // `deduped` rides on the same WS event from server.js. Surfaces
            // a "Duplicate" tag in the row so the operator can see at a
            // glance which finishes shared an existing on-disk file.
            deduped: p.deduped === true,
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
            // Filter changed → row set changed → full re-render. Reset
            // the rendered window so the user sees the first page of
            // the new filter, not a stale slice.
            renderRows();
            // Scroll back to the top so the user lands on the start of
            // the new filter rather than mid-list at the previous offset.
            const vp = document.getElementById('queue-viewport');
            if (vp) vp.scrollTop = 0;
        });
    });
}

// Full re-render — wipes the rows host, paints INITIAL_RENDER rows, and
// arms the load-more sentinel for further pages. Called when the
// filter/sort/search changes, or on the very first paint.
function renderRows() {
    const viewport = document.getElementById('queue-viewport');
    const rowsHost = document.getElementById('queue-rows');
    const empty = document.getElementById('queue-empty');
    const sentinel = document.getElementById('queue-load-more');
    if (!viewport || !rowsHost) return;

    const rows = getFilteredSorted();
    _renderedKeys.clear();
    if (rows.length === 0) {
        rowsHost.innerHTML = '';
        view.rendered = 0;
        if (empty) empty.classList.remove('hidden');
        if (sentinel) sentinel.classList.add('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');

    const initial = Math.min(INITIAL_RENDER, rows.length);
    const slice = rows.slice(0, initial);
    rowsHost.innerHTML = slice.map(j => renderRow(j)).join('');
    for (const j of slice) _renderedKeys.add(j.key);
    view.rendered = initial;

    _toggleSentinel(rows.length > view.rendered);
    _ensureLoadMoreObserver();

    // Wire per-row interaction via event delegation. Doing it on the host
    // (rather than per-row addEventListener) keeps the cost O(1) per
    // re-render even with 100+ visible rows.
    rowsHost.onclick = (ev) => {
        const btn = ev.target.closest('[data-row-action]');
        if (btn) {
            ev.preventDefault();
            ev.stopPropagation();
            const key = btn.closest('[data-key]')?.dataset.key;
            if (!key) return;
            runRowAction(btn.dataset.rowAction, key);
            return;
        }
        // Click anywhere else on a "done" row → open the media in the
        // viewer. Skip when an action button was the target (handled
        // above) or when text-selection is in progress.
        const row = ev.target.closest('[data-row-open]');
        if (!row) return;
        if (window.getSelection()?.toString()) return;
        const fp = row.dataset.rowOpen;
        if (!fp) return;
        // Build a minimal `state.files`-shaped record + 0-index so the
        // gallery's existing openMediaViewer pipeline can take over —
        // works for image / video / audio / document alike.
        const fileType = row.dataset.rowOpenType === 'video' ? 'videos'
            : row.dataset.rowOpenType === 'image' ? 'images'
            : row.dataset.rowOpenType === 'audio' ? 'audio'
            : 'documents';
        const ext = (fp.split('.').pop() || '').toLowerCase();
        try {
            // Stash the synthetic file in window so app.js's viewer can
            // pick it up. Falls back to a direct in-tab open if the
            // viewer isn't on the page (defensive).
            const file = {
                name: fp.split(/[\\/]/).pop(),
                fullPath: fp,
                path: fp,
                type: fileType,
                extension: '.' + ext,
            };
            if (window.Viewer?.openMediaViewerSingle) {
                window.Viewer.openMediaViewerSingle(file);
            } else {
                window.open(`/files/${encodeURIComponent(fp)}?inline=1`, '_blank');
            }
        } catch (e) {
            console.warn('queue row open failed:', e);
            window.open(`/files/${encodeURIComponent(fp)}?inline=1`, '_blank');
        }
    };
}

// Append the next batch of rows to the current rendered window. Does NOT
// re-paint the existing rows — just extends. Called by the
// IntersectionObserver when the load-more sentinel scrolls into view.
function appendNextPage() {
    const rowsHost = document.getElementById('queue-rows');
    if (!rowsHost) return;
    const rows = getFilteredSorted();
    if (view.rendered >= rows.length) {
        _toggleSentinel(false);
        return;
    }
    const slice = rows.slice(view.rendered, view.rendered + PAGE_SIZE);
    if (slice.length === 0) {
        _toggleSentinel(false);
        return;
    }
    // Use insertAdjacentHTML for an O(N_appended) DOM insert that
    // doesn't re-parse the existing rows — a `rowsHost.innerHTML += …`
    // would re-parse the entire prior content, killing performance on
    // a long queue.
    rowsHost.insertAdjacentHTML('beforeend', slice.map(j => renderRow(j)).join(''));
    for (const j of slice) _renderedKeys.add(j.key);
    view.rendered += slice.length;
    _toggleSentinel(view.rendered < rows.length);
}

function _toggleSentinel(show) {
    const el = document.getElementById('queue-load-more');
    if (!el) return;
    el.classList.toggle('hidden', !show);
}

// Single shared IntersectionObserver. Re-armed across re-renders by the
// fact that the observer keeps watching the same DOM node — only the
// node's visibility property changes.
function _ensureLoadMoreObserver() {
    const sentinel = document.getElementById('queue-load-more');
    const viewport = document.getElementById('queue-viewport');
    if (!sentinel || !viewport) return;
    if (_loadMoreObserver) return;
    _loadMoreObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                appendNextPage();
                break;
            }
        }
    }, {
        // root: the queue viewport (a scrollable element). 200 px
        // pre-fetch margin so the next batch is in flight before the
        // user actually reaches the bottom — no flash of "Loading…".
        root: viewport,
        rootMargin: '200px 0px 200px 0px',
        threshold: 0,
    });
    _loadMoreObserver.observe(sentinel);
}

// Live progress patch — for every row currently in the DOM, look up the
// fresh state in the store and update only the bits that change between
// frames (progress bar width, transferred bytes, speed, ETA, status
// pill). Avoids a full re-render so a 60-FPS download stream doesn't
// thrash layout. Rows that were structurally added/removed are handled
// by the structural-render path.
function patchRenderedRows() {
    const rowsHost = document.getElementById('queue-rows');
    if (!rowsHost || _renderedKeys.size === 0) return;
    // Detect newly-added jobs that AREN'T in the rendered window — if
    // there are any (e.g. monitor just started a fresh download), force
    // a structural re-render so they appear.
    const filtered = getFilteredSorted();
    const filteredKeys = new Set();
    for (let i = 0; i < Math.min(filtered.length, view.rendered); i++) {
        filteredKeys.add(filtered[i].key);
    }
    // If the rendered window's set of keys diverged from the filtered
    // window (a new top-of-list job, a removal), do a structural pass.
    if (filteredKeys.size !== _renderedKeys.size) {
        renderRows();
        return;
    }
    for (const k of _renderedKeys) {
        if (!filteredKeys.has(k)) { renderRows(); return; }
    }
    // Patch in place. Each `[data-key]` row has a small set of named
    // child nodes the patcher knows about; update only those.
    for (const job of filtered.slice(0, view.rendered)) {
        const rowEl = rowsHost.querySelector(`[data-key="${CSS.escape(job.key)}"]`);
        if (!rowEl) continue;
        _patchRowNode(rowEl, job);
    }
}

function _patchRowNode(rowEl, job) {
    const pct = Math.max(0, Math.min(100, job.progress || 0));
    // Progress bar
    const bar = rowEl.querySelector('[data-row-bar]');
    if (bar) bar.style.width = pct + '%';
    // Numeric progress label
    const pctLbl = rowEl.querySelector('[data-row-pct]');
    if (pctLbl) pctLbl.textContent = pct + '%';
    // Transferred bytes / total / speed line
    const meta = rowEl.querySelector('[data-row-meta]');
    if (meta) {
        const total = job.total || job.fileSize || 0;
        const sizeLine = total
            ? `${formatBytes(job.received || 0)} / ${formatBytes(total)}`
            : (job.received ? formatBytes(job.received) : '');
        const speed = job.bps ? `${formatBytes(job.bps)}/s` : '';
        const eta = job.eta != null ? formatEta(job.eta) : '';
        meta.textContent = [sizeLine, speed, eta].filter(Boolean).join(' · ');
    }
    // Status pill — only DOM-touch when the status actually changed
    const pillEl = rowEl.querySelector('[data-row-status]');
    if (pillEl && pillEl.dataset.status !== job.status) {
        // Status change can flip the action set (active → done changes
        // the per-row buttons). Cheapest correct fix: re-render this
        // single row.
        const next = renderRow(job);
        const tmp = document.createElement('div');
        tmp.innerHTML = next;
        const newRow = tmp.firstElementChild;
        if (newRow) rowEl.replaceWith(newRow);
    }
}

function renderRow(j) {
    const name = j.fileName || (j.messageId ? `#${j.messageId}` : i18nT('queue.row.unnamed', 'Unnamed file'));
    const groupName = getGroupName(j.groupId, { fallback: j.groupName || j.groupId || '?' });
    const ext = (name.split('.').pop() || '').toLowerCase();
    const isImage = j.mediaType === 'image' || j.mediaType === 'photos' || ['jpg','jpeg','png','webp','gif','bmp'].includes(ext);
    const isVideo = j.mediaType === 'video' || j.mediaType === 'videos' || ['mp4','mkv','mov','avi','webm'].includes(ext);
    const isAudio = j.mediaType === 'audio' || j.mediaType === 'voice' || ['mp3','m4a','flac','wav','ogg'].includes(ext);
    const icon = isVideo ? 'ri-video-line'
        : isImage ? 'ri-image-line'
        : isAudio ? 'ri-music-line'
        : getFileIcon(ext);

    // Status-aware progress: completed jobs always read 100, queued reads
    // blank, otherwise use the live %. Without this, finished rows kept
    // showing 0% because the in-memory job object was never bumped.
    const isDone = j.status === 'done';
    const pct = isDone ? 100 : Math.max(0, Math.min(100, j.progress || 0));
    // Size is only meaningful once Telegram has told us; show "—" only
    // while the job is queued and the size is genuinely unknown.
    const sizeStr = j.fileSize
        ? formatBytes(j.fileSize)
        : (j.status === 'queued' ? '…' : '—');
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

    // "Duplicate" tag — emitted when the downloader finished but the file
    // hash matched an existing on-disk row. The file isn't downloaded
    // again (`bytesAddedToDisk = 0`) but the (group, msg) → file mapping
    // is still recorded so it shows in the gallery. The tag stays after
    // dismiss/close — purely informational.
    const dupBadge = j.deduped
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-tg-orange/15 text-tg-orange ml-1.5 inline-flex items-center gap-0.5" title="${escapeHtml(i18nT('queue.duplicate.tooltip', 'Same file already exists on disk — no new bytes written, this row points at the existing copy.'))}"><i class="ri-file-copy-2-line"></i><span data-i18n="queue.duplicate">Duplicate</span></span>`
        : '';

    // Click-to-view: a finished row whose filePath we know becomes a link
    // to the in-app media viewer. Nothing else changes (drag-select etc.
    // still fires through the same handler).
    const openable = isDone && j.filePath;
    const rowExtraCls = openable ? ' cursor-pointer' : '';
    const rowAttrs = openable
        ? `data-row-open="${escapeHtml(j.filePath)}" data-row-open-type="${isVideo ? 'video' : isImage ? 'image' : isAudio ? 'audio' : 'file'}"`
        : '';

    // Thumbnails dropped in v2.3.21. We used to render
    //   <img src="/files/…?inline=1">  for done image rows
    //   <video preload="metadata" src="/files/…">  for done video rows
    // Both caused real-world pain on busy queues:
    //   • Video preload pulls ~256 KB of MP4 header per visible row,
    //     re-fired on every scroll → "queue extremely laggy".
    //   • Image thumbnails 404'd for any row whose file had been
    //     rotated / deleted / never fully written, spamming the console.
    // The row is still clickable + opens the actual file in the
    // viewer when it's done — the icon-only placeholder is enough
    // visual cue, with zero network and no 404 risk.
    const tint = isVideo ? 'bg-black/70 text-white'
        : isImage ? 'bg-tg-blue/15 text-tg-blue'
        : isAudio ? 'bg-tg-orange/15 text-tg-orange'
        : 'bg-tg-bg/40 text-tg-textSecondary';
    const thumb = `
        <div class="w-9 h-9 rounded ${tint} flex items-center justify-center">
            <i class="${icon}"></i>
        </div>`;

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

    // Hide the % under a finished bar (label is redundant against the
    // pill) and show "100%" only while in-flight so the progress feedback
    // stays meaningful.
    const pctLabel = isDone ? '' : (j.status === 'queued' ? '' : `${pct}%`);

    // The hooks `data-row-bar`, `data-row-pct`, `data-row-meta`, and
    // `data-row-status` let `_patchRowNode()` update only the changing
    // bits on every WS progress tick (no full re-render of the row).
    return `
        <div data-key="${escapeHtml(j.key)}" ${rowAttrs}
             class="grid grid-cols-[40px_minmax(0,2.5fr)_90px_minmax(140px,1.4fr)_80px_70px_90px_120px] items-center gap-2 px-3 py-2 hover:bg-tg-hover/40${rowExtraCls}">
            ${thumb}
            <div class="min-w-0">
                <div class="text-sm text-tg-text truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="text-[11px] text-tg-textSecondary truncate">${escapeHtml(groupName)}${j.error ? ' · ' + escapeHtml(j.error) : ''}</div>
            </div>
            <div class="text-xs text-tg-textSecondary text-right tabular-nums">${escapeHtml(sizeStr)}</div>
            <div class="min-w-0">
                <div class="h-1.5 bg-tg-bg/60 rounded overflow-hidden">
                    <div data-row-bar class="h-full ${j.status === 'failed' ? 'bg-red-500' : isDone ? 'bg-tg-green' : 'bg-tg-blue'} transition-all" style="width: ${pct}%"></div>
                </div>
                <div data-row-pct class="text-[10px] text-tg-textSecondary tabular-nums mt-0.5">${escapeHtml(pctLabel)}</div>
            </div>
            <div data-row-meta class="text-xs text-tg-textSecondary text-right tabular-nums">${escapeHtml(speedStr)}</div>
            <div class="text-xs text-tg-textSecondary text-right tabular-nums">${escapeHtml(etaStr)}</div>
            <div><span data-row-status data-status="${escapeHtml(j.status)}" class="text-[11px] px-2 py-0.5 rounded-full ${pillCls}">${escapeHtml(pillLabel)}</span>${dupBadge}</div>
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
            // Confirm before aborting an in-flight download — easy to
            // mis-tap on mobile and the work is already partially done.
            if (!(await confirmSheet({
                title: i18nT('queue.confirm.cancel_title', 'Cancel download?'),
                message: i18nT('queue.confirm.cancel', 'Stop this download? Any partial bytes will be discarded.'),
                confirmLabel: i18nT('queue.action.cancel', 'Cancel'),
                danger: true,
            }))) return;
            await api.post(`/api/queue/${encodeURIComponent(key)}/cancel`);
            remove(key);
            scheduleRender();
        } else if (action === 'retry') {
            await api.post(`/api/queue/${encodeURIComponent(key)}/retry`);
        } else if (action === 'dismiss') {
            // Local-only — drop from the recent tail. Server-side
            // clear-finished is the bulk equivalent. No confirm: the
            // action is non-destructive (file + DB row stay) and a
            // user-visible Undo would be more annoying than a re-add.
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
    // Debounced search — fast typing should not re-render on every
    // keystroke. 120 ms feels instant + drops 95 % of intermediate
    // renders on a normal typing speed.
    let _searchTimer = 0;
    document.getElementById('queue-search')?.addEventListener('input', (e) => {
        const value = e.target.value || '';
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
            view.search = value;
            invalidateFilterCache();
            renderRows();
            const vp = document.getElementById('queue-viewport');
            if (vp) vp.scrollTop = 0;
        }, 120);
    });
    document.getElementById('queue-sort')?.addEventListener('change', (e) => {
        view.sort = e.target.value || 'addedAt';
        invalidateFilterCache();
        renderRows();
        const vp = document.getElementById('queue-viewport');
        if (vp) vp.scrollTop = 0;
    });
    document.getElementById('queue-pause-all')?.addEventListener('click', () => runGlobalAction('pause-all'));
    document.getElementById('queue-resume-all')?.addEventListener('click', () => runGlobalAction('resume-all'));
    document.getElementById('queue-cancel-all')?.addEventListener('click', () => runGlobalAction('cancel-all'));
    document.getElementById('queue-clear-finished')?.addEventListener('click', () => runGlobalAction('clear-finished'));

    // Track scroll position so a navigation away and back lands at the
    // same spot — the IntersectionObserver on `#queue-load-more` does
    // the actual append-on-scroll work, no per-frame render needed here.
    const viewport = document.getElementById('queue-viewport');
    if (viewport) {
        viewport.addEventListener('scroll', () => {
            view.scrollTop = viewport.scrollTop;
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
