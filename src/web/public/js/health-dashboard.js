/**
 * System health dashboard — real-time metrics via /api/system/health.
 * Renders into the #health-panel container on the maintenance page.
 */

import { api } from './api.js';

let _interval = null;
let _panel = null;

export function initHealthDashboard(container) {
    _panel = container;
    if (!_panel) return;
    _panel.innerHTML = _skeleton();
    _refresh();
    _interval = setInterval(_refresh, 5000);
}

export function destroyHealthDashboard() {
    if (_interval) clearInterval(_interval);
    _interval = null;
}

async function _refresh() {
    if (!_panel) return;
    try {
        const h = await api.get('/api/system/health');
        _panel.innerHTML = _render(h);
    } catch {
        // Leave last render in place
    }
}

function _skeleton() {
    return `<div class="health-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;padding:12px 0;">
        ${Array(6).fill('<div class="health-card skeleton" style="height:80px;border-radius:8px;background:var(--tg-bg-secondary,#1e1e1e);"></div>').join('')}
    </div>`;
}

function _render(h) {
    const p = h.process;
    const s = h.system;
    const d = h.database;

    const uptimeStr = _formatUptime(p.uptime);
    const memPercent = s.usedMemPercent;
    const memBar = _bar(memPercent);
    const heapPercent = Math.round((p.memoryMB.heapUsed / p.memoryMB.heapTotal) * 100);
    const heapBar = _bar(heapPercent);

    return `<div class="health-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;padding:12px 0;">
        ${_card('Uptime', `<span style="font-size:20px;font-weight:600;">${uptimeStr}</span><br><small style="color:var(--tg-textSecondary);">PID ${p.pid} · Node ${p.nodeVersion}</small>`)}
        ${_card('System Memory', `${memBar}<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--tg-textSecondary);margin-top:4px;"><span>${s.totalMemMB - s.freeMemMB} / ${s.totalMemMB} MB</span><span>${memPercent}%</span></div>`)}
        ${_card('Heap Memory', `${heapBar}<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--tg-textSecondary);margin-top:4px;"><span>${p.memoryMB.heapUsed} / ${p.memoryMB.heapTotal} MB</span><span>${heapPercent}%</span></div>`)}
        ${_card('CPU', `<span style="font-size:16px;font-weight:500;">${s.cpuCount}× ${s.cpuModel.split(' ').slice(0, 3).join(' ')}</span><br><small style="color:var(--tg-textSecondary);">Load: ${s.loadAvg.join(' / ')}</small>`)}
        ${_card('Database', d ? `<span style="font-size:16px;font-weight:500;">${d.sizeMB} MB</span><br><small style="color:var(--tg-textSecondary);">${d.journalMode.toUpperCase()} · WAL: ${d.walPages} pages</small>` : '<span style="color:var(--tg-textSecondary);">unavailable</span>')}
        ${_card('Connections', `<span style="font-size:20px;font-weight:600;">${h.connections.wsClients}</span><br><small style="color:var(--tg-textSecondary);">WebSocket clients</small>`)}
    </div>`;
}

function _card(title, body) {
    return `<div class="health-card" style="padding:12px 16px;border-radius:8px;background:var(--tg-bg-secondary,#1e1e1e);border:1px solid var(--tg-border,#333);">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--tg-textSecondary);margin-bottom:6px;">${title}</div>
        <div>${body}</div>
    </div>`;
}

function _bar(percent) {
    const color = percent > 85 ? '#ef4444' : percent > 60 ? '#f59e0b' : '#22c55e';
    return `<div style="height:6px;border-radius:3px;background:var(--tg-bg-tertiary,#2a2a2a);overflow:hidden;">
        <div style="height:100%;width:${percent}%;background:${color};border-radius:3px;transition:width 0.3s ease;"></div>
    </div>`;
}

function _formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}
