// Engine (monitor runtime) controller — drives the Engine card in Settings.

import { api } from './api.js';
import { showToast, formatBytes, escapeHtml } from './utils.js';

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

// Live in-flight downloads, keyed by job.key. Updated from WS
// download_progress events; entries auto-expire 8 s after their last update so
// a stuck job doesn't sit forever.
const activeJobs = new Map();
const ACTIVE_TTL = 8000;
let activeRenderTimer = null;

function pruneActive() {
    const cutoff = Date.now() - ACTIVE_TTL;
    for (const [k, v] of activeJobs) if (v.ts < cutoff) activeJobs.delete(k);
}

function renderActive() {
    pruneActive();
    const host = $('engine-active-list');
    if (!host) return;
    if (activeJobs.size === 0) {
        host.classList.add('hidden');
        host.innerHTML = '<div class="text-tg-textSecondary text-xs">Live downloads</div>';
        return;
    }
    host.classList.remove('hidden');
    const rows = Array.from(activeJobs.values())
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 6)
        .map(j => {
            const pct = Math.max(0, Math.min(100, j.progress || 0));
            const sizeLine = j.total
                ? `${formatBytes(j.received || 0)} / ${formatBytes(j.total)}`
                : (j.received ? formatBytes(j.received) : '');
            const speed = j.bps ? `${formatBytes(j.bps)}/s` : '';
            return `
                <div class="bg-tg-bg/40 rounded p-2 text-xs">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-tg-text truncate">${escapeHtml(j.groupName || j.groupId || '?')} <span class="text-tg-textSecondary">· ${escapeHtml(j.mediaType || '')} #${j.messageId ?? ''}</span></span>
                        <span class="text-tg-textSecondary tabular-nums">${pct}%${speed ? ' · ' + speed : ''}</span>
                    </div>
                    <div class="mt-1 h-1 bg-tg-bg rounded overflow-hidden">
                        <div class="h-full bg-tg-blue transition-all" style="width: ${pct}%"></div>
                    </div>
                    <div class="text-[10px] text-tg-textSecondary mt-1">${escapeHtml(sizeLine)}</div>
                </div>`;
        }).join('');
    host.innerHTML = '<div class="text-tg-textSecondary text-xs">Live downloads</div>' + rows;
}

function scheduleRender() {
    if (activeRenderTimer) return;
    activeRenderTimer = setTimeout(() => { activeRenderTimer = null; renderActive(); }, 200);
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
        if (msg.state === 'stopped' || msg.state === 'error') {
            activeJobs.clear();
            renderActive();
        }
        return;
    }
    if (msg.type === 'history_progress' || msg.type === 'history_done' || msg.type === 'history_error') {
        refresh();
        return;
    }
    // server.js does `broadcast({type:'monitor_event', ...e})` where `e` is
    // `{type, payload}` — the spread overwrites the outer type, so engine
    // events arrive at the WS as `{type:'download_progress', payload:{...}}`
    // (or _complete / _error / _start, etc.). Handle them directly.
    if (msg.type === 'download_progress' && msg.payload?.key) {
        const j = activeJobs.get(msg.payload.key) || {};
        Object.assign(j, msg.payload, { ts: Date.now() });
        activeJobs.set(msg.payload.key, j);
        scheduleRender();
        return;
    }
    if (msg.type === 'download_complete') {
        if (msg.payload?.key) activeJobs.delete(msg.payload.key);
        scheduleRender();
        refresh();
        return;
    }
    if (msg.type === 'download_start' || msg.type === 'download_error' || msg.type === 'queue_length') {
        refresh();
    }
}
