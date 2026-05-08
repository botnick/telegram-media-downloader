// Maintenance — NSFW review tool (admin page).
//
// Five-tier classifier review (def_not / maybe_not / uncertain / maybe / def).
// Owns:
//   - Top stats cards: scanned / whitelisted / last scan time.
//   - Tier panel — clickable cards filter the row list below.
//   - "Show whitelisted" toggle — surfaces previously-whitelisted rows so
//     mistakes can be restored via the per-row Restore action.
//   - Score histogram (vanilla SVG, tiers shaded with their accent colour).
//   - Scan controls — start/cancel, threshold display, concurrency display,
//     live progress bar.
//   - Paginated row list — per-row whitelist (or restore) / reclassify / delete.
//   - Bulk actions — delete / whitelist (or restore) / reclassify the
//     entire current tier with live progress and stuck-state recovery.
//
// View state (tier + page + whitelisted toggle) lives in the URL hash so
// refresh / back-button restore the operator's filter context.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { loadAdvanced, setupAutoSave } from './settings.js';
import { openMediaViewerForReview } from './viewer.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;

// Tier colour palette mirrors the spec: red / orange / gray / blue / green.
const TIER_COLOR = {
    def_not: '#E53935',
    maybe_not: '#FB8C00',
    uncertain: '#9E9E9E',
    maybe: '#1E88E5',
    def: '#43A047',
};

// Local view state — persists for the lifetime of the SPA. Hydrated
// from the URL hash on init so refresh / back-button restore the
// operator's filter context.
const view = {
    tier: null, // null = all tiers
    page: 1,
    limit: 50,
    totalPages: 1,
    includeWhitelisted: false, // toggle to surface previously-whitelisted rows
    tiersMeta: null, // [{ id, min, max, label }]
    tierCounts: null, // { tiers: {def_not: n, ...}, scanned, totalEligible, whitelisted, threshold }
};

// Hash state lives at #/maintenance/nsfw?tier=...&page=...&whitelisted=0|1
// so refresh / browser-history navigation restore the filter context.
// Default tier on a clean URL is `uncertain` (the actual review queue) so
// new arrivals don't have to wade through 95% of def_not items first.
const DEFAULT_TIER = 'uncertain';

function _readHashState() {
    const raw = window.location.hash || '';
    const qIdx = raw.indexOf('?');
    if (qIdx < 0) return {};
    const qs = new URLSearchParams(raw.slice(qIdx + 1));
    const out = {};
    if (qs.has('tier')) out.tier = qs.get('tier') || null;
    if (qs.has('page')) {
        const p = Number(qs.get('page'));
        if (Number.isFinite(p) && p >= 1) out.page = Math.floor(p);
    }
    if (qs.has('whitelisted')) out.includeWhitelisted = qs.get('whitelisted') === '1';
    return out;
}

function _writeHashState() {
    const raw = window.location.hash || '';
    const qIdx = raw.indexOf('?');
    const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const qs = new URLSearchParams();
    if (view.tier) qs.set('tier', view.tier);
    if (view.page > 1) qs.set('page', String(view.page));
    if (view.includeWhitelisted) qs.set('whitelisted', '1');
    const nextHash = qs.toString() ? `${path || '#'}?${qs.toString()}` : path;
    if (nextHash !== raw) {
        // replaceState — we don't want every tier click to grow history.
        history.replaceState(null, '', nextHash || window.location.pathname);
    }
}

function _formatRelTime(epochMs) {
    if (!epochMs) return '—';
    const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (diffSec < 60) return i18nT('share.just_now', 'just now');
    if (diffSec < 3600)
        return i18nTf(
            'share.mins_ago',
            { n: Math.floor(diffSec / 60) },
            `${Math.floor(diffSec / 60)}m ago`,
        );
    if (diffSec < 86400)
        return i18nTf(
            'share.hours_ago',
            { n: Math.floor(diffSec / 3600) },
            `${Math.floor(diffSec / 3600)}h ago`,
        );
    return i18nTf(
        'share.days_ago',
        { n: Math.floor(diffSec / 86400) },
        `${Math.floor(diffSec / 86400)}d ago`,
    );
}

async function _loadTiersMeta() {
    if (view.tiersMeta) return view.tiersMeta;
    try {
        const r = await api.get('/api/maintenance/nsfw/v2/tiers-meta');
        view.tiersMeta = r.tiers || [];
    } catch {
        view.tiersMeta = [];
    }
    return view.tiersMeta;
}

function _tierLabel(tierId) {
    const meta = (view.tiersMeta || []).find((t) => t.id === tierId);
    if (!meta) return tierId;
    const i18nKey = `maintenance.nsfw.tier.${tierId}`;
    return i18nT(i18nKey, meta.label || tierId);
}

function _renderTiersPanel(tierCounts) {
    const panel = $('nsfw-tiers');
    if (!panel) return;
    const counts = tierCounts.tiers || {};
    panel.innerHTML = (view.tiersMeta || [])
        .map((t) => {
            const n = counts[t.id] || 0;
            const active = view.tier === t.id ? 'ring-2 ring-tg-blue/60' : '';
            const color = TIER_COLOR[t.id] || '#9E9E9E';
            return `
            <button type="button" class="nsfw-tier-card text-left bg-tg-bg/40 hover:bg-tg-hover rounded-lg p-3 ${active}" data-tier="${t.id}">
                <div class="flex items-center gap-2 mb-1">
                    <span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${color}"></span>
                    <span class="text-xs uppercase tracking-wide text-tg-textSecondary">${escapeHtml(_tierLabel(t.id))}</span>
                </div>
                <div class="text-2xl font-semibold text-tg-text tabular-nums">${n}</div>
                <div class="text-[11px] text-tg-textSecondary mt-0.5">${(t.min * 100).toFixed(0)}% – ${(t.max * 100).toFixed(0)}%</div>
            </button>`;
        })
        .join('');
    panel.querySelectorAll('[data-tier]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.tier;
            view.tier = view.tier === next ? null : next;
            view.page = 1;
            _writeHashState();
            _renderTiersPanel(view.tierCounts || tierCounts);
            _renderBulkBar();
            _loadList();
        });
    });
}

function _renderBulkBar() {
    const bar = $('nsfw-bulk-bar');
    if (!bar) return;
    if (!view.tier) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    const tierLabel = _tierLabel(view.tier);
    const labelEl = $('nsfw-bulk-label');
    if (labelEl) {
        labelEl.textContent = i18nTf(
            'maintenance.nsfw.bulk.title',
            { tier: tierLabel },
            `Bulk actions for "${tierLabel}":`,
        );
    }
    const setLabel = (id, key, fallback) => {
        const el = $(id);
        if (el) {
            el.textContent = i18nTf(
                key,
                { tier: tierLabel },
                fallback.replace('{tier}', tierLabel),
            );
        }
    };
    setLabel(
        'nsfw-bulk-delete-btn',
        'maintenance.nsfw.bulk.delete_in_tier',
        'Delete all in {tier}',
    );
    // The whitelist button doubles as a Restore button when the show-
    // whitelisted toggle is on — same visual slot, opposite semantic.
    if (view.includeWhitelisted) {
        setLabel(
            'nsfw-bulk-whitelist-btn',
            'maintenance.nsfw.bulk.restore_in_tier',
            'Restore all in {tier} to review',
        );
    } else {
        setLabel(
            'nsfw-bulk-whitelist-btn',
            'maintenance.nsfw.bulk.whitelist_in_tier',
            'Whitelist all in {tier}',
        );
    }
    setLabel(
        'nsfw-bulk-reclassify-btn',
        'maintenance.nsfw.bulk.reclassify_in_tier',
        'Re-classify all in {tier}',
    );
    // Clear stale progress text when the bar re-renders (e.g. after a
    // tier change). Live progress is wired in _wireWs.
    const progEl = $('nsfw-bulk-progress');
    if (progEl) progEl.textContent = '';
}

function _renderHistogram(hist) {
    const svgEl = $('nsfw-histogram');
    if (!svgEl) return;
    const counts = hist.counts || [];
    const bins = hist.bins || counts.length;
    if (!bins) {
        svgEl.innerHTML = '';
        return;
    }
    const maxN = Math.max(1, ...counts);
    const W = 600;
    const H = 140;
    const PLOT_TOP = 8; // breathing room above the tallest bar
    const PLOT_BOT = 28; // baseline + axis labels
    const PLOT_H = H - PLOT_TOP - PLOT_BOT;
    const barW = W / bins;
    const tiers = view.tiersMeta || [];
    const tierFor = (mid) => {
        for (const t of tiers) {
            if (mid >= t.min && mid < t.max) return t.id;
        }
        return null;
    };
    // Tier-band shading: paint each tier's score range as a light wash
    // behind the bars so the operator sees which bin lives in which
    // bucket without consulting the legend.
    const bands = tiers
        .map((t) => {
            const x = t.min * W;
            const w = (Math.min(1, t.max) - t.min) * W;
            const color = TIER_COLOR[t.id] || '#9E9E9E';
            return `<rect x="${x.toFixed(1)}" y="${PLOT_TOP}" width="${w.toFixed(1)}" height="${PLOT_H}" fill="${color}" opacity="0.08"/>`;
        })
        .join('');
    const bars = counts
        .map((n, i) => {
            const mid = (i + 0.5) / bins;
            const tid = tierFor(mid);
            const color = TIER_COLOR[tid] || '#9E9E9E';
            const h = (n / maxN) * (PLOT_H - 2);
            const x = i * barW + 0.5;
            const y = PLOT_TOP + PLOT_H - h;
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.9"><title>${(mid * 100).toFixed(0)}%: ${n}</title></rect>`;
        })
        .join('');
    // Threshold marker (vertical line at the configured cutoff). Score
    // is in [0,1] so x = threshold * W.
    const threshold = Number(view.tierCounts?.threshold) || 0;
    const tx = (threshold * W).toFixed(1);
    const thresholdLine =
        threshold > 0 && threshold < 1
            ? `<line x1="${tx}" y1="${PLOT_TOP - 4}" x2="${tx}" y2="${PLOT_TOP + PLOT_H}" stroke="#fff" stroke-opacity="0.65" stroke-width="1" stroke-dasharray="3 3"/>
           <text x="${tx}" y="${PLOT_TOP - 6}" font-size="9" fill="currentColor" fill-opacity="0.75" text-anchor="middle">τ=${threshold.toFixed(2)}</text>`
            : '';
    // X-axis ticks at 0/25/50/75/100% and a baseline rule.
    const baselineY = PLOT_TOP + PLOT_H + 0.5;
    const ticks = [0, 25, 50, 75, 100]
        .map((p) => {
            const x = (p / 100) * W;
            return `<text x="${x}" y="${H - 6}" font-size="10" fill="currentColor" fill-opacity="0.6" text-anchor="${p === 0 ? 'start' : p === 100 ? 'end' : 'middle'}">${p}%</text>`;
        })
        .join('');
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.innerHTML = `${bands}${bars}${thresholdLine}
        <line x1="0" y1="${baselineY}" x2="${W}" y2="${baselineY}" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"/>
        ${ticks}`;
}

// Pick a tier for a score so the tile badge / bottom-border lands in
// the right colour bucket. Identical bucketing logic to the SQL CASE in
// db.js — the boundaries live in `view.tiersMeta`.
function _tierForScore(score) {
    const tiers = view.tiersMeta || [];
    for (const t of tiers) {
        if (score >= t.min && score < t.max) return t.id;
    }
    return null;
}

function _renderTile(file, index) {
    const scorePct = Math.round((file.nsfw_score || 0) * 100);
    const tid = _tierForScore(file.nsfw_score || 0);
    const tierColor = TIER_COLOR[tid] || '#9E9E9E';
    const thumb = `/api/thumbs/${encodeURIComponent(file.id)}?w=400`;
    const isWl = !!file.nsfw_whitelist;
    const wlPin = isWl
        ? `<span class="absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-tg-blue/85 text-white font-medium">WL</span>`
        : '';
    return `
        <button type="button" data-tile-index="${index}" data-id="${file.id}"
                class="nsfw-tile group relative aspect-square rounded-md overflow-hidden bg-tg-bg/40 focus:outline-none focus:ring-2 focus:ring-tg-blue">
            <img loading="lazy" decoding="async"
                 class="absolute inset-0 w-full h-full object-cover"
                 src="${escapeHtml(thumb)}" alt=""
                 onerror="this.style.display='none'">
            <span class="hidden sm:block absolute top-1 right-1 px-1.5 py-0.5 text-[10px] font-mono rounded text-white tabular-nums"
                  style="background:${tierColor}cc">${scorePct}%</span>
            <span class="block sm:hidden absolute inset-x-0 bottom-0 h-1" style="background:${tierColor}"></span>
            ${wlPin}
            <span class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition flex items-end p-2 pointer-events-none">
                <span class="text-[11px] text-white truncate w-full text-left">${escapeHtml(file.file_name || '')}</span>
            </span>
        </button>`;
}

// The current page's row data — kept module-local so the lightbox can
// render the same rows the grid is showing without re-querying. Updated
// every _loadList() call.
let _currentRows = [];

// Map an NSFW DB row into the file shape the viewer expects.
//   `fullPath` becomes the URL the modal loads (`/files/<encoded>?inline=1`)
//   `type` swaps to the gallery's plural (photo→images, video→videos)
function _rowToViewerFile(row) {
    const type =
        row.file_type === 'photo' ? 'images' : row.file_type === 'video' ? 'videos' : 'images';
    const sizeMb = row.file_size ? (row.file_size / (1024 * 1024)).toFixed(1) : '0';
    return {
        fullPath: row.file_path || '',
        type,
        name: row.file_name || '',
        sizeFormatted: `${sizeMb} MB`,
        modified: row.created_at || Date.now(),
        // Stash the raw row so review handlers can pull score/id/whitelist
        // directly off the file object the viewer hands them.
        _nsfwRow: row,
    };
}

// Build the action set passed to the lightbox. Each handler resolves
// the underlying NSFW row id, hits the API, and returns a navigation
// outcome string the viewer uses to drop / advance the file.
function _reviewActionsFor() {
    const onError = (e) => {
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
    };
    const removeFromGrid = (popped) => {
        const id = popped?._nsfwRow?.id;
        if (!id) return;
        const tile = document.querySelector(`#nsfw-list [data-id="${id}"]`);
        if (tile) tile.remove();
        // Mutate the cached row array so subsequent grid renders match.
        _currentRows = _currentRows.filter((r) => r.id !== id);
        _refreshStats();
    };
    const whitelistAction = view.includeWhitelisted
        ? {
              key: 'w',
              label: i18nT('maintenance.nsfw.row.restore', 'Restore'),
              icon: 'ri-arrow-go-back-line',
              handler: async (file) => {
                  const id = file?._nsfwRow?.id;
                  if (!id) return;
                  try {
                      await api.post('/api/maintenance/nsfw/v2/unwhitelist', { ids: [id] });
                      showToast(
                          i18nT('maintenance.nsfw.row.restore_done', 'Restored to review'),
                          'success',
                      );
                      return 'remove-and-advance';
                  } catch (e) {
                      onError(e);
                  }
              },
              afterRemove: removeFromGrid,
          }
        : {
              key: 'w',
              label: i18nT('maintenance.nsfw.row.whitelist', 'Whitelist'),
              icon: 'ri-shield-check-line',
              handler: async (file) => {
                  const id = file?._nsfwRow?.id;
                  if (!id) return;
                  try {
                      await api.post('/api/maintenance/nsfw/v2/bulk-whitelist', { ids: [id] });
                      showToast(
                          i18nT('maintenance.nsfw.marked_kept', 'Marked as 18+ (kept)'),
                          'success',
                      );
                      return 'remove-and-advance';
                  } catch (e) {
                      onError(e);
                  }
              },
              afterRemove: removeFromGrid,
          };
    return [
        whitelistAction,
        {
            key: 'r',
            label: i18nT('maintenance.nsfw.row.reclassify', 'Re-classify'),
            icon: 'ri-refresh-line',
            handler: async (file) => {
                const id = file?._nsfwRow?.id;
                if (!id) return;
                try {
                    await api.post('/api/maintenance/nsfw/v2/reclassify', { ids: [id] });
                    showToast(
                        i18nT(
                            'maintenance.nsfw.row.reclassify_done',
                            'Will re-classify on next scan',
                        ),
                        'success',
                    );
                    return 'remove-and-advance';
                } catch (e) {
                    onError(e);
                }
            },
            afterRemove: removeFromGrid,
        },
        {
            key: 'd',
            label: i18nT('maintenance.nsfw.row.delete', 'Delete'),
            icon: 'ri-delete-bin-line',
            danger: true,
            handler: async (file) => {
                const id = file?._nsfwRow?.id;
                if (!id) return;
                const ok = await confirmSheet({
                    title: i18nT('maintenance.nsfw.confirm_title', 'Delete selected photos?'),
                    message: i18nTf(
                        'maintenance.nsfw.confirm_body',
                        { n: 1 },
                        'Permanently delete 1 photo from disk and database?',
                    ),
                    confirmLabel: i18nT('maintenance.nsfw.confirm_btn', 'Delete'),
                    danger: true,
                });
                if (!ok) return;
                try {
                    await api.post('/api/maintenance/nsfw/v2/bulk-delete', {
                        ids: [id],
                        confirm: true,
                    });
                    showToast(i18nT('maintenance.nsfw.row.delete_done', 'Deleted'), 'success');
                    return 'remove-and-advance';
                } catch (e) {
                    onError(e);
                }
            },
            afterRemove: removeFromGrid,
        },
    ];
}

function _reviewMetaFor(file) {
    const row = file?._nsfwRow;
    if (!row) return '';
    const score = Math.round((row.nsfw_score || 0) * 100);
    const tid = _tierForScore(row.nsfw_score || 0);
    const color = TIER_COLOR[tid] || '#9E9E9E';
    const tierLbl = tid ? _tierLabel(tid) : '';
    const wl = row.nsfw_whitelist
        ? `<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-tg-blue/30">${escapeHtml(i18nT('maintenance.nsfw.row.whitelisted_badge', 'Whitelisted'))}</span>`
        : '';
    return `
        <span class="inline-flex items-center gap-2">
            <span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${color}"></span>
            <span class="font-mono tabular-nums">${score}%</span>
            <span class="opacity-80">${escapeHtml(tierLbl)}</span>
            ${wl}
        </span>`;
}

function _wireTileClicks() {
    const list = $('nsfw-list');
    if (!list) return;
    list.querySelectorAll('[data-tile-index]').forEach((tile) => {
        if (tile.dataset.wired) return;
        tile.dataset.wired = '1';
        tile.addEventListener('click', () => {
            const idx = Number(tile.dataset.tileIndex);
            if (Number.isFinite(idx)) _openLightbox(idx);
        });
    });
}

function _openLightbox(startIndex) {
    if (!_currentRows.length) return;
    const files = _currentRows.map(_rowToViewerFile);
    openMediaViewerForReview(files, startIndex, {
        actions: _reviewActionsFor(),
        metaRender: _reviewMetaFor,
    });
}

function _renderEmptyState(total) {
    const empty = $('nsfw-empty');
    if (!empty) return;
    const counts = view.tierCounts || {};
    const scanned = counts.scanned ?? 0;
    const totalEligible = counts.totalEligible ?? 0;
    let text;
    if (scanned === 0 && totalEligible > 0) {
        text = i18nT(
            'maintenance.nsfw.empty.never_scanned',
            'Nothing scanned yet — click Scan above to score this library.',
        );
    } else if (view.tier && total === 0) {
        // Suggest the next non-empty tier so the operator doesn't bounce
        // back to the panel to find one with content.
        const tierMap = counts.tiers || {};
        const fallback = Object.entries(tierMap).find(([id, n]) => n > 0 && id !== view.tier);
        const fallbackLabel = fallback ? _tierLabel(fallback[0]) : '';
        const tierLbl = _tierLabel(view.tier);
        text = fallback
            ? i18nTf(
                  'maintenance.nsfw.empty.tier_with_suggestion',
                  { tier: tierLbl, next: fallbackLabel, count: fallback[1] },
                  `No items in "${tierLbl}". Try "${fallbackLabel}" — ${fallback[1]} item(s) waiting.`,
              )
            : i18nTf('maintenance.nsfw.empty.tier', { tier: tierLbl }, `No items in "${tierLbl}".`);
    } else {
        text = i18nT('maintenance.nsfw.empty', 'No candidates — the library is clean.');
    }
    empty.textContent = text;
    empty.classList.remove('hidden');
}

async function _loadList() {
    const list = $('nsfw-list');
    const empty = $('nsfw-empty');
    const banner = $('nsfw-empty-db-banner');
    const pageInfo = $('nsfw-page-info');
    const prevBtn = $('nsfw-prev-btn');
    const nextBtn = $('nsfw-next-btn');
    if (!list) return;
    list.innerHTML = `<div class="py-6 text-center text-xs text-tg-textSecondary"><i class="ri-loader-4-line animate-spin mr-1"></i>${escapeHtml(i18nT('queue.loading_more', 'Loading…'))}</div>`;
    try {
        const qs = new URLSearchParams();
        qs.set('page', String(view.page));
        qs.set('limit', String(view.limit));
        if (view.tier) qs.set('tier', view.tier);
        if (view.includeWhitelisted) qs.set('include_whitelisted', '1');
        const r = await api.get(`/api/maintenance/nsfw/v2/list?${qs.toString()}`);
        view.totalPages = r.totalPages || 1;
        if (banner) {
            const empty1 =
                (view.tierCounts?.scanned ?? 0) === 0 &&
                (view.tierCounts?.totalEligible ?? 0) === 0;
            banner.classList.toggle('hidden', !empty1);
        }
        _currentRows = r.rows || [];
        if (!_currentRows.length) {
            list.innerHTML = '';
            _renderEmptyState(r.total || 0);
        } else {
            if (empty) empty.classList.add('hidden');
            list.innerHTML = _currentRows.map((row, i) => _renderTile(row, i)).join('');
            _wireTileClicks();
        }
        if (pageInfo) {
            pageInfo.textContent = i18nTf(
                'maintenance.nsfw.page_info',
                { page: view.page, totalPages: view.totalPages, total: r.total || 0 },
                `Page ${view.page} / ${view.totalPages} · ${r.total || 0} rows`,
            );
        }
        if (prevBtn) prevBtn.disabled = view.page <= 1;
        if (nextBtn) nextBtn.disabled = view.page >= view.totalPages;
    } catch (e) {
        list.innerHTML = `<div class="py-6 text-center text-xs text-red-400">${escapeHtml(e?.data?.error || e.message || 'Failed')}</div>`;
    }
}

async function _refreshHistogram() {
    try {
        const r = await api.get('/api/maintenance/nsfw/v2/histogram?bins=20');
        _renderHistogram(r);
    } catch {
        // non-fatal
    }
}

async function _refreshStats() {
    try {
        const counts = await api.get('/api/maintenance/nsfw/v2/tiers');
        view.tierCounts = counts;
        // Stats cards
        const scannedEl = $('nsfw-stat-scanned');
        const whitelistedEl = $('nsfw-stat-whitelisted');
        const borderlineEl = $('nsfw-stat-borderline');
        const lastEl = $('nsfw-stat-last');
        const thresholdEl = $('nsfw-threshold-value');
        if (scannedEl)
            scannedEl.textContent = `${counts.scanned ?? 0} / ${counts.totalEligible ?? 0}`;
        if (whitelistedEl) whitelistedEl.textContent = String(counts.whitelisted ?? 0);
        if (borderlineEl) {
            // Borderline = the three middle tiers (maybe_not + uncertain + maybe).
            // def_not + def are the confident ends; the middle is what needs eyeballs.
            const t = counts.tiers || {};
            const n = (t.maybe_not || 0) + (t.uncertain || 0) + (t.maybe || 0);
            borderlineEl.textContent = String(n);
        }
        if (thresholdEl) thresholdEl.textContent = (Number(counts.threshold) || 0).toFixed(2);

        // Pull last-scan from the legacy status endpoint (it has the timestamp).
        try {
            const s = await api.get('/api/maintenance/nsfw/status');
            if (lastEl) {
                lastEl.textContent = s.lastCheckedAt
                    ? _formatRelTime(s.lastCheckedAt)
                    : i18nT('maintenance.nsfw.never_scanned', 'never scanned');
            }
            // Scan progress bar — only visible while running.
            const progress = $('nsfw-scan-progress');
            const bar = $('nsfw-scan-progress-bar');
            const scanBtn = $('nsfw-scan-btn');
            const concurrencyEl = $('nsfw-concurrency-value');
            if (concurrencyEl && Number.isFinite(s.concurrency)) {
                concurrencyEl.textContent = String(s.concurrency);
            }
            if (s.running) {
                if (progress) progress.classList.remove('hidden');
                if (bar) {
                    const total = Math.max(1, s.total || 1);
                    const pct = Math.min(100, Math.round((s.scanned / total) * 100));
                    bar.style.width = pct + '%';
                }
                if (scanBtn) {
                    // Label-span swap pattern preserves the button's
                    // icon — `textContent = …` would erase the
                    // <i ri-search-line> child along with the label.
                    const labelSpan = scanBtn.querySelector('span[data-i18n]');
                    if (labelSpan) {
                        labelSpan.textContent = i18nT('maintenance.nsfw.cancel', 'Cancel');
                    } else {
                        scanBtn.textContent = i18nT('maintenance.nsfw.cancel', 'Cancel');
                    }
                    scanBtn.dataset.mode = 'cancel';
                }
            } else {
                if (progress) progress.classList.add('hidden');
                if (scanBtn) {
                    const labelSpan = scanBtn.querySelector('span[data-i18n]');
                    if (labelSpan) {
                        labelSpan.textContent = i18nT('maintenance.nsfw.action', 'Scan');
                    } else {
                        scanBtn.textContent = i18nT('maintenance.nsfw.action', 'Scan');
                    }
                    scanBtn.dataset.mode = 'scan';
                }
            }
        } catch {
            // tolerate — stats card is best-effort
        }

        _renderTiersPanel(counts);
    } catch (e) {
        console.error('nsfw stats:', e);
    }
}

async function _toggleScan() {
    const btn = $('nsfw-scan-btn');
    if (!btn) return;
    if (btn.dataset.mode === 'cancel') {
        try {
            await api.post('/api/maintenance/nsfw/scan/cancel', {});
        } catch (e) {
            showToast(e.message || 'Cancel failed', 'error');
        }
        return;
    }
    btn.disabled = true;
    try {
        const r = await api.post('/api/maintenance/nsfw/scan', {});
        if (r.alreadyRunning) {
            showToast(
                i18nT('maintenance.nsfw.already_running', 'A scan is already running'),
                'info',
            );
        } else {
            showToast(
                i18nT('maintenance.nsfw.started', 'Scan started — will notify when done'),
                'info',
            );
        }
        _refreshStats();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Scan failed', 'error');
    } finally {
        btn.disabled = false;
    }
}

// Watchdog so a dropped `nsfw_bulk_done` event doesn't strand the UI
// with disabled buttons forever. Cleared whenever the WS event arrives
// or another _setBulkUi(false) fires.
let _bulkWatchdog = null;
function _setBulkUi(running) {
    for (const id of [
        'nsfw-bulk-delete-btn',
        'nsfw-bulk-whitelist-btn',
        'nsfw-bulk-reclassify-btn',
    ]) {
        const b = $(id);
        if (b) b.disabled = !!running;
    }
    if (_bulkWatchdog) {
        clearTimeout(_bulkWatchdog);
        _bulkWatchdog = null;
    }
    if (running) {
        // 60 s after we go busy, fall back to the canonical server status
        // — if the tracker says it's idle we re-enable the buttons even
        // though we never saw the done event (lost-WS-event recovery).
        _bulkWatchdog = setTimeout(async () => {
            try {
                const s = await api.get('/api/maintenance/nsfw/v2/bulk/status');
                if (!s?.running) _setBulkUi(false);
            } catch {}
        }, 60_000);
    } else {
        const progEl = $('nsfw-bulk-progress');
        if (progEl) progEl.textContent = '';
    }
}

async function _bulkAction(kind) {
    if (!view.tier) return;
    const tierLabel = _tierLabel(view.tier);
    const body = { tier: view.tier, fileTypes: ['photo'] };

    let url, confirmOpts;
    if (kind === 'delete') {
        confirmOpts = {
            title: i18nTf(
                'maintenance.nsfw.bulk.confirm_delete_title',
                { tier: tierLabel },
                `Delete every photo in "${tierLabel}"?`,
            ),
            message: i18nT(
                'maintenance.nsfw.bulk.confirm_delete_body',
                'Permanently deletes every file in this tier from disk and database. This cannot be undone.',
            ),
            confirmLabel: i18nT('maintenance.nsfw.confirm_btn', 'Delete'),
            danger: true,
        };
        body.confirm = true;
        url = '/api/maintenance/nsfw/v2/bulk-delete';
    } else if (kind === 'whitelist') {
        // The same toolbar slot does Whitelist OR Restore, depending on
        // whether the operator has the "Show whitelisted" toggle on.
        // The unwhitelist endpoint resolves the tier server-side (with
        // includeWhitelisted forced true) so we just send the same body
        // shape and a different URL.
        if (view.includeWhitelisted) {
            confirmOpts = {
                title: i18nTf(
                    'maintenance.nsfw.bulk.confirm_restore_title',
                    { tier: tierLabel },
                    `Restore every photo in "${tierLabel}" to review?`,
                ),
                message: i18nT(
                    'maintenance.nsfw.bulk.confirm_restore_body',
                    'Flips the whitelist flag back to 0 so the next scan can pick them up again.',
                ),
                confirmLabel: i18nT('maintenance.nsfw.bulk.restore_confirm', 'Restore'),
            };
            url = '/api/maintenance/nsfw/v2/unwhitelist';
        } else {
            confirmOpts = {
                title: i18nTf(
                    'maintenance.nsfw.bulk.confirm_whitelist_title',
                    { tier: tierLabel },
                    `Whitelist every photo in "${tierLabel}"?`,
                ),
                message: i18nT(
                    'maintenance.nsfw.bulk.confirm_whitelist_body',
                    'Marks every file in this tier as confirmed 18+. They will be skipped on future scans.',
                ),
                confirmLabel: i18nT('maintenance.nsfw.bulk.whitelist_confirm', 'Whitelist'),
            };
            url = '/api/maintenance/nsfw/v2/bulk-whitelist';
        }
    } else if (kind === 'reclassify') {
        confirmOpts = {
            title: i18nTf(
                'maintenance.nsfw.bulk.confirm_reclassify_title',
                { tier: tierLabel },
                `Re-classify every photo in "${tierLabel}"?`,
            ),
            message: i18nT(
                'maintenance.nsfw.bulk.confirm_reclassify_body',
                'Clears the cached score so the next scan run picks them up again.',
            ),
            confirmLabel: i18nT('maintenance.nsfw.bulk.reclassify_confirm', 'Re-classify'),
        };
        url = '/api/maintenance/nsfw/v2/reclassify';
    } else {
        return;
    }

    const ok = await confirmSheet(confirmOpts);
    if (!ok) return;

    // All four bulk endpoints share the `nsfwBulk` tracker server-side
    // so they're mutually exclusive across operations + clients. POST
    // returns 200 immediately; result toast lands via `nsfw_bulk_done`
    // (handled in _wireWs). This means the desktop sees the toast even
    // if the action was triggered on a phone.
    _setBulkUi(true);
    try {
        const r = await api.post(url, body);
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
        _setBulkUi(false);
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;

    ws.on('nsfw_progress', (m) => {
        const progress = $('nsfw-scan-progress');
        const bar = $('nsfw-scan-progress-bar');
        const scanBtn = $('nsfw-scan-btn');
        if (m && m.running) {
            if (progress) progress.classList.remove('hidden');
            if (bar) {
                const total = Math.max(1, m.total || 1);
                const pct = Math.min(100, Math.round(((m.scanned || 0) / total) * 100));
                bar.style.width = pct + '%';
            }
            if (scanBtn) {
                const labelSpan = scanBtn.querySelector('span[data-i18n]');
                if (labelSpan) {
                    labelSpan.textContent = i18nT('maintenance.nsfw.cancel', 'Cancel');
                } else {
                    scanBtn.textContent = i18nT('maintenance.nsfw.cancel', 'Cancel');
                }
                scanBtn.dataset.mode = 'cancel';
            }
        }
    });

    ws.on('nsfw_done', () => {
        _refreshStats();
        _refreshHistogram();
        _loadList();
    });

    // Live model-download progress — flips the model-status pill into a
    // "Loading X%" state, then "Ready" / "Error" on completion.
    ws.on('nsfw_model_downloading', (m) => {
        const status = String(m?.status || '').toLowerCase();
        if (status === 'progress' || status === 'download' || m?.progress != null) {
            const pct = m?.progress != null ? Math.round(Number(m.progress)) : null;
            _renderModelStatus({
                state: 'loading',
                label:
                    pct != null
                        ? i18nTf(
                              'maintenance.nsfw.model_status.loading_pct',
                              { pct },
                              `Loading ${pct}%`,
                          )
                        : i18nT('maintenance.nsfw.model_status.loading', 'Loading…'),
                progress: pct,
                file: m?.file || '',
            });
        } else if (status === 'ready' || status === 'done') {
            _renderModelStatus({
                state: 'ready',
                label: i18nT('maintenance.nsfw.model_status.ready', 'Ready'),
            });
        } else if (status === 'error') {
            _renderModelStatus({
                state: 'error',
                label: i18nT('maintenance.nsfw.model_status.error', 'Failed'),
            });
        }
    });

    // Bulk-delete / whitelist / unwhitelist / reclassify share one
    // `nsfwBulk` tracker, so a single done event covers all four ops.
    // The payload's `op` field tells us which toast to render. The
    // progress payload's `processed`/`total` (when the op exposes them
    // — only delete does today) drives a small "Processing N/M" hint.
    ws.on('nsfw_bulk_progress', (m) => {
        _setBulkUi(true);
        const progEl = $('nsfw-bulk-progress');
        if (!progEl) return;
        if (Number.isFinite(m?.processed) && Number.isFinite(m?.total) && m.total > 0) {
            progEl.textContent = i18nTf(
                'maintenance.nsfw.bulk.progress',
                { n: m.processed, total: m.total },
                `Processing ${m.processed} / ${m.total}…`,
            );
        } else if (m?.stage) {
            // Earlier stages (resolving / updating / clearing) just print
            // the stage so the operator sees something is alive.
            progEl.textContent = i18nT(
                `maintenance.nsfw.bulk.stage_${m.stage}`,
                m.stage.charAt(0).toUpperCase() + m.stage.slice(1) + '…',
            );
        }
    });
    ws.on('nsfw_bulk_done', async (m) => {
        _setBulkUi(false);
        if (m?.error) {
            showToast(m.error, 'error');
            return;
        }
        if (m?.op === 'delete') {
            showToast(
                i18nTf(
                    'maintenance.nsfw.bulk.deleted',
                    { n: m?.deleted || 0 },
                    `Deleted ${m?.deleted || 0} files`,
                ),
                'success',
            );
        } else if (m?.op === 'whitelist') {
            showToast(
                i18nTf(
                    'maintenance.nsfw.bulk.whitelisted',
                    { n: m?.updated || 0 },
                    `Whitelisted ${m?.updated || 0} files`,
                ),
                'success',
            );
        } else if (m?.op === 'unwhitelist') {
            showToast(
                i18nTf(
                    'maintenance.nsfw.bulk.unwhitelisted',
                    { n: m?.updated || 0 },
                    `Restored ${m?.updated || 0} files for review`,
                ),
                'success',
            );
        } else if (m?.op === 'reclassify') {
            showToast(
                i18nTf(
                    'maintenance.nsfw.bulk.reclassified',
                    { n: m?.cleared || 0 },
                    `Cleared ${m?.cleared || 0} files for re-scan`,
                ),
                'success',
            );
        }
        try {
            await _refreshStats();
        } catch {}
        try {
            await _refreshHistogram();
        } catch {}
        try {
            await _loadList();
        } catch {}
    });

    // WebSocket reconnect path: when the socket comes back up after a
    // drop, re-poll the bulk tracker so the bar's enabled/disabled state
    // matches reality. Without this, a bulk op that finished while we
    // were offline would leave the buttons stuck disabled.
    ws.on('open', async () => {
        try {
            const s = await api.get('/api/maintenance/nsfw/v2/bulk/status');
            _setBulkUi(!!s?.running);
        } catch {}
    });
}

// Render the model-status pill in the Settings card. `state` drives the
// dot colour (idle/loading/ready/error) and `label` is the human string.
const MODEL_STATUS_COLOR = {
    idle: 'bg-tg-textSecondary',
    loading: 'bg-tg-orange',
    ready: 'bg-tg-green',
    error: 'bg-red-400',
};
function _renderModelStatus({ state = 'idle', label = '', progress = null, file = '' } = {}) {
    const pill = $('nsfw-model-status');
    const progLine = $('nsfw-model-progress');
    if (pill) {
        const dotClass = MODEL_STATUS_COLOR[state] || MODEL_STATUS_COLOR.idle;
        pill.innerHTML = `
            <span class="w-1.5 h-1.5 rounded-full ${dotClass}"></span>
            <span>${escapeHtml(label || i18nT('maintenance.nsfw.model_status.idle', 'Not loaded'))}</span>
        `;
    }
    if (progLine) {
        if (state === 'loading' && file) {
            progLine.textContent = i18nTf(
                'maintenance.nsfw.model_status.loading_file',
                { file, pct: progress != null ? `${progress}%` : '' },
                `Downloading ${file} ${progress != null ? `(${progress}%)` : ''}`,
            );
        } else if (state === 'ready') {
            progLine.textContent = i18nT(
                'maintenance.nsfw.model_status.ready_help',
                'Weights cached on disk — scans start instantly.',
            );
        } else if (state === 'error') {
            progLine.textContent = i18nT(
                'maintenance.nsfw.model_status.error_help',
                'Load failed. Check the realtime log for details, then try a different model id or precision.',
            );
        } else {
            progLine.textContent = '';
        }
    }
}

async function _refreshModelStatus() {
    try {
        const r = await api.get('/api/maintenance/nsfw/model-status');
        const state =
            r?.state === 'ready'
                ? 'ready'
                : r?.state === 'loading'
                  ? 'loading'
                  : r?.state === 'error'
                    ? 'error'
                    : 'idle';
        const label =
            state === 'ready'
                ? i18nT('maintenance.nsfw.model_status.ready', 'Ready')
                : state === 'loading'
                  ? i18nT('maintenance.nsfw.model_status.loading', 'Loading…')
                  : state === 'error'
                    ? i18nT('maintenance.nsfw.model_status.error', 'Failed')
                    : i18nT('maintenance.nsfw.model_status.idle', 'Not loaded');
        _renderModelStatus({
            state,
            label,
            progress: r?.progress?.progress != null ? Math.round(r.progress.progress) : null,
            file: r?.progress?.file || '',
        });
    } catch {
        _renderModelStatus({ state: 'idle' });
    }
}

async function _onPreloadClick() {
    const btn = $('nsfw-preload-btn');
    if (!btn) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = `<i class="ri-loader-4-line animate-spin"></i><span>${escapeHtml(i18nT('common.loading', 'Loading…'))}</span>`;
    try {
        const r = await api.post('/api/maintenance/nsfw/preload', {});
        if (r?.alreadyReady) {
            showToast(
                i18nT('maintenance.nsfw.preload.already_ready', 'Model already loaded.'),
                'info',
            );
        } else if (r?.alreadyLoading) {
            showToast(
                i18nT(
                    'maintenance.nsfw.preload.already_loading',
                    'A preload is already in progress.',
                ),
                'info',
            );
        } else {
            showToast(
                i18nT(
                    'maintenance.nsfw.preload.started',
                    'Preload started — progress in the realtime log.',
                ),
                'success',
            );
        }
        _renderModelStatus({
            state: 'loading',
            label: i18nT('maintenance.nsfw.model_status.loading', 'Loading…'),
        });
    } catch (e) {
        showToast(e?.data?.error || e?.message || 'Preload failed', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
}

async function _onCacheClearClick() {
    const ok = await confirmSheet({
        title: i18nT('maintenance.nsfw.cache_clear.confirm_title', 'Wipe cached weights?'),
        message: i18nT(
            'maintenance.nsfw.cache_clear.confirm_body',
            'The classifier cache directory will be emptied. The next scan or preload will re-download the model.',
        ),
        confirmLabel: i18nT('common.delete', 'Delete'),
        danger: true,
    });
    if (!ok) return;
    const btn = $('nsfw-cache-clear-btn');
    if (btn) btn.disabled = true;
    try {
        const r = await api.del('/api/maintenance/nsfw/cache');
        const mb = ((r?.bytes || 0) / (1024 * 1024)).toFixed(1);
        showToast(
            i18nTf(
                'maintenance.nsfw.cache_clear.done',
                { files: r?.files || 0, mb },
                `Removed ${r?.files || 0} file(s), ${mb} MB freed.`,
            ),
            'success',
        );
        _renderModelStatus({ state: 'idle' });
    } catch (e) {
        showToast(e?.data?.error || e?.message || 'Wipe failed', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Apply hash state to the view, falling back to the review-queue tier
// when the URL is bare. Pulled out of init() so popstate can re-run it.
function _applyHashState() {
    const hash = _readHashState();
    view.tier = hash.tier !== undefined ? hash.tier : DEFAULT_TIER;
    view.page = hash.page || 1;
    view.includeWhitelisted = !!hash.includeWhitelisted;
    const wlToggle = $('nsfw-show-whitelisted');
    if (wlToggle) wlToggle.checked = view.includeWhitelisted;
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        $('nsfw-scan-btn')?.addEventListener('click', _toggleScan);
        $('nsfw-prev-btn')?.addEventListener('click', () => {
            if (view.page > 1) {
                view.page -= 1;
                _writeHashState();
                _loadList();
            }
        });
        $('nsfw-next-btn')?.addEventListener('click', () => {
            if (view.page < view.totalPages) {
                view.page += 1;
                _writeHashState();
                _loadList();
            }
        });
        $('nsfw-bulk-delete-btn')?.addEventListener('click', () => _bulkAction('delete'));
        $('nsfw-bulk-whitelist-btn')?.addEventListener('click', () => _bulkAction('whitelist'));
        $('nsfw-bulk-reclassify-btn')?.addEventListener('click', () => _bulkAction('reclassify'));
        $('nsfw-preload-btn')?.addEventListener('click', _onPreloadClick);
        $('nsfw-cache-clear-btn')?.addEventListener('click', _onCacheClearClick);
        $('nsfw-show-whitelisted')?.addEventListener('change', (ev) => {
            view.includeWhitelisted = !!ev.target.checked;
            view.page = 1;
            _writeHashState();
            _renderBulkBar();
            _loadList();
        });
        // Browser back / hash edit — re-hydrate state and re-render
        // without re-running the whole init pipeline.
        window.addEventListener('hashchange', () => {
            _applyHashState();
            _renderTiersPanel(view.tierCounts || { tiers: {} });
            _renderBulkBar();
            _loadList();
        });
        // Page-level keyboard shortcuts — only fire when this page is
        // visible AND the lightbox modal is closed (modal owns its own
        // keys). Skip while the user is typing in an input.
        document.addEventListener('keydown', (e) => {
            const page = $('page-maintenance-nsfw');
            if (!page || page.classList.contains('hidden')) return;
            const modal = document.getElementById('media-modal');
            if (modal && !modal.classList.contains('hidden')) return;
            const tag = (e.target?.tagName || '').toLowerCase();
            if (
                tag === 'input' ||
                tag === 'textarea' ||
                tag === 'select' ||
                e.target?.isContentEditable
            )
                return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // [ / ] — page nav
            if (e.key === '[') {
                e.preventDefault();
                $('nsfw-prev-btn')?.click();
                return;
            }
            if (e.key === ']') {
                e.preventDefault();
                $('nsfw-next-btn')?.click();
                return;
            }
            // 1-5 selects a tier; 0 clears.
            const tierByDigit = {
                1: 'def_not',
                2: 'maybe_not',
                3: 'uncertain',
                4: 'maybe',
                5: 'def',
            };
            if (tierByDigit[e.key]) {
                e.preventDefault();
                view.tier = tierByDigit[e.key];
                view.page = 1;
                _writeHashState();
                _renderTiersPanel(view.tierCounts || { tiers: {} });
                _renderBulkBar();
                _loadList();
                return;
            }
            if (e.key === '0') {
                e.preventDefault();
                view.tier = null;
                view.page = 1;
                _writeHashState();
                _renderTiersPanel(view.tierCounts || { tiers: {} });
                _renderBulkBar();
                _loadList();
                return;
            }
        });
        // Dismiss the review badge on the maintenance hub the moment the
        // operator lands here — they've now "seen" the candidates so the
        // unread dot shouldn't keep nagging on the dashboard.
        try {
            const status = api.get('/api/maintenance/nsfw/status');
            status
                .then((s) => {
                    try {
                        localStorage.setItem('tgdl.nsfw.lastSeen', String(s?.candidates || 0));
                    } catch {}
                })
                .catch(() => {});
        } catch {}
    }
    _applyHashState();
    (async () => {
        // Hydrate the Settings card inputs from /api/config so the model
        // id, dtype, threshold, etc. show the persisted values. Same path
        // the Settings page uses — keeps the two surfaces in lock-step.
        try {
            const cfg = await api.get('/api/config');
            loadAdvanced(cfg);
        } catch {
            /* best-effort — input still typeable, autosave still works */
        }
        try {
            setupAutoSave();
        } catch {}
        // Independent fetches run in parallel so the page renders in one
        // round-trip instead of waiting for each to finish in turn.
        await Promise.all([
            _loadTiersMeta(),
            _refreshStats(),
            _refreshHistogram(),
            _refreshModelStatus(),
            (async () => {
                try {
                    const s = await api.get('/api/maintenance/nsfw/v2/bulk/status');
                    if (s?.running) _setBulkUi(true);
                } catch {}
            })(),
        ]);
        _renderBulkBar();
        // The list depends on tiersMeta + tierCounts being hydrated so
        // empty-state copy can suggest a fallback tier — runs last.
        await _loadList();
    })();
}
