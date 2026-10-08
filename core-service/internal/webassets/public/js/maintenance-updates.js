// Maintenance — Updates panel.
//
// Surfaces the update_history audit trail so an operator can see which
// past Install update clicks succeeded, which failed, and why. The
// chooser sheet (the existing badge-click flow in statusbar.js) is the
// canonical install entry — the "Retry update" button on this page just
// re-opens it.
//
// Owns:
//   - Header with status pill (Up to date / Update available).
//   - Trigger button — opens the existing chooser sheet so install logic
//     stays in one place.
//   - History list — the last 25 update_history rows, prettiest fields
//     first (when, version transition, status, error if any, snapshot
//     size if any).
//
// The lazy stall sweep on the server side runs on every /api/update/history
// GET, so a row that watchtower failed to recreate surfaces here without
// waiting for the next process restart.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, formatRelativeTime } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { _openUpdateChooser } from './statusbar.js';

const $ = (id) => document.getElementById(id);

let _wired = false;
let _wsWired = false;
let _state = { available: false, latest: null };

function _renderStats(history) {
    const versionEl = $('updates-stat-version');
    const lastEl = $('updates-stat-last');
    const pendingEl = $('updates-stat-pending');
    if (versionEl) {
        // Prefer the live /api/version response we get from refreshStatus
        // (cached on _state.current); fall back to the package-time const
        // already on window if the status call hasn't returned.
        const v = _state.current || (window.APP_VERSION ?? null);
        versionEl.textContent = v ? `v${v}` : '—';
    }
    if (lastEl) {
        const top = (history || [])[0];
        lastEl.textContent = top?.created_at
            ? formatRelativeTime(top.created_at)
            : i18nT('update.stats.never', 'Never');
    }
    if (pendingEl) {
        if (_state.available && _state.latest) {
            pendingEl.textContent = `v${_state.latest}`;
            pendingEl.classList.add('text-tg-orange');
            pendingEl.classList.remove('text-tg-text');
        } else {
            pendingEl.textContent = i18nT('update.stats.up_to_date', 'Up to date');
            pendingEl.classList.remove('text-tg-orange');
            pendingEl.classList.add('text-tg-text');
        }
    }
}

function _formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _formatRelative(unixMs) {
    const t = Number(unixMs) || 0;
    if (!t) return '—';
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

function _statusPill(status) {
    const cls = {
        triggered: 'bg-tg-blue/15 text-tg-blue',
        success: 'bg-tg-green/15 text-tg-green',
        failed: 'bg-tg-red/15 text-tg-red',
        stalled: 'bg-tg-orange/15 text-tg-orange',
    };
    const label = i18nT(`update.history.status_${status}`, status);
    return `<span class="inline-block px-2 py-0.5 rounded text-[11px] font-medium ${cls[status] || 'bg-tg-bg/50 text-tg-textSecondary'}">${label}</span>`;
}

function _versionCell(row) {
    const from = row.from_version ? `v${row.from_version}` : '—';
    const to = row.to_version ? `v${row.to_version}` : '…';
    if (row.status === 'success' && to !== '…') return `${from} → ${to}`;
    return from;
}

function _errorCell(row) {
    if (!row.error_code) return '';
    const codeKey = `update.error.${row.error_code}`;
    const translated = i18nT(codeKey, '');
    const human = translated && translated !== codeKey ? translated : row.error_msg || '';
    const safeCode = String(row.error_code).replace(/[^A-Z0-9_]/g, '');
    const safeHuman = String(human).replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `
        <div class="text-xs">
            <code class="text-[10px] uppercase tracking-wide text-tg-textSecondary">${safeCode}</code>
            <div class="text-tg-text mt-0.5">${safeHuman}</div>
        </div>`;
}

function _backupCell(row) {
    if (!row.backup_path) return '';
    const fname = String(row.backup_path).replace(/^.*[\\/]/, '');
    const safeFname = fname.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`);
    const sz = row.backup_bytes ? _formatBytes(row.backup_bytes) : '';
    return `<div class="text-xs"><div class="font-mono text-tg-textSecondary truncate" title="${safeFname}">${safeFname}</div>${sz ? `<div class="text-[11px] text-tg-textSecondary mt-0.5">${sz}</div>` : ''}</div>`;
}

function _renderRows(rows) {
    if (!rows || rows.length === 0) {
        return `<div class="text-center py-8 text-sm text-tg-textSecondary">${i18nT('update.history.empty', 'No updates have been triggered from this dashboard yet.')}</div>`;
    }
    const head = `
        <thead>
            <tr class="text-left text-[11px] uppercase tracking-wide text-tg-textSecondary border-b border-tg-border/40">
                <th class="py-2 px-2">${i18nT('update.history.col_when', 'When')}</th>
                <th class="py-2 px-2">${i18nT('update.history.col_versions', 'Version')}</th>
                <th class="py-2 px-2">${i18nT('update.history.col_status', 'Status')}</th>
                <th class="py-2 px-2">${i18nT('update.history.col_error', 'Error')}</th>
                <th class="py-2 px-2">${i18nT('update.history.col_backup', 'Snapshot')}</th>
            </tr>
        </thead>`;
    const body = rows
        .map(
            (r) => `
        <tr class="border-b border-tg-border/20 align-top">
            <td class="py-2 px-2 text-xs text-tg-textSecondary whitespace-nowrap">${_formatRelative(r.started_at)}</td>
            <td class="py-2 px-2 text-xs whitespace-nowrap">${_versionCell(r)}</td>
            <td class="py-2 px-2 whitespace-nowrap">${_statusPill(r.status)}</td>
            <td class="py-2 px-2">${_errorCell(r)}</td>
            <td class="py-2 px-2">${_backupCell(r)}</td>
        </tr>`,
        )
        .join('');
    return `<table class="w-full text-sm">${head}<tbody>${body}</tbody></table>`;
}

async function _refresh() {
    const list = $('updates-history-list');
    if (!list) return;
    try {
        const r = await api.get('/api/update/history?limit=25');
        list.innerHTML = _renderRows(r?.history || []);
        _renderStats(r?.history || []);
    } catch (e) {
        list.innerHTML = `<div class="text-center py-8 text-sm text-tg-red">${e?.message || 'Failed to load update history'}</div>`;
        _renderStats([]);
    }
}

async function _refreshStatus() {
    try {
        const s = await api.get('/api/update/status');
        _state = { ..._state, ...s };
        // Pull the running version so the stats tile can show it. Cheap;
        // the handler reads from process.env / package.json once per call.
        try {
            const cur = await api.get('/api/version');
            _state.current = cur?.version || null;
        } catch {
            /* keep last */
        }
        const card = $('updates-status-card');
        if (!card) return;
        const triggerBtn = $('updates-trigger-btn');
        if (s.available) {
            // Try to fetch the latest version so the button reads
            // "Install vX.Y.Z" rather than a generic label. /api/version/check
            // is server-cached so this is cheap.
            try {
                const v = await api.get('/api/version/check');
                _state.latest = v?.latest || null;
                if (triggerBtn) {
                    if (v?.updateAvailable && v?.latest) {
                        triggerBtn.disabled = false;
                        triggerBtn.innerHTML = `<i class="ri-download-cloud-2-line"></i><span>${i18nTf('update.install_now', { version: v.latest }, `Install v${v.latest}`)}</span>`;
                    } else {
                        triggerBtn.disabled = true;
                        triggerBtn.innerHTML = `<i class="ri-check-line"></i><span>${i18nT('maintenance.update.up_to_date_btn', 'Up to date')}</span>`;
                    }
                }
            } catch {
                /* network blip — leave button text alone */
            }
        } else {
            if (triggerBtn) {
                triggerBtn.disabled = true;
                triggerBtn.innerHTML = `<i class="ri-information-line"></i><span>${i18nT('update.install_disabled', 'Install (unavailable)')}</span>`;
            }
        }
    } catch {
        /* status endpoint unreachable — keep last known state */
    }
}

export async function init() {
    const root = $('page-maintenance-updates');
    if (!root) return;
    if (!_wired) {
        _wired = true;
        $('updates-refresh-btn')?.addEventListener('click', _refresh);
        $('updates-trigger-btn')?.addEventListener('click', async () => {
            if (!_state.available || !_state.latest) {
                showToast(
                    i18nT('maintenance.update.up_to_date', 'Already running the latest release.'),
                    'info',
                    4000,
                );
                return;
            }
            try {
                await _openUpdateChooser(_state.latest, null);
            } catch (e) {
                showToast(e?.message || 'Failed to open update sheet', 'error');
            }
        });
    }
    if (!_wsWired) {
        _wsWired = true;
        ws.on('update_started', () => _refresh());
        ws.on('update_done', () => _refresh());
    }
    await Promise.all([_refreshStatus(), _refresh()]);
}
