import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import * as Notifications from './notifications.js';
import * as Fonts from './fonts.js';
import { ws } from './ws.js';
import { wireJobButton } from './job-buttons.js';

// Tracks whether the font <select> has already had its options +
// change-listener wired this session. Re-populating on every
// loadSettings() open is harmless (sets innerHTML to identical markup)
// but the listener flag prevents stacking duplicate change handlers.
let _fontPickerWired = false;
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { openSheet, confirmSheet, promptSheet } from './sheet.js';

export async function loadSettings() {
    try {
        // Guest sessions can't read /api/config (admin-only). Swallow the 403
        // and continue with an empty config — the localStorage-backed Video
        // Player + Appearance + font wiring below still runs, which is the
        // only Settings surface a guest sees anyway.
        const isGuest = (typeof document !== 'undefined' && document.body?.dataset?.role === 'guest');
        let config = {};
        if (!isGuest) {
            config = await api.get('/api/config');
        }

        // Defensive: ensure the font picker is populated every time the
        // user opens the Settings page. The boot-time wire in app.js
        // covers the cold-load case but a stale SW cache or a deferred
        // module load could land us here with an empty <select>; re-
        // populating is idempotent (same markup) so it's safe.
        try {
            const fontSelect = document.getElementById('setting-font');
            if (fontSelect) {
                Fonts.populateSelect(fontSelect);
                if (!_fontPickerWired) {
                    fontSelect.addEventListener('change', () => Fonts.applyFont(fontSelect.value));
                    _fontPickerWired = true;
                }
            }
        } catch (e) { console.warn('[settings] font picker re-init:', e); }

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

        // Max Download Speed — dual-input (numeric value + unit picker)
        // mirroring whatever bytes are stored on disk. 0 / blank = unlimited.
        // Picks the most natural unit on load (don't show "10240 KB/s" when
        // the user typed "10 MB/s"). The hidden #setting-max-speed input
        // gets the raw bytes so the save path's `get('setting-max-speed')`
        // works unchanged.
        const speedHidden = document.getElementById('setting-max-speed');
        const speedValEl  = document.getElementById('setting-max-speed-value');
        const speedUnitEl = document.getElementById('setting-max-speed-unit');
        const speedLabel  = document.getElementById('speed-value');
        if (speedHidden && speedValEl && speedUnitEl) {
            const bytes = Number(dl.maxSpeed) || 0;
            let unit = 'MB', value = '';
            if (bytes > 0) {
                if (bytes >= 1024 * 1024 * 1024) { unit = 'GB'; value = +(bytes / 1073741824).toFixed(2); }
                else if (bytes >= 1024 * 1024)   { unit = 'MB'; value = +(bytes / 1048576).toFixed(2); }
                else                             { unit = 'KB'; value = +(bytes / 1024).toFixed(2); }
            }
            speedValEl.value = value === 0 ? '' : String(value);
            speedUnitEl.value = unit;
            const refresh = () => {
                const v = parseFloat(speedValEl.value);
                const u = speedUnitEl.value;
                if (!Number.isFinite(v) || v <= 0) {
                    speedHidden.value = '0';
                    if (speedLabel) speedLabel.textContent = i18nT('settings.download.unlimited', 'Unlimited');
                    return;
                }
                const mult = u === 'GB' ? 1073741824 : u === 'KB' ? 1024 : 1048576;
                speedHidden.value = String(Math.round(v * mult));
                if (speedLabel) speedLabel.textContent = `${v} ${u}/s`;
            };
            speedValEl.addEventListener('input', refresh);
            speedUnitEl.addEventListener('change', refresh);
            refresh();
        }

        // Total disk cap is split into a numeric input + unit dropdown so
        // mobile + desktop users get a real picker instead of a flaky
        // <input list> autocomplete. parseDiskCap() handles legacy strings
        // like "500GB", "1.5 TB", "250 MB", or a bare number (= MB).
        const parsed = parseDiskCap(dm.maxTotalSize);
        const dvEl = document.getElementById('setting-max-disk-value');
        const duEl = document.getElementById('setting-max-disk-unit');
        if (dvEl) dvEl.value = parsed.value;
        if (duEl) duEl.value = parsed.unit;

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

        // Video Player preferences. Pure browser-side (localStorage); the
        // viewer module reads the same keys on every clip .load(). One
        // helper covers all the on/off toggles to avoid 5 copies of the
        // same wire-up.
        const wireBoolPref = (toggleId, key, onMsg, offMsg) => {
            const el = document.getElementById(toggleId);
            if (!el) return;
            const refresh = () => el.classList.toggle('active', localStorage.getItem(key) === '1');
            refresh();
            el.onclick = (e) => {
                e.preventDefault();
                const on = localStorage.getItem(key) !== '1';
                try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private mode */ }
                refresh();
                showToast(on ? i18nT(onMsg, onMsg) : i18nT(offMsg, offMsg), 'info');
            };
        };
        wireBoolPref('setting-viewer-autoplay',     'viewer-autoplay',     'toast.viewer_autoplay_on',     'toast.viewer_autoplay_off');
        wireBoolPref('setting-viewer-start-muted',  'video-muted',         'toast.viewer_muted_on',        'toast.viewer_muted_off');
        wireBoolPref('setting-viewer-loop',         'viewer-loop',         'toast.viewer_loop_on',         'toast.viewer_loop_off');
        wireBoolPref('setting-viewer-auto-advance', 'viewer-auto-advance', 'toast.viewer_advance_on',      'toast.viewer_advance_off');
        // PiP / Speed button visibility — defaults to ON (legacy behaviour).
        // Use inverted-sense keys ('viewer-hide-pip' = '1' → hidden) so
        // existing users who never touched the toggle keep both visible.
        const wireHidePref = (toggleId, key, applyFn, onMsg, offMsg) => {
            const el = document.getElementById(toggleId);
            if (!el) return;
            const refresh = () => el.classList.toggle('active', localStorage.getItem(key) !== '1');
            const apply = () => applyFn(localStorage.getItem(key) !== '1');
            refresh(); apply();
            el.onclick = (e) => {
                e.preventDefault();
                const visible = localStorage.getItem(key) !== '1';
                try { localStorage.setItem(key, visible ? '1' : '0'); } catch {}
                refresh(); apply();
                showToast(visible ? i18nT(offMsg, offMsg) : i18nT(onMsg, onMsg), 'info');
            };
        };
        wireHidePref('setting-viewer-show-pip',   'viewer-hide-pip',
            (visible) => { const b = document.getElementById('video-pip-btn'); if (b) b.style.display = visible ? '' : 'none'; },
            'toast.viewer_pip_on', 'toast.viewer_pip_off');
        wireHidePref('setting-viewer-show-speed', 'viewer-hide-speed',
            (visible) => { const b = document.getElementById('video-settings-btn'); if (b) b.style.display = visible ? '' : 'none'; },
            'toast.viewer_speedbtn_on', 'toast.viewer_speedbtn_off');
        // Seed default ON for double-tap-fullscreen so the toggle reflects
        // the legacy behaviour on first visit. Once set, user clicks
        // toggle as expected.
        if (localStorage.getItem('viewer-dbl-tap-fs') === null) {
            try { localStorage.setItem('viewer-dbl-tap-fs', '1'); } catch {}
        }
        wireBoolPref('setting-viewer-dbl-tap-fs', 'viewer-dbl-tap-fs',
            'toast.viewer_dbltap_on', 'toast.viewer_dbltap_off');
        // Resume defaults to ON (legacy behaviour) — store the OPPOSITE
        // sense ('viewer-no-resume' = 1 when disabled) so existing users
        // who never touched the toggle keep their resume behaviour.
        const resumeEl = document.getElementById('setting-viewer-resume');
        if (resumeEl) {
            const KEY = 'viewer-no-resume';
            const refresh = () => resumeEl.classList.toggle('active', localStorage.getItem(KEY) !== '1');
            refresh();
            resumeEl.onclick = (e) => {
                e.preventDefault();
                const wasOn = localStorage.getItem(KEY) !== '1';
                try { localStorage.setItem(KEY, wasOn ? '1' : '0'); } catch { /* private mode */ }
                refresh();
                showToast(wasOn
                    ? i18nT('toast.viewer_resume_off', 'Resume disabled')
                    : i18nT('toast.viewer_resume_on', 'Resume enabled'),
                    'info');
            };
        }
        // Default speed — bound directly to the existing video-speed key
        // so changing it here propagates instantly to every player open.
        const speedSel = document.getElementById('setting-viewer-default-speed');
        if (speedSel) {
            const cur = parseFloat(localStorage.getItem('video-speed') || '1');
            speedSel.value = String(Number.isFinite(cur) && cur > 0 ? cur : 1);
            speedSel.onchange = () => {
                try { localStorage.setItem('video-speed', String(parseFloat(speedSel.value) || 1)); } catch {}
            };
        }
        // Default volume — same pattern, just clamped 0..1.
        const volSlider = document.getElementById('setting-viewer-default-volume');
        const volLabel  = document.getElementById('setting-viewer-default-volume-val');
        if (volSlider) {
            const cur = parseFloat(localStorage.getItem('video-volume') || '1');
            const pct = Math.round((Number.isFinite(cur) ? cur : 1) * 100);
            volSlider.value = String(pct);
            if (volLabel) volLabel.textContent = String(pct);
            volSlider.oninput = () => {
                const n = parseInt(volSlider.value, 10);
                if (volLabel) volLabel.textContent = String(n);
                try { localStorage.setItem('video-volume', String(Math.max(0, Math.min(1, n / 100)))); } catch {}
            };
        }
        // Skip step (left/right arrow seek seconds) + auto-hide controls
        // delay. Both clamp & persist on every input event so the player
        // picks up changes on the very next clip open.
        const wireNumberPref = (id, key, def, min, max) => {
            const el = document.getElementById(id);
            if (!el) return;
            const cur = parseInt(localStorage.getItem(key) || '', 10);
            el.value = String(Number.isFinite(cur) && cur >= min && cur <= max ? cur : def);
            el.oninput = () => {
                const n = Math.max(min, Math.min(max, parseInt(el.value, 10) || def));
                try { localStorage.setItem(key, String(n)); } catch {}
            };
        };
        wireNumberPref('setting-viewer-skip-step',  'viewer-skip-step',  5, 1, 60);
        wireNumberPref('setting-viewer-hide-delay', 'viewer-hide-delay', 3, 1, 30);

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
                // Enabling Force HTTPS without a working TLS cert behind
                // the reverse proxy locks the operator out — the dashboard
                // 308-redirects every request to https:// and the browser
                // can't reach the cert. Confirm sheet on enable, plain
                // toggle on disable (escape hatch should be friction-free).
                if (next) {
                    const ok = await confirmSheet({
                        title: i18nT('settings.security.force_https_confirm_title', 'Enable Force HTTPS?'),
                        message: i18nT('settings.security.force_https_confirm_body', 'Every HTTP request will 308-redirect to HTTPS. Make sure your reverse proxy has a working TLS cert and TRUST_PROXY=1 is set, otherwise the dashboard becomes unreachable. Localhost is exempt so you can still recover from the host.'),
                        confirmLabel: i18nT('settings.security.force_https_confirm_ok', 'Enable Force HTTPS'),
                        danger: true,
                    });
                    if (!ok) return;
                }
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

        // Admin-only sub-panels — skip for guest sessions to avoid 403s.
        if (!isGuest) {
            // Accounts list rendered async (independent from main settings load)
            loadAccounts().catch(() => {});

            // Maintenance panel — wire once. Idempotent because loadSettings can
            // run again on config_updated WS events.
            wireMaintenance();

            // Advanced runtime tunables. Every field falls back to the same
            // hardcoded constant the consumer uses, so a missing `advanced` block
            // (older config.json) renders defaults that match current behaviour.
            loadAdvanced(config);

            // Guest password sub-block (lives inside Dashboard Security).
            wireGuestPassword();
        }

    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

// ---------------------------------------------------------------------------
// Guest password (admin-only sub-block in Dashboard Security)
// ---------------------------------------------------------------------------
let _guestWired = false;
async function wireGuestPassword() {
    const enableToggle = document.getElementById('setting-guest-enabled');
    const setBtn = document.getElementById('guest-set-btn');
    const clearBtn = document.getElementById('guest-clear-btn');
    const pwInput = document.getElementById('setting-guest-password');
    const status = document.getElementById('guest-enable-status');
    if (!enableToggle || !setBtn || !clearBtn || !pwInput) return;

    const refreshStatus = async () => {
        try {
            const ac = await api.get('/api/auth_check');
            const enabled = !!ac?.guestEnabled;
            enableToggle.classList.toggle('active', enabled);
            if (status) {
                status.textContent = enabled
                    ? i18nT('settings.security.guest_enabled_on', 'Enabled — share the guest password with read-only viewers.')
                    : i18nT('settings.security.guest_enabled_off', 'Disabled — set a guest password and toggle on to share view-only access.');
            }
        } catch { /* admin-only endpoint should always succeed for admin */ }
    };
    refreshStatus();

    if (_guestWired) return;
    _guestWired = true;

    enableToggle.addEventListener('click', async (e) => {
        e.preventDefault();
        const willEnable = !enableToggle.classList.contains('active');
        try {
            const r = await api.post('/api/auth/guest-password', { enabled: willEnable });
            enableToggle.classList.toggle('active', !!r.enabled);
            refreshStatus();
            showToast(willEnable
                ? i18nT('settings.security.guest_enabled_toast_on', 'Guest access enabled')
                : i18nT('settings.security.guest_enabled_toast_off', 'Guest access disabled — existing guest sessions revoked'));
        } catch (err) {
            showToast(err.data?.error || err.message || 'Failed', 'error');
        }
    });

    setBtn.addEventListener('click', async () => {
        const password = pwInput.value;
        if (!password || password.length < 8) {
            showToast(i18nT('settings.security.guest_password_short', 'Guest password must be at least 8 characters'), 'error');
            return;
        }
        setBtn.disabled = true;
        try {
            await api.post('/api/auth/guest-password', { password });
            pwInput.value = '';
            refreshStatus();
            showToast(i18nT('settings.security.guest_password_saved', 'Guest password saved'));
        } catch (err) {
            const code = err.data?.code;
            if (code === 'SAME_AS_ADMIN') {
                showToast(i18nT('settings.security.guest_same_as_admin', 'Guest password must differ from admin'), 'error');
            } else {
                showToast(err.data?.error || err.message || 'Failed', 'error');
            }
        } finally {
            setBtn.disabled = false;
        }
    });

    clearBtn.addEventListener('click', async () => {
        const ok = await confirmSheet({
            title: i18nT('settings.security.guest_clear_title', 'Clear guest password?'),
            body: i18nT('settings.security.guest_clear_body', 'This will disable guest access and sign out anyone currently logged in as guest.'),
            confirmText: i18nT('settings.security.guest_clear_confirm', 'Clear'),
            destructive: true,
        });
        if (!ok) return;
        try {
            await api.post('/api/auth/guest-password', { clear: true });
            pwInput.value = '';
            refreshStatus();
            showToast(i18nT('settings.security.guest_cleared_toast', 'Guest access cleared'));
        } catch (err) {
            showToast(err.data?.error || err.message || 'Failed', 'error');
        }
    });
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
        backpressureMaxWaitMs: 15 * 60 * 1000,
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

/**
 * Split a disk-cap string like "500GB", "1.5 TB", "250MB", or a bare
 * number-as-MB into { value, unit } for the dual input. Returns
 * `{ value: '', unit: '' }` for empty/null/garbage so the picker shows
 * "no limit". Accepts both upper- and lower-case units.
 */
function parseDiskCap(s) {
    if (s == null || s === '' || s === 0 || s === '0') return { value: '', unit: '' };
    if (typeof s === 'number' && Number.isFinite(s)) return { value: String(s), unit: 'MB' };
    const m = String(s).trim().match(/^([\d.]+)\s*([KMGT]?B?)?$/i);
    if (!m) return { value: '', unit: '' };
    const num = parseFloat(m[1]);
    if (!Number.isFinite(num) || num <= 0) return { value: '', unit: '' };
    let unit = (m[2] || 'MB').toUpperCase();
    if (unit === 'K' || unit === 'KB') unit = 'MB';   // drop sub-MB granularity, the disk rotator works in MB
    if (unit === 'G') unit = 'GB';
    if (unit === 'T') unit = 'TB';
    if (unit === 'M') unit = 'MB';
    if (!['MB', 'GB', 'TB'].includes(unit)) unit = 'GB';
    return { value: String(num), unit };
}

/**
 * Inverse of parseDiskCap — combines (value, unit) into the string form
 * the server expects. Empty value or empty unit → null (= no limit).
 */
function combineDiskCap(value, unit) {
    const v = String(value ?? '').trim();
    const u = String(unit ?? '').trim().toUpperCase();
    if (!v || !u) return null;
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return `${n}${u}`;
}

// Exported so the per-tool maintenance pages (NSFW, thumbs, AI) can
// hydrate their settings cards on enter without going through the
// Settings page. Idempotent — safe to call multiple times.
export function loadAdvanced(config) {
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
    set('setting-adv-auto-first-limit',  Number.isFinite(h.autoFirstLimit) ? h.autoFirstLimit : 100);
    set('setting-adv-batch-insert',      Number.isFinite(h.batchInsertSize) ? h.batchInsertSize : 50);
    // Toggle widgets — flip on click, default to ON when undefined.
    const _wireToggle = (id, current) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('active', current !== false);
        if (!el.dataset.wired) {
            el.dataset.wired = '1';
            el.addEventListener('click', (e) => { e.preventDefault(); el.classList.toggle('active'); });
        }
    };
    _wireToggle('setting-adv-auto-first-backfill', h.autoFirstBackfill);
    _wireToggle('setting-adv-auto-catchup',        h.autoCatchUp);

    const r = { ...ADVANCED_DEFAULTS.diskRotator, ...(adv.diskRotator || {}) };
    set('setting-adv-sweep-batch',       r.sweepBatch);
    set('setting-adv-max-deletes',       r.maxDeletesPerSweep);

    const it = { ...ADVANCED_DEFAULTS.integrity, ...(adv.integrity || {}) };
    set('setting-adv-integrity-min',     it.intervalMin);
    set('setting-adv-integrity-batch',   it.batchSize);

    const w = { ...ADVANCED_DEFAULTS.web, ...(adv.web || {}) };
    set('setting-adv-session-days',      w.sessionTtlDays);

    // NSFW review tool — opt-in toggle + model id + dtype + threshold +
    // concurrency + preload-on-start. The toggles use the `.tg-toggle`
    // widget; click-to-flip is wired idempotently below. Defaults mirror
    // `core/nsfw.js` NSFW_DEFAULTS.
    const ns = adv.nsfw || {};
    const wireToggle = (id, on) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('active', on === true);
        if (!el.dataset.wired) {
            el.dataset.wired = '1';
            el.addEventListener('click', (e) => {
                e.preventDefault();
                el.classList.toggle('active');
            });
        }
    };
    wireToggle('setting-adv-nsfw-enabled', ns.enabled === true);
    wireToggle('setting-adv-nsfw-preload', ns.preload === true);
    set('setting-adv-nsfw-model',       (typeof ns.model === 'string' && ns.model.trim()) ? ns.model.trim() : 'AdamCodd/vit-base-nsfw-detector');
    set('setting-adv-nsfw-dtype',       ['q8', 'fp16', 'fp32', 'q4'].includes(ns.dtype) ? ns.dtype : 'q8');
    set('setting-adv-nsfw-threshold',   Number.isFinite(ns.threshold) ? ns.threshold : 0.6);
    set('setting-adv-nsfw-concurrency', Number.isFinite(ns.concurrency) ? ns.concurrency : 1);

    // AI subsystem — HuggingFace access token. Optional; surfaces on
    // /maintenance/ai. We bind through the same autosave pipeline so
    // changes round-trip via PATCH /api/config.
    const aiCfg = adv.ai || {};
    set('setting-adv-ai-hf-token', typeof aiCfg.hfToken === 'string' ? aiCfg.hfToken : '');

    // ffmpeg hardware acceleration — written to `advanced.thumbs.hwaccel`.
    // Empty string = off (default); `vaapi` / `qsv` / `cuda` / etc.
    // are passed straight to ffmpeg's `-hwaccel` flag in core/thumbs.js.
    const tHw = adv.thumbs?.hwaccel ?? '';
    const tHwEl = document.getElementById('setting-adv-ffmpeg-hwaccel');
    if (tHwEl) tHwEl.value = String(tHw);
    // Toggle for the consolidated thumb-miss warning. Default on; the
    // server falls back to true when the key is absent so first-run
    // installs see the helpful warning until they explicitly silence it.
    wireToggle('setting-adv-thumbs-warn-misses', adv.thumbs?.warnMisses !== false);

    // Probe button — fetch /thumbs/hwaccel-probe and render available
    // backends as small chips. Idempotent wire-up via `dataset.wired`.
    const probeBtn = document.getElementById('setting-adv-ffmpeg-hwaccel-probe');
    const probeOut = document.getElementById('setting-adv-ffmpeg-hwaccel-probe-result');
    if (probeBtn && !probeBtn.dataset.wired) {
        probeBtn.dataset.wired = '1';
        probeBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            probeBtn.disabled = true;
            const orig = probeBtn.innerHTML;
            probeBtn.innerHTML = `<i class="ri-loader-4-line animate-spin"></i><span>${escapeHtml(i18nT('common.loading', 'Loading…'))}</span>`;
            if (probeOut) probeOut.innerHTML = '';
            try {
                const r = await api.get('/api/maintenance/thumbs/hwaccel-probe');
                if (probeOut) {
                    if (!r?.available?.length) {
                        probeOut.innerHTML = `<span class="px-2 py-0.5 rounded-full bg-tg-bg/40 text-tg-textSecondary text-[11px]">${escapeHtml(i18nT('settings.advanced.thumbs.hwaccel_probe_none', 'No hardware backends available — CPU only'))}</span>`;
                    } else {
                        probeOut.innerHTML = r.available.map((b) =>
                            `<span class="px-2 py-0.5 rounded-full bg-tg-blue/15 text-tg-blue text-[11px] inline-flex items-center gap-1">
                                <i class="ri-check-line"></i>${escapeHtml(b)}
                            </span>`).join('');
                    }
                }
            } catch (err) {
                if (probeOut) {
                    probeOut.innerHTML = `<span class="text-red-300 text-[11px]">${escapeHtml(err?.message || 'Probe failed')}</span>`;
                }
            } finally {
                probeBtn.disabled = false;
                probeBtn.innerHTML = orig;
            }
        });
    }
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
            autoFirstBackfill:      document.getElementById('setting-adv-auto-first-backfill')?.classList.contains('active') !== false,
            autoFirstLimit:         num('setting-adv-auto-first-limit',  100),
            autoCatchUp:            document.getElementById('setting-adv-auto-catchup')?.classList.contains('active') !== false,
            batchInsertSize:        num('setting-adv-batch-insert',      50),
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
        nsfw: {
            enabled: document.getElementById('setting-adv-nsfw-enabled')?.classList.contains('active') === true,
            preload: document.getElementById('setting-adv-nsfw-preload')?.classList.contains('active') === true,
            model: String(get('setting-adv-nsfw-model') || '').trim() || 'AdamCodd/vit-base-nsfw-detector',
            dtype: String(get('setting-adv-nsfw-dtype') || 'q8'),
            threshold: parseFloat(get('setting-adv-nsfw-threshold')) || 0.6,
            concurrency: num('setting-adv-nsfw-concurrency', 1),
        },
        thumbs: {
            // Empty string = CPU (off). Validated server-side against an
            // allow-list so a hand-edited config can't pass arbitrary
            // values through to the ffmpeg process.
            hwaccel: String(get('setting-adv-ffmpeg-hwaccel') || ''),
            warnMisses: document.getElementById('setting-adv-thumbs-warn-misses')?.classList.contains('active') !== false,
        },
        ai: {
            // HuggingFace access token. Trimmed; empty = unset.
            hfToken: String(get('setting-adv-ai-hf-token') || '').trim(),
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
    // Endpoint is admin-only; the rescue line lives inside an admin-only
    // section that's hidden for guests anyway, but skip the call so the
    // console stays quiet.
    if (typeof document !== 'undefined' && document.body?.dataset?.role === 'guest') return;
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

// ---- Auto-save -----------------------------------------------------------
//
// Debounced auto-save for every editable Setting field — operators stop
// having to scroll to the bottom of the page to hit "Save". The button
// stays as a manual flush escape hatch (still works) and as the visible
// affordance that says "yes this page persists changes".
//
// Lifecycle:
//   1. Edit a field → onInput → schedule flush in AUTOSAVE_DEBOUNCE_MS.
//   2. Field blurs early → flush immediately (operator's done with it).
//   3. Tab visibility flips to hidden → flush immediately (best-effort
//      "don't lose unsaved changes when the user closes the tab").
//   4. Status indicator: idle → "Saving…" → "Saved at HH:MM:SS" → idle
//      after 4 s. Errors stick until the next successful save.
//
// `_autoSaveSnapshot` records the last saved JSON of the gathered config
// so we don't issue a no-op POST when the operator only tabbed through
// fields without changing values.

const AUTOSAVE_DEBOUNCE_MS = 800;
let _autoSaveTimer = null;
let _autoSaveInflight = false;
let _autoSaveSnapshot = null;
let _autoSaveStatusFadeTimer = null;
let _autoSaveBound = false;

// State shape on the autosave pill:
//   idle    — invisible, no message (the manual Save button used to live here)
//   dirty   — pencil icon, "Editing…" — fades in as soon as a field changes
//   saving  — spinner, "Saving…"
//   saved   — green check + "Saved at HH:MM:SS", auto-fades back to idle
//             after 2.5s; the same event also pulses a notification bell row
//             so the operator gets durable confirmation even after the chip
//             fades.
//   error   — red triangle, error msg, sticks until the next successful save.
//
// CSS state is driven by `data-state="…"` on the pill so animations + colors
// live in main.css next to the rest of the chip styles.
function _setAutosaveStatus(state, msg) {
    const root = document.getElementById('settings-autosave-status');
    const iconEl = document.getElementById('settings-autosave-icon');
    const textEl = document.getElementById('settings-autosave-text');
    if (!root || !iconEl || !textEl) return;
    if (_autoSaveStatusFadeTimer) { clearTimeout(_autoSaveStatusFadeTimer); _autoSaveStatusFadeTimer = null; }
    const ICON = {
        idle:   '',
        dirty:  '<i class="ri-edit-2-line"></i>',
        saving: '<i class="ri-loader-4-line"></i>',
        saved:  '<i class="ri-checkbox-circle-fill"></i>',
        error:  '<i class="ri-error-warning-fill"></i>',
    };
    iconEl.innerHTML = ICON[state] || '';
    textEl.textContent = msg || '';
    root.dataset.state = state || 'idle';
    if (state === 'saved') {
        _autoSaveStatusFadeTimer = setTimeout(() => _setAutosaveStatus('idle', ''), 2500);
    }
}

// Pipe the saved/error event into the notification bell so the operator
// has a persistent record of every config save (the chip fades; the bell
// keeps history). `pushLogToNotify` is the public hook the bell exposes;
// importing it lazily keeps the settings module stand-alone in tests.
async function _notifyAutoSave(level, msg) {
    try {
        const { pushLogToNotify } = await import('./header-mobile.js');
        pushLogToNotify({ ts: Date.now(), source: 'settings', level, msg });
    } catch { /* bell not available (e.g. tests / cold-load race) — silent */ }
}

async function _autoSaveFlush() {
    if (_autoSaveInflight) {
        // Re-arm — the in-flight POST will re-trigger via finally() but
        // we may have newer edits that landed between the previous flush
        // and now.
        _scheduleAutoSave();
        return;
    }
    if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }

    let payload;
    try { payload = _gatherSettingsPayload(); }
    catch (e) { _setAutosaveStatus('error', i18nT('settings.autosave.error', 'Could not gather settings: ') + (e?.message || e)); return; }

    const json = JSON.stringify(payload);
    if (json === _autoSaveSnapshot) {
        // No-op — fields visually changed (or focus events fired) but the
        // serialized payload matches the last saved snapshot.
        _setAutosaveStatus('idle', '');
        return;
    }

    _autoSaveInflight = true;
    _setAutosaveStatus('saving', i18nT('settings.autosave.saving', 'Saving…'));
    try {
        await api.post('/api/config', payload);
        _autoSaveSnapshot = json;
        const ts = new Date();
        const hh = String(ts.getHours()).padStart(2, '0');
        const mm = String(ts.getMinutes()).padStart(2, '0');
        const ss = String(ts.getSeconds()).padStart(2, '0');
        const savedMsg = i18nTf('settings.autosave.saved', { time: `${hh}:${mm}:${ss}` }, `Saved at ${hh}:${mm}:${ss}`);
        _setAutosaveStatus('saved', savedMsg);
        // Mirror to the notification bell as `info` — bell only surfaces
        // warn/error in its dropdown by default, but `info` writes into
        // the buffer so admins who turn on "show all levels" can audit
        // every save.
        _notifyAutoSave('info', i18nT('settings.autosave.notify.saved', 'Settings saved.'));
    } catch (e) {
        const failMsg = i18nTf('settings.autosave.failed', { msg: e?.message || String(e) }, `Save failed: ${e?.message || e}`);
        _setAutosaveStatus('error', failMsg);
        // Bell DOES surface this — `error` level pings the badge so the
        // operator notices a failed save even after they scrolled away.
        _notifyAutoSave('error', failMsg);
    } finally {
        _autoSaveInflight = false;
    }
}

function _scheduleAutoSave() {
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _setAutosaveStatus('dirty', i18nT('settings.autosave.dirty', 'Editing…'));
    _autoSaveTimer = setTimeout(_autoSaveFlush, AUTOSAVE_DEBOUNCE_MS);
}

// Single source of truth for the saved JSON shape. Both the manual Save
// button and the auto-save flush call this — keeps validation / clamping
// logic in lock-step.
function _gatherSettingsPayload() {
    const get = (id) => document.getElementById(id)?.value;
    const dmActive = document.getElementById('setting-allow-dm')?.classList.contains('active') === true;
    const rescueDefaultOn = document.getElementById('setting-rescue-default')?.classList.contains('active') === true;
    const rescueHours = Math.max(1, Math.min(720, parseInt(get('setting-rescue-default-hours'), 10) || 48));
    const rescueSweep = Math.max(1, Math.min(1440, parseInt(get('setting-rescue-sweep-min'), 10) || 10));
    return {
        download: {
            concurrent: parseInt(get('setting-concurrent')),
            retries: parseInt(get('setting-retries')),
            maxSpeed: parseInt(get('setting-max-speed')) || 0,
        },
        rateLimits: { requestsPerMinute: parseInt(get('setting-rpm')) },
        pollingInterval: parseInt(get('setting-polling')),
        diskManagement: {
            maxTotalSize: combineDiskCap(get('setting-max-disk-value'), get('setting-max-disk-unit')),
            maxVideoSize: get('setting-max-video') || null,
            maxImageSize: get('setting-max-image') || null,
            enabled: document.getElementById('setting-disk-rotate')?.classList.contains('active') === true,
        },
        rescue: { enabled: rescueDefaultOn, retentionHours: rescueHours, sweepIntervalMin: rescueSweep },
        advanced: gatherAdvanced(),
        allowDmDownloads: dmActive,
    };
}

/**
 * Wire auto-save listeners. Idempotent — safe to call on every settings
 * page render; the `_autoSaveBound` flag short-circuits re-binding.
 *
 * Watches: `[id^="setting-"]` (every Setting input/select), `.tg-toggle`
 * (custom-rendered toggles that don't fire native change events on
 * .classList toggle), and explicit click events for preset buttons.
 */
export function setupAutoSave() {
    if (_autoSaveBound) return;
    _autoSaveBound = true;

    // Bind to <body> instead of #page-settings so per-tool settings cards
    // on the maintenance pages (e.g. NSFW model id, ffmpeg hwaccel) auto-
    // save through the same pipeline. The id-prefix filter keeps it from
    // firing on unrelated form fields.
    const root = document.body;
    if (!root) return;

    // Capture the baseline so an "untouched page renders + scrolls" doesn't
    // trip a save. loadSettings() will fire input events as it populates,
    // we delay the first arm by a microtask so they don't all queue saves.
    queueMicrotask(() => {
        try { _autoSaveSnapshot = JSON.stringify(_gatherSettingsPayload()); } catch {}
    });

    // Inputs that opt in to autosave are flagged either by an `id` that
    // starts with `setting-` (legacy convention) or a `data-autosave`
    // attribute (newer modules). The closure bundles both checks.
    const isAutosaveInput = (t) => {
        if (!t) return false;
        if (t.id && t.id.startsWith('setting-')) return true;
        if (typeof t.closest === 'function' && t.closest('[data-autosave]')) return true;
        return false;
    };

    // Native input/change events from <input> / <select> / <textarea>.
    root.addEventListener('input', (e) => {
        if (!isAutosaveInput(e.target)) return;
        _scheduleAutoSave();
    });
    root.addEventListener('change', (e) => {
        if (!isAutosaveInput(e.target)) return;
        _scheduleAutoSave();
    });

    // tg-toggle is a div+class trick — listen on click bubbling. Restrict
    // to toggles whose id matches the autosave convention so unrelated
    // toggles (e.g. theme switch) don't queue saves.
    root.addEventListener('click', (e) => {
        const t = e.target.closest('.tg-toggle');
        if (!t || !t.id || !t.id.startsWith('setting-')) return;
        // Defer so the toggle handler that flips .active runs first.
        setTimeout(_scheduleAutoSave, 0);
    });

    // Flush early when the user blurs a field (they're done with it).
    root.addEventListener('focusout', (e) => {
        if (!_autoSaveTimer) return;
        if (!isAutosaveInput(e.target)) return;
        _autoSaveFlush();
    });

    // Tab close / hide → best-effort flush so unsaved edits don't vanish
    // when the operator switches tabs and doesn't come back.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && _autoSaveTimer) _autoSaveFlush();
    });
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
            maxTotalSize: combineDiskCap(get('setting-max-disk-value'), get('setting-max-disk-unit')),
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
    once(document.getElementById('maint-verify-btn'), maintVerifyFiles);
    // The four standalone maintenance pages (added v2.3.48) take over from
    // the inline sheets these buttons used to open. The sheet-based handlers
    // (maintFindDuplicates, maintBuildThumbs, maintRebuildThumbs, maintBrowseLogs,
    // and the NSFW review sheet in nsfw-ui.js) are kept for now as a fallback
    // in case the SPA needs to fall back to the legacy flow.
    const _go = (slug) => () => { try { window.navigateTo?.(slug); } catch {} };
    once(document.getElementById('maint-dedup-btn'), _go('maintenance/duplicates'));
    once(document.getElementById('maint-shares-btn'), maintManageShares);
    once(document.getElementById('maint-thumbs-build-btn'), _go('maintenance/thumbs'));
    once(document.getElementById('maint-thumbs-rebuild-btn'), _go('maintenance/thumbs'));
    once(document.getElementById('maint-update-btn'), maintInstallUpdate);
    once(document.getElementById('maint-nsfw-scan-btn'), _go('maintenance/nsfw'));
    once(document.getElementById('maint-nsfw-review-btn'), _go('maintenance/nsfw'));
    once(document.getElementById('maint-logs-btn'), _go('maintenance/logs'));
    once(document.getElementById('maint-config-btn'), maintViewConfig);
    once(document.getElementById('maint-export-btn'), maintExportSession);
    once(document.getElementById('maint-signout-all-btn'), maintRevokeAllSessions);

    // Refresh the cache stat line on first open + after each operation.
    refreshThumbsStats();
    refreshUpdateStatus();
    _nsfwModule().then(m => m.refreshNsfwStatus()).catch(() => {});
    // Hydrate every fire-and-forget admin button + subscribe to its
    // `*_done` WS event so a job started on phone re-paints the
    // desktop's button when it finishes.
    wireMaintenanceJobToasts();
}

let _nsfwModulePromise = null;
function _nsfwModule() {
    if (!_nsfwModulePromise) _nsfwModulePromise = import('./nsfw-ui.js');
    return _nsfwModulePromise;
}

async function refreshThumbsStats() {
    const el = document.getElementById('maint-thumbs-stats');
    if (!el) return;
    try {
        const r = await api.get('/api/maintenance/thumbs/stats');
        const mb = r.bytes ? (r.bytes / (1024 * 1024)).toFixed(1) : '0';
        const noFf = r.ffmpegAvailable === false
            ? ' · ' + i18nT('maintenance.thumbs.no_ffmpeg', 'ffmpeg unavailable — image-only')
            : '';
        el.textContent = `· ${r.count} cached, ${mb} MB${noFf}`;
    } catch { /* ignore */ }
}

// Kept as a fallback in case we need to re-wire to a Settings sheet — the
// canonical entry-point is now the standalone Maintenance → Thumbnails page.
async function _maintBuildThumbs() {
    const btn = document.getElementById('maint-thumbs-build-btn');
    if (btn) { btn.disabled = true; btn.textContent = i18nT('maintenance.thumbs.building', 'Building…'); }
    try {
        const r = await api.post('/api/maintenance/thumbs/build-all', {});
        showToast(i18nTf('maintenance.thumbs.done',
            { built: r.built, skipped: r.skipped, scanned: r.scanned },
            `Built ${r.built}, ${r.skipped} already cached out of ${r.scanned}`),
            'success');
        refreshThumbsStats();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = i18nT('maintenance.thumbs.action', 'Build'); }
    }
}

async function maintInstallUpdate() {
    // Reuse the chooser sheet from statusbar.js so there's one canonical
    // install flow (same confirm step, same overlay, same WS handling).
    // We pass `latest` if we know it, otherwise the chooser falls back
    // to "Install" with the version unspecified.
    let latest = null;
    let releaseUrl = null;
    try {
        const v = await api.get('/api/version/check');
        latest = v?.latest || null;
        releaseUrl = v?.releaseUrl || null;
    } catch { /* ignore */ }
    if (!latest) {
        showToast(i18nT('maintenance.update.up_to_date',
            'Already running the latest release.'), 'success');
        return;
    }
    try {
        const m = await import('./statusbar.js');
        if (typeof m._openUpdateChooser === 'function') {
            await m._openUpdateChooser(latest, releaseUrl);
        }
    } catch (e) {
        showToast(e?.message || 'Failed to open update sheet', 'error');
    }
}

async function refreshUpdateStatus() {
    const el = document.getElementById('maint-update-status');
    const btn = document.getElementById('maint-update-btn');
    if (!el && !btn) return;
    try {
        const s = await api.get('/api/update/status');
        if (el) {
            if (s.available) {
                el.textContent = '· ' + i18nT('maintenance.update.ready', 'auto-update ready');
            } else if (!s.inDocker) {
                el.textContent = '· ' + i18nT('maintenance.update.not_docker', 'standalone install — manual update only');
            } else {
                el.textContent = '· ' + i18nT('maintenance.update.no_watchtower', 'enable the auto-update profile to use this');
            }
        }
        // Cross-check the actual release feed so the button reflects
        // whether there's anything to install. Up-to-date → disable the
        // button + flip the label to "Up to date" so the operator doesn't
        // wonder why it's a no-op.
        if (btn) {
            try {
                const v = await api.get('/api/version/check');
                const upToDate = !v?.latest;
                btn.disabled = upToDate;
                btn.classList.toggle('opacity-50', upToDate);
                btn.classList.toggle('cursor-not-allowed', upToDate);
                const labelEl = btn.querySelector('[data-i18n]') || btn;
                if (upToDate) {
                    labelEl.textContent = i18nT('maintenance.update.up_to_date_btn', 'Up to date');
                    btn.title = i18nT('maintenance.update.up_to_date',
                        'Already running the latest release.');
                } else {
                    labelEl.textContent = i18nTf('maintenance.update.action_with_version',
                        { version: v.latest }, `Install v${v.latest}`);
                    btn.title = '';
                }
            } catch { /* leave default */ }
        }
    } catch { /* leave blank */ }
}

// Kept as a fallback — see _maintBuildThumbs comment above.
async function _maintRebuildThumbs() {
    const ok = await confirmSheet({
        title: i18nT('maintenance.thumbs.rebuild_title', 'Rebuild thumbnail cache?'),
        body: i18nT('maintenance.thumbs.rebuild_body', 'Wipes every cached thumbnail. The next gallery scroll regenerates them on demand. Useful when previews look stale or after a quality tweak.'),
        confirmText: i18nT('maintenance.thumbs.rebuild_confirm', 'Wipe cache'),
        destructive: true,
    });
    if (!ok) return;
    const btn = document.getElementById('maint-thumbs-rebuild-btn');
    if (btn) btn.disabled = true;
    try {
        const r = await api.post('/api/maintenance/thumbs/rebuild', {});
        showToast(i18nTf('maintenance.thumbs.rebuilt',
            { removed: r.removed },
            `Wiped ${r.removed} cached thumbnails`),
            'success');
        refreshThumbsStats();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function maintManageShares() {
    try {
        const m = await import('./share.js');
        await m.openAllSharesSheet();
    } catch (e) {
        console.error('shares sheet load:', e);
        showToast(i18nT('share.error.load', 'Could not open share manager — try again'), 'error');
    }
}

// Find duplicate files by SHA-256 — opens a sheet showing every set of
// byte-identical copies, lets the user pick which to keep, then deletes
// the rest. Two-step UX: scan first (no destructive op), explicit Delete
// confirmation second.
// Kept as a fallback — see _maintBuildThumbs comment above.
async function _maintFindDuplicates() {
    const btn = document.getElementById('maint-dedup-btn');
    if (btn) { btn.disabled = true; btn.textContent = i18nT('maintenance.dedup.scanning', 'Scanning…'); }
    showToast(i18nT('maintenance.dedup.starting', 'Scanning files — this may take a while on the first run'), 'info');
    try {
        const r = await api.post('/api/maintenance/dedup/scan', {});
        if (!r.duplicateSets?.length) {
            showToast(i18nTf('maintenance.dedup.none',
                { scanned: r.scanned ?? 0 },
                `No duplicates found — scanned ${r.scanned ?? 0} files.`),
                'success');
            return;
        }
        await openDedupSheet(r.duplicateSets);
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = i18nT('maintenance.dedup.action', 'Scan'); }
    }
}

function _formatBytesLocal(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _isImage(t) { return /^(image|photo)/i.test(t || ''); }
function _isVideo(t) { return /^video/i.test(t || ''); }

async function openDedupSheet(sets) {
    const totalSets = sets.length;
    const totalDupes = sets.reduce((s, x) => s + (x.count - 1), 0);
    const totalReclaim = sets.reduce((s, x) => s + (x.fileSize * (x.count - 1)), 0);

    // Default selection — keep the OLDEST (first by createdAt asc) of every
    // set, mark the rest for deletion. Users can flip per-row before confirm.
    const selected = new Set();   // ids marked FOR DELETION
    for (const set of sets) {
        for (let i = 1; i < set.files.length; i++) selected.add(set.files[i].id);
    }

    const renderRow = (file, set) => {
        const isThumb = _isImage(file.fileType);
        const isVideo = _isVideo(file.fileType);
        // Server-side WebP thumbnail — way smaller than the full file and
        // works for video previews too (first-frame extraction).
        const fileUrl = `/files/${encodeURIComponent(file.filePath || '')}?inline=1`;
        const thumbUrl = (isThumb || isVideo)
            ? `/api/thumbs/${encodeURIComponent(file.id)}?w=120`
            : null;
        const thumb = thumbUrl
            ? `<img loading="lazy" decoding="async" class="w-12 h-12 object-cover rounded-md bg-tg-bg/40" src="${escapeHtml(thumbUrl)}" alt="" onerror="this.style.display='none'">`
            : `<div class="w-12 h-12 rounded-md bg-tg-bg/60 flex items-center justify-center text-tg-textSecondary"><i class="ri-file-line text-xl"></i></div>`;
        const when = file.createdAt ? new Date(file.createdAt).toLocaleString() : '—';
        const checked = selected.has(file.id) ? 'checked' : '';
        return `
            <label class="flex items-center gap-2 p-2 rounded-md hover:bg-tg-hover cursor-pointer" data-file-row="${file.id}">
                <input type="checkbox" class="dedup-del" data-id="${file.id}" data-hash="${escapeHtml(set.hash)}" ${checked}>
                ${thumb}
                <div class="min-w-0 flex-1">
                    <div class="text-sm text-tg-text truncate">${escapeHtml(file.fileName || '(unnamed)')}</div>
                    <div class="text-xs text-tg-textSecondary truncate">${escapeHtml(file.groupName || file.groupId || '')} · ${when}</div>
                </div>
                <a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener"
                   class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue">
                    <i class="ri-eye-line"></i>
                </a>
            </label>`;
    };

    const renderSet = (set) => `
        <div class="bg-tg-bg/40 rounded-lg p-3 mb-3 border border-tg-border/40" data-set="${escapeHtml(set.hash)}">
            <div class="flex items-center justify-between mb-2 gap-2">
                <div class="text-xs text-tg-textSecondary">
                    ${escapeHtml(i18nTf('maintenance.dedup.set_header',
                        { count: set.count, size: _formatBytesLocal(set.fileSize) },
                        `${set.count} copies · ${_formatBytesLocal(set.fileSize)} each`))}
                </div>
                <div class="flex items-center gap-1">
                    <button type="button" class="text-xs px-2 py-0.5 rounded border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue"
                            data-keep="oldest" data-hash="${escapeHtml(set.hash)}">
                        <span data-i18n="maintenance.dedup.keep_oldest">Keep oldest</span>
                    </button>
                    <button type="button" class="text-xs px-2 py-0.5 rounded border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue"
                            data-keep="newest" data-hash="${escapeHtml(set.hash)}">
                        <span data-i18n="maintenance.dedup.keep_newest">Keep newest</span>
                    </button>
                </div>
            </div>
            <div class="space-y-1">${set.files.map(f => renderRow(f, set)).join('')}</div>
        </div>`;

    const html = `
        <div class="text-sm text-tg-text mb-2">
            ${escapeHtml(i18nTf('maintenance.dedup.summary',
                { sets: totalSets, dupes: totalDupes, freed: _formatBytesLocal(totalReclaim) },
                `${totalSets} duplicate sets · ${totalDupes} extra copies · up to ${_formatBytesLocal(totalReclaim)} reclaimable`))}
        </div>
        <p class="text-xs text-tg-textSecondary mb-3" data-i18n="maintenance.dedup.help_pick">Each set below contains byte-identical files. Tick the copies you want to delete; the rest are kept. Default selection deletes everything except the oldest copy.</p>
        <div id="dedup-list" class="max-h-[60vh] overflow-y-auto pr-1">
            ${sets.map(renderSet).join('')}
        </div>
        <div class="mt-3 flex items-center justify-between gap-3">
            <div id="dedup-summary" class="text-xs text-tg-textSecondary"></div>
            <div class="flex items-center gap-2">
                <button id="dedup-cancel" type="button" class="tg-btn-secondary text-sm" data-i18n="maintenance.dedup.cancel">Cancel</button>
                <button id="dedup-delete" type="button" class="tg-btn text-sm bg-red-600 hover:bg-red-700">
                    <i class="ri-delete-bin-line mr-1"></i><span data-i18n="maintenance.dedup.delete">Delete selected</span>
                </button>
            </div>
        </div>`;

    const sheet = openSheet({
        title: i18nT('maintenance.dedup.sheet_title', 'Duplicate files'),
        content: html,
        size: 'lg',
    });

    const root = sheet?.body || document;
    const sumEl = root.querySelector('#dedup-summary');

    const refreshSummary = () => {
        const ids = [...root.querySelectorAll('.dedup-del:checked')].map(el => Number(el.dataset.id));
        let bytes = 0;
        for (const set of sets) {
            for (const f of set.files) if (ids.includes(f.id)) bytes += Number(f.fileSize) || 0;
        }
        if (sumEl) {
            sumEl.textContent = i18nTf('maintenance.dedup.selected',
                { count: ids.length, freed: _formatBytesLocal(bytes) },
                `${ids.length} selected · ${_formatBytesLocal(bytes)} will be freed`);
        }
    };
    root.querySelectorAll('.dedup-del').forEach(cb => cb.addEventListener('change', refreshSummary));

    // Quick "keep oldest/newest" per set — flips checkboxes in one click.
    root.querySelectorAll('[data-keep]').forEach(btn => {
        btn.addEventListener('click', () => {
            const hash = btn.dataset.hash;
            const keep = btn.dataset.keep;
            const set = sets.find(s => s.hash === hash);
            if (!set) return;
            const sortedAsc = [...set.files].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            const keepId = (keep === 'newest' ? sortedAsc[sortedAsc.length - 1] : sortedAsc[0]).id;
            for (const f of set.files) {
                const cb = root.querySelector(`.dedup-del[data-id="${f.id}"]`);
                if (cb) cb.checked = (f.id !== keepId);
            }
            refreshSummary();
        });
    });

    refreshSummary();

    root.querySelector('#dedup-cancel')?.addEventListener('click', () => sheet?.close());
    root.querySelector('#dedup-delete')?.addEventListener('click', async () => {
        const ids = [...root.querySelectorAll('.dedup-del:checked')].map(el => Number(el.dataset.id));
        if (!ids.length) {
            showToast(i18nT('maintenance.dedup.nothing', 'Nothing selected'), 'info');
            return;
        }
        const ok = await confirmSheet({
            title: i18nT('maintenance.dedup.confirm_title', 'Delete duplicate files?'),
            body: i18nTf('maintenance.dedup.confirm_body',
                { n: ids.length },
                `Permanently delete ${ids.length} file(s) from disk and database?`),
            confirmText: i18nT('maintenance.dedup.confirm_btn', 'Delete'),
            destructive: true,
        });
        if (!ok) return;
        try {
            const r = await api.post('/api/maintenance/dedup/delete', { ids });
            showToast(i18nTf('maintenance.dedup.deleted',
                { removed: r.removed, freed: _formatBytesLocal(r.freedBytes) },
                `Removed ${r.removed} files — freed ${_formatBytesLocal(r.freedBytes)}`),
                'success');
            sheet?.close();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        }
    });
}

// Settings → Maintenance buttons trigger fire-and-forget admin jobs.
// Each handler does the up-front confirm dialog (where applicable) and
// then POSTs the run endpoint; the backend returns 200 immediately and
// the actual work runs in the background. Result toasts and re-enable
// of the button live in `wireMaintenanceJobToasts()` (one set of WS
// subscribers, fired by `${prefix}_done`) so a job started on a phone
// re-paints the desktop's button when it finishes.
async function maintVerifyFiles() {
    try {
        showToast(i18nT('maintenance.verify.running', 'Verifying files…'), 'info');
        const r = await api.post('/api/maintenance/files/verify', {});
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintResyncDialogs() {
    try {
        showToast(i18nT('maintenance.resync.running', 'Resyncing dialogs…'), 'info');
        const r = await api.post('/api/maintenance/resync-dialogs', {});
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
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
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

async function maintDbIntegrity() {
    try {
        showToast(i18nT('maintenance.db_check.running', 'Checking database integrity…'), 'info');
        const r = await api.post('/api/maintenance/db/integrity', {});
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
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
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(i18nT('jobs.already_running',
                'Already running on another tab — waiting for it to finish.'), 'info');
            return;
        }
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

// Wire all `*_done` WS subscribers + button hydration once per session.
// Done events fire here regardless of which client started the job, so
// a phone-triggered VACUUM still pops a result toast on the desktop.
let _maintWsWired = false;
function wireMaintenanceJobToasts() {
    if (_maintWsWired) return;
    _maintWsWired = true;

    // files/verify
    wireJobButton({
        btn: document.getElementById('maint-verify-btn'),
        statusUrl: '/api/maintenance/files/verify/status',
        eventPrefix: 'files_verify',
        runUrl: '/api/maintenance/files/verify',
        attachClick: false,
    });
    ws.on('files_verify_done', (m) => {
        if (m?.error) {
            const msg = i18nTf('maintenance.failed', { msg: m.error }, `Failed: ${m.error}`);
            showToast(msg, 'error');
            // Persist failures to the bell so the operator sees them after
            // the toast auto-dismisses (especially relevant for jobs that
            // started on another device).
            import('./header-mobile.js').then((mod) => mod.pushLogToNotify({
                level: 'error',
                source: 'verify',
                msg,
                ts: Date.now(),
            })).catch(() => {});
            return;
        }
        const scanned = m?.scanned ?? 0;
        const pruned = m?.pruned ?? 0;
        const msg = i18nTf('maintenance.verify.done',
            { scanned, pruned },
            `Verified ${scanned} files — pruned ${pruned} missing rows`);
        showToast(msg, pruned > 0 ? 'warning' : 'success');
        import('./header-mobile.js').then((mod) => mod.pushLogToNotify({
            level: pruned > 0 ? 'warn' : 'info',
            source: 'verify',
            msg,
            ts: Date.now(),
        })).catch(() => {});
    });

    // db/integrity
    wireJobButton({
        btn: document.getElementById('maint-db-check-btn'),
        statusUrl: '/api/maintenance/db/integrity/status',
        eventPrefix: 'db_integrity',
        runUrl: '/api/maintenance/db/integrity',
        attachClick: false,
    });
    ws.on('db_integrity_done', (m) => {
        if (m?.error) {
            showToast(i18nTf('maintenance.failed', { msg: m.error }, `Failed: ${m.error}`), 'error');
            return;
        }
        if (m?.ok) {
            showToast(i18nT('maintenance.db_check.ok', 'Database integrity: ok'), 'success');
        } else {
            const msg = (m?.messages || []).slice(0, 3).join(' / ') || 'unknown';
            showToast(i18nTf('maintenance.db_check.bad', { msg },
                `Database issues: ${msg}`), 'error');
        }
    });

    // db/vacuum — confirm sheet handled by maintDbVacuum, so the
    // wireJobButton click is suppressed (would double-POST otherwise).
    wireJobButton({
        btn: document.getElementById('maint-db-vacuum-btn'),
        statusUrl: '/api/maintenance/db/vacuum/status',
        eventPrefix: 'db_vacuum',
        runUrl: '/api/maintenance/db/vacuum',
        runBody: { confirm: true },
        attachClick: false,
    });
    ws.on('db_vacuum_done', (m) => {
        if (m?.error) {
            showToast(i18nTf('maintenance.failed', { msg: m.error }, `Failed: ${m.error}`), 'error');
            return;
        }
        const reclaimed = formatBytesShort(m?.reclaimedBytes || 0);
        showToast(i18nTf('maintenance.db_vacuum.done', { bytes: reclaimed },
            `VACUUM done — reclaimed ${reclaimed}`), 'success');
    });

    // restart-monitor
    wireJobButton({
        btn: document.getElementById('maint-restart-btn'),
        statusUrl: '/api/maintenance/restart-monitor/status',
        eventPrefix: 'restart_monitor',
        runUrl: '/api/maintenance/restart-monitor',
        runBody: { confirm: true },
        attachClick: false,
    });
    ws.on('restart_monitor_done', (m) => {
        if (m?.error) {
            showToast(i18nTf('maintenance.failed', { msg: m.error }, `Failed: ${m.error}`), 'error');
            return;
        }
        if (m?.restarted) {
            showToast(i18nT('maintenance.restart.done', 'Monitor restarted'), 'success');
        } else {
            showToast(m?.note || i18nT('maintenance.restart.idle',
                'Monitor was not running.'), 'info');
        }
    });

    // resync-dialogs
    wireJobButton({
        btn: document.getElementById('maint-resync-btn'),
        statusUrl: '/api/maintenance/resync-dialogs/status',
        eventPrefix: 'resync_dialogs',
        runUrl: '/api/maintenance/resync-dialogs',
        attachClick: false,
    });
    ws.on('resync_dialogs_done', (m) => {
        if (m?.error) {
            showToast(i18nTf('maintenance.failed', { msg: m.error }, `Failed: ${m.error}`), 'error');
            return;
        }
        showToast(i18nTf('maintenance.resync.done',
            { updated: m?.updated || 0, scanned: m?.scanned || 0 },
            `Resynced ${m?.updated || 0} of ${m?.scanned || 0} groups`), 'success');
    });

    // auto-update — the click handler opens a sheet, so we only wire
    // the disable-state hydration here. The `update_done` toast happens
    // automatically; the watchtower restart usually kills the WS first.
    wireJobButton({
        btn: document.getElementById('maint-update-btn'),
        statusUrl: '/api/auto-update/status',
        eventPrefix: 'update',
        runUrl: '/api/update',
        attachClick: false,
    });
}

// Kept as a fallback — see _maintBuildThumbs comment above.
async function _maintBrowseLogs() {
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
                    // 30 s ceiling on the read — large logs over a slow link
                    // shouldn't lock the UI forever and an aborted fetch
                    // releases the in-flight server-side stream.
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 30000);
                    try {
                        const res = await fetch(`/api/maintenance/logs/download?name=${encodeURIComponent(name)}&lines=10000`, { signal: ctrl.signal });
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
                        const msg = e?.name === 'AbortError'
                            ? i18nT('maintenance.logs.timeout', 'Log read timed out (file too large or server busy)')
                            : (e?.message || String(e));
                        showToast(i18nTf('maintenance.failed', { msg }, `Failed: ${msg}`), 'error');
                    } finally {
                        clearTimeout(timer);
                        btn.disabled = false;
                    }
                });
            });
        }, 50);
    } catch (e) {
        showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
    }
}

// Pretty-print JSON as a Telegram-styled collapsible tree. Each row gets:
//   - A real chevron (▸ / ▾) instead of the default <details> triangle
//     so a search hit can highlight the row without fighting native UA chrome.
//   - Subtle indent guides via a left border on every level.
//   - Monospace numbers + tabular-nums so digits align in long lists.
//   - Per-row data attrs (`data-key-path`, `data-value-text`) so the
//     search filter can hide rows that don't match without re-rendering.
//   - Copy button revealed on hover for individual leaf values.
//
// No third-party dep; everything reuses the existing Tailwind / `--tg-*`
// palette so the tree picks up dark/light theme overrides automatically.
function _renderJsonTree(value, key = null, path = '$') {
    const isLeaf = (v) => v === null || typeof v !== 'object';
    const wrap = (cls, content) => `<span class="${cls}">${content}</span>`;
    const fullPath = key === null ? path : (Number.isInteger(key) ? `${path}[${key}]` : `${path}.${escapeHtml(String(key))}`);
    const keyTok = key === null
        ? ''
        : `<span class="text-tg-blue/90 font-medium">"${escapeHtml(String(key))}"</span><span class="text-tg-textSecondary">: </span>`;

    // Leaves render inline.
    let valTok = '';
    let valText = '';
    if (value === null) { valTok = wrap('text-tg-textSecondary italic', 'null'); valText = 'null'; }
    else if (typeof value === 'boolean') { valTok = wrap('text-purple-300', String(value)); valText = String(value); }
    else if (typeof value === 'number') { valTok = wrap('text-tg-orange tabular-nums', String(value)); valText = String(value); }
    else if (typeof value === 'string') {
        const safe = escapeHtml(value);
        valTok = wrap('text-tg-green break-all', `"${safe}"`);
        valText = value;
    }
    if (valTok) {
        return `<div class="json-row group flex items-start gap-1 px-1 py-0.5 rounded hover:bg-tg-hover/40" data-key-path="${escapeHtml(fullPath)}" data-value-text="${escapeHtml(valText.slice(0, 200))}">
            <span class="json-row-content flex-1 min-w-0 break-words">${keyTok}${valTok}</span>
            <button type="button" class="json-copy opacity-0 group-hover:opacity-100 text-[10px] px-1 py-0.5 rounded text-tg-textSecondary hover:text-tg-blue hover:bg-tg-bg/60 transition-opacity"
                data-copy="${escapeHtml(valText)}" title="${escapeHtml(i18nT('maintenance.config.copy_value', 'Copy value'))}">
                <i class="ri-clipboard-line"></i>
            </button>
        </div>`;
    }

    // Containers — collapsible with explicit chevron we control.
    const isArr = Array.isArray(value);
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    const open = '<span class="text-tg-textSecondary">' + (isArr ? '[' : '{') + '</span>';
    const close = '<span class="text-tg-textSecondary">' + (isArr ? ']' : '}') + '</span>';
    if (!entries.length) {
        return `<div class="json-row flex items-center gap-1 px-1 py-0.5" data-key-path="${escapeHtml(fullPath)}">
            ${keyTok}${open}${close}
        </div>`;
    }
    const children = entries.map(([k, v], i) =>
        `<div class="json-child" data-child>${_renderJsonTree(v, k, fullPath)}<span class="text-tg-textSecondary/60">${i < entries.length - 1 ? ',' : ''}</span></div>`
    ).join('');
    return `<details class="json-node" data-key-path="${escapeHtml(fullPath)}" open>
        <summary class="json-summary list-none cursor-pointer flex items-center gap-1 px-1 py-0.5 rounded hover:bg-tg-hover/40 select-none">
            <i class="json-chev ri-arrow-down-s-line text-sm text-tg-textSecondary shrink-0 transition-transform"></i>
            <span class="flex-1 min-w-0 break-words">${keyTok}${open}<span class="text-tg-textSecondary text-[10px] mx-1 tabular-nums">${entries.length}</span>${close}</span>
        </summary>
        <div class="json-children pl-3 ml-1.5 border-l border-tg-border/30">${children}</div>
    </details>`;
}

async function maintViewConfig() {
    try {
        const res = await fetch('/api/maintenance/config/raw');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let tree;
        try {
            tree = _renderJsonTree(JSON.parse(text));
        } catch {
            // Server returned non-JSON (rare) — fall back to a plain pre.
            tree = `<pre class="text-xs whitespace-pre-wrap">${escapeHtml(text)}</pre>`;
        }
        openSheet({
            title: i18nT('maintenance.config.title', 'View config.json'),
            size: 'lg',
            content: `
                <div class="flex flex-wrap items-center gap-2 mb-3">
                    <div class="relative flex-1 min-w-[200px]">
                        <i class="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-tg-textSecondary text-sm" aria-hidden="true"></i>
                        <input type="search" id="config-search" autocomplete="off"
                            data-i18n-placeholder="maintenance.config.search"
                            placeholder="${escapeHtml(i18nT('maintenance.config.search', 'Search keys or values…'))}"
                            class="tg-input w-full pl-9 pr-3 text-xs h-8">
                    </div>
                    <button data-config-collapse class="tg-btn-secondary text-xs px-3 h-8 inline-flex items-center gap-1">
                        <i class="ri-contract-up-down-line"></i>${escapeHtml(i18nT('maintenance.config.collapse_all', 'Collapse'))}
                    </button>
                    <button data-config-expand class="tg-btn-secondary text-xs px-3 h-8 inline-flex items-center gap-1">
                        <i class="ri-expand-up-down-line"></i>${escapeHtml(i18nT('maintenance.config.expand_all', 'Expand'))}
                    </button>
                    <button data-config-copy class="tg-btn-secondary text-xs px-3 h-8 inline-flex items-center gap-1">
                        <i class="ri-clipboard-line"></i>${escapeHtml(i18nT('maintenance.logs.copy', 'Copy'))}
                    </button>
                    <button data-config-download class="tg-btn-secondary text-xs px-3 h-8 inline-flex items-center gap-1">
                        <i class="ri-download-line"></i>${escapeHtml(i18nT('maintenance.config.download', 'Download'))}
                    </button>
                </div>
                <div id="maint-config-tree" class="text-[12px] font-mono bg-tg-bg/60 rounded-xl p-4 overflow-auto max-h-[60vh] leading-relaxed border border-tg-border/40">${tree}</div>
                <div class="flex items-center justify-between gap-2 mt-3 text-[11px] text-tg-textSecondary">
                    <span class="inline-flex items-center gap-1.5">
                        <i class="ri-shield-check-line text-tg-green"></i>
                        <span data-i18n="maintenance.config.redacted_help">Sensitive fields (apiHash, password hash, proxy password) are redacted.</span>
                    </span>
                    <span id="config-match-count" class="tabular-nums"></span>
                </div>`,
        });
        setTimeout(() => {
            const root = document.getElementById('maint-config-tree');
            if (!root) return;
            const expandAll = (open) => root.querySelectorAll('details.json-node').forEach(d => d.open = open);
            document.querySelector('[data-config-collapse]')?.addEventListener('click', () => expandAll(false));
            document.querySelector('[data-config-expand]')?.addEventListener('click', () => expandAll(true));
            document.querySelector('[data-config-copy]')?.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    showToast(i18nT('maintenance.export.copied', 'Copied'), 'success');
                } catch {
                    showToast(i18nT('maintenance.export.copy_manual', 'Press Ctrl/Cmd+C to copy'), 'info');
                }
            });
            document.querySelector('[data-config-download]')?.addEventListener('click', () => {
                const blob = new Blob([text], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `config-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            });
            // Per-leaf "copy value" buttons.
            root.addEventListener('click', async (e) => {
                const btn = e.target.closest('.json-copy');
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                try {
                    await navigator.clipboard.writeText(btn.dataset.copy || '');
                    showToast(i18nT('maintenance.export.copied', 'Copied'), 'success');
                } catch {
                    showToast(i18nT('maintenance.export.copy_manual', 'Press Ctrl/Cmd+C to copy'), 'info');
                }
            });
            // Live filter — hides rows that don't match the query.
            // Matches against either the dotted key path (`web.shareSecret`) or
            // the stringified leaf value. Container nodes whose children all
            // get hidden also collapse out of the way.
            const search = document.getElementById('config-search');
            const matchCount = document.getElementById('config-match-count');
            let searchTimer = null;
            const applyFilter = (q) => {
                q = String(q || '').trim().toLowerCase();
                let matches = 0;
                const allRows = root.querySelectorAll('.json-row, details.json-node');
                if (!q) {
                    allRows.forEach(el => el.classList.remove('hidden'));
                    if (matchCount) matchCount.textContent = '';
                    return;
                }
                // Walk depth-first; a container is visible iff itself or any
                // descendant matches the query.
                const matchesRow = (el) => {
                    const path = (el.dataset.keyPath || '').toLowerCase();
                    const val = (el.dataset.valueText || '').toLowerCase();
                    return path.includes(q) || val.includes(q);
                };
                const visit = (el) => {
                    let visible = false;
                    const children = el.querySelectorAll(':scope > .json-children > [data-child]');
                    if (children.length) {
                        children.forEach(child => {
                            const innerNode = child.querySelector(':scope > details.json-node, :scope > .json-row');
                            if (!innerNode) return;
                            const childVisible = visit(innerNode);
                            child.classList.toggle('hidden', !childVisible);
                            if (childVisible) visible = true;
                        });
                    } else if (el.classList.contains('json-row')) {
                        visible = matchesRow(el);
                    }
                    // Self can also match by its summary (e.g. searching 'web' on the {web:…} container)
                    if (!visible && matchesRow(el)) visible = true;
                    el.classList.toggle('hidden', !visible);
                    if (visible && (el.classList.contains('json-row') || !el.querySelectorAll(':scope > .json-children > [data-child] > .json-row, :scope > .json-children > [data-child] > details').length)) matches += 1;
                    if (visible && el.tagName === 'DETAILS') el.open = true;
                    return visible;
                };
                root.querySelectorAll(':scope > details.json-node, :scope > .json-row').forEach(visit);
                if (matchCount) matchCount.textContent = i18nTf('maintenance.config.matches', { n: matches }, `${matches} match${matches === 1 ? '' : 'es'}`);
            };
            search?.addEventListener('input', () => {
                if (searchTimer) clearTimeout(searchTimer);
                searchTimer = setTimeout(() => applyFilter(search.value), 120);
            });
        }, 60);
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
        <div class="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
            <div class="flex items-start gap-2">
                <i class="ri-error-warning-line text-red-400 text-base mt-0.5"></i>
                <div>
                    <div class="text-red-300 text-sm font-medium">${escapeHtml(i18nT('maintenance.export.warn_title', 'Sensitive — full account access'))}</div>
                    <p class="text-xs text-red-200/90 mt-1 leading-snug">${escapeHtml(i18nT('maintenance.export.warn',
                        'Anyone with this string can act as the account. Treat it like a password.'))}</p>
                </div>
            </div>
        </div>
        <label class="text-tg-text text-sm block mb-1" data-i18n="maintenance.export.pick">Account</label>
        <select id="maint-export-pick" class="tg-input w-full text-sm mb-3">${opts}</select>
        <button id="maint-export-do" class="tg-btn w-full text-sm">${escapeHtml(i18nT('maintenance.export.action', 'Export'))}</button>
        <div id="maint-export-out" class="mt-3 hidden">
            <label class="text-tg-text text-sm block mb-1" data-i18n="maintenance.export.string">Session string</label>
            <div class="relative">
                <textarea id="maint-export-str" class="tg-input w-full text-xs font-mono blur-sm focus:blur-none transition-all" rows="6" readonly aria-label="Encrypted session string — click reveal to see"></textarea>
                <button id="maint-export-reveal" class="absolute inset-0 w-full h-full flex items-center justify-center bg-tg-bg/80 backdrop-blur-sm rounded-lg text-tg-text text-sm font-medium hover:bg-tg-bg/60 transition">
                    <i class="ri-eye-line mr-2"></i>${escapeHtml(i18nT('maintenance.export.reveal', 'Click to reveal'))}
                </button>
            </div>
            <div class="flex items-center gap-2 mt-2">
                <button id="maint-export-copy" class="tg-btn-secondary flex-1 text-xs">${escapeHtml(i18nT('maintenance.export.copy', 'Copy to clipboard'))}</button>
                <button id="maint-export-clear" class="tg-btn-secondary text-xs px-3" title="${escapeHtml(i18nT('maintenance.export.clear', 'Clear from screen'))}"><i class="ri-eye-close-line"></i></button>
            </div>
            <p class="text-[10px] text-tg-textSecondary mt-2" data-i18n="maintenance.export.auto_clear_help">The string auto-clears from the screen after 60 seconds. Copy it somewhere safe before then.</p>
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
                // Auto-clear after 60 s — even if the user walks away, the
                // sensitive string doesn't sit on the screen forever.
                if (autoClearTimer) clearTimeout(autoClearTimer);
                autoClearTimer = setTimeout(() => {
                    if (str) str.value = '';
                    if (out) out.classList.add('hidden');
                    showToast(i18nT('maintenance.export.cleared', 'Session string cleared from screen'), 'info');
                }, 60 * 1000);
            } catch (e) {
                showToast(i18nTf('maintenance.failed', { msg: e.message }, `Failed: ${e.message}`), 'error');
            } finally {
                doBtn.disabled = false;
            }
        });
        // Reveal — drop the blur + remove the cover button so the textarea
        // is readable. One-shot per export.
        const reveal = document.getElementById('maint-export-reveal');
        if (reveal) reveal.addEventListener('click', () => {
            str?.classList.remove('blur-sm');
            reveal.remove();
        });
        // Manual clear button — wipe the string immediately.
        const clearBtn = document.getElementById('maint-export-clear');
        if (clearBtn) clearBtn.addEventListener('click', () => {
            if (str) str.value = '';
            if (out) out.classList.add('hidden');
            if (autoClearTimer) { clearTimeout(autoClearTimer); autoClearTimer = null; }
            showToast(i18nT('maintenance.export.cleared', 'Session string cleared from screen'), 'info');
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
let autoClearTimer = null;

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
