// Backfill page — dedicated top-level surface for the History Backfill
// feature (formerly buried in the Group Settings modal). Three stacked
// cards: active jobs, start a new backfill, recent jobs (last 30 days).
//
// Server contract:
//   GET  /api/history/jobs               → { active: [...], past: [...] }
//   POST /api/history { groupId, limit } → { jobId, ... }
//   POST /api/history/:jobId/cancel
//
// WS events consumed:
//   history_progress  — patches a row in place
//   history_done      — flashes green ~2 s then drops the row
//   history_error     — flashes red, drops the row, shows toast
//   history_cancelled — flashes amber, drops the row, shows toast
//
// State is intentionally local — only the active-jobs map and the
// preselected group survive between renders. Recent jobs come from the
// server's JSON file (data/history-jobs.json) so a tab refresh always
// shows the canonical list.

import { state, getGroupName } from './store.js';
import { api } from './api.js';
import { ws } from './ws.js';
import { escapeHtml, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf, applyToDOM as applyI18n } from './i18n.js';

const PRESETS = [
    { value: 100, key: 'backfill.preset.last_100', fallback: 'Last 100' },
    { value: 1000, key: 'backfill.preset.last_1k', fallback: 'Last 1k' },
    { value: 10000, key: 'backfill.preset.last_10k', fallback: 'Last 10k' },
    { value: 0, key: 'backfill.preset.all', fallback: 'All' },
];

const activeJobs = new Map(); // jobId → { id, group, groupId, processed, downloaded, limit, startedAt, ... }
let recentJobs = [];          // server-provided list of finished jobs
let selectedGroupId = null;
let selectedLimit = 100;
let customLimitTouched = false;
let initialised = false;
let elapsedTimer = null;

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export function initBackfillPage() {
    if (initialised) return;
    initialised = true;

    setupGroupPicker();
    setupPresetRow();
    setupCustomLimit();
    setupStartButton();

    // WS event handlers — keep the page reactive even when the user
    // isn't currently looking at it (so re-opening shows a fresh state).
    ws.on('history_progress', onProgress);
    ws.on('history_done', onDone);
    ws.on('history_error', onError);
    ws.on('history_cancelled', onCancelled);
    // Server still emits this transitional event when a cancel is
    // requested but the loop hasn't bailed yet — surface it as a status.
    ws.on('history_cancelling', onCancelling);
}

/**
 * Called whenever the route lands on #/backfill (or #/backfill/<groupId>).
 * Loads the latest server-side snapshot and renders all three cards.
 */
export async function showBackfillPage(params = {}) {
    initBackfillPage();
    await refreshFromServer();
    if (params.groupId) preselectGroup(params.groupId);
    renderAll();
    startElapsedTimer();
}

/**
 * Called by the modal's quick-shortcut buttons — opens this page with a
 * group preselected and a limit applied (but doesn't auto-start, so the
 * user still has the chance to back out).
 */
export function deepLinkFromModal(groupId, limit) {
    selectedGroupId = String(groupId);
    selectedLimit = (limit === 0 || limit === '0') ? 0 : parseInt(limit, 10) || 100;
    customLimitTouched = false;
    const customInput = document.getElementById('backfill-custom-limit');
    if (customInput) customInput.value = '';
    // Hand off to the router — the route handler calls showBackfillPage()
    // which renders everything in the right order.
    location.hash = `#/backfill/${encodeURIComponent(String(groupId))}`;
}

// ────────────────────────────────────────────────────────────────────
// Server I/O
// ────────────────────────────────────────────────────────────────────

async function refreshFromServer() {
    try {
        const r = await api.get('/api/history/jobs');
        // Re-seed the in-memory active map from the server (covers
        // browser refreshes / first visits while a job is still running).
        const seen = new Set();
        for (const j of (r.active || [])) {
            seen.add(j.id);
            const existing = activeJobs.get(j.id) || {};
            activeJobs.set(j.id, { ...existing, ...j });
        }
        // Drop in-memory entries the server no longer reports active —
        // they finished while we were offline.
        for (const id of Array.from(activeJobs.keys())) {
            if (!seen.has(id)) activeJobs.delete(id);
        }
        recentJobs = (r.recent || r.past || []).slice(0, 30);
    } catch (e) {
        console.error('backfill: refreshFromServer', e);
    }
}

// ────────────────────────────────────────────────────────────────────
// WS handlers — patch state then re-render the affected card only.
// ────────────────────────────────────────────────────────────────────

function onProgress(m) {
    if (!m.jobId) return;
    const existing = activeJobs.get(m.jobId) || {};
    activeJobs.set(m.jobId, {
        ...existing,
        id: m.jobId,
        groupId: m.groupId || existing.groupId,
        group: m.group || existing.group,
        limit: m.limit !== undefined ? m.limit : existing.limit,
        startedAt: m.startedAt || existing.startedAt || Date.now(),
        processed: m.processed ?? existing.processed ?? 0,
        downloaded: m.downloaded ?? existing.downloaded ?? 0,
        state: 'running',
    });
    if (state.currentPage === 'backfill') renderActive();
}

function onDone(m) {
    if (!m.jobId) return;
    const existing = activeJobs.get(m.jobId);
    if (existing) {
        activeJobs.set(m.jobId, { ...existing, ...m, state: 'done', _flash: 'done' });
        if (state.currentPage === 'backfill') renderActive();
        // Drop the row after the green flash, then refresh recent.
        setTimeout(() => {
            activeJobs.delete(m.jobId);
            refreshFromServer().then(() => {
                if (state.currentPage === 'backfill') renderAll();
            });
        }, 2000);
    } else {
        // Job we never saw start — just refresh the recent list.
        refreshFromServer().then(() => {
            if (state.currentPage === 'backfill') renderAll();
        });
    }
}

function onError(m) {
    if (!m.jobId) return;
    const existing = activeJobs.get(m.jobId);
    if (existing) {
        activeJobs.set(m.jobId, { ...existing, state: 'error', error: m.error, _flash: 'error' });
        if (state.currentPage === 'backfill') renderActive();
        setTimeout(() => {
            activeJobs.delete(m.jobId);
            refreshFromServer().then(() => {
                if (state.currentPage === 'backfill') renderAll();
            });
        }, 2500);
    }
    showToast(i18nTf('backfill.row.failed', { msg: m.error || '' }, `Backfill failed: ${m.error || ''}`), 'error');
}

function onCancelled(m) {
    if (!m.jobId) return;
    const existing = activeJobs.get(m.jobId);
    if (existing) {
        activeJobs.set(m.jobId, { ...existing, state: 'cancelled', _flash: 'cancel' });
        if (state.currentPage === 'backfill') renderActive();
        setTimeout(() => {
            activeJobs.delete(m.jobId);
            refreshFromServer().then(() => {
                if (state.currentPage === 'backfill') renderAll();
            });
        }, 2000);
    }
    showToast(i18nT('toast.backfill_cancelled', 'Backfill cancelled'), 'info');
}

function onCancelling(m) {
    if (!m.jobId) return;
    const existing = activeJobs.get(m.jobId);
    if (existing) {
        activeJobs.set(m.jobId, { ...existing, state: 'cancelling' });
        if (state.currentPage === 'backfill') renderActive();
    }
}

// ────────────────────────────────────────────────────────────────────
// Card A — Active jobs
// ────────────────────────────────────────────────────────────────────

function renderActive() {
    const list = document.getElementById('backfill-active-list');
    const empty = document.getElementById('backfill-active-empty');
    if (!list) return;

    const jobs = Array.from(activeJobs.values()).sort(
        (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
    );

    if (jobs.length === 0) {
        list.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');

    list.innerHTML = jobs.map(job => renderActiveRow(job)).join('');

    // Wire cancel buttons.
    list.querySelectorAll('[data-cancel-job]').forEach(btn => {
        btn.addEventListener('click', () => cancelJob(btn.dataset.cancelJob));
    });
    // Wire "go to chat" links.
    list.querySelectorAll('[data-open-chat]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            location.hash = `#/viewer/${encodeURIComponent(el.dataset.openChat)}`;
        });
    });
}

function renderActiveRow(job) {
    const id = String(job.id);
    const groupName = getGroupName(job.groupId, { fallback: job.group || job.groupId });
    const target = job.limit === null || job.limit === 0
        ? i18nT('backfill.preset.all', 'All')
        : i18nTf('backfill.preset.last_n', { n: formatLimit(job.limit) }, `Last ${formatLimit(job.limit)}`);
    const processed = job.processed || 0;
    const downloaded = job.downloaded || 0;
    const elapsed = formatElapsed(Date.now() - (job.startedAt || Date.now()));
    const pct = (job.limit && job.limit > 0)
        ? Math.min(100, Math.round((processed / job.limit) * 100))
        : null;

    let flashClass = '';
    let stateBadge = '';
    if (job._flash === 'done') {
        flashClass = 'border-tg-green/50 bg-tg-green/10';
        stateBadge = `<span class="text-xs text-tg-green font-medium ml-2"><i class="ri-check-line"></i></span>`;
    } else if (job._flash === 'error') {
        flashClass = 'border-red-500/50 bg-red-500/10';
        stateBadge = `<span class="text-xs text-red-400 font-medium ml-2">${escapeHtml(i18nT('backfill.row.failed_short', 'failed'))}</span>`;
    } else if (job._flash === 'cancel') {
        flashClass = 'border-tg-warning/50 bg-tg-warning/10';
        stateBadge = `<span class="text-xs text-tg-warning font-medium ml-2">${escapeHtml(i18nT('backfill.row.cancelled', 'cancelled'))}</span>`;
    } else if (job.state === 'cancelling') {
        stateBadge = `<span class="text-xs text-tg-warning ml-2">${escapeHtml(i18nT('backfill.row.cancelling', 'cancelling…'))}</span>`;
    }

    const showCancel = job.state === 'running' && !job._flash;
    const progressBar = pct !== null
        ? `<div class="mt-2 h-1.5 bg-tg-bg/60 rounded-full overflow-hidden">
              <div class="h-full bg-tg-blue transition-all" style="width: ${pct}%"></div>
           </div>`
        : `<div class="mt-2 h-1.5 bg-tg-bg/60 rounded-full overflow-hidden">
              <div class="h-full bg-tg-blue/60 animate-pulse" style="width: 30%"></div>
           </div>`;

    return `
        <div class="rounded-lg border border-tg-border/40 ${flashClass} p-3 transition-colors" data-job-row="${escapeHtml(id)}">
            <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                    <a href="#/viewer/${encodeURIComponent(String(job.groupId || ''))}"
                       data-open-chat="${escapeHtml(String(job.groupId || ''))}"
                       class="text-sm font-medium text-tg-text truncate block hover:text-tg-blue">
                        ${escapeHtml(groupName)}
                    </a>
                    <div class="text-xs text-tg-textSecondary mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span><i class="ri-target-line"></i> ${escapeHtml(target)}</span>
                        <span><i class="ri-file-list-line"></i> ${escapeHtml(i18nTf('backfill.row.processed', { n: processed }, `${processed} processed`))}</span>
                        <span><i class="ri-download-line"></i> ${escapeHtml(i18nTf('backfill.row.downloaded', { n: downloaded }, `${downloaded} downloaded`))}</span>
                        <span data-elapsed="${job.startedAt || ''}"><i class="ri-time-line"></i> ${escapeHtml(i18nTf('backfill.row.elapsed', { t: elapsed }, `elapsed ${elapsed}`))}</span>
                        ${stateBadge}
                    </div>
                </div>
                ${showCancel ? `
                    <button type="button" data-cancel-job="${escapeHtml(id)}"
                        class="text-xs px-2.5 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-red-400 hover:border-red-400 transition-colors flex-shrink-0">
                        <i class="ri-stop-circle-line mr-1"></i>${escapeHtml(i18nT('backfill.row.cancel', 'Cancel'))}
                    </button>` : ''}
            </div>
            ${progressBar}
        </div>`;
}

async function cancelJob(jobId) {
    if (!jobId) return;
    if (!confirm(i18nT('backfill.row.cancel_confirm', 'Cancel this backfill?'))) return;
    try {
        await api.post(`/api/history/${encodeURIComponent(jobId)}/cancel`, {});
    } catch (e) {
        showToast(i18nTf('backfill.row.cancel_failed', { msg: e.message }, `Cancel failed: ${e.message}`), 'error');
    }
}

// ────────────────────────────────────────────────────────────────────
// Card B — Start a new backfill
// ────────────────────────────────────────────────────────────────────

function setupGroupPicker() {
    const input = document.getElementById('backfill-group-search');
    const results = document.getElementById('backfill-group-results');
    const clear = document.getElementById('backfill-group-clear');
    if (!input || !results) return;

    const renderResults = (q) => {
        const groups = (state.groups || []);
        const needle = q.toLowerCase().trim();
        const matched = needle
            ? groups.filter(g => {
                const name = getGroupName(g.id, { fallback: g.name }).toLowerCase();
                return name.includes(needle) || String(g.id).includes(needle);
              })
            : groups;
        if (matched.length === 0) {
            results.innerHTML = `<div class="p-2 text-xs text-tg-textSecondary">${escapeHtml(i18nT('backfill.start.no_results', 'No matching chats. Add one from the Chats page first.'))}</div>`;
            results.classList.remove('hidden');
            return;
        }
        results.innerHTML = matched.slice(0, 50).map(g => {
            const name = getGroupName(g.id, { fallback: g.name });
            return `
                <button type="button" data-pick-group="${escapeHtml(String(g.id))}"
                    class="w-full text-left px-3 py-2 hover:bg-tg-hover text-sm text-tg-text truncate block">
                    ${escapeHtml(name)}
                    <span class="text-xs text-tg-textSecondary ml-1">· ${escapeHtml(String(g.id))}</span>
                </button>`;
        }).join('');
        results.classList.remove('hidden');
        results.querySelectorAll('[data-pick-group]').forEach(btn => {
            btn.addEventListener('click', () => {
                preselectGroup(btn.dataset.pickGroup);
            });
        });
    };

    input.addEventListener('input', (e) => renderResults(e.target.value));
    input.addEventListener('focus', (e) => renderResults(e.target.value));
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !results.contains(e.target)) {
            results.classList.add('hidden');
        }
    });

    clear?.addEventListener('click', () => {
        selectedGroupId = null;
        renderSelectedGroup();
        input.value = '';
        input.focus();
    });
}

function preselectGroup(groupId) {
    selectedGroupId = String(groupId);
    const results = document.getElementById('backfill-group-results');
    if (results) results.classList.add('hidden');
    const input = document.getElementById('backfill-group-search');
    if (input) input.value = '';
    renderSelectedGroup();
}

function renderSelectedGroup() {
    const wrap = document.getElementById('backfill-group-selected');
    const nameEl = document.getElementById('backfill-group-selected-name');
    if (!wrap || !nameEl) return;
    if (!selectedGroupId) {
        wrap.classList.add('hidden');
        return;
    }
    const name = getGroupName(selectedGroupId, { fallback: selectedGroupId });
    nameEl.textContent = name;
    wrap.classList.remove('hidden');
    wrap.classList.add('flex');
}

function setupPresetRow() {
    const row = document.getElementById('backfill-preset-row');
    if (!row) return;
    row.innerHTML = PRESETS.map(p => `
        <button type="button" data-preset-limit="${p.value}"
            class="px-3 py-1.5 rounded-full text-xs border transition-colors"
            data-i18n="${p.key}">${escapeHtml(p.fallback)}</button>
    `).join('');
    row.querySelectorAll('[data-preset-limit]').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedLimit = parseInt(btn.dataset.presetLimit, 10);
            customLimitTouched = false;
            const custom = document.getElementById('backfill-custom-limit');
            if (custom) custom.value = '';
            renderPresetSelection();
            renderStartWarn();
        });
    });
    renderPresetSelection();
}

function renderPresetSelection() {
    const row = document.getElementById('backfill-preset-row');
    if (!row) return;
    const effective = customLimitTouched ? -1 : selectedLimit;
    row.querySelectorAll('[data-preset-limit]').forEach(btn => {
        const val = parseInt(btn.dataset.presetLimit, 10);
        const active = val === effective;
        btn.classList.toggle('bg-tg-blue', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-tg-blue', active);
        btn.classList.toggle('text-tg-textSecondary', !active);
        btn.classList.toggle('border-tg-border', !active);
        btn.classList.toggle('hover:text-tg-text', !active);
    });
}

function setupCustomLimit() {
    const input = document.getElementById('backfill-custom-limit');
    if (!input) return;
    input.addEventListener('input', () => {
        customLimitTouched = !!input.value.trim();
        renderPresetSelection();
        renderStartWarn();
    });
}

function renderStartWarn() {
    const warn = document.getElementById('backfill-start-warn');
    if (!warn) return;
    const lim = effectiveLimit();
    warn.classList.toggle('hidden', lim !== 0);
}

function effectiveLimit() {
    if (customLimitTouched) {
        const v = parseInt(document.getElementById('backfill-custom-limit')?.value, 10);
        if (!Number.isFinite(v) || v < 1) return null; // invalid
        return Math.min(50000, Math.max(1, v));
    }
    return selectedLimit;
}

function setupStartButton() {
    const btn = document.getElementById('backfill-start-btn');
    if (!btn) return;
    btn.addEventListener('click', startBackfill);
}

async function startBackfill() {
    const btn = document.getElementById('backfill-start-btn');
    const lim = effectiveLimit();
    if (!selectedGroupId) {
        showToast(i18nT('backfill.start.warn_pick', 'Pick a chat first'), 'warning');
        return;
    }
    if (lim === null) {
        showToast(i18nT('backfill.start.warn_limit', 'Enter a valid limit'), 'warning');
        return;
    }
    const groupName = getGroupName(selectedGroupId, { fallback: selectedGroupId });
    if (lim === 0) {
        if (!confirm(i18nT('group.backfill.all_confirm',
            'Backfill ALL history for this chat? This may take hours and download a lot of data.'))) return;
    } else {
        if (!confirm(i18nTf('group.backfill.confirm_n', { n: lim, name: groupName }, `Download the last ${lim} messages of "${groupName}" into the queue?`))) return;
    }

    if (btn) {
        btn.disabled = true;
        const span = btn.querySelector('span[data-i18n]');
        if (span) span.textContent = i18nT('backfill.start.button_running', 'Starting…');
    }
    try {
        const r = await api.post('/api/history', { groupId: selectedGroupId, limit: lim });
        showToast(i18nT('toast.backfill_started', 'Backfill started'), 'success');
        // Optimistically seed the active row so the user sees instant
        // feedback even if the first WS event takes a beat.
        if (r?.jobId) {
            activeJobs.set(r.jobId, {
                id: r.jobId,
                group: groupName,
                groupId: selectedGroupId,
                limit: lim === 0 ? null : lim,
                processed: 0,
                downloaded: 0,
                startedAt: Date.now(),
                state: 'running',
            });
            renderActive();
        }
    } catch (e) {
        showToast(i18nTf('group.backfill.failed', { msg: e.message }, `History failed: ${e.message}`), 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            const span = btn.querySelector('span[data-i18n]');
            if (span) span.textContent = i18nT('backfill.start.button', 'Start backfill');
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Card C — Recent jobs
// ────────────────────────────────────────────────────────────────────

function renderRecent() {
    const list = document.getElementById('backfill-recent-list');
    const empty = document.getElementById('backfill-recent-empty');
    if (!list) return;

    if (!recentJobs.length) {
        list.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');

    list.innerHTML = recentJobs.map(j => renderRecentRow(j)).join('');

    list.querySelectorAll('[data-rerun]').forEach(btn => {
        btn.addEventListener('click', () => rerunFromRecent(btn.dataset.rerun));
    });
}

function renderRecentRow(job) {
    const id = String(job.id);
    const name = getGroupName(job.groupId, { fallback: job.group || job.groupId });
    const target = job.limit === null || job.limit === 0
        ? i18nT('backfill.preset.all', 'All')
        : i18nTf('backfill.preset.last_n', { n: formatLimit(job.limit) }, `Last ${formatLimit(job.limit)}`);
    const when = job.finishedAt ? new Date(job.finishedAt).toLocaleString()
        : (job.startedAt ? new Date(job.startedAt).toLocaleString() : '—');

    let statePill = '';
    if (job.state === 'done') {
        statePill = `<span class="text-xs px-2 py-0.5 rounded-full bg-tg-green/15 text-tg-green">${escapeHtml(i18nT('backfill.row.done', 'Done'))}</span>`;
    } else if (job.state === 'cancelled') {
        statePill = `<span class="text-xs px-2 py-0.5 rounded-full bg-tg-warning/15 text-tg-warning">${escapeHtml(i18nT('backfill.row.cancelled', 'Cancelled'))}</span>`;
    } else if (job.state === 'error') {
        statePill = `<span class="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400" title="${escapeHtml(job.error || '')}">${escapeHtml(i18nT('backfill.row.failed', 'Failed'))}</span>`;
    }

    return `
        <div class="rounded-lg border border-tg-border/40 p-3" data-recent-row="${escapeHtml(id)}">
            <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-tg-text truncate">${escapeHtml(name)}</div>
                    <div class="text-xs text-tg-textSecondary mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span><i class="ri-target-line"></i> ${escapeHtml(target)}</span>
                        <span><i class="ri-file-list-line"></i> ${escapeHtml(i18nTf('backfill.row.processed', { n: job.processed || 0 }, `${job.processed || 0} processed`))}</span>
                        <span><i class="ri-download-line"></i> ${escapeHtml(i18nTf('backfill.row.downloaded', { n: job.downloaded || 0 }, `${job.downloaded || 0} downloaded`))}</span>
                        <span><i class="ri-time-line"></i> ${escapeHtml(when)}</span>
                    </div>
                    ${job.state === 'error' && job.error ? `<div class="text-xs text-red-400 mt-1 truncate">${escapeHtml(job.error)}</div>` : ''}
                </div>
                <div class="flex flex-col items-end gap-1.5 flex-shrink-0">
                    ${statePill}
                    <button type="button" data-rerun="${escapeHtml(id)}"
                        class="text-xs px-2.5 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue transition-colors">
                        <i class="ri-refresh-line mr-1"></i>${escapeHtml(i18nT('backfill.row.run_again', 'Run again'))}
                    </button>
                </div>
            </div>
        </div>`;
}

async function rerunFromRecent(jobId) {
    const job = recentJobs.find(j => String(j.id) === String(jobId));
    if (!job) return;
    selectedGroupId = String(job.groupId);
    selectedLimit = (job.limit === null || job.limit === 0) ? 0 : (job.limit || 100);
    customLimitTouched = false;
    const customInput = document.getElementById('backfill-custom-limit');
    if (customInput) customInput.value = '';
    renderSelectedGroup();
    renderPresetSelection();
    renderStartWarn();
    await startBackfill();
}

// ────────────────────────────────────────────────────────────────────
// Render entry points + helpers
// ────────────────────────────────────────────────────────────────────

function renderAll() {
    renderActive();
    renderRecent();
    renderSelectedGroup();
    renderPresetSelection();
    renderStartWarn();
    // Re-translate any fresh DOM that we just injected.
    const root = document.getElementById('page-backfill');
    if (root) applyI18n(root);
}

function startElapsedTimer() {
    if (elapsedTimer) return;
    elapsedTimer = setInterval(() => {
        if (state.currentPage !== 'backfill') return;
        document.querySelectorAll('#backfill-active-list [data-elapsed]').forEach(el => {
            const startedAt = parseInt(el.dataset.elapsed, 10);
            if (!Number.isFinite(startedAt) || !startedAt) return;
            const t = formatElapsed(Date.now() - startedAt);
            const label = i18nTf('backfill.row.elapsed', { t }, `elapsed ${t}`);
            el.innerHTML = `<i class="ri-time-line"></i> ${escapeHtml(label)}`;
        });
    }, 1000);
}

function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (m < 60) return `${m}m ${sec}s`;
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${h}h ${min}m`;
}

function formatLimit(n) {
    if (n === null || n === undefined) return '∞';
    if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
    return String(n);
}
