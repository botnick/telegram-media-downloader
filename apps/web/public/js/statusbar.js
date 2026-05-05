// Sticky status bar — runtime state, queue, active workers, disk usage, WS link.

import { api } from './api.js';
import { ws } from './ws.js';
import { formatBytes, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { subscribe as subscribeMonitorStatus, refreshNow as refreshMonitorStatus } from './monitor-status.js';
import { openSheet, confirmSheet } from './sheet.js';

const $ = (id) => document.getElementById(id);

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
    const pillEl = $('engine-status-pill');
    if (pillEl) {
        pillEl.dataset.state = state || 'stopped';
        const pillLbl = pillEl.querySelector('.engine-status-label');
        if (pillLbl) pillLbl.textContent = m.text;
        pillEl.setAttribute('aria-label', i18nTf('header.engine_state', { state: m.text }, `Engine status: ${m.text}`));
    }
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
        badge.title = i18nT('update.click_to_install', 'v{version} is out — click for install / release notes').replace('{version}', latest);
        // Click opens a tiny chooser sheet so admins can pick between
        // one-click install (when configured) and the release-notes link.
        badge.href = r.releaseUrl || `https://github.com/botnick/telegram-media-downloader/releases/tag/${latest}`;
        badge.onclick = (e) => {
            e.preventDefault();
            _openUpdateChooser(latest, r.releaseUrl).catch(() => {});
        };
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

    // Stats — WS push only (v2.3.24). Server broadcasts `stats_push`
    // every 30 s with the snapshot; we still fetch once on boot so
    // the bar isn't blank for the first 30 s, and once on every
    // WS reconnect so a disconnect-window's worth of new downloads
    // shows up immediately. The mutation-events still trigger a
    // refetch (download_complete etc.) so the user sees their own
    // delete / new download instantly without waiting for the next
    // 30-second push.
    refreshStats();
    ws.on('stats_push', (msg) => {
        if (!msg?.payload) return;
        const f = $('status-files'); if (f) f.textContent = msg.payload.totalFiles ?? 0;
        const d = $('status-disk'); if (d) d.textContent = msg.payload.diskUsageFormatted || formatBytes(msg.payload.diskUsage || 0);
    });
    ws.on('__ws_open', () => refreshStats());
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

    // Auto-update — server fires this right BEFORE watchtower kills the
    // container. We surface a full-screen overlay so the operator knows
    // the disconnect that's about to happen is intentional, not a crash.
    // The browser's WS reconnect loop handles getting back in once the
    // new image is up; on reconnect we sniff the version and reload to
    // pick up the new SPA bundle.
    ws.on('update_started', () => _showUpdateOverlay());
    let _versionAtBoot = null;
    api.get('/api/version').then(r => { _versionAtBoot = r?.version || null; }).catch(() => {});
    ws.on('__ws_open', async () => {
        // Only check after a real reconnect (we have the boot version
        // cached). If the version changed we reload — the new SPA bundle
        // is live in the new container.
        if (!_versionAtBoot) return;
        try {
            const r = await api.get('/api/version');
            if (r?.version && r.version !== _versionAtBoot) {
                showToast(i18nTf('update.completed', { version: r.version },
                    `Updated to v${r.version} — reloading`), 'success', 3000);
                setTimeout(() => location.reload(), 1500);
            }
        } catch { /* ignore — overlay will time out */ }
    });
}

// ---- Update chooser sheet --------------------------------------------------
//
// Triggered by clicking the "Update available" pill. Two paths:
//   1. Install update — calls /api/update if the watchtower sidecar is up,
//                        otherwise opens a help section explaining how to
//                        enable the auto-update profile.
//   2. View release notes — opens the GitHub release page in a new tab.

export async function _openUpdateChooser(latest, releaseUrl) {
    let status = { available: false };
    try { status = await api.get('/api/update/status'); } catch { /* ignore */ }

    const installButtonHtml = status.available
        ? `<button id="upd-install-btn" class="tg-btn w-full flex items-center justify-center gap-2">
              <i class="ri-download-cloud-2-line"></i><span>${i18nTf('update.install_now',
                { version: latest }, `Install v${latest}`)}</span>
           </button>`
        : `<button class="tg-btn-secondary w-full flex items-center justify-center gap-2 opacity-60 cursor-not-allowed" disabled
                   title="${(!status.inDocker
                       ? i18nT('update.not_docker', 'Auto-update only works inside Docker.')
                       : i18nT('update.no_watchtower', 'Watchtower sidecar is not configured. See docker-compose.yml comments to enable the auto-update profile.'))}">
              <i class="ri-download-cloud-2-line"></i><span>${i18nT('update.install_disabled', 'Install (unavailable)')}</span>
           </button>`;

    const helpHtml = !status.available
        ? `<div class="mt-3 p-3 rounded-lg bg-tg-bg/40 border border-tg-border/40 text-xs text-tg-textSecondary">
            ${(!status.inDocker
                ? i18nT('update.help_not_docker', 'You are running outside Docker — pull the latest source and restart manually.')
                : i18nT('update.help_no_watchtower_html', 'To enable: <code>docker compose --profile auto-update up -d</code> after setting <code>WATCHTOWER_HTTP_API_TOKEN</code> in <code>.env</code>. See <code>docker-compose.yml</code> for the full setup.'))}
        </div>`
        : '';

    const sheet = openSheet({
        title: i18nTf('update.sheet_title', { version: latest }, `Update available — v${latest}`),
        size: 'sm',
        content: `
            <p class="text-xs text-tg-textSecondary mb-3">${i18nT('update.sheet_help',
                'Installing pulls the new image and recreates this container. Your data volume and config are preserved; the SQLite database is snapshotted to data/backups/ first. The dashboard reconnects automatically once the new container passes its healthcheck.')}</p>
            <div class="space-y-2">
                ${installButtonHtml}
                <a class="tg-btn-secondary w-full flex items-center justify-center gap-2"
                   href="${releaseUrl || `https://github.com/botnick/telegram-media-downloader/releases/tag/${latest}`}"
                   target="_blank" rel="noopener">
                    <i class="ri-github-line"></i><span>${i18nT('update.view_release', 'View release notes')}</span>
                </a>
            </div>
            ${helpHtml}`,
    });

    const installBtn = sheet?.body?.querySelector('#upd-install-btn');
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            const ok = await confirmSheet({
                title: i18nT('update.confirm_title', 'Install update now?'),
                body: i18nT('update.confirm_body', 'The dashboard will go offline briefly while the new image swaps in (~30 seconds). This page will reconnect automatically.'),
                confirmText: i18nT('update.confirm_btn', 'Install update'),
            });
            if (!ok) return;
            installBtn.disabled = true;
            installBtn.innerHTML = `<i class="ri-loader-4-line animate-spin"></i><span>${i18nT('update.starting', 'Starting…')}</span>`;
            try {
                await api.post('/api/update', {});
                _showUpdateOverlay();
                sheet?.close?.();
            } catch (e) {
                installBtn.disabled = false;
                installBtn.innerHTML = `<i class="ri-download-cloud-2-line"></i><span>${i18nTf('update.install_now',
                    { version: latest }, `Install v${latest}`)}</span>`;
                showToast(e?.data?.error || e.message || 'Update failed', 'error');
            }
        });
    }
}

// ---- Full-screen "Updating…" overlay --------------------------------------
//
// Shown while the new container is being pulled / started. Covers the
// entire viewport so the operator doesn't poke at a stale UI mid-swap.
// Auto-removed when the WS reconnects to the new container (the
// reconnect handler above reloads the page if the version changed).
function _showUpdateOverlay() {
    if (document.getElementById('tgdl-update-overlay')) return;
    const div = document.createElement('div');
    div.id = 'tgdl-update-overlay';
    div.style.cssText = `
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(15, 23, 42, 0.92);
        display: flex; align-items: center; justify-content: center;
        backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    `;
    div.innerHTML = `
        <div style="text-align: center; color: #E2E8F0; max-width: 440px; padding: 32px;">
            <div style="display: inline-block; width: 48px; height: 48px; border: 4px solid rgba(255,255,255,0.18); border-top-color: #2AABEE; border-radius: 50%; animation: tgdl-spin 1s linear infinite; margin-bottom: 20px;"></div>
            <h2 style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">${i18nT('update.overlay_title', 'Updating…')}</h2>
            <p style="font-size: 13px; opacity: 0.8; line-height: 1.5;">${i18nT('update.overlay_body',
                'Pulling the new image and restarting the container. The dashboard will reconnect automatically once the new version passes its healthcheck.')}</p>
        </div>
        <style>@keyframes tgdl-spin { to { transform: rotate(360deg); } }</style>`;
    document.body.appendChild(div);
}

