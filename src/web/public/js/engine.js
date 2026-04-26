// Engine (monitor runtime) controller — drives the Engine card in Settings.

import { api } from './api.js';
import { showToast } from './utils.js';

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
        running: { text: 'Running', cls: 'bg-tg-green/20 text-tg-green' },
        starting: { text: 'Starting…', cls: 'bg-tg-blue/20 text-tg-blue' },
        stopping: { text: 'Stopping…', cls: 'bg-tg-orange/20 text-tg-orange' },
        stopped: { text: 'Stopped', cls: 'bg-gray-700 text-gray-300' },
        error: { text: 'Error', cls: 'bg-red-500/20 text-red-300' },
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

let pollHandle = null;

async function refresh() {
    try { applyStatus(await api.get('/api/monitor/status')); }
    catch { /* SPA bootstraps without engine being reachable yet — not fatal */ }
}

export function initEngine() {
    $('engine-start')?.addEventListener('click', async () => {
        $('engine-start').disabled = true;
        try {
            const r = await api.post('/api/monitor/start');
            applyStatus(r.status);
            showToast('Monitor started', 'success');
        } catch (e) {
            showToast(`Start failed: ${e.message}`, 'error');
        } finally {
            $('engine-start').disabled = false;
        }
    });
    $('engine-stop')?.addEventListener('click', async () => {
        $('engine-stop').disabled = true;
        try {
            const r = await api.post('/api/monitor/stop');
            applyStatus(r.status);
            showToast('Monitor stopped', 'info');
        } catch (e) {
            showToast(`Stop failed: ${e.message}`, 'error');
        } finally {
            $('engine-stop').disabled = false;
        }
    });

    refresh();
    // Light polling so Queue/Uptime stay fresh even if the WS misses an event.
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(refresh, 3000);
}

export function handleEngineWsMessage(msg) {
    if (msg.type === 'monitor_state') {
        applyStatus({ state: msg.state, error: msg.error });
        setTimeout(refresh, 100);
    } else if (msg.type === 'monitor_event' || msg.type === 'history_progress' ||
               msg.type === 'history_done'  || msg.type === 'history_error') {
        // Most engine + history events are informational; keep counters fresh.
        refresh();
    }
}
