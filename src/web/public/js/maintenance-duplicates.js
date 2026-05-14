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
//   - Library status panel (total / hashed / awaiting hash / last scan)
//     so a fresh visit can see at a glance what Scan will do.
//   - Verify-files-on-disk button — surfaces the integrity sweep next to
//     dedup so users don't have to hunt for it on the Settings page.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { fileTokenQuery } from './media-url.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;
let _sets = []; // last scan result
let _stopRequested = false; // true while waiting for scan to wind down after Stop

function _formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Compact "2 hours ago" / "3 days ago" / "just now". Avoids importing a
// date-fns-class dep — the page only needs one relative time string and
// the buckets here are sufficient at the granularity users care about
// for "when did the last scan run".
function _formatRelative(unixMs) {
    const t = Number(unixMs) || 0;
    if (!t) return '';
    const diff = Math.max(0, Date.now() - t);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return i18nT('maintenance.duplicates.stats.just_now', 'just now');
    const min = Math.floor(sec / 60);
    if (min < 60)
        return i18nTf('maintenance.duplicates.stats.minutes_ago', { n: min }, `${min} min ago`);
    const hr = Math.floor(min / 60);
    if (hr < 24) return i18nTf('maintenance.duplicates.stats.hours_ago', { n: hr }, `${hr} h ago`);
    const days = Math.floor(hr / 24);
    return i18nTf('maintenance.duplicates.stats.days_ago', { n: days }, `${days} d ago`);
}

// Library status panel — top-of-page card with hash coverage + last scan
// summary. Hits /api/maintenance/dedup/stats which is cheap (three
// COUNT(*) and one kv read), so we refresh it after every scan / delete
// / reindex / verify so the numbers stay honest.
async function _refreshStats() {
    try {
        const s = await api.get('/api/maintenance/dedup/stats');
        if (!s || typeof s !== 'object') return;
        const totalEl = $('dup-stat-total');
        const hashedEl = $('dup-stat-hashed');
        const missingEl = $('dup-stat-missing');
        const lastEl = $('dup-stat-last');
        const summaryEl = $('dup-stat-summary');
        if (totalEl) totalEl.textContent = (s.totalFiles || 0).toLocaleString();
        if (hashedEl) hashedEl.textContent = (s.hashed || 0).toLocaleString();
        if (missingEl) {
            missingEl.textContent = (s.missing || 0).toLocaleString();
            // Green when there's nothing left to hash, orange while
            // there's still bytes-to-hash on the next scan. The colour
            // alone is the at-a-glance "next scan will be expensive"
            // hint without the user having to read the number.
            missingEl.classList.toggle('text-tg-orange', (s.missing || 0) > 0);
            missingEl.classList.toggle(
                'text-tg-green',
                (s.missing || 0) === 0 && (s.hashed || 0) > 0,
            );
        }
        const last = s.lastScan;
        if (lastEl) {
            if (last && last.finishedAt) {
                lastEl.textContent = _formatRelative(last.finishedAt);
                lastEl.title = new Date(last.finishedAt).toLocaleString();
            } else {
                lastEl.textContent = i18nT('maintenance.duplicates.stats.last_scan_never', 'Never');
                lastEl.title = '';
            }
        }
        if (summaryEl) {
            if (last && last.finishedAt) {
                summaryEl.textContent = i18nTf(
                    'maintenance.duplicates.stats.last_scan_result',
                    {
                        sets: (last.duplicateSets || 0).toLocaleString(),
                        extras: (last.extraCopies || 0).toLocaleString(),
                        reclaim: _formatBytes(last.reclaimableBytes || 0),
                        scanned: (last.scanned || 0).toLocaleString(),
                    },
                    `Last scan found ${last.duplicateSets || 0} set(s) · ${last.extraCopies || 0} extra copies · ${_formatBytes(last.reclaimableBytes || 0)} reclaimable (scanned ${last.scanned || 0} files)`,
                );
                summaryEl.classList.remove('hidden');
            } else {
                summaryEl.classList.add('hidden');
            }
        }
    } catch {
        /* non-fatal — stats are informational */
    }
}

// Coerce createdAt (an ISO-like string from the SQLite DATETIME column
// or a unix-epoch number when a caller already normalised it) to a
// sortable numeric. The sort comparators below would otherwise compute
// `'2026-05-07 15:30:05' - '2026-05-08 16:00:00'` → NaN; the spec then
// leaves the order engine-defined, so "Keep oldest / newest" was riding
// on V8's stable-sort happening to preserve the SQL `ORDER BY` order —
// fragile, and nothing on the server side guarantees that order.
function _createdAtMs(file) {
    const v = file?.createdAt;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : 0;
    }
    return 0;
}

function _renderRow(file, set) {
    const thumbUrl = `/api/thumbs/${encodeURIComponent(file.id)}?w=320`;
    const _ftq = fileTokenQuery();
    const fileUrl = `/files/${encodeURIComponent(file.filePath || '')}?inline=1${_ftq ? '&' + _ftq : ''}`;
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
    const reclaim = Math.max(0, set.count - 1) * (Number(set.fileSize) || 0);
    const previewThumb =
        set.files?.[0]?.id != null
            ? `<img loading="lazy" decoding="async"
                 class="w-14 h-14 object-cover rounded-lg bg-tg-bg/40 shrink-0 ring-1 ring-tg-border/40"
                 src="/api/thumbs/${encodeURIComponent(set.files[0].id)}?w=320" alt="" onerror="this.style.display='none'">`
            : '<div class="w-14 h-14 rounded-lg bg-tg-bg/40 shrink-0 ring-1 ring-tg-border/40 flex items-center justify-center text-tg-textSecondary"><i class="ri-file-copy-2-line text-lg"></i></div>';
    const shortHash = String(set.hash || '').slice(0, 12);
    return `
        <div class="bg-tg-panel rounded-xl p-3 mb-2 border border-tg-border/30 hover:border-tg-blue/40 hover:shadow-lg hover:shadow-tg-blue/5 transition-all" data-set="${escapeHtml(set.hash)}" data-set-idx="${idx}">
            <div class="flex items-center gap-3 mb-2">
                ${previewThumb}
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap mb-0.5">
                        <span class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-tg-blue/15 text-tg-blue font-medium">
                            <i class="ri-stack-line"></i>${set.count}
                        </span>
                        <span class="text-sm text-tg-text font-medium tabular-nums">${escapeHtml(_formatBytes(set.fileSize))}</span>
                        <span class="text-[10px] text-tg-textSecondary/60 font-mono">${escapeHtml(shortHash)}…</span>
                    </div>
                    <div class="text-[11px] text-tg-green tabular-nums inline-flex items-center gap-1">
                        <i class="ri-coins-line"></i>
                        ${escapeHtml(
                            i18nTf(
                                'maintenance.dedup.set_reclaim',
                                { size: _formatBytes(reclaim) },
                                `Up to ${_formatBytes(reclaim)} reclaimable`,
                            ),
                        )}
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
            <div class="space-y-1 pl-1">${set.files.map((f) => _renderRow(f, set)).join('')}</div>
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
        sum.textContent = i18nTf(
            'maintenance.dedup.selected',
            { count: ids.length, freed: _formatBytes(bytes) },
            `${ids.length} selected · ${_formatBytes(bytes)} will be freed`,
        );
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

const _idleSchedule = (fn) =>
    typeof requestIdleCallback === 'function'
        ? requestIdleCallback(fn, { timeout: 200 })
        : setTimeout(fn, 32);

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
    const totalReclaim = _sets.reduce((s, x) => s + x.fileSize * (x.count - 1), 0);
    const totalFiles = _sets.reduce((s, x) => s + (x.count || 0), 0);
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
    list.innerHTML =
        initial.map((s, i) => _renderSet(s, i)).join('') +
        (_sets.length > FIRST_PAINT_SETS
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
        const sortedAsc = [...set.files].sort((a, b) => _createdAtMs(a) - _createdAtMs(b));
        const keepId = sortedAsc[0]?.id;
        for (const f of set.files) {
            // Default: keep the oldest, mark the rest for delete. Recorded
            // on the in-memory model so chunk-rendered tail rows + bulk
            // operations all reference the same source of truth.
            if (f._delete == null) f._delete = f.id !== keepId;
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

// _setScanUi(running, opts)
//   running — true while scan is in flight, false otherwise.
//   opts.resume — when true and not running, labels the Scan button as
//     "Resume scan" so the operator sees that prior partial hashing won't
//     be repeated.
//   opts.stopRequested — transient state while waiting for the stop to
//     propagate (button shows "Stopping…" and is disabled).
function _setScanUi(running, opts = {}) {
    const btn = $('dup-scan-btn');
    const stopBtn = $('dup-stop-btn');
    const progress = $('dup-progress');
    const bar = $('dup-progress-bar');
    const pct = $('dup-progress-pct');
    if (btn) {
        // Preserve the icon — only swap the label span. textContent on
        // the whole button blew away the <i class="ri-search-line">.
        btn.disabled = !!running || !!opts.stopRequested;
        btn.classList.toggle('hidden', !!running);
        const labelSpan = btn.querySelector('span[data-i18n]');
        if (labelSpan) {
            if (!running && opts.resume) {
                labelSpan.textContent = i18nT('maintenance.duplicates.resume_scan', 'Resume scan');
            } else {
                labelSpan.textContent = i18nT('maintenance.duplicates.scan', 'Scan');
            }
        }
    }
    if (stopBtn) {
        stopBtn.classList.toggle('hidden', !running);
        stopBtn.disabled = !!opts.stopRequested;
        const stopLabel = stopBtn.querySelector('span[data-i18n]');
        if (stopLabel) {
            stopLabel.textContent = opts.stopRequested
                ? i18nT('maintenance.duplicates.stopping', 'Stopping…')
                : i18nT('maintenance.duplicates.stop_scan', 'Stop');
        }
    }
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running) {
        if (bar) bar.style.width = '0%';
        if (pct) pct.textContent = '';
    }
}

// `POST /api/maintenance/dedup/scan` is fire-and-forget — returns 200
// with `{started:true}` immediately so Cloudflare's 100 s tunnel timeout
// can never bite, and a 50 GB library hashing for minutes doesn't hold
// the request open. Result lands via `dedup_done` WS event; status
// recovery on re-mount via GET /dedup/status.
// When a previous scan was stopped partway through the server will
// naturally skip already-hashed rows, so "Resume" = "Scan again".
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
            showToast(
                i18nT(
                    'maintenance.dedup.already_running',
                    'A dedup scan is already running on another client.',
                ),
                'info',
            );
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setScanUi(false);
    }
}

// Stop the running dedup scan. The server signals the abort controller;
// the scan finishes the current file then breaks cleanly. The `dedup_done`
// WS event fires shortly after with whatever partial result was accumulated.
async function _stopScan() {
    // Show "Stopping…" immediately so the operator gets feedback while
    // waiting for the current file hash to finish (could be a few seconds
    // on a very large file).
    _stopRequested = true;
    _setScanUi(true, { stopRequested: true });
    try {
        await api.post('/api/maintenance/dedup/scan/stop', {});
        // Don't change UI here — wait for `dedup_done` which fires when
        // the scan actually stops. If the scan wasn't running, dedup_done
        // won't fire but the next _refreshStats will update the panel.
    } catch (e) {
        _stopRequested = false;
        showToast(e?.data?.error || e.message || 'Failed to stop', 'error');
        // Revert to plain running state — scan may still be going.
        _setScanUi(true);
    }
}

// Recover live state on (re-)entry — the scan keeps running on the
// server even after a tab close, so we re-paint the running UI + the
// last completed result if any. Also hydrates the bulk-delete + reindex
// + verify trackers so a job started on one client disables the buttons
// on this tab until it finishes.
async function _recoverScanState() {
    try {
        const r = await api.get('/api/maintenance/dedup/status');
        if (r?.running) {
            _setScanUi(true);
        } else if (r?.result?.duplicateSets) {
            // Last run finished with results — show them and check if it
            // was a partial run so the Resume label appears.
            const wasAborted = !!r.result.aborted;
            _setScanUi(false, { resume: wasAborted });
            _renderSets(r.result.duplicateSets);
        }
    } catch {
        /* non-fatal */
    }
    // If the scan was stopped and the server restarted (result cleared),
    // check for persisted partial-progress from the stats endpoint.
    try {
        const stats = await api.get('/api/maintenance/dedup/stats');
        if (stats?.partialProgress?.partial) {
            // Only show resume label if not already in running/result state.
            const scanBtn = $('dup-scan-btn');
            if (scanBtn && !scanBtn.classList.contains('hidden')) {
                _setScanUi(false, { resume: true });
            }
        }
    } catch {
        /* non-fatal */
    }
    try {
        const r = await api.get('/api/maintenance/dedup/delete/status');
        if (r?.running) _setDeleteUi(true);
    } catch {}
    try {
        const r = await api.get('/api/maintenance/reindex/status');
        if (r?.running) {
            const btn = $('dup-reindex-btn');
            const progress = $('dup-reindex-progress');
            const labelSpan = btn?.querySelector('span[data-i18n]');
            if (btn) btn.disabled = true;
            if (labelSpan) {
                labelSpan.textContent = i18nT('maintenance.reindex.running', 'Re-indexing…');
            }
            if (progress) progress.classList.remove('hidden');
        }
    } catch {}
    try {
        const r = await api.get('/api/maintenance/files/verify/status');
        if (r?.running) _setVerifyUi(true);
    } catch {}
    _refreshStats();
}

// Verify-files-on-disk — same fire-and-forget contract as the dedup
// scan. The endpoint walks every catalogue row and drops the ones whose
// file has gone missing on disk (manual deletes, rotated downloads,
// bind-mount remount). Surfaces here on the duplicates page because
// users intuit "checksum integrity" lives next to dedup, even though
// the back-end has shipped this on the Settings page for a while.
function _setVerifyUi(running) {
    const btn = $('dup-verify-btn');
    const progress = $('dup-verify-progress');
    const bar = $('dup-verify-progress-bar');
    if (btn) {
        btn.disabled = !!running;
        const labelSpan = btn.querySelector('span[data-i18n]');
        if (labelSpan) {
            labelSpan.textContent = running
                ? i18nT('maintenance.duplicates.verify.running_short', 'Verifying…')
                : i18nT('maintenance.duplicates.verify.button', 'Verify files');
        }
    }
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running && bar) bar.style.width = '0%';
}

async function _runVerify() {
    _setVerifyUi(true);
    try {
        const r = await api.post('/api/maintenance/files/verify', {});
        if (r?.error && !r?.started) throw new Error(r.error);
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            _setVerifyUi(true);
            showToast(
                i18nT(
                    'jobs.already_running',
                    'Already running on another tab — waiting for it to finish.',
                ),
                'info',
            );
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setVerifyUi(false);
    }
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
        message: i18nTf(
            'maintenance.dedup.confirm_body',
            { n: ids.length },
            `Permanently delete ${ids.length} file(s) from disk and database?`,
        ),
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
            showToast(
                i18nT(
                    'jobs.already_running',
                    'Already running on another tab — waiting for it to finish.',
                ),
                'info',
            );
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
    const labelSpan = btn?.querySelector('span[data-i18n]');
    if (btn) btn.disabled = true;
    if (labelSpan) {
        labelSpan.textContent = i18nT('maintenance.reindex.running', 'Re-indexing…');
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
        if (btn) btn.disabled = false;
        if (labelSpan) {
            labelSpan.textContent = i18nT('maintenance.reindex.button', 'Re-index from disk');
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
        _setScanUi(true, { stopRequested: _stopRequested });
        const bar = $('dup-progress-bar');
        const stage = $('dup-progress-stage');
        const pctEl = $('dup-progress-pct');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round(((m.processed || 0) / total) * 100));
        bar.style.width = pct + '%';
        // Stage-specific labels — generic "hashing · 12 / 5000" was too
        // terse to convey what's happening on a multi-minute scan. Each
        // backend stage gets its own friendly i18n string.
        if (stage) {
            const stageKey = String(m.stage || '').toLowerCase();
            if (stageKey === 'hashing') {
                stage.textContent = i18nTf(
                    'maintenance.duplicates.progress.hashing',
                    { processed: m.processed || 0, total: m.total || 0 },
                    `Hashing files… ${m.processed || 0} / ${m.total || 0}`,
                );
            } else if (stageKey === 'grouping') {
                stage.textContent = i18nT(
                    'maintenance.duplicates.progress.grouping',
                    'Grouping by hash…',
                );
            } else if (stageKey === 'starting' || !stageKey) {
                stage.textContent = i18nT('maintenance.duplicates.progress.starting', 'Starting…');
            } else {
                stage.textContent = i18nTf(
                    'maintenance.dedup.progress',
                    { stage: m.stage || '', processed: m.processed || 0, total: m.total || 0 },
                    `${m.stage || ''} · ${m.processed || 0} / ${m.total || 0}`,
                );
            }
        }
        if (pctEl) {
            pctEl.textContent =
                m.total > 0
                    ? `${pct}% · ${(m.processed || 0).toLocaleString()} / ${(m.total || 0).toLocaleString()}`
                    : '';
        }
    });

    ws.on('dedup_done', (m) => {
        _stopRequested = false;
        if (m?.error) {
            _setScanUi(false);
            showToast(
                i18nTf(
                    'maintenance.dedup.scan_failed',
                    { msg: m.error },
                    `Dedup scan failed: ${m.error}`,
                ),
                'error',
            );
            return;
        }
        // `aborted:true` means the scan was stopped mid-run. Already-hashed
        // files are persisted in the DB — the next scan skips them — so "Scan"
        // and "Resume" are identical in behaviour. We just label the button
        // "Resume scan" to make that clear to the operator.
        const wasAborted = !!m?.aborted;
        _setScanUi(false, { resume: wasAborted });
        const sets = Array.isArray(m?.duplicateSets) ? m.duplicateSets : [];
        if (sets.length) {
            // Partial scans may surface duplicate sets from files hashed in
            // prior runs — render them so results aren't lost.
            _renderSets(sets);
        }
        if (wasAborted) {
            showToast(
                i18nTf(
                    'maintenance.duplicates.scan_stopped',
                    { hashed: m?.hashed ?? 0 },
                    `Scan stopped — ${m?.hashed ?? 0} file(s) hashed. Click Resume scan to continue.`,
                ),
                'info',
            );
        } else if (!sets.length) {
            showToast(
                i18nTf(
                    'maintenance.dedup.none',
                    { scanned: m?.scanned ?? 0 },
                    `No duplicates found — scanned ${m?.scanned ?? 0} files.`,
                ),
                'success',
            );
        }
        // Persisted summary just got a new entry — re-pull stats so the
        // panel shows "just now" + the new sets / reclaim numbers.
        _refreshStats();
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
            showToast(
                i18nTf('maintenance.failed', { msg: m.error }, `Failed: ${m.error}`),
                'error',
            );
            return;
        }
        const removed = m?.removed ?? m?.deleted ?? 0;
        const freed = m?.freedBytes ?? 0;
        showToast(
            i18nTf(
                'maintenance.dedup.deleted',
                { removed, freed: _formatBytes(freed) },
                `Removed ${removed} files — freed ${_formatBytes(freed)}`,
            ),
            'success',
        );
        _refreshStats();
        try {
            await _runScan();
        } catch {}
    });

    // Verify-files-on-disk — same JobTracker contract as nsfw / thumbs.
    // Progress events stream the bar; the done event re-enables the
    // button and refreshes stats so a "Total files" delta is immediately
    // visible.
    ws.on('files_verify_progress', (m) => {
        _setVerifyUi(true);
        const bar = $('dup-verify-progress-bar');
        const status = $('dup-verify-status');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round(((m.processed || 0) / total) * 100));
        bar.style.width = pct + '%';
        if (status) {
            status.textContent = i18nTf(
                'maintenance.duplicates.verify.progress',
                { processed: m.processed || 0, total: m.total || 0 },
                `${m.processed || 0} / ${m.total || 0}`,
            );
        }
    });

    ws.on('files_verify_done', (m) => {
        _setVerifyUi(false);
        if (m?.error) {
            showToast(
                i18nTf(
                    'maintenance.duplicates.verify.failed',
                    { msg: m.error },
                    `Verify failed: ${m.error}`,
                ),
                'error',
            );
            return;
        }
        const removed = m?.removed ?? m?.dropped ?? 0;
        showToast(
            i18nTf(
                'maintenance.duplicates.verify.done',
                { removed },
                `Verified — removed ${removed} stale row(s).`,
            ),
            'success',
        );
        _refreshStats();
    });

    ws.on('reindex_progress', (m) => {
        const bar = $('dup-reindex-progress-bar');
        const status = $('dup-reindex-status');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round(((m.processed || 0) / total) * 100));
        bar.style.width = pct + '%';
        if (status) {
            status.textContent = i18nTf(
                'maintenance.reindex.progress',
                { processed: m.processed || 0, total: m.total || 0 },
                `${m.processed || 0} / ${m.total || 0} groups`,
            );
        }
    });

    ws.on('reindex_done', (m) => {
        const btn = $('dup-reindex-btn');
        const progress = $('dup-reindex-progress');
        const status = $('dup-reindex-status');
        if (btn) {
            btn.disabled = false;
            const labelSpan = btn.querySelector('span[data-i18n]');
            if (labelSpan) {
                labelSpan.textContent = i18nT('maintenance.reindex.button', 'Re-index from disk');
            }
        }
        if (progress) progress.classList.add('hidden');
        if (m?.error) {
            showToast(
                i18nTf(
                    'maintenance.reindex.failed',
                    { msg: m.error },
                    `Re-index failed: ${m.error}`,
                ),
                'error',
            );
            if (status) status.textContent = '';
            return;
        }
        const added = m?.added ?? m?.indexed ?? 0;
        const scanned = m?.scanned ?? m?.total ?? 0;
        const msg = i18nTf(
            'maintenance.reindex.done',
            { added, scanned },
            `Re-index done — added ${added} rows from ${scanned} files.`,
        );
        showToast(msg, 'success');
        if (status) status.textContent = msg;
        // Re-index can add hundreds of new rows that lack hashes — make
        // the panel reflect that immediately so the operator sees the
        // "Awaiting hash" number jump and knows the next Scan will work.
        _refreshStats();
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
        const sortedAsc = [...set.files].sort((a, b) => _createdAtMs(a) - _createdAtMs(b));
        const keepId = (keep === 'newest' ? sortedAsc[sortedAsc.length - 1] : sortedAsc[0])?.id;
        for (const f of set.files) {
            // Update the in-memory marker so `_renderSet` paints the right
            // checkbox/border state when this set is rendered later in the
            // chunk loop. (`_renderSet` reads `_keepDecision` if present.)
            f._delete = f.id !== keepId;
            // If the set is already rendered, sync the DOM live.
            if (list) {
                const cb = list.querySelector(`.dup-del[data-id="${f.id}"]`);
                if (cb) cb.checked = f.id !== keepId;
                const row = list.querySelector(`[data-file-row="${f.id}"]`);
                if (row) {
                    row.classList.toggle('border-l-red-400/60', f.id !== keepId);
                    row.classList.toggle('border-l-tg-green/60', f.id === keepId);
                }
            }
        }
    }
    _refreshSummary();
    showToast(
        i18nTf(
            'maintenance.duplicates.bulk.applied',
            { n: _sets.length, mode: keep },
            `Applied "keep ${keep}" to ${_sets.length} set(s)`,
        ),
        'success',
    );
}

function _bulkClearSelection() {
    const list = $('dup-list');
    if (!list) return;
    for (const set of _sets) {
        for (const f of set.files) f._delete = false;
    }
    list.querySelectorAll('.dup-del').forEach((cb) => {
        cb.checked = false;
    });
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
        $('dup-stop-btn')?.addEventListener('click', _stopScan);
        $('dup-delete-btn')?.addEventListener('click', _deleteSelected);
        $('dup-reindex-btn')?.addEventListener('click', _runReindex);
        $('dup-verify-btn')?.addEventListener('click', _runVerify);
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
                const sortedAsc = [...set.files].sort((a, b) => _createdAtMs(a) - _createdAtMs(b));
                const keepId = (keep === 'newest' ? sortedAsc[sortedAsc.length - 1] : sortedAsc[0])
                    ?.id;
                for (const f of set.files) {
                    f._delete = f.id !== keepId;
                    const cb = list.querySelector(`.dup-del[data-id="${f.id}"]`);
                    if (cb) cb.checked = f.id !== keepId;
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
