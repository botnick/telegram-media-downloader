// NSFW review tool UI — Maintenance status line + scan button + review sheet.
//
// Lives in its own module so the main settings.js stays focused on
// general preferences. Lazy-imported by settings.js when wireMaintenance
// runs, so the initial paint doesn't pay for it.
//
// UX rules driven by the scan being a long background job:
//   - Status line refreshes itself on WS pushes (`nsfw_progress`,
//     `nsfw_done`) AND when the Maintenance section is opened. No timers.
//   - Scan button doubles as Cancel while a scan is running.
//   - Review sheet uses append-on-scroll (50/page) — never paints
//     thousands of rows up front.
//   - Per-row Mark-as-18+ removes the row in place; bulk delete confirms
//     before unlinking.

import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { openSheet, confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const LS_LAST_SEEN = 'tgdl.nsfw.lastSeen';
let _lastSeenCandidates = (() => {
    try { return parseInt(localStorage.getItem(LS_LAST_SEEN) || '0', 10) || 0; }
    catch { return 0; }
})();

function _formatRelTime(epochMs) {
    if (!epochMs) return '—';
    const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (diffSec < 60) return i18nT('share.just_now', 'just now');
    if (diffSec < 3600) return i18nTf('share.mins_ago', { n: Math.floor(diffSec / 60) }, `${Math.floor(diffSec / 60)}m ago`);
    if (diffSec < 86400) return i18nTf('share.hours_ago', { n: Math.floor(diffSec / 3600) }, `${Math.floor(diffSec / 3600)}h ago`);
    return i18nTf('share.days_ago', { n: Math.floor(diffSec / 86400) }, `${Math.floor(diffSec / 86400)}d ago`);
}

export async function refreshNsfwStatus() {
    const statusEl = document.getElementById('maint-nsfw-status');
    const reviewBtn = document.getElementById('maint-nsfw-review-btn');
    const scanBtn = document.getElementById('maint-nsfw-scan-btn');
    const badge = document.getElementById('maint-nsfw-badge');
    const progress = document.getElementById('maint-nsfw-progress');
    const bar = document.getElementById('maint-nsfw-progress-bar');
    if (!statusEl) return;
    try {
        const s = await api.get('/api/maintenance/nsfw/status');
        if (!s.enabled) {
            statusEl.textContent = '· ' + i18nT('maintenance.nsfw.disabled',
                'Disabled. Enable in Settings → Advanced → NSFW review tool.');
            if (reviewBtn) reviewBtn.classList.add('hidden');
            if (badge) badge.classList.add('hidden');
            if (progress) progress.classList.add('hidden');
            if (scanBtn) { scanBtn.disabled = true; scanBtn.classList.add('opacity-50'); }
            return;
        }
        if (scanBtn) { scanBtn.disabled = false; scanBtn.classList.remove('opacity-50'); }
        const eligible = s.totalEligible || 0;
        const scanned = s.scanned || 0;
        const candidates = s.candidates || 0;
        const last = s.lastCheckedAt
            ? _formatRelTime(s.lastCheckedAt)
            : i18nT('maintenance.nsfw.never_scanned', 'never scanned');
        statusEl.textContent = '· ' + i18nTf('maintenance.nsfw.summary',
            { scanned, eligible, candidates, when: last },
            `${scanned} / ${eligible} scanned · ${candidates} possibly not 18+ · last: ${last}`);

        if (badge) {
            const unseen = candidates > _lastSeenCandidates;
            badge.textContent = candidates > 99 ? '99+' : String(candidates);
            badge.classList.toggle('hidden', !unseen || candidates === 0);
        }
        if (reviewBtn) {
            reviewBtn.classList.toggle('hidden', candidates === 0);
            reviewBtn.textContent = i18nTf('maintenance.nsfw.review_n',
                { n: candidates }, `Review ${candidates}`);
        }

        if (progress && bar) {
            if (s.running) {
                progress.classList.remove('hidden');
                const total = Math.max(1, s.total || 1);
                const pct = Math.min(100, Math.round((s.scanned / total) * 100));
                bar.style.width = pct + '%';
                if (scanBtn) {
                    scanBtn.textContent = i18nT('maintenance.nsfw.cancel', 'Cancel');
                    scanBtn.dataset.mode = 'cancel';
                }
            } else {
                progress.classList.add('hidden');
                if (scanBtn) {
                    scanBtn.textContent = i18nT('maintenance.nsfw.action', 'Scan');
                    scanBtn.dataset.mode = 'scan';
                }
            }
        }
    } catch {
        statusEl.textContent = '· ' + i18nT('maintenance.nsfw.status_unavailable', 'status unavailable');
    }
}

export async function maintNsfwScan() {
    const btn = document.getElementById('maint-nsfw-scan-btn');
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
        refreshNsfwStatus();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Scan failed', 'error');
    } finally {
        btn.disabled = false;
    }
}

export async function maintNsfwReview() {
    try {
        const s = await api.get('/api/maintenance/nsfw/status').catch(() => ({}));
        _lastSeenCandidates = s.candidates || 0;
        try { localStorage.setItem(LS_LAST_SEEN, String(_lastSeenCandidates)); } catch {}
        refreshNsfwStatus();
        await openNsfwReviewSheet();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    }
}

async function openNsfwReviewSheet() {
    let firstPage;
    try {
        firstPage = await api.get('/api/maintenance/nsfw/results?page=1&limit=50');
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        return;
    }
    if (!firstPage?.rows?.length) {
        showToast(i18nT('maintenance.nsfw.empty', 'No candidates — the library is clean.'), 'success');
        return;
    }

    const html = `
        <p class="text-xs text-tg-textSecondary mb-3" data-i18n="maintenance.nsfw.review_help">These photos scored as NOT 18+ (below the threshold). Tick the ones you want to delete; a confirmation sheet appears before anything is removed. If a row IS 18+ but the classifier got it wrong, click "Mark as 18+" to keep it and skip future scans.</p>
        <div id="nsfw-list" class="space-y-1 max-h-[60vh] overflow-y-auto pr-1"></div>
        <div id="nsfw-load-more" class="hidden flex items-center justify-center py-3 text-xs text-tg-textSecondary">
            <i class="ri-loader-4-line animate-spin mr-2"></i>
            <span data-i18n="queue.loading_more">Loading more…</span>
        </div>
        <div class="mt-3 flex items-center justify-between gap-3">
            <div id="nsfw-summary" class="text-xs text-tg-textSecondary"></div>
            <div class="flex items-center gap-2">
                <button id="nsfw-cancel-btn" type="button" class="tg-btn-secondary text-sm" data-i18n="maintenance.dedup.cancel">Cancel</button>
                <button id="nsfw-delete-btn" type="button" class="tg-btn text-sm bg-red-600 hover:bg-red-700">
                    <i class="ri-delete-bin-line mr-1"></i><span data-i18n="maintenance.nsfw.delete_selected">Delete selected</span>
                </button>
            </div>
        </div>`;

    const sheet = openSheet({
        title: i18nTf('maintenance.nsfw.sheet_title',
            { n: firstPage.total }, `Possibly not 18+ (${firstPage.total})`),
        content: html,
        size: 'lg',
    });
    const root = sheet?.body;
    if (!root) return;

    const listEl = root.querySelector('#nsfw-list');
    const loadMoreEl = root.querySelector('#nsfw-load-more');
    const sumEl = root.querySelector('#nsfw-summary');

    let allRows = [];
    let nextPage = 1;
    let totalPages = 1;
    let loading = false;
    const removed = new Set();

    const refreshSummary = () => {
        const ids = [...root.querySelectorAll('.nsfw-del:checked')].map(el => Number(el.dataset.id));
        sumEl.textContent = i18nTf('maintenance.nsfw.selected',
            { count: ids.length, shown: allRows.length - removed.size },
            `${ids.length} selected · ${allRows.length - removed.size} shown`);
    };

    const renderRow = (file) => {
        const score = Math.round((file.nsfw_score || 0) * 100);
        const when = file.created_at ? new Date(file.created_at).toLocaleString() : '—';
        return `
            <label class="flex items-center gap-2 p-2 rounded-md hover:bg-tg-hover cursor-pointer" data-row-id="${file.id}">
                <input type="checkbox" class="nsfw-del" data-id="${file.id}">
                <img loading="lazy" decoding="async"
                     class="w-14 h-14 object-cover rounded-md bg-tg-bg/40"
                     src="/api/thumbs/${encodeURIComponent(file.id)}?w=120"
                     onerror="this.style.display='none'" alt="">
                <div class="min-w-0 flex-1">
                    <div class="text-sm text-tg-text truncate">${escapeHtml(file.file_name || '')}</div>
                    <div class="text-xs text-tg-textSecondary truncate">${escapeHtml(file.group_name || file.group_id || '')} · ${when}</div>
                    <div class="text-[10px] text-tg-textSecondary mt-0.5">NSFW score: ${score}%</div>
                </div>
                <button type="button" data-whitelist="${file.id}"
                        class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue"
                        title="${escapeHtml(i18nT('maintenance.nsfw.mark_keep_title', 'Mark as 18+ — keep and skip future scans'))}">
                    ${escapeHtml(i18nT('maintenance.nsfw.mark_keep', 'Mark as 18+'))}
                </button>
                <a href="/files/${encodeURIComponent(file.file_path || '')}?inline=1" target="_blank" rel="noopener"
                   class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue"
                   title="${escapeHtml(i18nT('maintenance.nsfw.view_full', 'View full image'))}">
                    <i class="ri-eye-line"></i>
                </a>
            </label>`;
    };

    const wireActions = () => {
        listEl.querySelectorAll('.nsfw-del').forEach(cb => {
            if (cb.dataset.wired) return;
            cb.dataset.wired = '1';
            cb.addEventListener('change', refreshSummary);
        });
        listEl.querySelectorAll('[data-whitelist]').forEach(btn => {
            if (btn.dataset.wired) return;
            btn.dataset.wired = '1';
            btn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const id = Number(btn.dataset.whitelist);
                if (!id) return;
                btn.disabled = true;
                try {
                    await api.post('/api/maintenance/nsfw/whitelist', { ids: [id] });
                    const row = btn.closest('[data-row-id]');
                    if (row) row.remove();
                    removed.add(id);
                    refreshSummary();
                    showToast(i18nT('maintenance.nsfw.marked_kept', 'Marked as 18+ (kept)'), 'success');
                    refreshNsfwStatus();
                } catch (e) {
                    btn.disabled = false;
                    showToast(e?.data?.error || e.message || 'Failed', 'error');
                }
            });
        });
    };

    const appendRows = (rows) => {
        listEl.insertAdjacentHTML('beforeend', rows.map(renderRow).join(''));
        wireActions();
        refreshSummary();
    };

    allRows = firstPage.rows.slice();
    nextPage = 1;
    totalPages = firstPage.totalPages || 1;
    appendRows(firstPage.rows);
    if (totalPages > 1) loadMoreEl.classList.remove('hidden');

    const loadMore = async () => {
        if (loading) return;
        if (nextPage >= totalPages) {
            loadMoreEl.classList.add('hidden');
            return;
        }
        loading = true;
        try {
            const next = nextPage + 1;
            const r = await api.get(`/api/maintenance/nsfw/results?page=${next}&limit=50`);
            allRows = allRows.concat(r.rows || []);
            appendRows(r.rows || []);
            nextPage = next;
            if (nextPage >= totalPages) loadMoreEl.classList.add('hidden');
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        } finally {
            loading = false;
        }
    };

    if (loadMoreEl) {
        const obs = new IntersectionObserver((entries) => {
            for (const e of entries) if (e.isIntersecting) loadMore();
        }, { root: listEl.parentElement, rootMargin: '200px 0px 200px 0px', threshold: 0 });
        obs.observe(loadMoreEl);
    }

    root.querySelector('#nsfw-cancel-btn')?.addEventListener('click', () => sheet?.close());
    root.querySelector('#nsfw-delete-btn')?.addEventListener('click', async () => {
        const ids = [...root.querySelectorAll('.nsfw-del:checked')].map(el => Number(el.dataset.id));
        if (!ids.length) {
            showToast(i18nT('maintenance.nsfw.nothing', 'Nothing selected'), 'info');
            return;
        }
        const ok = await confirmSheet({
            title: i18nT('maintenance.nsfw.confirm_title', 'Delete selected photos?'),
            body: i18nTf('maintenance.nsfw.confirm_body',
                { n: ids.length },
                `Permanently delete ${ids.length} photo(s) from disk and database?`),
            confirmText: i18nT('maintenance.nsfw.confirm_btn', 'Delete'),
            destructive: true,
        });
        if (!ok) return;
        try {
            const r = await api.post('/api/maintenance/nsfw/delete', { ids });
            showToast(i18nTf('maintenance.nsfw.deleted',
                { removed: r.removed }, `Deleted ${r.removed} photos`), 'success');
            for (const id of ids) {
                const row = listEl.querySelector(`[data-row-id="${id}"]`);
                if (row) row.remove();
                removed.add(id);
            }
            refreshSummary();
            refreshNsfwStatus();
            if (listEl.children.length === 0) sheet?.close();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        }
    });
}
