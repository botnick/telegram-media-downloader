// Maintenance — Thumbnails (admin page).
//
// Two actions:
//   - Build all: walks every catalogued file and generates a WebP thumb
//     where one's missing. Live thumbs_progress WS events drive the bar.
//   - Wipe cache: deletes every cached thumb so the next gallery scroll
//     regenerates them on demand. Confirm-gated.
//
// Stats panel pulls /api/maintenance/thumbs/stats — total cached count,
// disk bytes, ffmpeg availability, allowed widths.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { loadAdvanced, setupAutoSave } from './settings.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;

function _formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function _refreshStats() {
    const countEl = $('thumbs-stat-count');
    const bytesEl = $('thumbs-stat-bytes');
    const ffmpegChip = $('thumbs-no-ffmpeg');
    const widthsEl = $('thumbs-stat-widths');
    const breakdownEl = $('thumbs-breakdown');
    try {
        const r = await api.get('/api/maintenance/thumbs/stats');
        if (countEl) countEl.textContent = String(r.count ?? 0);
        if (bytesEl) bytesEl.textContent = _formatBytes(r.bytes);
        if (widthsEl && Array.isArray(r.allowedWidths)) {
            // Render each allowed width as a chip — the slash-joined
            // string read like a phone number; chips communicate "these
            // are distinct picker options the server will serve at".
            widthsEl.innerHTML = r.allowedWidths.map((w) =>
                `<span class="inline-flex items-center px-1.5 py-0.5 rounded-md bg-tg-blue/15 text-tg-blue text-[11px] font-medium tabular-nums">${Number(w) || 0}<span class="text-tg-blue/70 ml-0.5">px</span></span>`
            ).join('');
        }
        if (ffmpegChip) {
            ffmpegChip.classList.toggle('hidden', r.ffmpegAvailable !== false);
        }
        if (breakdownEl) {
            const byKind = r.byKind || r.kinds || null;
            if (byKind && typeof byKind === 'object') {
                const order = ['image', 'photo', 'video', 'audio', 'other'];
                const entries = Object.entries(byKind).sort(
                    (a, b) => (order.indexOf(a[0]) - order.indexOf(b[0])));
                breakdownEl.innerHTML = entries.map(([k, v]) => `
                    <div class="bg-tg-bg/40 rounded-lg p-2 text-center">
                        <div class="text-xs text-tg-textSecondary uppercase tracking-wide">${k}</div>
                        <div class="text-lg font-semibold text-tg-text tabular-nums">${Number(v) || 0}</div>
                    </div>`).join('');
            } else {
                breakdownEl.innerHTML = '';
            }
        }
    } catch {
        // leave stale values; non-fatal
    }
}

function _setBuildUi(running) {
    const btn = $('thumbs-build-btn');
    const progress = $('thumbs-progress');
    const bar = $('thumbs-progress-bar');
    if (btn) {
        btn.disabled = !!running;
        btn.textContent = running
            ? i18nT('maintenance.thumbs.building', 'Building…')
            : i18nT('maintenance.thumbs.build_all', 'Build all');
    }
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running && bar) bar.style.width = '0%';
}

// `POST /api/maintenance/thumbs/build-all` is fire-and-forget — it
// returns 200 with `{started:true}` immediately and runs the actual
// build in the background, broadcasting `thumbs_progress` then a final
// `thumbs_done`. The client just kicks it off and hands UI completion
// to the WS handlers in `_wireWs()`. Closing the tab no longer kills
// work in flight; reopening the page calls `/build/status` to recover.
async function _buildAll() {
    _setBuildUi(true);
    try {
        const r = await api.post('/api/maintenance/thumbs/build-all', {});
        if (r?.error) {
            showToast(r.error, 'error');
            _setBuildUi(false);
            return;
        }
        // Toast intentionally omitted here — `thumbs_done` will fire one
        // when the build actually finishes (with real numbers).
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setBuildUi(false);
    }
}

async function _wipeCache() {
    const ok = await confirmSheet({
        title: i18nT('maintenance.thumbs.rebuild_title', 'Rebuild thumbnail cache?'),
        message: i18nT('maintenance.thumbs.rebuild_body', 'Wipes every cached thumbnail. The next gallery scroll regenerates them on demand. Useful when previews look stale or after a quality tweak.'),
        confirmLabel: i18nT('maintenance.thumbs.rebuild_confirm', 'Wipe cache'),
        danger: true,
    });
    if (!ok) return;
    const btn = $('thumbs-wipe-btn');
    if (btn) btn.disabled = true;
    // Fire-and-forget: a 100k-thumb cache walk takes time. The done
    // toast fires from the `thumbs_rebuild_done` WS handler so a
    // sibling tab on a phone re-paints this desktop's button too.
    try {
        const r = await api.post('/api/maintenance/thumbs/rebuild', {});
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        if (btn) btn.disabled = false;
    }
}

function _setWipeUi(running) {
    const btn = $('thumbs-wipe-btn');
    if (btn) btn.disabled = !!running;
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('thumbs_progress', (m) => {
        const bar = $('thumbs-progress-bar');
        const status = $('thumbs-progress-status');
        // Make sure the progress UI is visible even if the user just
        // re-opened the page mid-build (init's `/build/status` recovery
        // path handles the cold case, but a WS-arriving-first race is
        // possible too).
        const progress = $('thumbs-progress');
        if (progress) progress.classList.remove('hidden');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round((m.processed || 0) / total * 100));
        bar.style.width = pct + '%';
        if (status) {
            status.textContent = i18nTf('maintenance.thumbs.progress',
                { processed: m.processed || 0, total: m.total || 0, built: m.built || 0 },
                `${m.processed || 0} / ${m.total || 0} · ${m.built || 0} built`);
        }
    });
    ws.on('thumbs_done', (m) => {
        _setBuildUi(false);
        if (m?.error) {
            showToast(m.error, 'error');
        } else {
            showToast(i18nTf('maintenance.thumbs.done',
                { built: m?.built || 0, skipped: m?.skipped || 0, scanned: m?.scanned || 0 },
                `Built ${m?.built || 0}, ${m?.skipped || 0} already cached out of ${m?.scanned || 0}`),
                'success');
        }
        _refreshStats().catch(() => {});
    });
    // Wipe-cache (purgeAllThumbs) — separate tracker, separate events.
    ws.on('thumbs_rebuild_progress', () => _setWipeUi(true));
    ws.on('thumbs_rebuild_done', (m) => {
        _setWipeUi(false);
        if (m?.error) {
            showToast(m.error, 'error');
        } else {
            showToast(i18nTf('maintenance.thumbs.rebuilt',
                { removed: m?.removed || 0 },
                `Wiped ${m?.removed || 0} cached thumbnails`), 'success');
        }
        _refreshStats().catch(() => {});
    });
}

// Recover live state on (re-)entry — covers the close-tab → reopen flow
// for both build-all and wipe-cache.
async function _recoverBuildState() {
    try {
        const r = await api.get('/api/maintenance/thumbs/build/status');
        if (r?.running) _setBuildUi(true);
    } catch { /* status endpoint failures are non-fatal */ }
    try {
        const r = await api.get('/api/maintenance/thumbs/rebuild/status');
        if (r?.running) _setWipeUi(true);
    } catch {}
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        $('thumbs-build-btn')?.addEventListener('click', _buildAll);
        $('thumbs-wipe-btn')?.addEventListener('click', _wipeCache);
    }
    // Hydrate the Decoder backend dropdown from /api/config + arm the
    // shared autosave so picking a backend persists immediately. Same
    // pipeline the Settings page uses.
    (async () => {
        try {
            const cfg = await api.get('/api/config');
            loadAdvanced(cfg);
        } catch { /* select still operable; autosave still wired */ }
        try { setupAutoSave(); } catch {}
    })();
    _refreshStats();
    _recoverBuildState();
}
