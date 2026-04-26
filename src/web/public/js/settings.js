import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import * as Notifications from './notifications.js';

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
                speedLabel.textContent = dl.maxSpeed ? (dl.maxSpeed / 1024 / 1024).toFixed(0) + ' MB/s' : 'Unlimited';
            }
        }

        bind('setting-max-disk', dm.maxTotalSize || '');
        bind('setting-max-video', dm.maxVideoSize || '');
        bind('setting-max-image', dm.maxImageSize || '');

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
                    showToast('Notifications disabled', 'info');
                } else {
                    const ok = await Notifications.requestEnable();
                    showToast(ok ? 'Notifications enabled' : 'Permission denied', ok ? 'success' : 'error');
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
                    showToast(next ? 'Force HTTPS enabled' : 'Force HTTPS disabled', next ? 'success' : 'info');
                } catch (err) {
                    showToast(`Save failed: ${err.message}`, 'error');
                }
            };
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
        if (pw) pw.placeholder = proxy.password ? '(saved — leave blank to keep)' : '';
        const apiHashEl = document.getElementById('setting-api-hash');
        if (apiHashEl) apiHashEl.placeholder = tg.apiHashSet
            ? '(saved — leave blank to keep)'
            : 'From my.telegram.org';

        // Accounts list rendered async (independent from main settings load)
        loadAccounts().catch(() => {});

    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

export async function saveSettings() {
    const get = (id) => document.getElementById(id)?.value;

    const dmActive = document.getElementById('setting-allow-dm')?.classList.contains('active') === true;
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
        },
        allowDmDownloads: dmActive,
    };

    try {
        await api.post('/api/config', data);
        showToast('Settings saved!', 'success');
    } catch (e) {
        showToast(`Failed to save settings: ${e.message}`, 'error');
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
        showToast('Proxy disabled', 'info');
        return;
    }
    if (!host || !port) { showToast('Host and port required', 'error'); return; }
    const proxy = { type, host, port: parseInt(port, 10) };
    const username = get('proxy-username'); if (username) proxy.username = username;
    const password = get('proxy-password'); if (password) proxy.password = password;
    const secret = get('proxy-secret'); if (secret) proxy.secret = secret;
    try {
        await api.post('/api/config', { proxy });
        showToast('Proxy saved — restart the monitor for it to take effect', 'success');
    } catch (e) {
        showToast(`Save failed: ${e.message}`, 'error');
    }
}

export async function testProxy() {
    const get = (id) => document.getElementById(id)?.value.trim();
    const host = get('proxy-host'); const port = get('proxy-port');
    const status = document.getElementById('proxy-status');
    if (!host || !port) { showToast('Host and port required', 'error'); return; }
    if (status) { status.textContent = 'Connecting…'; status.className = 'text-xs text-tg-textSecondary mt-2'; }
    try {
        const r = await api.post('/api/proxy/test', { host, port: parseInt(port, 10) });
        if (status) {
            if (r.ok) {
                status.textContent = `✓ Reachable (${r.ms}ms TCP) — protocol handshake happens at monitor start.`;
                status.className = 'text-xs text-tg-green mt-2';
            } else {
                status.textContent = `✗ Failed: ${r.error}`;
                status.className = 'text-xs text-red-400 mt-2';
            }
        }
    } catch (e) {
        if (status) {
            status.textContent = `✗ ${e.message}`;
            status.className = 'text-xs text-red-400 mt-2';
        }
    }
}

// ====== Telegram API credentials ============================================

export async function saveApiCredentials() {
    const apiId = document.getElementById('setting-api-id')?.value.trim();
    const apiHash = document.getElementById('setting-api-hash')?.value.trim();
    if (!apiId) {
        showToast('API ID required', 'error');
        return;
    }
    const body = { telegram: { apiId } };
    if (apiHash) body.telegram.apiHash = apiHash;
    try {
        await api.post('/api/config', body);
        showToast('Credentials saved', 'success');
        document.getElementById('setting-api-hash').value = '';
        loadSettings();
    } catch (e) {
        showToast(`Failed: ${e.message}`, 'error');
    }
}

// ====== Accounts ============================================================

export async function loadAccounts() {
    const container = document.getElementById('accounts-list');
    if (!container) return;
    try {
        const accounts = await api.get('/api/accounts');
        if (!accounts.length) {
            container.innerHTML = `<p class="text-tg-textSecondary text-sm">No Telegram accounts yet. Click <strong>Add account</strong> above to get started.</p>`;
            return;
        }
        container.innerHTML = accounts.map(a => {
            const star = a.isDefault ? '<span class="text-tg-blue text-xs">★ default</span>' : '';
            const sub = [a.username && `@${a.username}`, a.phone].filter(Boolean).join(' • ');
            return `
            <div class="flex items-center justify-between bg-tg-bg/40 rounded-lg p-3" data-account="${escapeHtml(a.id)}">
                <div class="min-w-0">
                    <div class="text-tg-text text-sm font-medium truncate">${escapeHtml(a.name || a.id)} ${star}</div>
                    <div class="text-tg-textSecondary text-xs truncate">${escapeHtml(sub || a.id)}</div>
                </div>
                <button class="tg-btn-secondary text-xs px-3 py-1 text-red-400 hover:bg-red-500/10" data-action="remove-account" data-id="${escapeHtml(a.id)}">
                    Remove
                </button>
            </div>`;
        }).join('');
        container.querySelectorAll('[data-action="remove-account"]').forEach(btn => {
            btn.addEventListener('click', () => removeAccount(btn.dataset.id));
        });
    } catch (e) {
        container.innerHTML = `<p class="text-red-400 text-sm">Failed to load accounts: ${escapeHtml(e.message)}</p>`;
    }
}

async function removeAccount(id) {
    if (!confirm(`Remove account "${id}"? The encrypted session file will be deleted.`)) return;
    try {
        await api.delete(`/api/accounts/${encodeURIComponent(id)}`);
        showToast('Account removed', 'success');
        loadAccounts();
    } catch (e) {
        showToast(`Remove failed: ${e.message}`, 'error');
    }
}

// ====== Dashboard security =================================================

export async function changePassword() {
    const cur = document.getElementById('sec-current')?.value;
    const next = document.getElementById('sec-new')?.value;
    if (!cur || !next) { showToast('Both fields required', 'error'); return; }
    if (next.length < 8) { showToast('New password must be at least 8 characters', 'error'); return; }
    try {
        await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
        document.getElementById('sec-current').value = '';
        document.getElementById('sec-new').value = '';
        showToast('Password changed', 'success');
    } catch (e) {
        showToast(`Change failed: ${e.message}`, 'error');
    }
}

export async function signOut() {
    try {
        await api.post('/api/logout');
    } catch { /* ignore — we're leaving anyway */ }
    window.location.href = '/login.html';
}
