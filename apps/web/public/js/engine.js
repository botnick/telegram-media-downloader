// Engine (monitor runtime) controller — drives the Engine card in Settings.
//
// As of v2.3.31 the per-row Live downloads list that used to live in this
// card is gone — the Queue page (sortable, filterable, paged) does that
// job in one canonical place. The Engine card focuses on monitor lifecycle
// (start/stop, error banner) and headline counters (queue / active /
// downloaded / uptime). The "View full queue" link beneath the buttons
// hands the user off to the dedicated page when they want detail.

import { api } from './api.js';
import { showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { subscribe as subscribeMonitorStatus, refreshNow as refreshMonitorStatus } from './monitor-status.js';

const $ = (id) => document.getElementById(id);

function formatUptime(ms) {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function applyStatus(status) {
    if (!status) return;
    const pill = $('engine-pill');
    const startBtn = $('engine-start');
    const stopBtn = $('engine-stop');
    const errEl = $('engine-error');
    const stateLabels = {
        running: { text: i18nT('settings.engine.running', 'Running'), cls: 'bg-tg-green/20 text-tg-green' },
        starting: { text: i18nT('settings.engine.starting', 'Starting…'), cls: 'bg-tg-blue/20 text-tg-blue' },
        stopping: { text: i18nT('settings.engine.stopping', 'Stopping…'), cls: 'bg-tg-orange/20 text-tg-orange' },
        stopped: { text: i18nT('settings.engine.stopped', 'Stopped'), cls: 'bg-gray-700 text-gray-300' },
        error: { text: i18nT('settings.engine.error', 'Error'), cls: 'bg-red-500/20 text-red-300' },
    };
    const lbl = stateLabels[status.state] || stateLabels.stopped;
    if (pill) {
        pill.textContent = lbl.text;
        pill.className = `ml-auto text-xs px-2 py-0.5 rounded-full ${lbl.cls}`;
    }
    if (startBtn && stopBtn) {
        const running = status.state === 'running' || status.state === 'starting';
        startBtn.classList.toggle('hidden', running);
        stopBtn.classList.toggle('hidden', !running);
    }
    if (errEl) {
        if (status.error) {
            errEl.textContent = status.error;
            errEl.classList.remove('hidden');
        } else {
            errEl.classList.add('hidden');
        }
    }
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('engine-queue', status.queue ?? 0);
    set('engine-active', status.active ?? 0);
    set('engine-downloaded', status.stats?.downloaded ?? 0);
    set('engine-uptime', formatUptime(status.uptimeMs));
}

// Refresh helper — kept as a thin alias around the shared monitor-status
// module so existing call sites in this file (WS handlers below) keep
// reading naturally.
function refresh() { refreshMonitorStatus(); }

export function initEngine() {
    // Idempotency guard — initEngine() runs every time the user navigates
    // to the Settings page. Without this, each visit stacked another
    // click listener on engine-start/stop, so after N visits a single
    // click fired N concurrent POSTs to /api/monitor/start.
    if (initEngine._wired) {
        // Already initialised — just kick a refresh to repopulate the
        // visible card; no need to spin up another poller because the
        // shared monitor-status module handles cadence centrally.
        refresh();
        return;
    }
    initEngine._wired = true;

    $('engine-start')?.addEventListener('click', async () => {
        $('engine-start').disabled = true;
        try {
            const r = await api.post('/api/monitor/start');
            applyStatus(r.status);
            showToast(i18nT('toast.monitor_started', 'Monitor started'), 'success');
        } catch (e) {
            showToast(i18nTf('toast.monitor_start_failed', { msg: e.message }, `Start failed: ${e.message}`), 'error');
        } finally {
            $('engine-start').disabled = false;
        }
    });
    $('engine-stop')?.addEventListener('click', async () => {
        $('engine-stop').disabled = true;
        try {
            const r = await api.post('/api/monitor/stop');
            applyStatus(r.status);
            showToast(i18nT('toast.monitor_stopped', 'Monitor stopped'), 'info');
        } catch (e) {
            showToast(i18nTf('toast.monitor_stop_failed', { msg: e.message }, `Stop failed: ${e.message}`), 'error');
        } finally {
            $('engine-stop').disabled = false;
        }
    });

    // Subscribe to the shared monitor-status poller — same data the
    // statusbar and onboarding modules consume, but only one HTTP request.
    subscribeMonitorStatus(applyStatus);
}

export function handleEngineWsMessage(msg) {
    if (msg.type === 'monitor_state') {
        applyStatus({ state: msg.state, error: msg.error });
        setTimeout(refresh, 100);
        return;
    }
    if (msg.type === 'history_progress' || msg.type === 'history_done'
        || msg.type === 'history_error' || msg.type === 'history_cancelled') {
        refresh();
        return;
    }
    // server.js does `broadcast({type:'monitor_event', ...e})` where `e` is
    // `{type, payload}` — the spread overwrites the outer type, so engine
    // events arrive at the WS as `{type:'download_progress', payload:{...}}`
    // (or _complete / _error / _start, etc.). The Engine card's headline
    // counters are refreshed via the shared monitor-status poller, so we
    // only need to forward lifecycle/queue-length deltas here.
    if (msg.type === 'download_complete' || msg.type === 'download_start'
        || msg.type === 'download_error' || msg.type === 'queue_length') {
        refresh();
    }
}
