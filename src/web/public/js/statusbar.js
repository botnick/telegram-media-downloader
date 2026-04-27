// Sticky status bar — runtime state, queue, active workers, disk usage, WS link.

import { api } from './api.js';
import { ws } from './ws.js';
import { formatBytes, showToast } from './utils.js';
import { t as i18nT } from './i18n.js';
import { subscribe as subscribeMonitorStatus, refreshNow as refreshMonitorStatus } from './monitor-status.js';

const $ = (id) => document.getElementById(id);
let statsPollHandle = null;

function applyState(state) {
    const dot = $('status-dot');
    const lbl = $('status-state');
    const map = {
        running: { color: 'bg-tg-green', text: i18nT('status.monitor_running', 'Monitor running') },
        starting: { color: 'bg-tg-blue', text: i18nT('status.starting', 'Starting…') },
        stopping: { color: 'bg-tg-orange', text: i18nT('status.stopping', 'Stopping…') },
        stopped: { color: 'bg-gray-500', text: i18nT('status.idle', 'Idle') },
        error: { color: 'bg-tg-red', text: i18nT('status.error', 'Error') },
    };
    const m = map[state] || map.stopped;
    if (dot) dot.className = `w-2 h-2 rounded-full ${m.color}`;
    if (lbl) lbl.textContent = m.text;
}

function applyMonitor(mon) {
    if (!mon) return;
    applyState(mon.state);
    const q = $('status-queue'); if (q) q.textContent = mon.queue ?? 0;
    const a = $('status-active'); if (a) a.textContent = mon.active ?? 0;
    // Bottom-nav engine badge — surface "there's something happening on
    // the Engine page" without forcing the user to navigate there. The
    // queue tab already has its own badge sourced from queue.js (which
    // counts queued + active jobs by polling the queue snapshot); this
    // one mirrors the same idea but reads from /api/monitor/status so
    // it works even when queue.js's WS-driven store hasn't booted.
    const navBadge = $('engine-nav-badge');
    if (navBadge) {
        const total = (Number(mon.queue) || 0) + (Number(mon.active) || 0);
        if (total > 0) {
            navBadge.textContent = total > 99 ? '99+' : String(total);
            navBadge.classList.remove('hidden');
        } else {
            navBadge.classList.add('hidden');
        }
    }
}

async function refreshStats() {
    try {
        const stats = await api.get('/api/stats').catch(() => null);
        if (stats) {
            const f = $('status-files'); if (f) f.textContent = stats.totalFiles ?? 0;
            const d = $('status-disk'); if (d) d.textContent = stats.diskUsageFormatted || formatBytes(stats.diskUsage || 0);
        }
    } catch { /* keep last values */ }
}

async function paintVersion() {
    const el = $('status-version');
    if (!el) return;
    try {
        const r = await api.get('/api/version').catch(() => null);
        if (!r) return;
        const short = r.commit && r.commit !== 'dev' ? r.commit : 'dev';
        // v2.2.0 · a1b2c3d   ← compact, mono, click → repo
        el.textContent = `v${r.version} · ${short}`;
        if (r.builtAt) {
            const d = new Date(r.builtAt);
            if (!isNaN(d)) el.title = `built ${d.toLocaleString()} · commit ${r.commit}`;
        }
        // Pin the link to the actual commit on GitHub when we have a real SHA.
        if (r.commit && r.commit !== 'dev') {
            el.href = `https://github.com/botnick/telegram-media-downloader/commit/${r.commit}`;
        }
    } catch { /* best-effort cosmetic */ }
}

// Update-check: poll /api/version/check (server-cached at 6 h) and surface a
// "vX.Y.Z" pill next to the version chip if a newer GitHub release exists.
// Per-version dismissal lives in localStorage so we don't nag forever; a
// per-session toast fires once so the user notices even if the chip is off-
// screen on a narrow viewport. Cosmetic — fail-soft on every error path.
const UPDATE_DISMISS_KEY = 'tgdl.update.dismissed';
const UPDATE_TOASTED_KEY = 'tgdl.update.toasted';
async function paintUpdateBadge() {
    const badge = $('status-update-badge');
    const dismiss = $('status-update-dismiss');
    if (!badge) return;
    const hide = () => {
        badge.classList.add('hidden');
        if (dismiss) dismiss.classList.add('hidden');
    };
    try {
        const r = await api.get('/api/version/check').catch(() => null);
        if (!r || !r.updateAvailable || !r.latest) { hide(); return; }
        if (localStorage.getItem(UPDATE_DISMISS_KEY) === r.latest) { hide(); return; }

        const latest = r.latest;
        badge.textContent = `${i18nT('update.available', 'Update available')} → ${latest}`;
        badge.title = i18nT('update.click_for_release', 'v{version} is out — click to view release notes').replace('{version}', latest);
        badge.href = r.releaseUrl || `https://github.com/botnick/telegram-media-downloader/releases/tag/${latest}`;
        badge.classList.remove('hidden');
        if (dismiss) {
            dismiss.classList.remove('hidden');
            // Re-bind on every paint since the badge may render different
            // versions over the lifetime of the tab; guard against
            // double-fires from rapid clicks before hide() lands.
            let dismissing = false;
            dismiss.onclick = () => {
                if (dismissing) return;
                dismissing = true;
                try { localStorage.setItem(UPDATE_DISMISS_KEY, latest); } catch { /* private mode */ }
                hide();
            };
        }

        if (sessionStorage.getItem(UPDATE_TOASTED_KEY) !== latest) {
            try { sessionStorage.setItem(UPDATE_TOASTED_KEY, latest); } catch { /* private mode */ }
            const msg = i18nT('update.toast', 'Update available — {version}').replace('{version}', latest);
            showToast(msg, 'info', 6000);
        }
    } catch { hide(); }
}

let _updatePollHandle = null;
let _booted = false;

export function initStatusBar() {
    // Idempotent — a stray double call (hot-reload, recovery flow) would
    // otherwise re-bind every WS handler below and fire each event 2×.
    if (_booted) return;
    _booted = true;

    // Build/version chip — fired once at boot, then on every config_updated
    // (which usually means the SPA was reloaded into a new container).
    paintVersion();
    ws.on('config_updated', paintVersion);

    // Update-check chip — one fetch at boot, refresh every 6 h (server caches).
    paintUpdateBadge();
    if (_updatePollHandle) clearInterval(_updatePollHandle);
    _updatePollHandle = setInterval(paintUpdateBadge, 6 * 60 * 60 * 1000);

    // Monitor state/queue/active: piggy-back on the shared monitor-status
    // poller (one /api/monitor/status fetch, three subscribers).
    subscribeMonitorStatus(applyMonitor);

    // Stats are heavier (disk walk + DB scan on the server). WS events
    // (download_complete / file_deleted / bulk_delete / purge_*) push
    // freshness already; the 60-second poll is just a safety net for
    // missed events / WS disconnects.
    refreshStats();
    if (statsPollHandle) clearInterval(statsPollHandle);
    statsPollHandle = setInterval(refreshStats, 60000);

    // Refresh on every event that mutates the file/disk counters so we
    // don't sit on stale numbers between safety-poll ticks.
    const wsRefresh = () => refreshStats();
    ws.on('download_complete', wsRefresh);
    ws.on('file_deleted', wsRefresh);
    ws.on('bulk_delete', wsRefresh);
    ws.on('purge_all', wsRefresh);
    ws.on('group_purged', wsRefresh);

    // Live cues from the WebSocket
    ws.on('__ws_open', () => {
        const dot = $('status-ws'); if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-tg-green mr-1';
    });
    ws.on('__ws_close', () => {
        const dot = $('status-ws'); if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-tg-red mr-1';
    });
    // Surface a one-time toast + offer manual retry when ws.js gives up
    // after MAX_ATTEMPTS_BEFORE_PAUSE so the user isn't left looking at a
    // dead red dot with no way to recover other than F5.
    ws.on('__ws_giveup', () => {
        const dot = $('status-ws');
        if (dot) {
            dot.className = 'inline-block w-2 h-2 rounded-full bg-tg-orange mr-1 cursor-pointer';
            dot.title = i18nT('ws.giveup_retry', 'Connection lost — click to retry');
            dot.onclick = () => {
                dot.className = 'inline-block w-2 h-2 rounded-full bg-gray-500 mr-1';
                dot.onclick = null;
                ws.retry();
            };
        }
        showToast(i18nT('ws.giveup', 'Lost connection to server — click WS dot to retry.'), 'warning', 8000);
    });
    ws.on('monitor_state', (m) => applyState(m.state));
    ws.on('*', (m) => {
        // refresh counters on relevant events; ignore most chatter to avoid stalls
        if (m.type && /^(download_complete|history_done|file_deleted|group_purged|purge_all|monitor_event)$/.test(m.type)) {
            refreshMonitorStatus();
            refreshStats();
        }
    });
}
