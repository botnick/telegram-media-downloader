// Maintenance — Recovery cleanup (admin page).
//
// Surfaces every group whose id starts with `unknown:` OR whose
// `_resolveFailedAt` is set. The list comes from
// `GET /api/maintenance/recovery/list`; bulk operations go through
// `/api/maintenance/recovery/{resolve,disable,delete,reassign}`.
//
// Owns:
//   - One-shot fetch + render of the list (chunked render).
//   - Bulk-select toolbar (checkboxes + per-row actions).
//   - Live progress bar via the `recoveryBulk` JobTracker WS events.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const $ = (id) => document.getElementById(id);

let _items = [];
let _selected = new Set();
let _accounts = [];
let _wsWired = false;
let _pageWired = false;
let _refreshing = false;
let _showIgnored = false;

const REASON_LABELS = {
    index_miss: 'maintenance.recovery.reason.index_miss',
    empty_folder: 'maintenance.recovery.reason.empty_folder',
    probe_empty: 'maintenance.recovery.reason.probe_empty',
};

function _formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

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

function _reasonText(it) {
    const code = String(it.resolveFailedReason || (it.isSynthetic ? 'index_miss' : 'unknown'));
    const head = code.split(':')[0];
    if (head === 'banned' || code.startsWith('banned:')) {
        return i18nT(
            'maintenance.recovery.reason.banned',
            'Channel exists but the loaded account was banned / kicked.',
        );
    }
    if (head === 'probe_failed' || code.startsWith('probe_failed:')) {
        const detail = code.split(':')[1] || '';
        return i18nTf(
            'maintenance.recovery.reason.probe_failed',
            { code: detail },
            `Probe failed: ${detail || 'unknown error'}`,
        );
    }
    const key = REASON_LABELS[head];
    if (key) {
        return i18nT(
            key,
            head === 'index_miss'
                ? "Folder not in any loaded account's dialogs."
                : head === 'empty_folder'
                  ? 'Synthetic id has no folder name.'
                  : 'Probe returned no message.',
        );
    }
    return code;
}

function _renderRow(it) {
    const checked = _selected.has(it.id) ? 'checked' : '';
    const enabledPill = it.enabled
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-tg-green/15 text-tg-green" data-i18n="maintenance.recovery.enabled">enabled</span>`
        : `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700/40 text-gray-300" data-i18n="maintenance.recovery.disabled">disabled</span>`;
    const synthBadge = it.isSynthetic
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-tg-orange/15 text-tg-orange ml-1" title="${escapeHtml(i18nT('maintenance.recovery.synthetic_tip', 'Synthetic unknown:* id'))}">synthetic</span>`
        : '';
    const ignoredBadge = it.recoveryIgnored
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-600/30 text-gray-400 ml-1" title="${escapeHtml(i18nT('maintenance.recovery.ignored_tip', 'Suppressed from this list'))}"><i class="ri-eye-off-line"></i> ${escapeHtml(i18nT('maintenance.recovery.ignored_badge', 'ignored'))}</span>`
        : '';
    const accountBadge = it.monitorAccount
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-tg-blue/15 text-tg-blue ml-1"><i class="ri-user-3-line"></i> ${escapeHtml(it.monitorAccount)}</span>`
        : '';
    return `
        <div class="bg-tg-panel rounded-xl p-3 border border-tg-border/30 hover:border-tg-blue/40 transition-colors" data-rec-row="${escapeHtml(it.id)}">
            <div class="flex items-start gap-3">
                <input type="checkbox" class="rec-row-check shrink-0 mt-1.5 rounded border-tg-border bg-tg-bg accent-tg-blue" data-id="${escapeHtml(it.id)}" ${checked}>
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm text-tg-text font-medium truncate">${escapeHtml(it.name)}</span>
                        ${enabledPill}${synthBadge}${ignoredBadge}${accountBadge}
                    </div>
                    <p class="text-[11px] text-tg-textSecondary mt-0.5">${escapeHtml(_reasonText(it))}</p>
                    <div class="text-[11px] text-tg-textSecondary/70 mt-1 inline-flex items-center gap-2 flex-wrap">
                        <span><i class="ri-file-copy-2-line"></i> ${escapeHtml((it.fileCount || 0).toLocaleString())} ${i18nT('maintenance.recovery.files', 'files')}</span>
                        ${
                            it.lastSeenAt
                                ? `<span class="text-tg-textSecondary/50">·</span><span><i class="ri-time-line"></i> ${escapeHtml(_formatRelative(it.lastSeenAt))}</span>`
                                : ''
                        }
                        <span class="text-tg-textSecondary/50">·</span>
                        <code class="text-[10px] font-mono text-tg-textSecondary/80">${escapeHtml(it.id.slice(0, 60))}</code>
                    </div>
                </div>
            </div>
        </div>`;
}

function _renderStats() {
    const host = $('recovery-stats');
    if (!host) return;
    const total = _items.length;
    const synthetic = _items.filter((i) => i.isSynthetic).length;
    const totalFiles = _items.reduce((s, i) => s + (Number(i.fileCount) || 0), 0);
    const enabled = _items.filter((i) => i.enabled).length;
    const ignored = _items.filter((i) => i.recoveryIgnored).length;
    const ignoredStat =
        _showIgnored && ignored > 0
            ? `<div class="bg-tg-bg/40 rounded-lg p-3 text-center">
            <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.recovery.stat.ignored">Ignored</div>
            <div class="text-xl font-semibold text-gray-400 tabular-nums">${ignored}</div>
        </div>`
            : '';
    host.innerHTML = `
        <div class="bg-tg-bg/40 rounded-lg p-3 text-center">
            <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.recovery.stat.total">Unresolved</div>
            <div class="text-xl font-semibold text-tg-text tabular-nums">${total}</div>
        </div>
        <div class="bg-tg-bg/40 rounded-lg p-3 text-center">
            <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.recovery.stat.synthetic">Synthetic ids</div>
            <div class="text-xl font-semibold text-tg-orange tabular-nums">${synthetic}</div>
        </div>
        <div class="bg-tg-bg/40 rounded-lg p-3 text-center">
            <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.recovery.stat.enabled">Still enabled</div>
            <div class="text-xl font-semibold text-tg-text tabular-nums">${enabled}</div>
        </div>
        <div class="bg-tg-bg/40 rounded-lg p-3 text-center">
            <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.recovery.stat.files">Files</div>
            <div class="text-xl font-semibold text-tg-text tabular-nums">${totalFiles.toLocaleString()}</div>
        </div>
        ${ignoredStat}`;
}

function _renderList() {
    const list = $('recovery-list');
    const empty = $('recovery-empty');
    const toolbar = $('recovery-toolbar');
    const stats = $('recovery-stats');
    if (!list) return;
    if (!_items.length) {
        list.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        if (toolbar) toolbar.classList.add('hidden');
        if (stats) stats.classList.add('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');
    if (toolbar) toolbar.classList.remove('hidden');
    if (stats) stats.classList.remove('hidden');
    _renderStats();
    list.innerHTML = _items.map(_renderRow).join('');
    _renderSelectionState();
}

function _renderSelectionState() {
    const count = _selected.size;
    const txt = $('recovery-selected-count');
    if (txt) {
        txt.textContent = count
            ? i18nTf('maintenance.recovery.selected', { n: count }, `${count} selected`)
            : '';
    }
    const all = $('recovery-select-all');
    if (all) {
        all.checked = count === _items.length && count > 0;
        all.indeterminate = count > 0 && count < _items.length;
    }
    // Reassign select — only show + populate when ≥1 row is selected AND
    // multiple accounts are loaded (otherwise pinning is pointless).
    const sel = $('recovery-reassign-select');
    if (sel) {
        if (count > 0 && _accounts.length > 1) {
            sel.classList.remove('hidden');
        } else {
            sel.classList.add('hidden');
        }
    }
}

async function _refresh() {
    if (_refreshing) return;
    _refreshing = true;
    try {
        const r = await api.get(
            `/api/maintenance/recovery/list${_showIgnored ? '?showIgnored=1' : ''}`,
        );
        _items = Array.isArray(r?.items) ? r.items : [];
        // Drop stale selections.
        const ids = new Set(_items.map((i) => i.id));
        for (const k of [..._selected]) if (!ids.has(k)) _selected.delete(k);
        _renderList();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    } finally {
        _refreshing = false;
    }
}

async function _loadAccounts() {
    try {
        const r = await api.get('/api/dialogs?accountsOnly=1').catch(() => null);
        _accounts = Array.isArray(r?.accounts) ? r.accounts : [];
        const sel = $('recovery-reassign-select');
        if (!sel) return;
        sel.innerHTML =
            `<option value="">${escapeHtml(i18nT('maintenance.recovery.reassign_placeholder', 'Pin to account…'))}</option>` +
            _accounts
                .map(
                    (a) =>
                        `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.username || a.id)}</option>`,
                )
                .join('');
    } catch {
        _accounts = [];
    }
}

function _selectedIds() {
    return [..._selected];
}

function _wireActions() {
    const list = $('recovery-list');
    if (!list) return;
    list.addEventListener('change', (e) => {
        const cb = e.target.closest('.rec-row-check');
        if (!cb) return;
        const id = cb.dataset.id;
        if (!id) return;
        if (cb.checked) _selected.add(id);
        else _selected.delete(id);
        _renderSelectionState();
    });
    const all = $('recovery-select-all');
    all?.addEventListener('change', () => {
        if (all.checked) {
            for (const it of _items) _selected.add(it.id);
        } else {
            _selected.clear();
        }
        _renderList();
    });
    $('recovery-resolve-btn')?.addEventListener('click', async () => {
        const ids = _selectedIds();
        if (!ids.length) {
            showToast(i18nT('maintenance.recovery.nothing_selected', 'Nothing selected'), 'info');
            return;
        }
        try {
            await api.post('/api/maintenance/recovery/resolve', { ids });
            showToast(i18nT('maintenance.recovery.resolve_started', 'Re-resolve started'), 'info');
        } catch (e) {
            if (e?.data?.code === 'ALREADY_RUNNING') {
                showToast(i18nT('jobs.already_running', 'Already running on another tab'), 'info');
            } else {
                showToast(e?.data?.error || e.message || 'Failed', 'error');
            }
        }
    });
    $('recovery-disable-btn')?.addEventListener('click', async () => {
        const ids = _selectedIds();
        if (!ids.length) return;
        try {
            const r = await api.post('/api/maintenance/recovery/disable', { ids });
            showToast(
                i18nTf(
                    'maintenance.recovery.disabled_n',
                    { n: r.disabled || 0 },
                    `Disabled ${r.disabled || 0} group(s)`,
                ),
                'success',
            );
            _selected.clear();
            await _refresh();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        }
    });
    $('recovery-delete-btn')?.addEventListener('click', async () => {
        const ids = _selectedIds();
        if (!ids.length) return;
        const purgeDownloads = await confirmSheet({
            title: i18nT('maintenance.recovery.delete_confirm_title', 'Delete from monitor list?'),
            message: i18nTf(
                'maintenance.recovery.delete_confirm_body',
                { n: ids.length },
                `Remove ${ids.length} group(s) from your monitor list. Click "Delete" to remove from config; pick "Delete + purge data" to also drop their downloaded files from the database.`,
            ),
            confirmLabel: i18nT('maintenance.recovery.delete_only', 'Delete (config only)'),
            cancelLabel: i18nT('common.cancel', 'Cancel'),
            danger: true,
        });
        if (purgeDownloads === false || purgeDownloads === undefined || purgeDownloads === null)
            return;
        try {
            const r = await api.post('/api/maintenance/recovery/delete', {
                ids,
                purgeDownloads: false,
            });
            showToast(
                i18nTf(
                    'maintenance.recovery.deleted_n',
                    { n: r.removed || 0 },
                    `Removed ${r.removed || 0} group(s)`,
                ),
                'success',
            );
            _selected.clear();
            await _refresh();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        }
    });
    $('recovery-show-ignored')?.addEventListener('change', async (e) => {
        _showIgnored = e.target.checked;
        const unignoreBtn = $('recovery-unignore-btn');
        const ignoreBtn = $('recovery-ignore-btn');
        if (unignoreBtn) unignoreBtn.classList.toggle('hidden', !_showIgnored);
        if (ignoreBtn) ignoreBtn.classList.toggle('hidden', _showIgnored);
        await _refresh();
    });
    $('recovery-ignore-btn')?.addEventListener('click', async () => {
        const ids = _selectedIds();
        if (!ids.length) {
            showToast(i18nT('maintenance.recovery.nothing_selected', 'Nothing selected'), 'info');
            return;
        }
        try {
            const r = await api.post('/api/maintenance/recovery/ignore', { ids });
            showToast(
                i18nTf(
                    'maintenance.recovery.ignored_n',
                    { n: r.ignored || 0 },
                    `Ignored ${r.ignored || 0} group(s)`,
                ),
                'success',
            );
            _selected.clear();
            await _refresh();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        }
    });
    $('recovery-unignore-btn')?.addEventListener('click', async () => {
        const ids = _selectedIds();
        if (!ids.length) {
            showToast(i18nT('maintenance.recovery.nothing_selected', 'Nothing selected'), 'info');
            return;
        }
        try {
            const r = await api.post('/api/maintenance/recovery/unignore', { ids });
            showToast(
                i18nTf(
                    'maintenance.recovery.unignored_n',
                    { n: r.unignored || 0 },
                    `Unignored ${r.unignored || 0} group(s)`,
                ),
                'success',
            );
            _selected.clear();
            await _refresh();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        }
    });
    const reassignSel = $('recovery-reassign-select');
    reassignSel?.addEventListener('change', async () => {
        const v = reassignSel.value;
        if (!v) return;
        const ids = _selectedIds();
        if (!ids.length) {
            reassignSel.value = '';
            return;
        }
        try {
            const r = await api.post('/api/maintenance/recovery/reassign', {
                ids,
                monitorAccount: v,
            });
            showToast(
                i18nTf(
                    'maintenance.recovery.reassigned_n',
                    { n: r.reassigned || 0, account: v },
                    `Pinned ${r.reassigned || 0} group(s) to ${v}`,
                ),
                'success',
            );
            await _refresh();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        } finally {
            reassignSel.value = '';
        }
    });
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('recovery_bulk_progress', (m) => {
        const bar = $('recovery-progress-bar');
        const pr = $('recovery-progress');
        const txt = $('recovery-progress-text');
        if (pr) pr.classList.remove('hidden');
        if (txt) txt.classList.remove('hidden');
        if (m.total > 0 && bar) {
            const pct = Math.min(100, Math.round((m.processed / m.total) * 100));
            bar.style.width = pct + '%';
        }
        if (txt) {
            txt.textContent = i18nTf(
                'maintenance.recovery.progress',
                { processed: m.processed || 0, total: m.total || 0 },
                `${m.processed || 0} / ${m.total || 0}`,
            );
        }
    });
    ws.on('recovery_bulk_done', async (m) => {
        const pr = $('recovery-progress');
        const txt = $('recovery-progress-text');
        if (pr) pr.classList.add('hidden');
        if (txt) txt.classList.add('hidden');
        if (m?.error) {
            showToast(
                i18nTf(
                    'maintenance.recovery.bulk_failed',
                    { msg: m.error },
                    `Bulk failed: ${m.error}`,
                ),
                'error',
            );
        } else if (m?.resolved) {
            showToast(
                i18nTf(
                    'maintenance.recovery.resolved_n',
                    { n: m.resolved, total: m.total },
                    `Resolved ${m.resolved}/${m.total} group(s)`,
                ),
                'success',
            );
        }
        await _refresh();
    });
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        _wireActions();
    }
    _refresh();
    _loadAccounts();
}
