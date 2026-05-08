// Maintenance — Video faststart optimiser (admin page).
//
// One action: walk every catalogued MP4 / MOV / M4V / 3GP, rewrite the
// ones whose `moov` atom is not at the head of the file with
// `ffmpeg -movflags +faststart -c copy`. Stream-copy means no quality
// loss; the operation is I/O bound and finishes in seconds per file.
//
// Drives the same fire-and-forget contract as the thumbs build flow:
// POST kicks off, server emits `faststart_progress` then a final
// `faststart_done` over WS, status endpoint recovers in-flight state on
// page reopen.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;

// Compact relative-time formatter — same buckets as the duplicates page
// for consistent freshness language across maintenance tools.
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

async function _refreshStats() {
    const elTotal = $('video-stat-total');
    const elOpt = $('video-stat-optimized');
    const elPend = $('video-stat-pending');
    const elSkip = $('video-stat-skipped');
    const elLast = $('video-stat-last');
    const elSummary = $('video-stat-summary');
    const ffmpegChip = $('video-no-ffmpeg');
    try {
        const r = await api.get('/api/maintenance/faststart/stats');
        if (elTotal) elTotal.textContent = String(r.total ?? 0);
        if (elOpt) elOpt.textContent = String(r.optimized ?? 0);
        if (elPend) elPend.textContent = String(r.pending ?? 0);
        // "Skipped" lumps together missing-on-disk + non-MP4 containers
        // + unreadable files. Operators care that they're not pending,
        // not which sub-bucket they fell into.
        const skipped = (r.missing ?? 0) + (r.unknown ?? 0) + (r.ext_skip ?? 0);
        if (elSkip) elSkip.textContent = String(skipped);
        if (ffmpegChip) ffmpegChip.classList.toggle('hidden', r.ffmpegAvailable !== false);

        // Persisted last-run summary — survives server restart, so a
        // fresh dashboard visit can answer "did this even run before?".
        const last = r?.lastRun;
        if (elLast) {
            if (last && last.finishedAt) {
                elLast.textContent = _formatRelative(last.finishedAt);
                elLast.title = new Date(last.finishedAt).toLocaleString();
            } else {
                elLast.textContent = i18nT('maintenance.duplicates.stats.last_scan_never', 'Never');
                elLast.title = '';
            }
        }
        if (elSummary) {
            if (last && last.finishedAt) {
                elSummary.textContent = i18nTf(
                    'maintenance.video.last_run_result',
                    {
                        optimized: (last.optimized || 0).toLocaleString(),
                        already: (last.already || 0).toLocaleString(),
                        skipped: (last.skipped || 0).toLocaleString(),
                        scanned: (last.scanned || 0).toLocaleString(),
                    },
                    `Last run: ${last.optimized || 0} optimised · ${last.already || 0} already faststart · ${last.skipped || 0} skipped (scanned ${last.scanned || 0})`,
                );
                elSummary.classList.remove('hidden');
            } else {
                elSummary.classList.add('hidden');
            }
        }
    } catch {
        /* leave stale values */
    }
}

function _setUi(running) {
    const btn = $('video-scan-btn');
    const progress = $('video-progress');
    const bar = $('video-progress-bar');
    const pctEl = $('video-progress-pct');
    if (btn) {
        btn.disabled = !!running;
        // Label-span swap pattern preserves the icon — `btn.textContent
        // = …` would erase the <i ri-…> child along with the label.
        const labelSpan = btn.querySelector('span[data-i18n]');
        if (labelSpan) {
            labelSpan.textContent = running
                ? i18nT('maintenance.video.scanning', 'Optimising…')
                : i18nT('maintenance.video.scan_all', 'Optimise all');
        }
    }
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running) {
        if (bar) bar.style.width = '0%';
        if (pctEl) pctEl.textContent = '';
    }
}

async function _scanAll() {
    _setUi(true);
    try {
        const r = await api.post('/api/maintenance/faststart/scan', {});
        if (r?.error) {
            showToast(r.error, 'error');
            _setUi(false);
            return;
        }
        // Done toast is fired by the WS handler in `_wireWs()` when the
        // sweep actually completes (with real numbers). No optimistic
        // toast here — the operator will see the bar fill regardless.
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
        _setUi(false);
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('faststart_progress', (m) => {
        const bar = $('video-progress-bar');
        const status = $('video-progress-status');
        const pctEl = $('video-progress-pct');
        const progress = $('video-progress');
        if (progress) progress.classList.remove('hidden');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round(((m.processed || 0) / total) * 100));
        bar.style.width = pct + '%';
        if (status) {
            status.textContent = i18nTf(
                'maintenance.video.progress',
                {
                    processed: m.processed || 0,
                    total: m.total || 0,
                    optimized: m.optimized || 0,
                },
                `${m.processed || 0} / ${m.total || 0} · ${m.optimized || 0} optimised`,
            );
        }
        if (pctEl) {
            pctEl.textContent =
                m.total > 0
                    ? `${pct}% · ${(m.processed || 0).toLocaleString()} / ${(m.total || 0).toLocaleString()}`
                    : '';
        }
    });
    ws.on('faststart_done', (m) => {
        _setUi(false);
        if (m?.error) {
            showToast(m.error, 'error');
        } else {
            showToast(
                i18nTf(
                    'maintenance.video.done',
                    {
                        optimized: m?.optimized || 0,
                        already: m?.already || 0,
                        scanned: m?.scanned || 0,
                    },
                    `Optimised ${m?.optimized || 0}, ${m?.already || 0} already faststart out of ${m?.scanned || 0}`,
                ),
                'success',
            );
        }
        _refreshStats().catch(() => {});
    });
}

async function _recoverState() {
    try {
        const r = await api.get('/api/maintenance/faststart/status');
        if (r?.running) _setUi(true);
    } catch {
        /* status endpoint failures are non-fatal */
    }
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        $('video-scan-btn')?.addEventListener('click', _scanAll);
    }
    _refreshStats();
    _recoverState();
}
