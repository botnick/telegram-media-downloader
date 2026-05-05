// Maintenance — Find duplicate files (admin page).
//
// Shows every set of byte-identical files (SHA-256), lets the admin pick
// which copies to delete, and runs a one-shot delete via
// /api/maintenance/dedup/delete. A "Re-index from disk" button at the top
// rebuilds the catalogue if files exist on disk but the DB is empty (a
// common cause of empty dedup results).
//
// Owns:
//   - One-shot scan + render of duplicate sets.
//   - Bulk-select shortcuts (keep oldest / keep newest / select-all).
//   - Live dedup_progress + reindex_progress / reindex_done WS handlers.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;
let _sets = []; // last scan result

function _formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _renderRow(file, set) {
    const thumbUrl = `/api/thumbs/${encodeURIComponent(file.id)}?w=120`;
    const fileUrl = `/files/${encodeURIComponent(file.filePath || '')}?inline=1`;
    const when = file.createdAt ? new Date(file.createdAt).toLocaleDateString() : '—';
    const sizeStr = file.fileSize ? _formatBytes(file.fileSize) : '';
    // `_delete` is the in-memory selection state — set by per-set keep
    // buttons, the bulk-keep buttons, and the default-selection pass.
    // The chunked render loop hits this for the tail rows so they pick
    // up the same state as the rows already in the DOM.
    const willDelete = file._delete === true;
    const accent = willDelete ? 'border-l-red-400/60' : 'border-l-tg-green/60';
    return `
        <label class="dup-row group flex items-center gap-3 p-2 rounded-lg hover:bg-tg-hover/40 cursor-pointer border-l-2 ${accent} transition-colors" data-file-row="${file.id}">
            <input type="checkbox" class="dup-del shrink-0" data-id="${file.id}" data-hash="${escapeHtml(set.hash)}" ${willDelete ? 'checked' : ''}>
            <img loading="lazy" decoding="async"
                 class="w-14 h-14 object-cover rounded-md bg-tg-bg/40 shrink-0 ring-1 ring-tg-border/40"
                 src="${escapeHtml(thumbUrl)}" alt=""
                 onerror="this.style.display='none'">
            <div class="min-w-0 flex-1">
                <div class="text-sm text-tg-text truncate font-medium">${escapeHtml(file.fileName || '(unnamed)')}</div>
                <div class="text-[11px] text-tg-textSecondary truncate flex items-center gap-1.5 flex-wrap">
                    <span class="inline-flex items-center gap-1"><i class="ri-folder-3-line"></i>${escapeHtml(file.groupName || file.groupId || '—')}</span>
                    ${sizeStr ? `<span class="text-tg-textSecondary/60">·</span><span class="tabular-nums">${escapeHtml(sizeStr)}</span>` : ''}
                    <span class="text-tg-textSecondary/60">·</span><span>${escapeHtml(when)}</span>
                </div>
            </div>
            <a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener"
               class="opacity-0 group-hover:opacity-100 text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue transition-opacity shrink-0"
               title="${escapeHtml(i18nT('maintenance.dedup.view', 'Open in viewer'))}"
               onclick="event.stopPropagation()">
                <i class="ri-external-link-line"></i>
            </a>
        </label>`;
}

function _renderSet(set, idx) {
    // Reclaim per set = (count - 1) × fileSize. We show this prominently
    // because it's the actual win — the "X copies" number alone doesn't
    // tell you whether deleting them is worth a click.
    const reclaim = Math.max(0, (set.count - 1)) * (Number(set.fileSize) || 0);
    const previewThumb = set.files?.[0]?.id != null
        ? `<img loading="lazy" decoding="async"
                 class="w-10 h-10 object-cover rounded-md bg-tg-bg/40 shrink-0 ring-1 ring-tg-border/40"
                 src="/api/thumbs/${encodeURIComponent(set.files[0].id)}?w=120" alt="" onerror="this.style.display='none'">`
        : '';
    return `
        <div class="bg-tg-bg/30 rounded-xl p-3 mb-2 border border-tg-border/30 hover:border-tg-blue/30 transition-colors" data-set="${escapeHtml(set.hash)}" data-set-idx="${idx}">
            <div class="flex items-center gap-3 mb-2">
                ${previewThumb}
                <div class="min-w-0 flex-1">
                    <div class="text-sm text-tg-text font-medium tabular-nums">
                        ${escapeHtml(i18nTf('maintenance.dedup.set_header_v2',
                            { count: set.count, size: _formatBytes(set.fileSize) },
                            `${set.count} copies · ${_formatBytes(set.fileSize)} each`))}
                    </div>
                    <div class="text-[11px] text-tg-green tabular-nums">
                        <i class="ri-coins-line"></i> ${escapeHtml(i18nTf('maintenance.dedup.set_reclaim',
                            { size: _formatBytes(reclaim) },
                            `Up to ${_formatBytes(reclaim)} reclaimable`))}
                    </div>
                </div>
                <div class="flex items-center gap-1 shrink-0 flex-wrap">
                    <button type="button" class="text-[11px] px-2 py-1 rounded-md bg-tg-bg/60 hover:bg-tg-blue/15 text-tg-textSecondary hover:text-tg-blue transition-colors"
                            data-keep="oldest" data-hash="${escapeHtml(set.hash)}"
                            data-i18n="maintenance.duplicates.keep_oldest">Keep oldest</button>
                    <button type="button" class="text-[11px] px-2 py-1 rounded-md bg-tg-bg/60 hover:bg-tg-blue/15 text-tg-textSecondary hover:text-tg-blue transition-colors"
                            data-keep="newest" data-hash="${escapeHtml(set.hash)}"
                            data-i18n="maintenance.duplicates.keep_newest">Keep newest</button>
                </div>
            </div>
            <div class="space-y-0.5 pl-1">${set.files.map((f) => _renderRow(f, set)).join('')}</div>
        </div>`;
}

function _refreshSummary() {
    const root = $('page-maintenance-duplicates');
    if (!root) return;
    const ids = [...root.querySelectorAll('.dup-del:checked')].map((el) => Number(el.dataset.id));
    let bytes = 0;
    for (const set of _sets) {
        for (const f of set.files) if (ids.includes(f.id)) bytes += Number(f.fileSize) || 0;
    }
    const sum = $('dup-summary');
    if (sum) {
        sum.textContent = i18nTf('maintenance.dedup.selected',
            { count: ids.length, freed: _formatBytes(bytes) },
            `${ids.length} selected · ${_formatBytes(bytes)} will be freed`);
    }
}

// Lazy-chunked rendering — first paint is the first 30 sets so even a
// library with 5 000 duplicate groups feels instant. Remaining sets land
// in idle-time slices via `requestIdleCallback` (or `setTimeout` on
// browsers without the API). Coupled with event-delegation below this
// keeps the page responsive on a Pi 4 / phone class device.
const FIRST_PAINT_SETS = 30;
const CHUNK_SETS = 50;
let _renderToken = 0; // bumps every full render so a stale chunk loop bails out

const _idleSchedule = (fn) => (typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fn, { timeout: 200 })
    : setTimeout(fn, 32));

function _renderSets(sets) {
    _sets = Array.isArray(sets) ? sets : [];
    const list = $('dup-list');
    const empty = $('dup-empty');
    const totals = $('dup-totals');
    if (!list) return;

    const bulkBar = $('dup-bulk-bar');
    if (!_sets.length) {
        list.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        if (totals) totals.innerHTML = '';
        if (bulkBar) bulkBar.classList.add('hidden');
        _refreshSummary();
        return;
    }
    if (empty) empty.classList.add('hidden');
    if (bulkBar) bulkBar.classList.remove('hidden');

    const totalSets = _sets.length;
    const totalDupes = _sets.reduce((s, x) => s + (x.count - 1), 0);
    const totalReclaim = _sets.reduce((s, x) => s + (x.fileSize * (x.count - 1)), 0);
    const totalFiles  = _sets.reduce((s, x) => s + (x.count || 0), 0);
    if (totals) {
        // Stats grid — Telegram-style 4-up cards. Bigger numbers, clear
        // labels, the headline (reclaimable size) gets the green accent
        // because it's the actual win.
        totals.innerHTML = `
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <div class="bg-tg-bg/40 rounded-lg p-3 text-center">
                    <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.dedup.stat.sets">Duplicate sets</div>
                    <div class="text-xl font-semibold text-tg-text tabular-nums">${totalSets.toLocaleString()}</div>
                </div>
                <div class="bg-tg-bg/40 rounded-lg p-3 text-center">
                    <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.dedup.stat.copies">Extra copies</div>
                    <div class="text-xl font-semibold text-tg-text tabular-nums">${totalDupes.toLocaleString()}</div>
                </div>
                <div class="bg-tg-bg/40 rounded-lg p-3 text-center">
                    <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.dedup.stat.files">Total files</div>
                    <div class="text-xl font-semibold text-tg-text tabular-nums">${totalFiles.toLocaleString()}</div>
                </div>
                <div class="bg-tg-green/10 border border-tg-green/30 rounded-lg p-3 text-center">
                    <div class="text-[10px] uppercase text-tg-green/80 tracking-wide" data-i18n="maintenance.dedup.stat.reclaim">Reclaimable</div>
                    <div class="text-xl font-semibold text-tg-green tabular-nums">${escapeHtml(_formatBytes(totalReclaim))}</div>
                </div>
            </div>`;
    }

    // Bump the render token so a previous render's idle chunks bail out
    // (the user clicked "Scan" again before the previous chunk finished).
    const token = ++_renderToken;

    // First paint: render FIRST_PAINT_SETS synchronously. Below the fold
    // gets a "Loading remaining…" hint that's replaced as chunks land.
    const initial = _sets.slice(0, FIRST_PAINT_SETS);
    list.innerHTML = initial.map((s, i) => _renderSet(s, i)).join('')
        + (_sets.length > FIRST_PAINT_SETS
            ? `<div id="dup-list-pending" class="text-center text-xs text-tg-textSecondary py-3"><i class="ri-loader-4-line animate-spin mr-1"></i>${escapeHtml(i18nTf('maintenance.dedup.loading_remaining', { n: _sets.length - FIRST_PAINT_SETS }, `Rendering ${_sets.length - FIRST_PAINT_SETS} more sets…`))}</div>`
            : '');
    _applyDefaultSelection(initial);

    // Background chunk loop for the remainder.
    const renderChunk = (offset) => {
        if (token !== _renderToken) return; // stale render — bail
        if (offset >= _sets.length) {
            const pend = $('dup-list-pending');
            if (pend) pend.remove();
            _refreshSummary();
            return;
        }
        const slice = _sets.slice(offset, offset + CHUNK_SETS);
        const html = slice.map((s, i) => _renderSet(s, offset + i)).join('');
        const pend = $('dup-list-pending');
        if (pend) {
            pend.insertAdjacentHTML('beforebegin', html);
            const remaining = _sets.length - (offset + slice.length);
            if (remaining > 0) {
                pend.innerHTML = `<i class="ri-loader-4-line animate-spin mr-1"></i>${escapeHtml(i18nTf('maintenance.dedup.loading_remaining', { n: remaining }, `Rendering ${remaining} more sets…`))}`;
            } else {
                pend.remove();
            }
        }
        _applyDefaultSelection(slice);
        _idleSchedule(() => renderChunk(offset + CHUNK_SETS));
    };
    if (_sets.length > FIRST_PAINT_SETS) _idleSchedule(() => renderChunk(FIRST_PAINT_SETS));

    _refreshSummary();
}

// Default selection: keep oldest of every set, mark rest for deletion.
// Called per-chunk so the user can interact with the first 30 sets the
// instant they paint.
function _applyDefaultSelection(setsSlice) {
    const list = $('dup-list');
    if (!list) return;
    for (const set of setsSlice) {
        const sortedAsc = [...set.files].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const keepId = sortedAsc[0]?.id;
        for (const f of set.files) {
            // Default: keep the oldest, mark the rest for delete. Recorded
            // on the in-memory model so chunk-rendered tail rows + bulk
            // operations all reference the same source of truth.
            if (f._delete == null) f._delete = (f.id !== keepId);
            const cb = list.querySelector(`.dup-del[data-id="${f.id}"]`);
            if (cb) cb.checked = f._delete === true;
            const row = list.querySelector(`[data-file-row="${f.id}"]`);
            if (row) {
                row.classList.toggle('border-l-red-400/60', f._delete === true);
                row.classList.toggle('border-l-tg-green/60', f._delete !== true);
            }
        }
    }
}

function _setScanUi(running) {
    const btn = $('dup-scan-btn');
    const progress = $('dup-progress');
    const bar = $('dup-progress-bar');
    if (btn) {
        btn.disabled = !!running;
        btn.textContent = running
            ? i18nT('maintenance.dedup.scanning', 'Scanning…')
            : i18nT('maintenance.duplicates.scan', 'Scan');
    }
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running && bar) bar.style.width = '0%';
}

// `POST /api/maintenance/dedup/scan` is fire-and-forget — returns 200
// with `{started:true}` immediately so Cloudflare's 100 s tunnel timeout
// can never bite, and a 50 GB library hashing for minutes doesn't hold
// the request open. Result lands via `dedup_done` WS event; status
// recovery on re-mount via GET /dedup/status.
async function _runScan() {
    _setScanUi(true);
    try {
        const r = await api.post('/api/maintenance/dedup/scan', {});
        if (r?.error) {
            showToast(r.error, 'error');
            _setScanUi(false);
            return;
        }
        // Don't render anything yet — wait for `dedup_done` over WS.
    } catch (e) {
        // 409 = already running on another client. Hydrate from /status
        // so the button stays disabled until the other client finishes.
        if (e?.data?.code === 'ALREADY_RUNNING') {
            _setScanUi(true);
            showToast(i18nT('maintenance.dedup.already_running', 'A dedup scan is already running on another client.'), 'info');
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setScanUi(false);
    }
}

// Recover live state on (re-)entry — the scan keeps running on the
// server even after a tab close, so we re-paint the running UI + the
// last completed result if any. Also hydrates the bulk-delete + reindex
// trackers so a job started on one client disables the buttons on this
// tab until it finishes.
async function _recoverScanState() {
    try {
        const r = await api.get('/api/maintenance/dedup/status');
        if (r?.running) _setScanUi(true);
        if (r?.result?.duplicateSets) _renderSets(r.result.duplicateSets);
    } catch { /* non-fatal */ }
    try {
        const r = await api.get('/api/maintenance/dedup/delete/status');
        if (r?.running) _setDeleteUi(true);
    } catch {}
    try {
        const r = await api.get('/api/maintenance/reindex/status');
        if (r?.running) {
            const btn = $('dup-reindex-btn');
            const progress = $('dup-reindex-progress');
            if (btn) {
                btn.disabled = true;
                btn.textContent = i18nT('maintenance.reindex.running', 'Re-indexing…');
            }
            if (progress) progress.classList.remove('hidden');
        }
    } catch {}
}

function _setDeleteUi(running) {
    const btn = $('dup-delete-btn');
    if (btn) btn.disabled = !!running;
}

async function _deleteSelected() {
    const root = $('page-maintenance-duplicates');
    if (!root) return;
    const ids = [...root.querySelectorAll('.dup-del:checked')].map((el) => Number(el.dataset.id));
    if (!ids.length) {
        showToast(i18nT('maintenance.dedup.nothing', 'Nothing selected'), 'info');
        return;
    }
    const ok = await confirmSheet({
        title: i18nT('maintenance.dedup.confirm_title', 'Delete duplicate files?'),
        message: i18nTf('maintenance.dedup.confirm_body',
            { n: ids.length },
            `Permanently delete ${ids.length} file(s) from disk and database?`),
        confirmLabel: i18nT('maintenance.dedup.confirm_btn', 'Delete'),
        danger: true,
    });
    if (!ok) return;
    // Fire-and-forget — at N=10k disk I/O can run for minutes. The
    // result lands via `dedup_delete_done` (handled in `_wireWs`); a
    // running job started by another client keeps THIS button disabled
    // through `dedup_delete_progress`.
    _setDeleteUi(true);
    try {
        const r = await api.post('/api/maintenance/dedup/delete', { ids });
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setDeleteUi(false);
    }
}

async function _runReindex() {
    const btn = $('dup-reindex-btn');
    const status = $('dup-reindex-status');
    const progress = $('dup-reindex-progress');
    const bar = $('dup-reindex-progress-bar');
    if (btn) {
        btn.disabled = true;
        btn.textContent = i18nT('maintenance.reindex.running', 'Re-indexing…');
    }
    if (progress) progress.classList.remove('hidden');
    if (bar) bar.style.width = '0%';
    if (status) status.textContent = '';
    try {
        await api.post('/api/maintenance/reindex', {});
        // Result lands over WS — handler re-enables the button when done.
    } catch (e) {
        const msg = e?.data?.error || e.message || 'Failed';
        showToast(msg, 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = i18nT('maintenance.reindex.button', 'Re-index from disk');
        }
        if (progress) progress.classList.add('hidden');
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;

    ws.on('dedup_progress', (m) => {
        // Make sure the running UI is visible — handles the case where a
        // sibling client started the scan and we're seeing it second-hand.
        _setScanUi(true);
        const bar = $('dup-progress-bar');
        const stage = $('dup-progress-stage');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round((m.processed || 0) / total * 100));
        bar.style.width = pct + '%';
        if (stage) {
            stage.textContent = i18nTf('maintenance.dedup.progress',
                { stage: m.stage || '', processed: m.processed || 0, total: m.total || 0 },
                `${m.stage || ''} · ${m.processed || 0} / ${m.total || 0}`);
        }
    });

    ws.on('dedup_done', (m) => {
        _setScanUi(false);
        if (m?.error) {
            showToast(i18nTf('maintenance.dedup.scan_failed',
                { msg: m.error }, `Dedup scan failed: ${m.error}`), 'error');
            return;
        }
        const sets = Array.isArray(m?.duplicateSets) ? m.duplicateSets : [];
        _renderSets(sets);
        if (!sets.length) {
            showToast(i18nTf('maintenance.dedup.none',
                { scanned: m?.scanned ?? 0 },
                `No duplicates found — scanned ${m?.scanned ?? 0} files.`),
                'success');
        }
    });

    // dedup_delete_progress / _done — fired by the bulk-delete tracker.
    // Both gallery-selection bulk-delete and the duplicate-finder's
    // delete button share this single tracker, so closing the tab
    // mid-delete and reopening this page still picks up the running
    // state (re-disables the Delete button) until the work finishes.
    ws.on('dedup_delete_progress', () => {
        _setDeleteUi(true);
    });

    ws.on('dedup_delete_done', async (m) => {
        _setDeleteUi(false);
        if (m?.error) {
            showToast(i18nTf('maintenance.failed',
                { msg: m.error }, `Failed: ${m.error}`), 'error');
            return;
        }
        const removed = m?.removed ?? m?.deleted ?? 0;
        const freed = m?.freedBytes ?? 0;
        showToast(i18nTf('maintenance.dedup.deleted',
            { removed, freed: _formatBytes(freed) },
            `Removed ${removed} files — freed ${_formatBytes(freed)}`),
            'success');
        try { await _runScan(); } catch {}
    });

    ws.on('reindex_progress', (m) => {
        const bar = $('dup-reindex-progress-bar');
        const status = $('dup-reindex-status');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round((m.processed || 0) / total * 100));
        bar.style.width = pct + '%';
        if (status) {
            status.textContent = i18nTf('maintenance.reindex.progress',
                { processed: m.processed || 0, total: m.total || 0 },
                `${m.processed || 0} / ${m.total || 0} groups`);
        }
    });

    ws.on('reindex_done', (m) => {
        const btn = $('dup-reindex-btn');
        const progress = $('dup-reindex-progress');
        const status = $('dup-reindex-status');
        if (btn) {
            btn.disabled = false;
            btn.textContent = i18nT('maintenance.reindex.button', 'Re-index from disk');
        }
        if (progress) progress.classList.add('hidden');
        if (m?.error) {
            showToast(i18nTf('maintenance.reindex.failed',
                { msg: m.error }, `Re-index failed: ${m.error}`), 'error');
            if (status) status.textContent = '';
            return;
        }
        const added = m?.added ?? m?.indexed ?? 0;
        const scanned = m?.scanned ?? m?.total ?? 0;
        const msg = i18nTf('maintenance.reindex.done',
            { added, scanned },
            `Re-index done — added ${added} rows from ${scanned} files.`);
        showToast(msg, 'success');
        if (status) status.textContent = msg;
    });
}

// Bulk keep — apply the "keep oldest" / "keep newest" rule to every set
// at once. Walks `_sets` directly (the in-memory model), so the chunk-
// rendered tail rows that aren't yet in the DOM still get the right
// state when they finally land. Re-uses the per-set keep code path's
// sort so behaviour stays identical.
function _bulkKeep(keep) {
    if (!_sets.length) return;
    const list = $('dup-list');
    for (const set of _sets) {
        const sortedAsc = [...set.files].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const keepId = (keep === 'newest' ? sortedAsc[sortedAsc.length - 1] : sortedAsc[0])?.id;
        for (const f of set.files) {
            // Update the in-memory marker so `_renderSet` paints the right
            // checkbox/border state when this set is rendered later in the
            // chunk loop. (`_renderSet` reads `_keepDecision` if present.)
            f._delete = (f.id !== keepId);
            // If the set is already rendered, sync the DOM live.
            if (list) {
                const cb = list.querySelector(`.dup-del[data-id="${f.id}"]`);
                if (cb) cb.checked = (f.id !== keepId);
                const row = list.querySelector(`[data-file-row="${f.id}"]`);
                if (row) {
                    row.classList.toggle('border-l-red-400/60', f.id !== keepId);
                    row.classList.toggle('border-l-tg-green/60', f.id === keepId);
                }
            }
        }
    }
    _refreshSummary();
    showToast(i18nTf('maintenance.duplicates.bulk.applied',
        { n: _sets.length, mode: keep },
        `Applied "keep ${keep}" to ${_sets.length} set(s)`), 'success');
}

function _bulkClearSelection() {
    const list = $('dup-list');
    if (!list) return;
    for (const set of _sets) {
        for (const f of set.files) f._delete = false;
    }
    list.querySelectorAll('.dup-del').forEach((cb) => { cb.checked = false; });
    list.querySelectorAll('[data-file-row]').forEach((row) => {
        row.classList.remove('border-l-red-400/60');
        row.classList.add('border-l-tg-green/60');
    });
    _refreshSummary();
}

export function init() {
    _wireWs();

    if (!_pageWired) {
        _pageWired = true;
        $('dup-scan-btn')?.addEventListener('click', _runScan);
        $('dup-delete-btn')?.addEventListener('click', _deleteSelected);
        $('dup-reindex-btn')?.addEventListener('click', _runReindex);
        $('dup-bulk-oldest')?.addEventListener('click', () => _bulkKeep('oldest'));
        $('dup-bulk-newest')?.addEventListener('click', () => _bulkKeep('newest'));
        $('dup-bulk-clear')?.addEventListener('click', _bulkClearSelection);

        // Event delegation on the list root — attaches ONE listener
        // instead of N×M (per-row + per-set-keep), so a 1000-set library
        // adds zero extra DOM listeners and chunk-rendering doesn't
        // need to re-bind anything.
        const list = $('dup-list');
        if (list) {
            list.addEventListener('change', (e) => {
                const t = e.target;
                if (!t || !t.classList?.contains('dup-del')) return;
                const row = t.closest('[data-file-row]');
                if (row) {
                    row.classList.toggle('border-l-red-400/60', t.checked);
                    row.classList.toggle('border-l-tg-green/60', !t.checked);
                }
                _refreshSummary();
            });
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-keep]');
                if (!btn) return;
                const hash = btn.dataset.hash;
                const keep = btn.dataset.keep;
                const set = _sets.find((s) => s.hash === hash);
                if (!set) return;
                const sortedAsc = [...set.files].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
                const keepId = (keep === 'newest' ? sortedAsc[sortedAsc.length - 1] : sortedAsc[0])?.id;
                for (const f of set.files) {
                    f._delete = (f.id !== keepId);
                    const cb = list.querySelector(`.dup-del[data-id="${f.id}"]`);
                    if (cb) cb.checked = (f.id !== keepId);
                    const row = list.querySelector(`[data-file-row="${f.id}"]`);
                    if (row) {
                        row.classList.toggle('border-l-red-400/60', f.id !== keepId);
                        row.classList.toggle('border-l-tg-green/60', f.id === keepId);
                    }
                }
                _refreshSummary();
            });
        }
    }

    // Always re-hydrate state on (re-)entry — covers the close-tab,
    // start-on-mobile-pop-on-pc, and tab-revisit-mid-scan flows. State
    // lives on the server, the front-end is just a renderer.
    _recoverScanState();
}
