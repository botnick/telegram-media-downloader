// Maintenance — NSFW review tool (admin page).
//
// Five-tier classifier review (def_not / maybe_not / uncertain / maybe / def).
// Owns:
//   - Top stats cards: scanned / whitelisted / last scan time.
//   - Tier panel — clickable cards filter the row list below.
//   - Score histogram (vanilla SVG, tiers shaded with their accent colour).
//   - Scan controls — start/cancel, threshold display, concurrency display,
//     live progress bar.
//   - Paginated row list — per-row keep / delete / whitelist / reclassify.
//   - Bulk actions — delete / whitelist / reclassify the entire current tier.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { loadAdvanced, setupAutoSave } from './settings.js';

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

// Local view state — persists for the lifetime of the SPA.
const view = {
    tier: null,           // null = all tiers
    page: 1,
    limit: 50,
    totalPages: 1,
    tiersMeta: null,      // [{ id, min, max, label }]
    tierCounts: null,     // { tiers: {def_not: n, ...}, scanned, totalEligible, whitelisted, threshold }
};

function _formatRelTime(epochMs) {
    if (!epochMs) return '—';
    const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (diffSec < 60) return i18nT('share.just_now', 'just now');
    if (diffSec < 3600) return i18nTf('share.mins_ago', { n: Math.floor(diffSec / 60) }, `${Math.floor(diffSec / 60)}m ago`);
    if (diffSec < 86400) return i18nTf('share.hours_ago', { n: Math.floor(diffSec / 3600) }, `${Math.floor(diffSec / 3600)}h ago`);
    return i18nTf('share.days_ago', { n: Math.floor(diffSec / 86400) }, `${Math.floor(diffSec / 86400)}d ago`);
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
    panel.innerHTML = (view.tiersMeta || []).map((t) => {
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
    }).join('');
    panel.querySelectorAll('[data-tier]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.tier;
            view.tier = (view.tier === next) ? null : next;
            view.page = 1;
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
        labelEl.textContent = i18nTf('maintenance.nsfw.bulk.title',
            { tier: tierLabel },
            `Bulk actions for "${tierLabel}":`);
    }
    const setLabel = (id, key, fallback) => {
        const el = $(id);
        if (el) {
            el.textContent = i18nTf(key, { tier: tierLabel }, fallback.replace('{tier}', tierLabel));
        }
    };
    setLabel('nsfw-bulk-delete-btn', 'maintenance.nsfw.bulk.delete_in_tier', 'Delete all in {tier}');
    setLabel('nsfw-bulk-whitelist-btn', 'maintenance.nsfw.bulk.whitelist_in_tier', 'Whitelist all in {tier}');
    setLabel('nsfw-bulk-reclassify-btn', 'maintenance.nsfw.bulk.reclassify_in_tier', 'Re-classify all in {tier}');
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
    const H = 80;
    const barW = W / bins;
    const tiers = view.tiersMeta || [];
    const tierFor = (mid) => {
        for (const t of tiers) {
            if (mid >= t.min && mid < t.max) return t.id;
        }
        return null;
    };
    const bars = counts.map((n, i) => {
        const mid = (i + 0.5) / bins;
        const tid = tierFor(mid);
        const color = TIER_COLOR[tid] || '#9E9E9E';
        const h = (n / maxN) * (H - 4);
        const x = (i * barW) + 0.5;
        const y = (H - h);
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.85"><title>${(mid * 100).toFixed(0)}%: ${n}</title></rect>`;
    }).join('');
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.innerHTML = `${bars}
        <line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>`;
}

function _renderRow(file) {
    const score = Math.round((file.nsfw_score || 0) * 100);
    const checked = file.nsfw_checked_at ? _formatRelTime(file.nsfw_checked_at) : '—';
    const thumb = `/api/thumbs/${encodeURIComponent(file.id)}?w=120`;
    return `
        <div class="flex items-center gap-2 p-2 rounded-md hover:bg-tg-hover" data-row-id="${file.id}">
            <img loading="lazy" decoding="async"
                 class="w-14 h-14 object-cover rounded-md bg-tg-bg/40"
                 src="${escapeHtml(thumb)}" alt=""
                 onerror="this.style.display='none'">
            <div class="min-w-0 flex-1">
                <div class="text-sm text-tg-text truncate">${escapeHtml(file.file_name || '')}</div>
                <div class="text-xs text-tg-textSecondary truncate">${escapeHtml(file.group_name || file.group_id || '')} · ${escapeHtml(checked)}</div>
                <div class="text-[10px] text-tg-textSecondary mt-0.5">NSFW score: ${score}%</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" data-act="keep" data-id="${file.id}" class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-green hover:border-tg-green" data-i18n="maintenance.nsfw.row.keep">Keep</button>
                <button type="button" data-act="whitelist" data-id="${file.id}" class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue" data-i18n="maintenance.nsfw.row.whitelist">Whitelist</button>
                <button type="button" data-act="reclassify" data-id="${file.id}" class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-orange hover:border-tg-orange" data-i18n="maintenance.nsfw.row.reclassify">Re-classify</button>
                <button type="button" data-act="delete" data-id="${file.id}" class="text-xs px-2 py-1 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10" data-i18n="maintenance.nsfw.row.delete">Delete</button>
            </div>
        </div>`;
}

function _wireRowActions() {
    const list = $('nsfw-list');
    if (!list) return;
    list.querySelectorAll('[data-act]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', async () => {
            const id = Number(btn.dataset.id);
            const act = btn.dataset.act;
            if (!id || !act) return;
            btn.disabled = true;
            try {
                if (act === 'keep') {
                    // "Keep" without whitelisting just re-classifies so it
                    // drops out of low-score tiers next scan.
                    await api.post('/api/maintenance/nsfw/v2/reclassify', { ids: [id] });
                    showToast(i18nT('maintenance.nsfw.row.keep_done', 'Kept — will re-classify on next scan'), 'success');
                } else if (act === 'whitelist') {
                    await api.post('/api/maintenance/nsfw/v2/bulk-whitelist', { ids: [id] });
                    showToast(i18nT('maintenance.nsfw.marked_kept', 'Marked as 18+ (kept)'), 'success');
                } else if (act === 'reclassify') {
                    await api.post('/api/maintenance/nsfw/v2/reclassify', { ids: [id] });
                    showToast(i18nT('maintenance.nsfw.row.reclassify_done', 'Will re-classify on next scan'), 'success');
                } else if (act === 'delete') {
                    const ok = await confirmSheet({
                        title: i18nT('maintenance.nsfw.confirm_title', 'Delete selected photos?'),
                        message: i18nTf('maintenance.nsfw.confirm_body',
                            { n: 1 }, 'Permanently delete 1 photo from disk and database?'),
                        confirmLabel: i18nT('maintenance.nsfw.confirm_btn', 'Delete'),
                        danger: true,
                    });
                    if (!ok) { btn.disabled = false; return; }
                    await api.post('/api/maintenance/nsfw/v2/bulk-delete', { ids: [id], confirm: true });
                    showToast(i18nT('maintenance.nsfw.row.delete_done', 'Deleted'), 'success');
                }
                const row = btn.closest('[data-row-id]');
                if (row) row.remove();
                _refreshStats();
            } catch (e) {
                btn.disabled = false;
                if (e?.data?.code === 'ALREADY_RUNNING') {
                    showToast(i18nT('jobs.already_running',
                        'Already running on another tab — waiting for it to finish.'), 'info');
                    return;
                }
                showToast(e?.data?.error || e.message || 'Failed', 'error');
            }
        });
    });
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
        const r = await api.get(`/api/maintenance/nsfw/v2/list?${qs.toString()}`);
        view.totalPages = r.totalPages || 1;
        if (banner) {
            const empty1 = (view.tierCounts?.scanned ?? 0) === 0 && (view.tierCounts?.totalEligible ?? 0) === 0;
            banner.classList.toggle('hidden', !empty1);
        }
        if (!r.rows?.length) {
            list.innerHTML = '';
            if (empty) empty.classList.remove('hidden');
        } else {
            if (empty) empty.classList.add('hidden');
            list.innerHTML = r.rows.map(_renderRow).join('');
            _wireRowActions();
        }
        if (pageInfo) {
            pageInfo.textContent = i18nTf('maintenance.nsfw.page_info',
                { page: view.page, totalPages: view.totalPages, total: r.total || 0 },
                `Page ${view.page} / ${view.totalPages} · ${r.total || 0} rows`);
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
        const lastEl = $('nsfw-stat-last');
        const thresholdEl = $('nsfw-threshold-value');
        if (scannedEl) scannedEl.textContent = `${counts.scanned ?? 0} / ${counts.totalEligible ?? 0}`;
        if (whitelistedEl) whitelistedEl.textContent = String(counts.whitelisted ?? 0);
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
                    scanBtn.textContent = i18nT('maintenance.nsfw.cancel', 'Cancel');
                    scanBtn.dataset.mode = 'cancel';
                }
            } else {
                if (progress) progress.classList.add('hidden');
                if (scanBtn) {
                    scanBtn.textContent = i18nT('maintenance.nsfw.action', 'Scan');
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
        try { await api.post('/api/maintenance/nsfw/scan/cancel', {}); }
        catch (e) { showToast(e.message || 'Cancel failed', 'error'); }
        return;
    }
    btn.disabled = true;
    try {
        const r = await api.post('/api/maintenance/nsfw/scan', {});
        if (r.alreadyRunning) {
            showToast(i18nT('maintenance.nsfw.already_running', 'A scan is already running'), 'info');
        } else {
            showToast(i18nT('maintenance.nsfw.started', 'Scan started — will notify when done'), 'info');
        }
        _refreshStats();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Scan failed', 'error');
    } finally {
        btn.disabled = false;
    }
}

function _setBulkUi(running) {
    for (const id of ['nsfw-bulk-delete-btn', 'nsfw-bulk-whitelist-btn',
        'nsfw-bulk-reclassify-btn']) {
        const b = $(id);
        if (b) b.disabled = !!running;
    }
}

async function _bulkAction(kind) {
    if (!view.tier) return;
    const tierLabel = _tierLabel(view.tier);
    const body = { tier: view.tier, fileTypes: ['photo'] };

    let url, confirmOpts;
    if (kind === 'delete') {
        confirmOpts = {
            title: i18nTf('maintenance.nsfw.bulk.confirm_delete_title',
                { tier: tierLabel }, `Delete every photo in "${tierLabel}"?`),
            message: i18nT('maintenance.nsfw.bulk.confirm_delete_body',
                'Permanently deletes every file in this tier from disk and database. This cannot be undone.'),
            confirmLabel: i18nT('maintenance.nsfw.confirm_btn', 'Delete'),
            danger: true,
        };
        body.confirm = true;
        url = '/api/maintenance/nsfw/v2/bulk-delete';
    } else if (kind === 'whitelist') {
        confirmOpts = {
            title: i18nTf('maintenance.nsfw.bulk.confirm_whitelist_title',
                { tier: tierLabel }, `Whitelist every photo in "${tierLabel}"?`),
            message: i18nT('maintenance.nsfw.bulk.confirm_whitelist_body',
                'Marks every file in this tier as confirmed 18+. They will be skipped on future scans.'),
            confirmLabel: i18nT('maintenance.nsfw.bulk.whitelist_confirm', 'Whitelist'),
        };
        url = '/api/maintenance/nsfw/v2/bulk-whitelist';
    } else if (kind === 'reclassify') {
        confirmOpts = {
            title: i18nTf('maintenance.nsfw.bulk.confirm_reclassify_title',
                { tier: tierLabel }, `Re-classify every photo in "${tierLabel}"?`),
            message: i18nT('maintenance.nsfw.bulk.confirm_reclassify_body',
                'Clears the cached score so the next scan run picks them up again.'),
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
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
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
                scanBtn.textContent = i18nT('maintenance.nsfw.cancel', 'Cancel');
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
        if (status === 'progress' || status === 'download' || (m?.progress != null)) {
            const pct = m?.progress != null ? Math.round(Number(m.progress)) : null;
            _renderModelStatus({
                state: 'loading',
                label: pct != null
                    ? i18nTf('maintenance.nsfw.model_status.loading_pct', { pct }, `Loading ${pct}%`)
                    : i18nT('maintenance.nsfw.model_status.loading', 'Loading…'),
                progress: pct,
                file: m?.file || '',
            });
        } else if (status === 'ready' || status === 'done') {
            _renderModelStatus({ state: 'ready', label: i18nT('maintenance.nsfw.model_status.ready', 'Ready') });
        } else if (status === 'error') {
            _renderModelStatus({ state: 'error', label: i18nT('maintenance.nsfw.model_status.error', 'Failed') });
        }
    });

    // Bulk-delete / whitelist / unwhitelist / reclassify share one
    // `nsfwBulk` tracker, so a single done event covers all four ops.
    // The payload's `op` field tells us which toast to render.
    ws.on('nsfw_bulk_progress', () => _setBulkUi(true));
    ws.on('nsfw_bulk_done', async (m) => {
        _setBulkUi(false);
        if (m?.error) {
            showToast(m.error, 'error');
            return;
        }
        if (m?.op === 'delete') {
            showToast(i18nTf('maintenance.nsfw.bulk.deleted',
                { n: m?.deleted || 0 }, `Deleted ${m?.deleted || 0} files`), 'success');
        } else if (m?.op === 'whitelist') {
            showToast(i18nTf('maintenance.nsfw.bulk.whitelisted',
                { n: m?.updated || 0 }, `Whitelisted ${m?.updated || 0} files`), 'success');
        } else if (m?.op === 'unwhitelist') {
            showToast(i18nTf('maintenance.nsfw.bulk.unwhitelisted',
                { n: m?.updated || 0 }, `Restored ${m?.updated || 0} files for review`), 'success');
        } else if (m?.op === 'reclassify') {
            showToast(i18nTf('maintenance.nsfw.bulk.reclassified',
                { n: m?.cleared || 0 }, `Cleared ${m?.cleared || 0} files for re-scan`), 'success');
        }
        try { await _refreshStats(); } catch {}
        try { await _refreshHistogram(); } catch {}
        try { await _loadList(); } catch {}
    });
}

// Render the model-status pill in the Settings card. `state` drives the
// dot colour (idle/loading/ready/error) and `label` is the human string.
const MODEL_STATUS_COLOR = {
    idle:    'bg-tg-textSecondary',
    loading: 'bg-tg-orange',
    ready:   'bg-tg-green',
    error:   'bg-red-400',
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
            progLine.textContent = i18nTf('maintenance.nsfw.model_status.loading_file',
                { file, pct: progress != null ? `${progress}%` : '' },
                `Downloading ${file} ${progress != null ? `(${progress}%)` : ''}`);
        } else if (state === 'ready') {
            progLine.textContent = i18nT('maintenance.nsfw.model_status.ready_help', 'Weights cached on disk — scans start instantly.');
        } else if (state === 'error') {
            progLine.textContent = i18nT('maintenance.nsfw.model_status.error_help', 'Load failed. Check the realtime log for details, then try a different model id or precision.');
        } else {
            progLine.textContent = '';
        }
    }
}

async function _refreshModelStatus() {
    try {
        const r = await api.get('/api/maintenance/nsfw/model-status');
        const state = r?.state === 'ready' ? 'ready'
                    : r?.state === 'loading' ? 'loading'
                    : r?.state === 'error' ? 'error'
                    : 'idle';
        const label = state === 'ready'   ? i18nT('maintenance.nsfw.model_status.ready', 'Ready')
                    : state === 'loading' ? i18nT('maintenance.nsfw.model_status.loading', 'Loading…')
                    : state === 'error'   ? i18nT('maintenance.nsfw.model_status.error', 'Failed')
                    : i18nT('maintenance.nsfw.model_status.idle', 'Not loaded');
        _renderModelStatus({ state, label, progress: r?.progress?.progress != null ? Math.round(r.progress.progress) : null, file: r?.progress?.file || '' });
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
            showToast(i18nT('maintenance.nsfw.preload.already_ready', 'Model already loaded.'), 'info');
        } else if (r?.alreadyLoading) {
            showToast(i18nT('maintenance.nsfw.preload.already_loading', 'A preload is already in progress.'), 'info');
        } else {
            showToast(i18nT('maintenance.nsfw.preload.started', 'Preload started — progress in the realtime log.'), 'success');
        }
        _renderModelStatus({ state: 'loading', label: i18nT('maintenance.nsfw.model_status.loading', 'Loading…') });
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
        body: i18nT('maintenance.nsfw.cache_clear.confirm_body', 'The classifier cache directory will be emptied. The next scan or preload will re-download the model.'),
        confirmText: i18nT('common.delete', 'Delete'),
        confirmDanger: true,
    });
    if (!ok) return;
    const btn = $('nsfw-cache-clear-btn');
    if (btn) btn.disabled = true;
    try {
        const r = await api.del('/api/maintenance/nsfw/cache');
        const mb = ((r?.bytes || 0) / (1024 * 1024)).toFixed(1);
        showToast(i18nTf('maintenance.nsfw.cache_clear.done',
            { files: r?.files || 0, mb },
            `Removed ${r?.files || 0} file(s), ${mb} MB freed.`), 'success');
        _renderModelStatus({ state: 'idle' });
    } catch (e) {
        showToast(e?.data?.error || e?.message || 'Wipe failed', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        $('nsfw-scan-btn')?.addEventListener('click', _toggleScan);
        $('nsfw-prev-btn')?.addEventListener('click', () => {
            if (view.page > 1) { view.page -= 1; _loadList(); }
        });
        $('nsfw-next-btn')?.addEventListener('click', () => {
            if (view.page < view.totalPages) { view.page += 1; _loadList(); }
        });
        $('nsfw-bulk-delete-btn')?.addEventListener('click', () => _bulkAction('delete'));
        $('nsfw-bulk-whitelist-btn')?.addEventListener('click', () => _bulkAction('whitelist'));
        $('nsfw-bulk-reclassify-btn')?.addEventListener('click', () => _bulkAction('reclassify'));
        $('nsfw-preload-btn')?.addEventListener('click', _onPreloadClick);
        $('nsfw-cache-clear-btn')?.addEventListener('click', _onCacheClearClick);
    }
    (async () => {
        // Hydrate the Settings card inputs from /api/config so the model
        // id, dtype, threshold, etc. show the persisted values. Same path
        // the Settings page uses — keeps the two surfaces in lock-step.
        try {
            const cfg = await api.get('/api/config');
            loadAdvanced(cfg);
        } catch { /* best-effort — input still typeable, autosave still works */ }
        // Wire the autosave pipeline so input changes here PATCH /api/config
        // through the same debounced flush the Settings page uses.
        try { setupAutoSave(); } catch {}
        await _loadTiersMeta();
        await _refreshStats();
        await _refreshHistogram();
        _renderBulkBar();
        await _loadList();
        await _refreshModelStatus();
        // Hydrate bulk-action state — a job started elsewhere keeps
        // this tab's bulk buttons disabled until it finishes.
        try {
            const s = await api.get('/api/maintenance/nsfw/v2/bulk/status');
            if (s?.running) _setBulkUi(true);
        } catch {}
    })();
}
