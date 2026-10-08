// NSFW review tool UI — Maintenance status line + scan button + badge.
//
// Lives in its own module so the main settings.js stays focused on
// general preferences. Lazy-imported by settings.js when wireMaintenance
// runs, so the initial paint doesn't pay for it.
//
// The full review experience lives at /maintenance/nsfw (dedicated
// page). This module owns only the hub card surface: status line,
// scan/cancel button, model-status pill, and the unseen-candidates
// badge that dismisses itself once the operator visits the page.

import { api } from './api.js';
import { showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const LS_LAST_SEEN = 'tgdl.nsfw.lastSeen';
// Re-read on every refresh so the badge dismisses promptly when the
// dedicated /maintenance/nsfw page bumps the counter on landing.
function _readLastSeen() {
    try {
        return parseInt(localStorage.getItem(LS_LAST_SEEN) || '0', 10) || 0;
    } catch {
        return 0;
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
            statusEl.textContent =
                '· ' +
                i18nT(
                    'maintenance.nsfw.disabled',
                    'Disabled. Enable in Settings → Advanced → NSFW review tool.',
                );
            if (reviewBtn) reviewBtn.classList.add('hidden');
            if (badge) badge.classList.add('hidden');
            if (progress) progress.classList.add('hidden');
            if (scanBtn) {
                scanBtn.disabled = true;
                scanBtn.classList.add('opacity-50');
            }
            return;
        }
        if (scanBtn) {
            scanBtn.disabled = false;
            scanBtn.classList.remove('opacity-50');
        }
        const eligible = s.totalEligible || 0;
        const scanned = s.scanned || 0;
        const candidates = s.candidates || 0;
        const last = s.lastCheckedAt
            ? _formatRelTime(s.lastCheckedAt)
            : i18nT('maintenance.nsfw.never_scanned', 'never scanned');
        statusEl.textContent =
            '· ' +
            i18nTf(
                'maintenance.nsfw.summary',
                { scanned, eligible, candidates, when: last },
                `${scanned} / ${eligible} scanned · ${candidates} possibly not 18+ · last: ${last}`,
            );

        if (badge) {
            const unseen = candidates > _readLastSeen();
            badge.textContent = candidates > 99 ? '99+' : String(candidates);
            badge.classList.toggle('hidden', !unseen || candidates === 0);
        }
        if (reviewBtn) {
            reviewBtn.classList.toggle('hidden', candidates === 0);
            reviewBtn.textContent = i18nTf(
                'maintenance.nsfw.review_n',
                { n: candidates },
                `Review ${candidates}`,
            );
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
        statusEl.textContent =
            '· ' + i18nT('maintenance.nsfw.status_unavailable', 'status unavailable');
    }
}

export async function maintNsfwScan() {
    const btn = document.getElementById('maint-nsfw-scan-btn');
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
        refreshNsfwStatus();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Scan failed', 'error');
    } finally {
        btn.disabled = false;
    }
}
