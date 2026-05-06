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

async function _refreshStats() {
    const elTotal = $('video-stat-total');
    const elOpt = $('video-stat-optimized');
    const elPend = $('video-stat-pending');
    const elSkip = $('video-stat-skipped');
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
    } catch {
        /* leave stale values */
    }
}

function _setUi(running) {
    const btn = $('video-scan-btn');
    const progress = $('video-progress');
    const bar = $('video-progress-bar');
    if (btn) {
        btn.disabled = !!running;
        btn.textContent = running
            ? i18nT('maintenance.video.scanning', 'Optimising…')
            : i18nT('maintenance.video.scan_all', 'Optimise all');
    }
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running && bar) bar.style.width = '0%';
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
