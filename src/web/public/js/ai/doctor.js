// Doctor card — renders /api/ai/health output and surfaces actionable
// guidance when something is broken.
//
// Always visible. If every check is OK we render a single green pill so
// the operator knows we did look. Failed checks render with the
// platform-specific recommendation so the operator can fix it without
// having to dig through documentation.

import { aiGet } from './api.js';
import { update, get, on } from './state.js';
import { escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';

const ROOT_ID = 'ai-doctor-card';

function _fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function _icon(check) {
    if (check.ok) return '<i class="ri-checkbox-circle-fill text-tg-green" aria-hidden="true"></i>';
    if (check.optional)
        return '<i class="ri-information-line text-tg-textSecondary" aria-hidden="true"></i>';
    return '<i class="ri-error-warning-fill text-red-400" aria-hidden="true"></i>';
}

function _renderCheck(check) {
    const label = i18nT(`maintenance.ai.doctor.check.${check.name}`, check.name);
    const detail = [];
    if (check.version) detail.push(`v${escapeHtml(check.version)}`);
    if (check.libvips) detail.push(`libvips ${escapeHtml(check.libvips)}`);
    if (check.dir) detail.push(escapeHtml(check.dir));
    if (Number.isFinite(check.freeBytes)) {
        detail.push(
            i18nTf(
                'maintenance.ai.doctor.free_bytes',
                { size: _fmtBytes(check.freeBytes) },
                `${_fmtBytes(check.freeBytes)} free`,
            ),
        );
    }
    if (check.error)
        detail.push(`<span class="text-red-400">${escapeHtml(check.error.slice(0, 240))}</span>`);
    if (check.note)
        detail.push(`<span class="text-tg-textSecondary">${escapeHtml(check.note)}</span>`);
    const recommendation = check.recommendation
        ? `<div class="ai-doctor-fix mt-1 text-[11px] text-tg-textSecondary">→ ${escapeHtml(check.recommendation)}</div>`
        : '';
    return `
        <div class="ai-doctor-row flex items-start gap-2 py-1">
            <div class="shrink-0 pt-0.5">${_icon(check)}</div>
            <div class="flex-1 min-w-0">
                <div class="text-tg-text text-xs font-medium">${escapeHtml(label)}${check.optional ? ` <span class="text-tg-textSecondary text-[10px]">(${escapeHtml(i18nT('maintenance.ai.doctor.optional', 'optional'))})</span>` : ''}</div>
                <div class="text-[11px] text-tg-textSecondary">${detail.join(' · ')}</div>
                ${recommendation}
            </div>
        </div>
    `;
}

function _render(state) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const h = state.health;
    if (!h) {
        root.classList.remove('hidden');
        root.innerHTML = `
            <div class="text-tg-textSecondary text-xs flex items-center gap-2">
                <i class="ri-loader-4-line animate-spin" aria-hidden="true"></i>
                <span>${escapeHtml(i18nT('maintenance.ai.doctor.loading', 'Running diagnostics…'))}</span>
            </div>
        `;
        return;
    }
    root.classList.remove('hidden');
    const headline = h.ok
        ? `<span class="text-tg-green">● ${escapeHtml(i18nT('maintenance.ai.doctor.headline_ok', 'All systems go'))}</span>`
        : `<span class="text-red-400">● ${escapeHtml(i18nT('maintenance.ai.doctor.headline_bad', 'Something needs attention'))}</span>`;
    const platform = `${h.platform || ''}${h.arch ? ` · ${h.arch}` : ''}${h.nodeVersion ? ` · Node ${h.nodeVersion}` : ''}`;
    root.innerHTML = `
        <div class="flex items-start justify-between gap-2 mb-2">
            <div>
                <div class="text-tg-text text-sm font-semibold">${escapeHtml(i18nT('maintenance.ai.doctor.heading', 'Doctor'))}</div>
                <div class="text-[11px] text-tg-textSecondary mt-0.5">${headline} <span class="text-tg-textSecondary">· ${escapeHtml(platform)}</span></div>
            </div>
            <button id="ai-doctor-refresh" type="button"
                    class="tg-btn-secondary text-[11px] px-2 py-1"
                    title="${escapeHtml(i18nT('maintenance.ai.doctor.refresh', 'Re-run checks'))}">
                <i class="ri-refresh-line" aria-hidden="true"></i>
            </button>
        </div>
        <div class="ai-doctor-list">
            ${(h.checks || []).map(_renderCheck).join('')}
        </div>
    `;
    document.getElementById('ai-doctor-refresh')?.addEventListener('click', () => refresh());
}

export async function refresh() {
    try {
        const r = await aiGet('/api/ai/health');
        update({ health: r });
    } catch (err) {
        update({
            health: {
                ok: false,
                checks: [
                    {
                        name: 'health-endpoint',
                        ok: false,
                        error: err?.message || String(err),
                        recommendation: 'The /api/ai/health endpoint failed. Check server logs.',
                    },
                ],
                recommendations: [],
                platform: navigator?.platform || '',
                nodeVersion: '',
            },
        });
    }
}

let _off = null;
export function init() {
    if (_off) return;
    _off = on(_render);
    _render(get());
    refresh();
}

export function dispose() {
    if (_off) {
        _off();
        _off = null;
    }
}
