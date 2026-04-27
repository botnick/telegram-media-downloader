import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import * as Notifications from './notifications.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { openSheet, confirmSheet, promptSheet } from './sheet.js';

export async function loadSettings() {
    try {
        const config = await api.get('/api/config');

        const bind = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val !== undefined ? val : '';
        };

        const dl = config.download || {};
        const rl = config.rateLimits || {};
        const dm = config.diskManagement || {};
        const tg = config.telegram || {};

        bind('setting-concurrent', dl.concurrent);
        document.getElementById('concurrent-value').textContent = dl.concurrent || 3;

        bind('setting-retries', dl.retries);
        document.getElementById('retries-value').textContent = dl.retries || 5;

        bind('setting-path', dl.path || './data/downloads');

        bind('setting-rpm', rl.requestsPerMinute);
        document.getElementById('rpm-value').textContent = rl.requestsPerMinute || 15;

        bind('setting-polling', config.pollingInterval);
        document.getElementById('polling-value').textContent = (config.pollingInterval || 10) + 's';

        const speedEl = document.getElementById('setting-max-speed');
        if (speedEl) {
            speedEl.value = dl.maxSpeed || 0;
            const speedLabel = document.getElementById('speed-value');
            if (speedLabel) {
                speedLabel.textContent = dl.maxSpeed ? (dl.maxSpeed / 1024 / 1024).toFixed(0) + ' MB/s' : i18nT('settings.download.unlimited', 'Unlimited');
            }
        }

        bind('setting-max-disk', dm.maxTotalSize || '');
        bind('setting-max-video', dm.maxVideoSize || '');
        bind('setting-max-image', dm.maxImageSize || '');

        // Auto-rotate toggle (deletes oldest unpinned downloads when the cap
        // is exceeded). Toggle is local-state only; the actual sweep cadence
        // is enforced server-side by src/core/disk-rotator.js.
        const rotateToggle = document.getElementById('setting-disk-rotate');
        if (rotateToggle) {
            rotateToggle.classList.toggle('active', dm.enabled === true);
            rotateToggle.onclick = (e) => {
                e.preventDefault();
                rotateToggle.classList.toggle('active');
                const on = rotateToggle.classList.contains('active');
                showToast(on
                    ? i18nT('toast.rotate_on', 'Auto-rotate enabled — save to apply')
                    : i18nT('toast.rotate_off', 'Auto-rotate disabled — save to apply'),
                    on ? 'success' : 'info');
            };
        }

        // Rescue Mode (global default). Per-group rescueMode='auto' inherits
        // from this toggle; 'on'/'off' override locally. Sweep interval is
        // global — there's only one timer per process.
        const rescueCfg = config.rescue || {};
        const rescueDefaultToggle = document.getElementById('setting-rescue-default');
        if (rescueDefaultToggle) {
            rescueDefaultToggle.classList.toggle('active', rescueCfg.enabled === true);
            rescueDefaultToggle.onclick = (e) => {
                e.preventDefault();
                rescueDefaultToggle.classList.toggle('active');
                const on = rescueDefaultToggle.classList.contains('active');
                showToast(on
                    ? i18nT('toast.rescue_default_on', 'Rescue mode default on — save to apply')
                    : i18nT('toast.rescue_default_off', 'Rescue mode default off — save to apply'),
                    on ? 'success' : 'info');
            };
        }
        bind('setting-rescue-default-hours', rescueCfg.retentionHours ?? 48);
        bind('setting-rescue-sweep-min', rescueCfg.sweepIntervalMin ?? 10);
        // Refresh stats line — fire-and-forget, fail silently if endpoint
        // isn't up yet (settings panel can re-open).
        refreshRescueStats().catch(() => {});

        const dmToggle = document.getElementById('setting-allow-dm');
        if (dmToggle) {
            dmToggle.classList.toggle('active', config.allowDmDownloads === true);
            dmToggle.onclick = () => {
                dmToggle.classList.toggle('active');
            };
        }

        const notifyToggle = document.getElementById('setting-notifications');
        if (notifyToggle) {
            const refresh = () => notifyToggle.classList.toggle('active', Notifications.isEnabled());
            refresh();
            notifyToggle.onclick = async (e) => {
                e.preventDefault();
                if (Notifications.isEnabled()) {
                    Notifications.disable();
                    showToast(i18nT('toast.notify_disabled', 'Notifications disabled'), 'info');
                } else {
                    const ok = await Notifications.requestEnable();
                    showToast(ok
                        ? i18nT('toast.notify_enabled', 'Notifications enabled')
                        : i18nT('toast.notify_denied', 'Permission denied'),
                        ok ? 'success' : 'error');
                }
                refresh();
            };
        }

        const httpsToggle = document.getElementById('setting-force-https');
        if (httpsToggle) {
            const refresh = () => httpsToggle.classList.toggle('active', config.web?.forceHttps === true);
            refresh();
            httpsToggle.onclick = async (e) => {
                e.preventDefault();
                const next = !httpsToggle.classList.contains('active');
                try {
                    await api.post('/api/config', { web: { forceHttps: next } });
                    httpsToggle.classList.toggle('active', next);
                    showToast(next
                        ? i18nT('toast.https_on', 'Force HTTPS enabled')
                        : i18nT('toast.https_off', 'Force HTTPS disabled'),
                        next ? 'success' : 'info');
                } catch (err) {
                    showToast(i18nTf('toast.save_failed', { msg: err.message }, `Save failed: ${err.message}`), 'error');
                }
            };
        }

        const rlToggle = document.getElementById('setting-rate-limit');
        const rlInput  = document.getElementById('setting-rate-limit-rpm');
        if (rlToggle && rlInput) {
            const rlCfg = config.web?.rateLimit || {};
            rlToggle.classList.toggle('active', rlCfg.enabled === true);
            rlInput.value = rlCfg.perMinute || 10000;

            const saveRateLimit = async () => {
                const enabled   = rlToggle.classList.contains('active');
                const perMinute = Math.max(10, Math.min(1000000, parseInt(rlInput.value, 10) || 10000));
                rlInput.value = perMinute;
                try {
                    await api.post('/api/config', { web: { rateLimit: { enabled, perMinute } } });
                    showToast(enabled
                        ? i18nTf('toast.rate_on', { n: perMinute }, `Rate limit: ${perMinute}/min`)
                        : i18nT('toast.rate_off', 'Rate limit disabled'),
                        enabled ? 'success' : 'info');
                } catch (err) {
                    showToast(i18nTf('toast.save_failed', { msg: err.message }, `Save failed: ${err.message}`), 'error');
                }
            };

            rlToggle.onclick = (e) => {
                e.preventDefault();
                rlToggle.classList.toggle('active');
                saveRateLimit();
            };
            rlInput.onchange = saveRateLimit;
        }

        // Telegram API: only the apiId is exposed; apiHash is server-only.
        const apiIdEl = document.getElementById('setting-api-id');
        if (apiIdEl) apiIdEl.value = tg.apiId || '';

        // Proxy
        const proxy = config.proxy || {};
        bind('proxy-type', proxy.type || '');
        bind('proxy-host', proxy.host || '');
        bind('proxy-port', proxy.port || '');
        bind('proxy-username', proxy.username || '');
        bind('proxy-secret', proxy.secret || '');
        // password is intentionally never echoed back; placeholder hint:
        const pw = document.getElementById('proxy-password');
        if (pw) pw.placeholder = proxy.password ? i18nT('settings.tg_api.saved_placeholder', '(saved — leave blank to keep)') : '';
        const apiHashEl = document.getElementById('setting-api-hash');
        if (apiHashEl) apiHashEl.placeholder = tg.apiHashSet
            ? i18nT('settings.tg_api.saved_placeholder', '(saved — leave blank to keep)')
            : i18nT('settings.tg_api.id_placeholder', 'From my.telegram.org');

        // Accounts list rendered async (independent from main settings load)
        loadAccounts().catch(() => {});

        // Maintenance panel — wire once. Idempotent because loadSettings can
        // run again on config_updated WS events.
        wireMaintenance();

        // Advanced runtime tunables. Every field falls back to the same
        // hardcoded constant the consumer uses, so a missing `advanced` block
        // (older config.json) renders defaults that match current behaviour.
        loadAdvanced(config);

    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

// ---------------------------------------------------------------------------
// Advanced runtime tunables (Settings → Advanced panel)
//
// Reading: read into the matching #setting-adv-<key> input. Writing: gathered
// inside saveSettings() below. We always send the full advanced block on save
// so server-side clamping applies uniformly; partial PATCHes would also work
// but full beats half-state debugging by a mile.
// ---------------------------------------------------------------------------
const ADVANCED_DEFAULTS = {
    downloader: {
        minConcurrency: 3,
        maxConcurrency: 20,
        scalerIntervalSec: 5,
        idleSleepMs: 200,
        spilloverThreshold: 2000,
    },
    history: {
        backpressureCap: 500,
        backpressureMaxWaitMs: 5 * 60 * 1000,
        shortBreakEveryN: 100,
        longBreakEveryN: 1000,
    },
    diskRotator: {
        sweepBatch: 50,
        maxDeletesPerSweep: 5000,
    },
    integrity: {
        intervalMin: 60,
        batchSize: 64,
    },
    web: {
        sessionTtlDays: 7,
    },
};

function loadAdvanced(config) {
    const adv = config?.advanced || {};
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el && val != null) el.value = val;
    };
    const dl = { ...ADVANCED_DEFAULTS.downloader, ...(adv.downloader || {}) };
    set('setting-adv-min-concurrency',   dl.minConcurrency);
    set('setting-adv-max-concurrency',   dl.maxConcurrency);
    set('setting-adv-scaler-sec',        dl.scalerIntervalSec);
    set('setting-adv-idle-sleep-ms',     dl.idleSleepMs);
    set('setting-adv-spillover',         dl.spilloverThreshold);

    const h = { ...ADVANCED_DEFAULTS.history, ...(adv.history || {}) };
    set('setting-adv-backpressure',      h.backpressureCap);
    set('setting-adv-backpressure-wait', h.backpressureMaxWaitMs);
    set('setting-adv-short-break',       h.shortBreakEveryN);
    set('setting-adv-long-break',        h.longBreakEveryN);

    const r = { ...ADVANCED_DEFAULTS.diskRotator, ...(adv.diskRotator || {}) };
    set('setting-adv-sweep-batch',       r.sweepBatch);
    set('setting-adv-max-deletes',       r.maxDeletesPerSweep);

    const it = { ...ADVANCED_DEFAULTS.integrity, ...(adv.integrity || {}) };
    set('setting-adv-integrity-min',     it.intervalMin);
    set('setting-adv-integrity-batch',   it.batchSize);

    const w = { ...ADVANCED_DEFAULTS.web, ...(adv.web || {}) };
    set('setting-adv-session-days',      w.sessionTtlDays);
}

function gatherAdvanced() {
    const get = (id) => document.getElementById(id)?.value;
    const num = (id, def) => {
        const v = parseInt(get(id), 10);
        return Number.isFinite(v) ? v : def;
    };
    return {
        downloader: {
            minConcurrency:     num('setting-adv-min-concurrency',   ADVANCED_DEFAULTS.downloader.minConcurrency),
            maxConcurrency:     num('setting-adv-max-concurrency',   ADVANCED_DEFAULTS.downloader.maxConcurrency),
            scalerIntervalSec:  num('setting-adv-scaler-sec',        ADVANCED_DEFAULTS.downloader.scalerIntervalSec),
            idleSleepMs:        num('setting-adv-idle-sleep-ms',     ADVANCED_DEFAULTS.downloader.idleSleepMs),
            spilloverThreshold: num('setting-adv-spillover',         ADVANCED_DEFAULTS.downloader.spilloverThreshold),
        },
        history: {
            backpressureCap:        num('setting-adv-backpressure',      ADVANCED_DEFAULTS.history.backpressureCap),
            backpressureMaxWaitMs:  num('setting-adv-backpressure-wait', ADVANCED_DEFAULTS.history.backpressureMaxWaitMs),
            shortBreakEveryN:       num('setting-adv-short-break',       ADVANCED_DEFAULTS.history.shortBreakEveryN),
            longBreakEveryN:        num('setting-adv-long-break',        ADVANCED_DEFAULTS.history.longBreakEveryN),
        },
        diskRotator: {
            sweepBatch:         num('setting-adv-sweep-batch', ADVANCED_DEFAULTS.diskRotator.sweepBatch),
            maxDeletesPerSweep: num('setting-adv-max-deletes', ADVANCED_DEFAULTS.diskRotator.maxDeletesPerSweep),
        },
        integrity: {
            intervalMin: num('setting-adv-integrity-min',   ADVANCED_DEFAULTS.integrity.intervalMin),
            batchSize:   num('setting-adv-integrity-batch', ADVANCED_DEFAULTS.integrity.batchSize),
        },
        web: {
            sessionTtlDays: num('setting-adv-session-days', ADVANCED_DEFAULTS.web.sessionTtlDays),
        },
    };
}

/**
 * Refresh the "X pending / Y rescued / cleared Z last sweep" line under the
 * Rescue panel. Cheap GET — fine to call on every settings open.
 */
async function refreshRescueStats() {
    const line = document.getElementById('rescue-stats-line');
    if (!line) return;
    try {
        const s = await api.get('/api/rescue/stats');
        line.textContent = i18nTf(
            'settings.rescue.stats',
            { pending: s.pending || 0, rescued: s.rescued || 0, swept: s.lastSweepCleared || 0 },
            `${s.pending || 0} pending · ${s.rescued || 0} rescued · ${s.lastSweepCleared || 0} cleared last sweep`
        );
    } catch {
        line.textContent = i18nT('settings.rescue.stats_unavailable', 'Rescue stats unavailable.');
    }
}

export async function saveSettings() {
    const get = (id) => document.getElementById(id)?.value;

    const dmActive = document.getElementById('setting-allow-dm')?.classList.contains('active') === true;
    // Rescue Mode global config. Hours / sweep min get clamped server-side too,
    // but we sanitise here so the toast doesn't confusingly say "saved" when
    // the value was rejected.
    const rescueDefaultOn = document.getElementById('setting-rescue-default')?.classList.contains('active') === true;
    const rescueHours = Math.max(1, Math.min(720, parseInt(get('setting-rescue-default-hours'), 10) || 48));
    const rescueSweep = Math.max(1, Math.min(1440, parseInt(get('setting-rescue-sweep-min'), 10) || 10));

    const data = {
        download: {
            concurrent: parseInt(get('setting-concurrent')),
            retries: parseInt(get('setting-retries')),
            maxSpeed: parseInt(get('setting-max-speed')) || 0,
        },
        rateLimits: {
            requestsPerMinute: parseInt(get('setting-rpm')),
        },
        pollingInterval: parseInt(get('setting-polling')),
        diskManagement: {
            maxTotalSize: get('setting-max-disk') || null,
            maxVideoSize: get('setting-max-video') || null,
            maxImageSize: get('setting-max-image') || null,
            enabled: document.getElementById('setting-disk-rotate')?.classList.contains('active') === true,
        },
        rescue: {
            enabled: rescueDefaultOn,
            retentionHours: rescueHours,
            sweepIntervalMin: rescueSweep,
        },
        // Server clamps every value, so worst-case typos still produce a
        // working config. Sending the full block keeps the on-disk shape
        // self-documenting (see DEFAULT_CONFIG.advanced in src/config/manager.js).
        advanced: gatherAdvanced(),
        allowDmDownloads: dmActive,
    };

    try {
        await api.post('/api/config', data);
        showToast(i18nT('toast.settings_saved', 'Settings saved!'), 'success');
    } catch (e) {
        showToast(i18nTf('toast.settings_save_failed', { msg: e.message }, `Failed to save settings: ${e.message}`), 'error');
    }
}

export function applyPreset(type) {
    if (type === 'safe') {
        document.getElementById('setting-concurrent').value = 1;
        document.getElementById('setting-rpm').value = 5;
        document.getElementById('setting-polling').value = 30;
    } else if (type === 'balanced') {
        document.getElementById('setting-concurrent').value = 3;
        document.getElementById('setting-rpm').value = 15;
        document.getElementById('setting-polling').value = 10;
    } else if (type === 'fast') {
        document.getElementById('setting-concurrent').value = 5;
        document.getElementById('setting-rpm').value = 30;
        document.getElementById('setting-polling').value = 5;
    }

    document.getElementById('setting-concurrent').dispatchEvent(new Event('input'));
    document.getElementById('setting-rpm').dispatchEvent(new Event('input'));
    document.getElementById('setting-polling').dispatchEvent(new Event('input'));
}

// ====== Proxy ===============================================================

export async function saveProxy() {
    const get = (id) => document.getElementById(id)?.value.trim();
    const type = get('proxy-type');
    const host = get('proxy-host');
    const port = get('proxy-port');
    if (!type) {
        // Clearing the proxy → send proxy:null and let the server overwrite.
        await api.post('/api/config', { proxy: null });
        showToast(i18nT('toast.proxy_disabled', 'Proxy disabled'), 'info');
        return;
    }
    if (!host || !port) { showToast(i18nT('toast.proxy_host_port_required', 'Host and port required'), 'error'); return; }
    const proxy = { type, host, port: parseInt(port, 10) };
    const username = get('proxy-username'); if (username) proxy.username = username;
    const password = get('proxy-password'); if (password) proxy.password = password;
    const secret = get('proxy-secret'); if (secret) proxy.secret = secret;
    try {
        await api.post('/api/config', { proxy });
        showToast(i18nT('toast.proxy_saved', 'Proxy saved — restart the monitor for it to take effect'), 'success');
    } catch (e) {
        showToast(i18nTf('toast.save_failed', { msg: e.message }, `Save failed: ${e.message}`), 'error');
    }
}

export async function testProxy() {
    const get = (id) => document.getElementById(id)?.value.trim();
    const host = get('proxy-host'); const port = get('proxy-port');
    const status = document.getElementById('proxy-status');
    if (!host || !port) { showToast(i18nT('toast.proxy_host_port_required', 'Host and port required'), 'error'); return; }
    if (status) { status.textContent = i18nT('settings.proxy.connecting', 'Connecting…'); status.className = 'text-xs text-tg-textSecondary mt-2'; }
    try {
        const r = await api.post('/api/proxy/test', { host, port: parseInt(port, 10) });
        if (status) {
            if (r.ok) {
                status.textContent = i18nTf('toast.proxy_reachable', { ms: r.ms }, `✓ Reachable (${r.ms}ms TCP) — protocol handshake happens at monitor start.`);
                status.className = 'text-xs text-tg-green mt-2';
            } else {
                status.textContent = i18nTf('toast.proxy_failed', { msg: r.error }, `✗ Failed: ${r.error}`);
                status.className = 'text-xs text-red-400 mt-2';
            }
        }
    } catch (e) {
        if (status) {
            status.textContent = i18nTf('toast.proxy_failed', { msg: e.message }, `✗ ${e.message}`);
            status.className = 'text-xs text-red-400 mt-2';
        }
    }
}

// ====== Telegram API credentials ============================================

export async function saveApiCredentials() {
    const apiId = document.getElementById('setting-api-id')?.value.trim();
    const apiHash = document.getElementById('setting-api-hash')?.value.trim();
    if (!apiId) {
        showToast(i18nT('toast.api_id_required', 'API ID required'), 'error');
        return;
    }
    const body = { telegram: { apiId } };
    if (apiHash) body.telegram.apiHash = apiHash;
    try {
        await api.post('/api/config', body);
        showToast(i18nT('toast.credentials_saved', 'Credentials saved'), 'success');
        document.getElementById('setting-api-hash').value = '';
        loadSettings();
    } catch (e) {
        showToast(i18nTf('toast.credentials_failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

// ====== Accounts ============================================================

export async function loadAccounts() {
    const container = document.getElementById('accounts-list');
    if (!container) return;
    try {
        const accounts = await api.get('/api/accounts');
        if (!accounts.length) {
            container.innerHTML = `<p class="text-tg-textSecondary text-sm">${i18nT('settings.accounts.empty_html', 'No Telegram accounts yet. Click <strong>Add account</strong> above to get started.')}</p>`;
            return;
        }
        const removeLbl = i18nT('settings.accounts.remove', 'Remove');
        const defaultLbl = i18nT('settings.accounts.default', 'default');
        container.innerHTML = accounts.map(a => {
            const star = a.isDefault ? `<span class="text-tg-blue text-xs">★ ${escapeHtml(defaultLbl)}</span>` : '';
            const sub = [a.username && `@${a.username}`, a.phone].filter(Boolean).join(' • ');
            return `
            <div class="flex items-center justify-between bg-tg-bg/40 rounded-lg p-3" data-account="${escapeHtml(a.id)}">
                <div class="min-w-0">
                    <div class="text-tg-text text-sm font-medium truncate">${escapeHtml(a.name || a.id)} ${star}</div>
                    <div class="text-tg-textSecondary text-xs truncate">${escapeHtml(sub || a.id)}</div>
                </div>
                <button class="tg-btn-secondary text-xs px-3 py-1 text-red-400 hover:bg-red-500/10" data-action="remove-account" data-id="${escapeHtml(a.id)}">
                    ${escapeHtml(removeLbl)}
                </button>
            </div>`;
        }).join('');
        container.querySelectorAll('[data-action="remove-account"]').forEach(btn => {
            btn.addEventListener('click', () => removeAccount(btn.dataset.id));
        });
    } catch (e) {
        container.innerHTML = `<p class="text-red-400 text-sm">${escapeHtml(i18nTf('settings.accounts.load_failed', { msg: e.message }, `Failed to load accounts: ${e.message}`))}</p>`;
    }
}

async function removeAccount(id) {
    if (!(await confirmSheet({
        title: i18nT('settings.accounts.remove', 'Remove'),
        message: i18nTf('account.remove.confirm', { id }, `Remove account "${id}"? The encrypted session file will be deleted.`),
        confirmLabel: i18nT('settings.accounts.remove', 'Remove'),
        danger: true,
    }))) return;
    try {
        await api.delete(`/api/accounts/${encodeURIComponent(id)}`);
        showToast(i18nT('account.remove.success', 'Account removed'), 'success');
        loadAccounts();
    } catch (e) {
        showToast(i18nTf('account.remove.failed', { msg: e.message }, `Remove failed: ${e.message}`), 'error');
    }
}

// ====== Dashboard security =================================================

export async function changePassword() {
    const cur = document.getElementById('sec-current')?.value;
    const next = document.getElementById('sec-new')?.value;
    if (!cur || !next) { showToast(i18nT('toast.password_both_required', 'Both fields required'), 'error'); return; }
    if (next.length < 8) { showToast(i18nT('toast.password_short', 'New password must be at least 8 characters'), 'error'); return; }
    try {
        await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
        document.getElementById('sec-current').value = '';
        document.getElementById('sec-new').value = '';
        showToast(i18nT('toast.password_changed', 'Password changed'), 'success');
    } catch (e) {
        showToast(i18nTf('toast.password_change_failed', { msg: e.message }, `Change failed: ${e.message}`), 'error');
    }
}

export async function signOut() {
    try {
        await api.post('/api/logout');
    } catch { /* ignore — we're leaving anyway */ }
    window.location.href = '/login.html';
}

// ====== Maintenance =========================================================
//
// Each button maps to one /api/maintenance/* endpoint. Destructive actions
// (restart monitor, vacuum, sign-out-all, session export, factory-reset) gate
// behind a confirm() dialog AND send {confirm:true} so the server's
// _requireConfirm guard is satisfied. Read endpoints (resync dialogs, db
// integrity, log download, raw config) skip the confirm because they don't
// mutate user data.
//
// We attach handlers idempotently — loadSettings() can fire repeatedly on
// config_updated WS events, but every binding uses a sentinel data-attribute
// so we don't stack listeners.
function wireMaintenance() {
    const once = (el, fn) => {
        if (!el || el.dataset.maintWired === '1') return;
        el.dataset.maintWired = '1';
        el.addEventListener('click', fn);
    };

    once(document.getElementById('maint-resync-btn'), maintResyncDialogs);
    once(document.getElementById('maint-restart-btn'), maintRestartMonitor);
    once(document.getElementById('maint-db-check-btn'), maintDbIntegrity);
    once(document.getElementById('maint-db-vacuum-btn'), maintDbVacuum);
    once(document.getElementById('maint-logs-btn'), maintBrowseLogs);
    once(document.getElementById('maint-config-btn'), maintViewConfig);
    once(document.getElementById('maint-export-btn'), maintExportSession);
    once(document.getElementById('maint-signout-all-btn'), maintRevokeAllSessions);
}

async function maintResyncDialogs() {
    try {
        showToast(i18nT('maintenance.resync.running', 'Resyncing dialogs…'), 'info');
        const r = await api.post('/api/maintenance/resync-dialogs', {});
        showToast(i18nTf('maintenance.resync.done', { updated: r.updated, scanned: r.scanned },
            `Resynced ${r.updated} of ${r.scanned} groups`), 'success');
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintRestartMonitor() {
    if (!(await confirmSheet({
        title: i18nT('maintenance.restart.title', 'Restart monitor'),
        message: i18nT('maintenance.restart.confirm',
            'Stop and restart the realtime monitor? In-flight downloads will be paused briefly.'),
        confirmLabel: i18nT('maintenance.restart.action', 'Restart'),
    }))) return;
    try {
        showToast(i18nT('maintenance.restart.running', 'Restarting monitor…'), 'info');
        const r = await api.post('/api/maintenance/restart-monitor', { confirm: true });
        if (r.restarted) {
            showToast(i18nT('maintenance.restart.done', 'Monitor restarted'), 'success');
        } else {
            showToast(r.note || i18nT('maintenance.restart.idle',
                'Monitor was not running.'), 'info');
        }
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintDbIntegrity() {
    try {
        const r = await api.post('/api/maintenance/db/integrity', {});
        if (r.ok) {
            showToast(i18nT('maintenance.db_check.ok', 'Database integrity: ok'), 'success');
        } else {
            const msg = (r.messages || []).slice(0, 3).join(' / ');
            showToast(i18nTf('maintenance.db_check.bad', { msg },
                `Database issues: ${msg}`), 'error');
        }
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintDbVacuum() {
    if (!(await confirmSheet({
        title: i18nT('maintenance.db_vacuum.title', 'VACUUM database'),
        message: i18nT('maintenance.db_vacuum.confirm',
            'Run VACUUM on the SQLite database? It briefly locks the DB and may take a minute on large datasets.'),
        confirmLabel: i18nT('maintenance.db_vacuum.action', 'Vacuum'),
    }))) return;
    try {
        showToast(i18nT('maintenance.db_vacuum.running', 'Running VACUUM…'), 'info');
        const r = await api.post('/api/maintenance/db/vacuum', { confirm: true });
        const reclaimed = formatBytesShort(r.reclaimedBytes);
        showToast(i18nTf('maintenance.db_vacuum.done', { bytes: reclaimed },
            `VACUUM done — reclaimed ${reclaimed}`), 'success');
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintBrowseLogs() {
    try {
        const r = await api.get('/api/maintenance/logs');
        const files = r.files || [];
        if (!files.length) {
            showToast(i18nT('maintenance.logs.empty', 'No log files yet.'), 'info');
            return;
        }
        const items = files.map(f => `
            <div class="flex items-center justify-between gap-3 bg-tg-bg/40 rounded-lg p-3">
                <div class="min-w-0">
                    <div class="text-tg-text text-sm font-medium truncate">${escapeHtml(f.name)}</div>
                    <div class="text-tg-textSecondary text-xs">${formatBytesShort(f.size)} · ${escapeHtml(new Date(f.modified).toLocaleString())}</div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <button class="tg-btn-secondary text-xs px-3 py-1" data-log-view="${escapeHtml(f.name)}">
                        ${escapeHtml(i18nT('maintenance.logs.view', 'View'))}
                    </button>
                    <a class="tg-btn-secondary text-xs px-3 py-1" href="/api/maintenance/logs/download?name=${encodeURIComponent(f.name)}&lines=10000" download="${escapeHtml(f.name)}">
                        ${escapeHtml(i18nT('maintenance.logs.download', 'Download'))}
                    </a>
                </div>
            </div>
        `).join('');
        openSheet({
            title: i18nT('maintenance.logs.title', 'Log files'),
            content: `<div class="space-y-2" id="maint-logs-list">${items}</div>
                      <p class="text-xs text-tg-textSecondary mt-3" data-i18n="maintenance.logs.tail_help">Last 10,000 lines per file.</p>`,
        });
        // Wire the per-file "View" buttons inside the sheet — open a second
        // sheet with the tail of the file in a <pre> for in-browser reading
        // (no need to download + open a separate viewer).
        setTimeout(() => {
            document.querySelectorAll('#maint-logs-list [data-log-view]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const name = btn.dataset.logView;
                    btn.disabled = true;
                    try {
                        const res = await fetch(`/api/maintenance/logs/download?name=${encodeURIComponent(name)}&lines=10000`);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const text = await res.text();
                        openSheet({
                            title: name,
                            content: `
                                <div class="flex items-center justify-end gap-2 mb-2">
                                    <button class="tg-btn-secondary text-xs px-3 py-1" id="log-copy-btn">${escapeHtml(i18nT('maintenance.logs.copy', 'Copy'))}</button>
                                    <a class="tg-btn-secondary text-xs px-3 py-1" href="/api/maintenance/logs/download?name=${encodeURIComponent(name)}&lines=10000" download="${escapeHtml(name)}">${escapeHtml(i18nT('maintenance.logs.download', 'Download'))}</a>
                                </div>
                                <pre id="log-pre" class="bg-tg-bg/60 rounded-lg p-3 text-[11px] font-mono text-tg-text whitespace-pre overflow-auto max-h-[70vh] leading-snug">${escapeHtml(text || i18nT('maintenance.logs.empty_tail', '(empty)'))}</pre>`,
                        });
                        // Auto-scroll to the bottom — the tail is what users care about.
                        // Copy-to-clipboard for the visible content.
                        setTimeout(() => {
                            const pre = document.getElementById('log-pre');
                            if (pre) pre.scrollTop = pre.scrollHeight;
                            const cp = document.getElementById('log-copy-btn');
                            cp?.addEventListener('click', async () => {
                                try {
                                    await navigator.clipboard.writeText(text);
                                    showToast(i18nT('maintenance.export.copied', 'Copied'), 'success');
                                } catch {
                                    showToast(i18nT('maintenance.export.copy_manual', 'Press Ctrl/Cmd+C to copy'), 'info');
                                }
                            });
                        }, 50);
                    } catch (e) {
                        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
                    } finally {
                        btn.disabled = false;
                    }
                });
            });
        }, 50);
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintViewConfig() {
    try {
        const res = await fetch('/api/maintenance/config/raw');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        openSheet({
            title: i18nT('maintenance.config.title', 'View raw config.json'),
            size: 'lg',
            content: `<pre class="text-xs bg-tg-bg/60 rounded-lg p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap">${escapeHtml(text)}</pre>
                      <p class="text-xs text-tg-textSecondary mt-2" data-i18n="maintenance.config.redacted_help">Sensitive fields (apiHash, password hash, proxy password) are redacted.</p>`,
        });
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintExportSession() {
    let accounts = [];
    try { accounts = await api.get('/api/accounts'); }
    catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
        return;
    }
    if (!accounts.length) {
        showToast(i18nT('maintenance.export.empty', 'No saved accounts to export.'), 'info');
        return;
    }
    const opts = accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)} · ${escapeHtml(a.id)}</option>`).join('');
    const html = `
        <p class="text-xs text-red-400 mb-3">${escapeHtml(i18nT('maintenance.export.warn',
            'Anyone with this string can act as the account. Treat it like a password.'))}</p>
        <label class="text-tg-text text-sm block mb-1" data-i18n="maintenance.export.pick">Account</label>
        <select id="maint-export-pick" class="tg-input w-full text-sm mb-3">${opts}</select>
        <button id="maint-export-do" class="tg-btn w-full text-sm">${escapeHtml(i18nT('maintenance.export.action', 'Export'))}</button>
        <div id="maint-export-out" class="mt-3 hidden">
            <label class="text-tg-text text-sm block mb-1" data-i18n="maintenance.export.string">Session string</label>
            <textarea id="maint-export-str" class="tg-input w-full text-xs font-mono" rows="6" readonly></textarea>
            <button id="maint-export-copy" class="tg-btn-secondary w-full text-xs mt-2">${escapeHtml(i18nT('maintenance.export.copy', 'Copy to clipboard'))}</button>
        </div>`;
    openSheet({
        title: i18nT('maintenance.export.title', 'Export Telegram session'),
        content: html,
    });
    // The sheet body is appended synchronously to document.body, so its
    // children are queryable on the next tick.
    setTimeout(() => {
        const doBtn = document.getElementById('maint-export-do');
        const pick = document.getElementById('maint-export-pick');
        const out = document.getElementById('maint-export-out');
        const str = document.getElementById('maint-export-str');
        const copy = document.getElementById('maint-export-copy');
        if (doBtn) doBtn.addEventListener('click', async () => {
            // Force the user to retype their dashboard password — exporting
            // a session string lets the holder act as the account, so cookie
            // alone is not enough proof of identity.
            const password = await promptSheet({
                title: i18nT('maintenance.export.title', 'Export Telegram session'),
                message: i18nT('maintenance.export.password_prompt',
                    'Enter your dashboard password to export the session string:'),
                inputType: 'password',
                confirmLabel: i18nT('maintenance.export.action', 'Export'),
            });
            if (password == null || password === '') return;
            doBtn.disabled = true;
            try {
                const r = await api.post('/api/maintenance/session/export', {
                    confirm: true,
                    accountId: pick.value,
                    password,
                });
                if (str) str.value = r.session || '';
                if (out) out.classList.remove('hidden');
            } catch (e) {
                showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
            } finally {
                doBtn.disabled = false;
            }
        });
        if (copy) copy.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(str.value);
                showToast(i18nT('maintenance.export.copied', 'Copied'), 'success');
            } catch {
                str.select();
                showToast(i18nT('maintenance.export.copy_manual', 'Press Ctrl/Cmd+C to copy'), 'info');
            }
        });
    }, 50);
}

async function maintRevokeAllSessions() {
    if (!(await confirmSheet({
        title: i18nT('maintenance.signout_all.title', 'Sign out everywhere'),
        message: i18nT('maintenance.signout_all.confirm',
            'Sign out every browser? You will be redirected to the login page.'),
        confirmLabel: i18nT('maintenance.signout_all.action', 'Sign out all'),
        danger: true,
    }))) return;
    // Require the dashboard password — without it a stolen cookie could
    // mass-evict everyone else off the dashboard.
    const password = await promptSheet({
        title: i18nT('maintenance.signout_all.title', 'Sign out everywhere'),
        message: i18nT('maintenance.signout_all.password_prompt',
            'Enter your dashboard password to sign out every browser:'),
        inputType: 'password',
        confirmLabel: i18nT('maintenance.signout_all.action', 'Sign out all'),
    });
    if (password == null || password === '') return;
    try {
        await api.post('/api/maintenance/sessions/revoke-all', { confirm: true, password });
        showToast(i18nT('maintenance.signout_all.done', 'All sessions revoked'), 'success');
        setTimeout(() => { window.location.href = '/login.html'; }, 600);
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

// Tiny formatter so we don't pull in utils.formatBytes (which has slightly
// different output). KB-based; locale-agnostic.
function formatBytesShort(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 ? 0 : 1) + ' ' + units[i];
}
