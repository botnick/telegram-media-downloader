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
import { fileTokenQuery } from './media-url.js';
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
const RENDER_COALESCE_MS = 60; // collapse WS bursts into one rAF tick

// Filter chip definitions. Order matters — also drives the keyboard tab order.
// `dupe` is a cross-cutting filter (any status, but only rows the
// downloader flagged as duplicates) — surfaces the rows that produced no
// new bytes on disk, so the operator can see "what got skipped today".
const STATUS_FILTERS = [
    { id: 'all', i18n: 'queue.chip.all', fallback: 'All', match: () => true },
    {
        id: 'active',
        i18n: 'queue.chip.active',
        fallback: 'Active',
        match: (j) => j.status === 'active',
    },
    {
        id: 'queued',
        i18n: 'queue.chip.queued',
        fallback: 'Queued',
        match: (j) => j.status === 'queued',
    },
    {
        id: 'paused',
        i18n: 'queue.chip.paused',
        fallback: 'Paused',
        match: (j) => j.status === 'paused',
    },
    {
        id: 'failed',
        i18n: 'queue.chip.failed',
        fallback: 'Failed',
        match: (j) => j.status === 'failed',
    },
    { id: 'done', i18n: 'queue.chip.done', fallback: 'Done', match: (j) => j.status === 'done' },
    {
        id: 'dupe',
        i18n: 'queue.chip.dupe',
        fallback: 'Duplicate',
        match: (j) => j.deduped === true,
    },
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
    sort: 'addedAt', // 'addedAt' | 'size' | 'progress' | 'group' | 'filename'
    sortDir: 'desc',
    search: '',
    scrollTop: 0,
    booted: false,
    visible: false,
    rendered: 0, // how many rows of the filtered list are in the DOM
};
let _loadMoreObserver = null;
// Keys whose rows landed in the DOM since the last full re-render. We
// cap this so an indefinite-scroll session doesn't grow the Set forever.
const _renderedKeys = new Set();

// Selected job keys — drives the floating action bar + per-row checkbox
// state. Survives WS patches because we keep keys here, not row refs;
// rows that disappear (cancel/dismiss/done-then-cleared) are pruned by
// `pruneSelection()` on every structural change.
const _selected = new Set();
// Pivot for shift-click range selection — last single toggle that
// happened in the rendered window. Cleared when the row disappears.
let _selectionPivot = null;

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
            // Refresh batch-action button state alongside other toolbar
            // counters — cheap (looks at statusCounts) and always
            // surfaces "Retry all" the moment a job lands in `failed`.
            renderToolbarState();
            // Selection bar + checkbox states need the latest filtered
            // set to compute tri-state — easy to lose this on a structural
            // re-render that wiped the row HTML.
            _patchSelectionDom();
            renderSelectionBar();
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
    if (next === 0) statusCounts.delete(status);
    else statusCounts.set(status, next);
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
    // A removed row can never be acted on again — drop it from the
    // selection so the floating-bar count and "select all" tri-state
    // stay accurate even when the underlying list churns.
    if (_selected.delete(key)) {
        if (_selectionPivot === key) _selectionPivot = null;
        scheduleSelectionRender();
    }
}

// ============ Selection ============
//
// Lightweight multi-select for the Queue page. The Set sits at module
// scope so navigation away + back keeps the selection (the Queue store
// already does the same for filter/sort/scroll). Render path: the row
// template reads `_selected` to decide checkbox state + row tint, and
// `renderSelectionBar()` shows/hides the floating action bar.

function selectionToggle(key) {
    if (!key) return;
    if (_selected.has(key)) _selected.delete(key);
    else _selected.add(key);
    _selectionPivot = key;
    scheduleSelectionRender();
}

function selectionClear() {
    if (_selected.size === 0) return;
    _selected.clear();
    _selectionPivot = null;
    scheduleSelectionRender();
}

// Range-select between the pivot and `key` based on current filtered+
// sorted order. Idempotent — already-selected rows in the range stay
// selected (we union, never subtract).
function selectionRange(toKey) {
    if (!_selectionPivot || _selectionPivot === toKey) {
        selectionToggle(toKey);
        return;
    }
    const rows = getFilteredSorted();
    const fromIdx = rows.findIndex((r) => r.key === _selectionPivot);
    const toIdx = rows.findIndex((r) => r.key === toKey);
    if (fromIdx === -1 || toIdx === -1) {
        selectionToggle(toKey);
        return;
    }
    const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    for (let i = lo; i <= hi; i++) _selected.add(rows[i].key);
    _selectionPivot = toKey;
    scheduleSelectionRender();
}

function selectionSelectAllVisible() {
    const rows = getFilteredSorted();
    if (rows.length === 0) return;
    const everyOn = rows.every((r) => _selected.has(r.key));
    if (everyOn) {
        for (const r of rows) _selected.delete(r.key);
        _selectionPivot = null;
    } else {
        for (const r of rows) _selected.add(r.key);
    }
    scheduleSelectionRender();
}

// Sync the in-DOM checkbox checked state + row tint without re-rendering
// the whole row. Cheap enough to call on every selection mutation
// because we only touch the rows in the rendered window.
function _patchSelectionDom() {
    const rowsHost = document.getElementById('queue-rows');
    if (!rowsHost) return;
    rowsHost.querySelectorAll('[data-key]').forEach((row) => {
        const key = row.dataset.key;
        const on = _selected.has(key);
        row.classList.toggle('bg-tg-blue/10', on);
        const cb = row.querySelector('input[data-row-select]');
        if (cb) cb.checked = on;
    });
    const headerCb = document.getElementById('queue-select-all');
    if (headerCb) {
        const rows = getFilteredSorted();
        if (rows.length === 0) {
            headerCb.checked = false;
            headerCb.indeterminate = false;
        } else {
            const onCount = rows.reduce((n, r) => n + (_selected.has(r.key) ? 1 : 0), 0);
            headerCb.checked = onCount === rows.length;
            headerCb.indeterminate = onCount > 0 && onCount < rows.length;
        }
    }
}

function renderSelectionBar() {
    const bar = document.getElementById('queue-selection-bar');
    const counter = document.getElementById('queue-selection-count');
    if (!bar) return;
    const n = _selected.size;
    // Bar is `position: fixed` in the viewport, so we must hide it when
    // the queue page itself isn't visible — otherwise it leaks across
    // navigation and floats over Settings / Maintenance / etc.
    if (n === 0 || !view.visible) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    if (counter) {
        counter.textContent = i18nTf(
            'queue.selection.count',
            { n },
            n === 1 ? '1 selected' : `${n} selected`,
        );
    }
}

let _selectionRenderScheduled = false;
function scheduleSelectionRender() {
    if (_selectionRenderScheduled) return;
    _selectionRenderScheduled = true;
    requestAnimationFrame(() => {
        _selectionRenderScheduled = false;
        _patchSelectionDom();
        renderSelectionBar();
    });
}

// Run a multi-row server action over the current selection. Coalesces
// the `keys` snapshot up front so a slow round-trip can't act on a
// stale set if the user keeps tweaking the selection mid-flight.
async function runBatchAction(action) {
    if (_selected.size === 0) return;
    const keys = Array.from(_selected);
    try {
        if (action === 'cancel') {
            if (
                !(await confirmSheet({
                    title: i18nT('queue.confirm.cancel_title', 'Cancel download?'),
                    message: i18nTf(
                        'queue.confirm.cancel_n',
                        { n: keys.length },
                        keys.length === 1
                            ? 'Stop this download? Any partial bytes will be discarded.'
                            : `Stop ${keys.length} downloads? Any partial bytes will be discarded.`,
                    ),
                    confirmLabel: i18nT('queue.action.cancel', 'Cancel'),
                    danger: true,
                }))
            )
                return;
        }
        const r = await api.post('/api/queue/batch', { keys, action });
        // The downloader's per-key `queue_changed` events update each
        // row, but `dismiss` is a client-only "drop from view" — handle
        // it here so the UI reacts immediately for done/failed rows.
        if (action === 'dismiss') {
            for (const k of keys) remove(k);
            scheduleStructuralRender();
        }
        showToast(
            i18nTf(
                'queue.toast.batch_done',
                { ok: r?.ok ?? keys.length, action },
                `${r?.ok ?? keys.length} updated (${action})`,
            ),
            'success',
        );
        selectionClear();
    } catch (e) {
        showToast(
            i18nTf('queue.toast.action_failed', { msg: e.message }, `Action failed: ${e.message}`),
            'error',
        );
    }
}

async function runRetryAll() {
    try {
        const r = await api.post('/api/queue/retry-all');
        const retried = r?.retried || 0;
        const skipped = r?.skipped || 0;
        if (retried === 0 && skipped === 0) {
            showToast(i18nT('queue.toast.no_failed', 'No failed jobs to retry'), 'info');
            return;
        }
        showToast(
            i18nTf(
                'queue.toast.retried_all',
                { retried, skipped },
                skipped > 0
                    ? `Retried ${retried}, skipped ${skipped}`
                    : `Retried ${retried} failed downloads`,
            ),
            'success',
        );
    } catch (e) {
        showToast(
            i18nTf('queue.toast.action_failed', { msg: e.message }, `Action failed: ${e.message}`),
            'error',
        );
    }
}

function patchProgress(payload) {
    if (!payload?.key) return;
    const prev = store.get(payload.key);
    const total = payload.total || prev?.total || prev?.fileSize || 0;
    const received = payload.received || 0;
    const bps = payload.bps || 0;
    const eta = bps > 0 && total > received ? Math.round((total - received) / bps) : null;
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
        accountId: payload.accountId ?? prev?.accountId ?? null,
        accountName: payload.accountName ?? prev?.accountName ?? null,
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
            showToast(
                i18nTf(
                    'queue.toast.snapshot_failed',
                    { msg: e.message },
                    `Failed to load queue: ${e.message}`,
                ),
                'error',
            );
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
                if (v.status === 'active' || v.status === 'queued' || v.status === 'paused')
                    remove(k);
            }
            scheduleStructuralRender();
        } else {
            scheduleRender();
        }
        return;
    }
    if (msg.type === 'queue_changed') {
        const p = msg.payload || {};
        if (p.op === 'pause-all') {
            globalPaused = true;
            scheduleStructuralRender();
            return;
        }
        if (p.op === 'resume-all') {
            globalPaused = false;
            scheduleStructuralRender();
            return;
        }
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
        if (!p.key) {
            scheduleRender();
            return;
        }
        const cur = store.get(p.key);
        if (p.op === 'pause' && cur) {
            cur.status = 'paused';
            bumpStatus('queued', -1);
            bumpStatus('active', -1);
            bumpStatus('paused', 1);
        } else if (p.op === 'resume' && cur) {
            cur.status = cur.received ? 'active' : 'queued';
            bumpStatus('paused', -1);
            bumpStatus(cur.status, 1);
        } else if (p.op === 'cancel') {
            remove(p.key);
            scheduleStructuralRender();
            return;
        } else if (p.op === 'retry' && cur) {
            cur.status = 'queued';
            cur.error = null;
            cur.progress = 0;
            cur.received = 0;
            cur.bps = 0;
            cur.eta = null;
            bumpStatus('failed', -1);
            bumpStatus('queued', 1);
        }
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
            accountId: p.accountId ?? prev?.accountId ?? null,
            accountName: p.accountName ?? prev?.accountName ?? null,
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
        const prev = store.get(p.key);
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
            accountId: p.accountId ?? prev?.accountId ?? null,
            accountName: p.accountName ?? prev?.accountName ?? null,
        });
        scheduleRender();
        return;
    }
    if (msg.type === 'download_error' && msg.payload?.job?.key) {
        const j = msg.payload.job;
        const prev = store.get(j.key);
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
            accountId: j.accountId ?? prev?.accountId ?? null,
            accountName: j.accountName ?? prev?.accountName ?? null,
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
    const filterFn = (STATUS_FILTERS.find((f) => f.id === view.filter) || STATUS_FILTERS[0]).match;
    const q = view.search.trim().toLowerCase();
    const out = [];
    for (const job of store.values()) {
        if (!filterFn(job)) continue;
        if (q) {
            const name = (job.fileName || '').toLowerCase();
            const group = (
                getGroupName(job.groupId, { fallback: job.groupName || '' }) || ''
            ).toLowerCase();
            if (!name.includes(q) && !group.includes(q)) continue;
        }
        out.push(job);
    }
    const dir = view.sortDir === 'asc' ? 1 : -1;
    const get = (j) => {
        switch (view.sort) {
            case 'size':
                return j.fileSize || 0;
            case 'progress':
                return j.progress || 0;
            case 'group':
                return getGroupName(j.groupId, { fallback: j.groupName || '' }) || '';
            case 'filename':
                return j.fileName || '';
            default:
                return j.addedAt || 0;
        }
    };
    out.sort((a, b) => {
        const av = get(a);
        const bv = get(b);
        if (typeof av === 'string') return av.localeCompare(bv) * dir;
        return ((av || 0) - (bv || 0)) * dir;
    });
    _filteredCache = out;
    _filteredCacheTag = tag;
    return out;
}

function invalidateFilterCache() {
    _filteredCacheTag = '';
}

// ============ Render ============
function renderChips() {
    const host = document.getElementById('queue-chips');
    if (!host) return;
    const total = store.size;
    // `deduped` is a cross-cutting flag, not a status — statusCounts tracks
    // active/queued/paused/failed/done only. Count it by sweeping the store
    // at render time (O(n) where n = store.size, capped by sliding window).
    // Without this the "Duplicate" chip always showed 0 even when rows
    // carried the orange Duplicate badge.
    let dupeCount = 0;
    for (const j of store.values()) {
        if (j.deduped === true) dupeCount += 1;
    }
    const counts = {
        all: total,
        active: statusCounts.get('active') || 0,
        queued: statusCounts.get('queued') || 0,
        paused: statusCounts.get('paused') || 0,
        failed: statusCounts.get('failed') || 0,
        done: statusCounts.get('done') || 0,
        dupe: dupeCount,
    };
    host.innerHTML = STATUS_FILTERS.map((f) => {
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
    host.querySelectorAll('[data-chip]').forEach((btn) => {
        btn.addEventListener('click', () => {
            view.filter = btn.dataset.chip;
            invalidateFilterCache();
            // Update the URL without re-dispatching the route handler so
            // back/forward still work but we don't churn the page.
            const target =
                view.filter === 'all' ? '#/queue' : `#/queue/${encodeURIComponent(view.filter)}`;
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
    rowsHost.innerHTML = slice.map((j) => renderRow(j)).join('');
    for (const j of slice) _renderedKeys.add(j.key);
    view.rendered = initial;

    _toggleSentinel(rows.length > view.rendered);
    _ensureLoadMoreObserver();

    // Wire per-row interaction via event delegation. Doing it on the host
    // (rather than per-row addEventListener) keeps the cost O(1) per
    // re-render even with 100+ visible rows.
    rowsHost.onclick = (ev) => {
        // Per-row checkbox — toggle selection without acting on the row.
        const cb = ev.target.closest('input[data-row-select]');
        if (cb) {
            ev.stopPropagation();
            const rowEl = cb.closest('[data-key]');
            const key = rowEl?.dataset.key;
            if (!key) return;
            // Shift+click on a checkbox = range select from pivot →
            // current. Plain click = single toggle. (We don't auto-toggle
            // here — the browser already changed `cb.checked`; we mirror
            // the desired final state into the Set.)
            if (ev.shiftKey && _selectionPivot && _selectionPivot !== key) {
                cb.checked = !cb.checked; // undo browser default — selectionRange decides final
                ev.preventDefault();
                selectionRange(key);
            } else {
                if (cb.checked) _selected.add(key);
                else _selected.delete(key);
                _selectionPivot = key;
                scheduleSelectionRender();
            }
            return;
        }
        const btn = ev.target.closest('[data-row-action]');
        if (btn) {
            ev.preventDefault();
            ev.stopPropagation();
            const key = btn.closest('[data-key]')?.dataset.key;
            if (!key) return;
            runRowAction(btn.dataset.rowAction, key);
            return;
        }
        // Click anywhere else with a modifier key = selection gesture
        // (Ctrl/Cmd toggle, Shift range). Falls through to the
        // open-viewer path only on plain clicks.
        const rowSel = ev.target.closest('[data-key]');
        if (rowSel && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
            ev.preventDefault();
            ev.stopPropagation();
            const key = rowSel.dataset.key;
            if (ev.shiftKey) selectionRange(key);
            else selectionToggle(key);
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
        const fileType =
            row.dataset.rowOpenType === 'video'
                ? 'videos'
                : row.dataset.rowOpenType === 'image'
                  ? 'images'
                  : row.dataset.rowOpenType === 'audio'
                    ? 'audio'
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
                const _ftq = fileTokenQuery();
                window.open(
                    `/files/${encodeURIComponent(fp)}?inline=1${_ftq ? '&' + _ftq : ''}`,
                    '_blank',
                );
            }
        } catch (e) {
            console.warn('queue row open failed:', e);
            const _ftq = fileTokenQuery();
            window.open(
                `/files/${encodeURIComponent(fp)}?inline=1${_ftq ? '&' + _ftq : ''}`,
                '_blank',
            );
        }
    };
}

// Append the next batch of rows to the current rendered window. Does NOT
// re-paint the existing rows — just extends. Called by the
// IntersectionObserver when the load-more sentinel scrolls into view.
//
// Sliding-window cap — past `MAX_DOM_ROWS` we drop the topmost rows that
// have scrolled past the viewport so the DOM doesn't grow with infinite
// scroll. A 10 k-job queue otherwise piles up 10 k <div> nodes in the
// DOM, each with progress-bar listeners + WS-patched data hooks; the
// browser tab eventually OOMs on heavy mobile devices.
// See CLAUDE.md → Big-data patterns rule 4.
const MAX_DOM_ROWS = 500;
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
    rowsHost.insertAdjacentHTML('beforeend', slice.map((j) => renderRow(j)).join(''));
    for (const j of slice) _renderedKeys.add(j.key);
    view.rendered += slice.length;
    // Sliding window — drop the topmost N rows that have scrolled out of
    // the viewport so the DOM stays bounded. Keeps the IntersectionObserver
    // sentinel intact at the bottom because it lives outside `queue-rows`.
    while (rowsHost.children.length > MAX_DOM_ROWS) {
        const first = rowsHost.firstElementChild;
        if (!first) break;
        const k = first.dataset?.key;
        if (k) _renderedKeys.delete(k);
        first.remove();
    }
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
    _loadMoreObserver = new IntersectionObserver(
        (entries) => {
            for (const e of entries) {
                if (e.isIntersecting) {
                    appendNextPage();
                    break;
                }
            }
        },
        {
            // root: the queue viewport (a scrollable element). 200 px
            // pre-fetch margin so the next batch is in flight before the
            // user actually reaches the bottom — no flash of "Loading…".
            root: viewport,
            rootMargin: '200px 0px 200px 0px',
            threshold: 0,
        },
    );
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
        if (!filteredKeys.has(k)) {
            renderRows();
            return;
        }
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
            : job.received
              ? formatBytes(job.received)
              : '';
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
    const name =
        j.fileName ||
        (j.messageId ? `#${j.messageId}` : i18nT('queue.row.unnamed', 'Unnamed file'));
    const groupName = getGroupName(j.groupId, { fallback: j.groupName || j.groupId || '?' });
    const ext = (name.split('.').pop() || '').toLowerCase();
    const isImage =
        j.mediaType === 'image' ||
        j.mediaType === 'photos' ||
        ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
    const isVideo =
        j.mediaType === 'video' ||
        j.mediaType === 'videos' ||
        ['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext);
    const isAudio =
        j.mediaType === 'audio' ||
        j.mediaType === 'voice' ||
        ['mp3', 'm4a', 'flac', 'wav', 'ogg'].includes(ext);
    const icon = isVideo
        ? 'ri-video-line'
        : isImage
          ? 'ri-image-line'
          : isAudio
            ? 'ri-music-line'
            : getFileIcon(ext);

    // Status-aware progress: completed jobs always read 100, queued reads
    // blank, otherwise use the live %. Without this, finished rows kept
    // showing 0% because the in-memory job object was never bumped.
    const isDone = j.status === 'done';
    const pct = isDone ? 100 : Math.max(0, Math.min(100, j.progress || 0));
    // Size is only meaningful once Telegram has told us; show "—" only
    // while the job is queued and the size is genuinely unknown.
    const sizeStr = j.fileSize ? formatBytes(j.fileSize) : j.status === 'queued' ? '…' : '—';
    const speedStr = j.status === 'active' && j.bps ? `${formatBytes(j.bps)}/s` : '—';
    const etaStr = j.status === 'active' && j.eta != null ? formatEta(j.eta) : '—';

    const pillCls =
        {
            active: 'bg-tg-blue/20 text-tg-blue',
            queued: 'bg-gray-700/40 text-gray-300',
            paused: 'bg-tg-orange/20 text-tg-orange',
            failed: 'bg-red-500/20 text-red-400',
            done: 'bg-tg-green/20 text-tg-green',
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

    // Account chip — surfaces which Telegram session pulled this job's
    // bytes. Suppressed for jobs queued before multi-account routing
    // landed (no accountName) so legacy rows don't render an empty pill.
    const accountChip = j.accountName
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-tg-blue/10 text-tg-blue ml-1.5 inline-flex items-center gap-0.5" title="${escapeHtml(i18nTf('queue.account.tooltip', { name: j.accountName }, `Pulled via account: ${j.accountName}`))}"><i class="ri-user-3-line"></i><span>${escapeHtml(j.accountName)}</span></span>`
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
    const tint = isVideo
        ? 'bg-black/70 text-white'
        : isImage
          ? 'bg-tg-blue/15 text-tg-blue'
          : isAudio
            ? 'bg-tg-orange/15 text-tg-orange'
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
        actions.push(
            actionBtn(
                'cancel',
                'ri-close-line',
                i18nT('queue.action.cancel', 'Cancel'),
                'text-red-400',
            ),
        );
    } else if (j.status === 'paused') {
        actions.push(actionBtn('resume', 'ri-play-line', i18nT('queue.action.resume', 'Resume')));
        actions.push(
            actionBtn(
                'cancel',
                'ri-close-line',
                i18nT('queue.action.cancel', 'Cancel'),
                'text-red-400',
            ),
        );
    } else if (j.status === 'failed') {
        actions.push(actionBtn('retry', 'ri-refresh-line', i18nT('queue.action.retry', 'Retry')));
        actions.push(
            actionBtn('dismiss', 'ri-delete-bin-line', i18nT('queue.action.dismiss', 'Dismiss')),
        );
    } else if (j.status === 'done') {
        actions.push(
            actionBtn('dismiss', 'ri-delete-bin-line', i18nT('queue.action.dismiss', 'Dismiss')),
        );
    }

    // Hide the % under a finished bar (label is redundant against the
    // pill) and show "100%" only while in-flight so the progress feedback
    // stays meaningful.
    const pctLabel = isDone ? '' : j.status === 'queued' ? '' : `${pct}%`;

    // Per-row selection checkbox — `data-row-select` lets the click
    // delegate toggle the checked state without re-rendering the whole
    // row. Hidden on mobile (the layout collapses to single-column there
    // and the floating bar covers selection actions) but the checkbox
    // is still in the DOM so keyboard shortcuts keep working.
    const isSelected = _selected.has(j.key);
    const selectCell = `
        <span class="hidden md:flex items-center justify-center">
            <input type="checkbox" data-row-select
                class="rounded border-tg-border bg-tg-bg cursor-pointer accent-tg-blue"
                ${isSelected ? 'checked' : ''}
                aria-label="Select row">
        </span>`;

    // The hooks `data-row-bar`, `data-row-pct`, `data-row-meta`, and
    // `data-row-status` let `_patchRowNode()` update only the changing
    // bits on every WS progress tick (no full re-render of the row).
    const rowSelClass = isSelected ? ' bg-tg-blue/10' : '';
    return `
        <div data-key="${escapeHtml(j.key)}" ${rowAttrs}
             class="grid grid-cols-[32px_40px_minmax(0,2.5fr)_90px_minmax(140px,1.4fr)_80px_70px_90px_120px] items-center gap-2 px-3 py-2 hover:bg-tg-hover/40${rowExtraCls}${rowSelClass}">
            ${selectCell}
            ${thumb}
            <div class="min-w-0">
                <div class="text-sm text-tg-text truncate" title="${escapeHtml(name)}">${escapeHtml(name)}${accountChip}</div>
                <div class="text-[11px] text-tg-textSecondary truncate flex items-center gap-1.5 flex-wrap">
                    <span class="truncate">${escapeHtml(groupName)}</span>
                    ${
                        j.addedAt
                            ? `<span class="text-tg-textSecondary/40">·</span><span class="inline-flex items-center gap-0.5 tabular-nums" title="${escapeHtml(i18nT('queue.row.added_tooltip', 'Added to queue'))}"><i class="ri-add-circle-line"></i>${escapeHtml(_fmtClock(j.addedAt))}</span>`
                            : ''
                    }
                    ${
                        j.finishedAt
                            ? `<span class="text-tg-textSecondary/40">·</span><span class="inline-flex items-center gap-0.5 tabular-nums ${j.status === 'failed' ? 'text-red-400/80' : 'text-tg-green/80'}" title="${escapeHtml(i18nT(j.status === 'failed' ? 'queue.row.failed_tooltip' : 'queue.row.finished_tooltip', j.status === 'failed' ? 'Failed at' : 'Finished at'))}"><i class="${j.status === 'failed' ? 'ri-close-circle-line' : 'ri-check-line'}"></i>${escapeHtml(_fmtClock(j.finishedAt))}</span>${
                                  j.addedAt && j.finishedAt > j.addedAt
                                      ? `<span class="text-tg-textSecondary/40">·</span><span class="tabular-nums" title="${escapeHtml(i18nT('queue.row.duration_tooltip', 'Time taken'))}">${escapeHtml(_fmtDuration(j.finishedAt - j.addedAt))}</span>`
                                      : ''
                              }`
                            : ''
                    }
                    ${j.error ? `<span class="text-tg-textSecondary/40">·</span><span class="text-red-400/80 truncate">${escapeHtml(j.error)}</span>` : ''}
                </div>
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

// IDM-style "10:23:45" if today, "11/12 10:23" if this year, "2025-11-12"
// otherwise. Compact enough for the secondary metadata line. Returns ''
// when t is missing or invalid so the caller can skip rendering.
function _fmtClock(t) {
    if (!t || !Number.isFinite(Number(t))) return '';
    const d = new Date(Number(t));
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    if (sameDay) return `${hh}:${mm}:${ss}`;
    if (d.getFullYear() === now.getFullYear()) {
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

function _fmtDuration(ms) {
    if (!ms || !Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

// Toolbar state — currently just enables / disables the "Retry all"
// button. Cheap on the existing statusCounts map; called from the same
// scheduleRender tick so it stays in lock-step with the chip counts.
function renderToolbarState() {
    const btn = document.getElementById('queue-retry-all');
    if (!btn) return;
    const failed = statusCounts.get('failed') || 0;
    btn.disabled = failed === 0;
}

function renderAggregate() {
    const host = document.getElementById('queue-aggregate');
    if (!host) return;
    let active = 0,
        queued = 0,
        totalBps = 0;
    for (const j of store.values()) {
        if (j.status === 'active') {
            active++;
            totalBps += j.bps || 0;
        } else if (j.status === 'queued') queued++;
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
            if (
                !(await confirmSheet({
                    title: i18nT('queue.confirm.cancel_title', 'Cancel download?'),
                    message: i18nT(
                        'queue.confirm.cancel',
                        'Stop this download? Any partial bytes will be discarded.',
                    ),
                    confirmLabel: i18nT('queue.action.cancel', 'Cancel'),
                    danger: true,
                }))
            )
                return;
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
        showToast(
            i18nTf('queue.toast.action_failed', { msg: e.message }, `Action failed: ${e.message}`),
            'error',
        );
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
            if (
                !(await confirmSheet({
                    title: i18nT('queue.action.cancel_all', 'Cancel queued'),
                    message: i18nT(
                        'queue.confirm.cancel_all',
                        'Cancel every queued download? Active jobs continue.',
                    ),
                    confirmLabel: i18nT('queue.action.cancel_all', 'Cancel queued'),
                    danger: true,
                }))
            )
                return;
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
        showToast(
            i18nTf('queue.toast.action_failed', { msg: e.message }, `Action failed: ${e.message}`),
            'error',
        );
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
                showToast(
                    i18nTf(
                        'queue.toast.throttle_failed',
                        { msg: e.message },
                        `Failed to update: ${e.message}`,
                    ),
                    'error',
                );
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
    if (params?.status && STATUS_FILTERS.some((f) => f.id === params.status)) {
        view.filter = params.status;
        invalidateFilterCache();
    }
    if (!view.booted) await loadSnapshot();
    wireOnce();
    bindThrottleSlider();
    renderChips();
    renderAggregate();
    renderRows();
    renderToolbarState();
    _patchSelectionDom();
    renderSelectionBar();
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
    document
        .getElementById('queue-pause-all')
        ?.addEventListener('click', () => runGlobalAction('pause-all'));
    document
        .getElementById('queue-resume-all')
        ?.addEventListener('click', () => runGlobalAction('resume-all'));
    document
        .getElementById('queue-cancel-all')
        ?.addEventListener('click', () => runGlobalAction('cancel-all'));
    document
        .getElementById('queue-clear-finished')
        ?.addEventListener('click', () => runGlobalAction('clear-finished'));
    document.getElementById('queue-retry-all')?.addEventListener('click', () => runRetryAll());

    // Header "select all visible" checkbox. Tri-state: empty / partial /
    // full. Clicking from any state goes to "full"; clicking when already
    // full clears.
    document.getElementById('queue-select-all')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        selectionSelectAllVisible();
    });

    // Floating selection bar buttons.
    document.getElementById('queue-selection-bar')?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-batch-action]');
        if (btn) {
            ev.preventDefault();
            runBatchAction(btn.dataset.batchAction);
            return;
        }
        if (ev.target.closest('#queue-selection-clear')) {
            ev.preventDefault();
            selectionClear();
        }
    });

    // Document-level keyboard shortcuts. Ignored when the user is typing
    // in an input/textarea/contenteditable so they don't fight the
    // search box.
    document.addEventListener('keydown', (ev) => {
        // Only when the queue page is the visible one — the SPA shows
        // multiple pages and these shortcuts shouldn't leak.
        if (!view.visible) return;
        const tag = (ev.target?.tagName || '').toLowerCase();
        const inField = tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable;
        if (inField) return;

        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
            ev.preventDefault();
            selectionSelectAllVisible();
            return;
        }
        if (ev.key === 'Escape' && _selected.size > 0) {
            ev.preventDefault();
            selectionClear();
            return;
        }
    });

    // Track scroll position so a navigation away and back lands at the
    // same spot — the IntersectionObserver on `#queue-load-more` does
    // the actual append-on-scroll work, no per-frame render needed here.
    const viewport = document.getElementById('queue-viewport');
    if (viewport) {
        viewport.addEventListener(
            'scroll',
            () => {
                view.scrollTop = viewport.scrollTop;
            },
            { passive: true },
        );
    }

    // Hide the page when navigating away — the WS handlers keep mutating
    // the store, but we skip rendering until the user comes back.
    const observer = new MutationObserver(() => {
        const el = document.getElementById('page-queue');
        if (!el) return;
        const wasVisible = view.visible;
        view.visible = !el.classList.contains('hidden');
        // Selection bar is `position: fixed` so it would leak across
        // navigation. Re-paint it whenever the page's visibility flips.
        if (wasVisible !== view.visible) renderSelectionBar();
    });
    const queuePage = document.getElementById('page-queue');
    if (queuePage) observer.observe(queuePage, { attributes: true, attributeFilter: ['class'] });
}
