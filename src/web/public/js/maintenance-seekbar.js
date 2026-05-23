/**
 * Maintenance → Seekbar previews — page controller.
 *
 * Mirrors the `maintenance-thumbs.js` shape: KPI strip + master toggle +
 * settings + JobTracker-driven scan/cancel. The Go sidecar status pill
 * recovers from the server snapshot on mount, and live updates land via
 * the `seekbar_*` WebSocket prefix the JobTracker emits.
 */

import { api } from './api.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { loadAdvanced, setupAutoSave } from './settings.js';
import { confirmSheet } from './sheet.js';
import { formatBytes, showToast } from './utils.js';
import { ws } from './ws.js';

let _wsWired = false;
let _buttonsWired = false;
let _running = false;
let _initDone = false;

export async function init() {
    _wireToggles();
    _wireButtons();
    if (!_wsWired) {
        ws.on('seekbar_progress', _onProgress);
        ws.on('seekbar_done', _onDone);
        ws.on('seekbar_rebuild_progress', _onProgress);
        ws.on('seekbar_rebuild_done', _onDone);
        ws.on('seekbar_sidecar_status', _renderSidecarStatus);
        _wsWired = true;
    }
    if (!_initDone) {
        _initDone = true;
        // setupAutoSave() covers the numeric inputs + <select>s under the
        // sprite-settings card (they all use `id="setting-adv-seekbar-*"`
        // and the helper listens body-wide). The two `.tg-toggle` divs
        // are handled by `_wireToggles` below — they need an explicit
        // optimistic flip + POST, not the generic autosave path, because
        // `.tg-toggle` is a div-with-class trick that doesn't fire
        // native change events on its own.
        try {
            setupAutoSave();
        } catch (e) {
            console.warn('[seekbar] setupAutoSave skipped:', e?.message || e);
        }
    }
    await Promise.all([
        _refreshStats(),
        _refreshLastBuild(),
        _refreshHealth(),
        _recoverBuildState(),
        _syncToggleState(),
        _loadGroupsSelector(),
        _refreshQueueStats(),
    ]);
}

function _wireToggles() {
    // `.tg-toggle` is a div + `.active` class — it doesn't self-flip on
    // click. The generic setupAutoSave() listener only *schedules* a
    // save post-flip, so without an explicit handler the visual state
    // never moves and the server never sees a change. Mirror
    // maintenance-ai.js: optimistic flip + POST /api/config, roll back
    // on failure.
    const master = document.getElementById('setting-adv-seekbar-enabled');
    const auto = document.getElementById('setting-adv-seekbar-autoOnDownload');
    if (master) {
        master.addEventListener('click', () => _toggleFlag(master, 'enabled'));
        master.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                _toggleFlag(master, 'enabled');
            }
        });
    }
    if (auto) {
        auto.addEventListener('click', () => _toggleFlag(auto, 'autoOnDownload'));
        auto.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                _toggleFlag(auto, 'autoOnDownload');
            }
        });
    }
}

async function _toggleFlag(el, key) {
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip so the click feels instant.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', {
            advanced: { seekbar: { [key]: next } },
        });
        if (!r?.success) throw new Error(r?.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        if (key === 'enabled') _refreshStats().catch(() => {});
    } catch (e) {
        // Roll back the optimistic flip — server rejected the write.
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${
                e?.data?.error || e?.message || 'unknown'
            }`,
            'error',
        );
    }
}

async function _syncToggleState() {
    // Seed every setting input (numeric / select / both toggles) from the
    // live kv config on mount so the visual state matches what the server
    // actually persisted. `loadAdvanced` is the same helper the Settings
    // page calls — keeps the population logic in one place so the two
    // surfaces never drift on field names or defaults.
    try {
        const cfg = await api.get('/api/config');
        loadAdvanced(cfg);
    } catch {
        /* non-fatal — the toggles + numeric inputs just stay at their
           HTML-attr defaults until the operator edits something. */
    }
}

function _wireButtons() {
    if (_buttonsWired) return;
    _buttonsWired = true;
    document.getElementById('seekbar-scan-btn')?.addEventListener('click', () => _startScan());
    document.getElementById('seekbar-cancel-btn')?.addEventListener('click', () => _cancelScan());
    // Coverage bar CTA delegates to the main scan button.
    document.getElementById('seekbar-scan-cta')?.addEventListener('click', () => _startScan());
    document.getElementById('seekbar-wipe-btn')?.addEventListener('click', () => _wipeCache());
    document
        .getElementById('seekbar-restart-btn')
        ?.addEventListener('click', () => _restartSidecar());
    document
        .getElementById('seekbar-hwaccel-probe')
        ?.addEventListener('click', () => _runHwaccelProbe());
    document.getElementById('seekbar-doctor-refresh-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        _refreshHealth().catch(() => {});
    });

    // External sidecar URL — save on blur/Enter, test on button click.
    const seekbarUrlEl = document.getElementById('setting-adv-seekbar-sidecar-url');
    if (seekbarUrlEl) {
        seekbarUrlEl.addEventListener('change', _onSeekbarSidecarUrlChange);
    }
    document
        .getElementById('seekbar-sidecar-test-btn')
        ?.addEventListener('click', _onSeekbarSidecarTestClick);

    // Group-selector enable/disable rebuild button when a group is selected.
    const groupSel = document.getElementById('seekbar-group-select');
    const rebuildGroupBtn = document.getElementById('seekbar-rebuild-group-btn');
    if (groupSel && rebuildGroupBtn) {
        groupSel.addEventListener('change', () => {
            rebuildGroupBtn.disabled = !groupSel.value;
        });
        rebuildGroupBtn.addEventListener('click', () => _rebuildGroup(groupSel.value));
    }
}

async function _startScan() {
    try {
        const r = await api.post('/api/maintenance/seekbar/build-all', {});
        if (r?.started) {
            _setBuildUi(true);
            showToast(i18nT('maintenance.seekbar.scan_started', 'Scan started'));
        }
    } catch (e) {
        // 409 = ALREADY_RUNNING — treat as info, not error
        if (e?.status === 409 || e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT('maintenance.seekbar.already_running', 'A scan is already running'),
                'info',
            );
            _setBuildUi(true);
            return;
        }
        showToast(e?.data?.error || e?.message || 'Failed to start scan', 'error');
    }
}

async function _cancelScan() {
    try {
        await api.post('/api/maintenance/seekbar/build/cancel', {});
        showToast(i18nT('maintenance.seekbar.cancelling', 'Cancelling…'));
    } catch (e) {
        showToast(e?.data?.error || e?.message || 'Cancel failed', 'error');
    }
}

async function _wipeCache() {
    const stats = await _safeGet('/api/maintenance/seekbar/stats');
    const count = stats?.count || 0;
    const bytes = stats?.bytes || 0;
    const ok = await confirmSheet({
        title: i18nT('maintenance.seekbar.wipe_confirm_title', 'Wipe sprite cache?'),
        body: i18nTf(
            'maintenance.seekbar.wipe_confirm_body',
            { count, size: formatBytes(bytes) },
            `${count} sprites · ${formatBytes(bytes)} on disk will be removed.`,
        ),
        confirmLabel: i18nT('maintenance.seekbar.wipe_cache', 'Wipe cache'),
        danger: true,
    });
    if (!ok) return;
    try {
        await api.post('/api/maintenance/seekbar/rebuild', { wipeOnly: true });
        showToast(i18nT('maintenance.seekbar.wipe_started', 'Wipe started'));
    } catch (e) {
        showToast(e?.data?.error || e?.message || 'Wipe failed', 'error');
    }
}

async function _onSeekbarSidecarUrlChange() {
    const el = document.getElementById('setting-adv-seekbar-sidecar-url');
    const tokenEl = document.getElementById('setting-adv-seekbar-api-token');
    const url = String(el?.value || '').trim();
    const token = String(tokenEl?.value || '').trim();
    try {
        await api.post('/api/config', {
            advanced: { seekbar: { sidecarUrl: url, apiToken: token } },
        });
        await api.post('/api/maintenance/seekbar/sidecar/restart', {});
        showToast(
            url
                ? i18nT(
                      'maintenance.seekbar.sidecar_url_saved',
                      'Sidecar URL saved — reconnecting…',
                  )
                : i18nT(
                      'maintenance.seekbar.sidecar_url_cleared',
                      'Sidecar URL cleared — using local',
                  ),
            'success',
        );
        await _refreshHealth();
    } catch (e) {
        showToast(`Save failed: ${e?.data?.error || e?.message || 'unknown'}`, 'error');
    }
}

async function _onSeekbarSidecarTestClick() {
    const el = document.getElementById('setting-adv-seekbar-sidecar-url');
    const resultEl = document.getElementById('seekbar-sidecar-test-result');
    const url = String(el?.value || '').trim();
    if (!url) {
        if (resultEl) {
            resultEl.textContent = i18nT(
                'maintenance.seekbar.sidecar_test_empty',
                'Enter a URL first',
            );
            resultEl.className = 'text-[10px] shrink-0 text-yellow-400';
        }
        return;
    }
    if (resultEl) {
        resultEl.textContent = i18nT('maintenance.seekbar.sidecar_testing', 'Testing…');
        resultEl.className = 'text-[10px] shrink-0 text-tg-textSecondary';
    }
    try {
        const tokenEl = document.getElementById('setting-adv-seekbar-api-token');
        const token = String(tokenEl?.value || '').trim();
        const r = await api.post('/api/maintenance/seekbar/sidecar-test', { url, token });
        if (resultEl) {
            if (r.ok) {
                const parts = [r.version ? `v${r.version}` : null].filter(Boolean).join(' · ');
                resultEl.textContent = `✓ ${parts || 'Connected'}`;
                resultEl.className = 'text-[10px] shrink-0 text-green-400';
            } else {
                resultEl.textContent = `✗ ${r.error || 'unreachable'}`;
                resultEl.className = 'text-[10px] shrink-0 text-red-400';
            }
        }
    } catch (e) {
        if (resultEl) {
            resultEl.textContent = `✗ ${e?.message || 'error'}`;
            resultEl.className = 'text-[10px] shrink-0 text-red-400';
        }
    }
}

async function _restartSidecar() {
    try {
        const r = await api.post('/api/maintenance/seekbar/sidecar/restart', {});
        if (r?.sidecar) _renderSidecarStatus(r.sidecar);
        showToast(i18nT('maintenance.seekbar.restart_done', 'Sidecar restarted'));
    } catch (e) {
        showToast(e?.data?.error || e?.message || 'Restart failed', 'error');
    }
}

async function _runHwaccelProbe() {
    const out = document.getElementById('seekbar-hwaccel-result');
    if (out) out.textContent = i18nT('maintenance.seekbar.hwaccel.probing', 'Probing…');
    try {
        const r = await api.get('/api/maintenance/seekbar/hwaccel-probe');
        _renderHwaccelChips(r);
        showToast(i18nT('maintenance.seekbar.hwaccel.probed', 'Hardware probe complete'));
    } catch (e) {
        if (out) out.textContent = `error: ${e?.message || e}`;
    }
}

function _renderHwaccelChips(r) {
    const out = document.getElementById('seekbar-hwaccel-result');
    if (!out) return;
    if (!r || r.error) {
        out.textContent = r?.error ? `error: ${r.error}` : '—';
        return;
    }
    const avail = new Set(r.available || []);
    const compiled = r.compiled || [];
    if (!compiled.length) {
        out.textContent = '—';
        return;
    }
    // chip per compiled backend; green if probe succeeded, muted otherwise.
    out.innerHTML = compiled
        .map((b) => {
            const ok = avail.has(b);
            const cls = ok ? 'bg-tg-green/15 text-tg-green' : 'bg-tg-bg/60 text-tg-textSecondary';
            const icon = ok ? 'ri-checkbox-circle-fill' : 'ri-close-circle-line';
            return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium ${cls}"><i class="${icon}"></i>${b}</span>`;
        })
        .join('');
}

async function _refreshStats() {
    const r = await _safeGet('/api/maintenance/seekbar/stats');
    if (!r) return;
    const count = Number(r.count || 0);
    const total = Number(r.totalVideos || 0);

    document.getElementById('seekbar-kpi-indexed').textContent = count.toLocaleString();
    document.getElementById('seekbar-kpi-disk').textContent = formatBytes(r.bytes || 0);

    // Coverage tile
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const covEl = document.getElementById('seekbar-kpi-coverage');
    if (covEl) covEl.textContent = total > 0 ? `${pct}%` : '—';

    // Coverage bar
    const wrap = document.getElementById('seekbar-coverage-wrap');
    const bar = document.getElementById('seekbar-coverage-bar');
    const label = document.getElementById('seekbar-coverage-label');
    const cta = document.getElementById('seekbar-scan-cta');
    if (wrap && bar && label) {
        wrap.classList.remove('hidden');
        bar.style.width = `${pct}%`;
        bar.className = `h-full transition-all duration-500 rounded-full ${pct >= 100 ? 'bg-tg-green' : pct >= 50 ? 'bg-tg-blue' : 'bg-yellow-400'}`;
        label.textContent =
            total > 0
                ? `${count.toLocaleString()} / ${total.toLocaleString()} videos have previews`
                : i18nT('maintenance.seekbar.coverage.none', 'No videos yet');
        if (cta) cta.classList.toggle('hidden', pct >= 100 || total === 0);
    }

    // ffmpeg line (de-emphasised)
    const ffmpegLine = document.getElementById('seekbar-ffmpeg-line');
    const ffmpegVal = document.getElementById('seekbar-kpi-ffmpeg');
    if (ffmpegLine && ffmpegVal) {
        ffmpegLine.classList.remove('hidden');
        ffmpegVal.textContent = r.ffmpegAvailable
            ? i18nT('maintenance.seekbar.ffmpeg.ok', 'available')
            : i18nT('maintenance.seekbar.ffmpeg.missing', 'missing');
        ffmpegVal.className = `font-mono ${r.ffmpegAvailable ? 'text-tg-green' : 'text-red-400'}`;
    }

    if (r.sidecar) _renderSidecarStatus(r.sidecar);
}

async function _refreshLastBuild() {
    const r = await _safeGet('/api/maintenance/seekbar/build/stats');
    const el = document.getElementById('seekbar-kpi-last');
    if (!el) return;
    if (r?.lastBuild?.finishedAt) {
        const dt = new Date(r.lastBuild.finishedAt);
        el.textContent = dt.toLocaleString();
    } else {
        el.textContent = i18nT('maintenance.seekbar.last_scan_none', 'never');
    }
}

async function _recoverBuildState() {
    const r = await _safeGet('/api/maintenance/seekbar/build/status');
    if (r && (r.running || r.status === 'running')) {
        _setBuildUi(true);
        if (r.lastProgress) _onProgress(r.lastProgress);
    }
}

function _setBuildUi(running) {
    _running = running;
    const scan = document.getElementById('seekbar-scan-btn');
    const cancel = document.getElementById('seekbar-cancel-btn');
    const progress = document.getElementById('seekbar-progress');
    if (scan) scan.disabled = running;
    if (cancel) cancel.disabled = !running;
    if (progress) progress.classList.toggle('hidden', !running);
}

function _onProgress(p) {
    if (!p) return;
    if (!_running) _setBuildUi(true);
    const total = Number(p.total) || 0;
    const processed = Number(p.processed) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const bar = document.getElementById('seekbar-progress-bar');
    const pctEl = document.getElementById('seekbar-progress-pct');
    const detail = document.getElementById('seekbar-progress-detail');
    if (bar) bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (detail) {
        const parts = [];
        parts.push(`${processed} / ${total}`);
        if (p.generated != null) parts.push(`generated ${p.generated}`);
        if (p.skipped != null) parts.push(`skipped ${p.skipped}`);
        if (p.errored) parts.push(`errored ${p.errored}`);
        detail.textContent = parts.join(' · ');
    }
}

function _onDone(p) {
    _setBuildUi(false);
    // Refresh stats + coverage bar now that sprites have been generated.
    _refreshStats().catch(() => {});
    _refreshLastBuild().catch(() => {});
    _refreshQueueStats().catch(() => {});
    if (p?.cancelled) {
        showToast(i18nT('maintenance.seekbar.cancelled', 'Scan cancelled'));
    } else {
        const generated = p?.generated ?? 0;
        const errored = p?.errored ?? 0;
        showToast(
            i18nTf(
                'maintenance.seekbar.done',
                { generated, errored },
                `Scan finished — ${generated} generated, ${errored} errored.`,
            ),
            errored ? 'warning' : 'success',
        );
    }
}

function _renderSidecarStatus(s) {
    if (!s) return;
    // Sidecar state changed — refresh the System health card so the
    // operator sees the new mode / pid / error without a page reload.
    _refreshHealth().catch(() => {});
    const pill = document.getElementById('seekbar-sidecar-pill');
    const detail = document.getElementById('seekbar-sidecar-detail');
    if (!pill) return;
    pill.classList.remove(
        'bg-tg-bg/60',
        'text-tg-textSecondary',
        'bg-tg-green/15',
        'text-tg-green',
        'bg-tg-orange/15',
        'text-tg-orange',
        'bg-red-500/15',
        'text-red-400',
    );
    let icon = 'ri-circle-line';
    let label = s.mode || 'idle';
    if (s.ok) {
        pill.classList.add('bg-tg-green/15', 'text-tg-green');
        icon = 'ri-circle-fill';
        label = i18nT('maintenance.seekbar.sidecar.running', 'sidecar running');
    } else if (s.mode === 'binary_missing') {
        pill.classList.add('bg-tg-orange/15', 'text-tg-orange');
        icon = 'ri-information-line';
        label = i18nT(
            'maintenance.seekbar.sidecar.binary_missing',
            'sidecar binary missing — using ffmpeg fallback',
        );
    } else if (s.mode === 'starting') {
        pill.classList.add('bg-tg-bg/60', 'text-tg-textSecondary');
        icon = 'ri-loader-4-line animate-spin';
        label = i18nT('maintenance.seekbar.sidecar.starting', 'starting…');
    } else if (s.mode === 'unhealthy' || s.mode === 'exited') {
        pill.classList.add('bg-red-500/15', 'text-red-400');
        icon = 'ri-error-warning-line';
        label = s.error || s.mode;
    } else {
        pill.classList.add('bg-tg-bg/60', 'text-tg-textSecondary');
    }
    pill.innerHTML = `<i class="${icon}"></i><span>${label}</span>`;
    if (detail) {
        const parts = [];
        if (s.url) parts.push(s.url);
        if (s.pid) parts.push(`pid=${s.pid}`);
        if (s.error && !s.ok) parts.push(s.error);
        detail.textContent = parts.join(' · ');
    }
}

async function _refreshHealth() {
    const r = await _safeGet('/api/maintenance/seekbar/health');
    if (!r) return;
    const s = r.sidecar || {};
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val || '—';
    };
    set('seekbar-health-sidecar', s.mode ? `${s.mode}${s.ok ? ' · ok' : ''}` : '—');
    set('seekbar-health-url', s.url || '—');
    set('seekbar-health-pid', s.pid ? String(s.pid) : '—');
    set('seekbar-health-binary', s.binPath || s.bin || (s.mode === 'remote' ? 'remote' : '—'));
    const hw = r.hwaccel;
    const hwTxt = hw?.error
        ? `error: ${hw.error}`
        : hw && Array.isArray(hw.available)
          ? hw.available.join(', ') || 'none'
          : '—';
    set('seekbar-health-hwaccel', hwTxt);
    set(
        'seekbar-health-version',
        r.version ? `v${r.version} · ${r.platform || ''}` : r.platform || '—',
    );
    // Mirror the live hwaccel result into the settings sub-card chip
    // strip so operators see the probe outcome the moment they open
    // the page — no extra click required.
    if (hw && !hw.error) _renderHwaccelChips(hw);

    // Doctor-summary one-liner (worst-state pick). Mirrors the AI
    // page's `ai-doctor-summary` shape so the collapsed <summary>
    // reflects "what would the operator care about right now".
    const summary = document.getElementById('seekbar-doctor-summary');
    if (summary) {
        if (s.ok && r.ffmpegAvailable) {
            const tail = hw?.available?.length ? ` · hwaccel: ${hw.available.join(', ')}` : '';
            summary.textContent = `· ${i18nT('maintenance.seekbar.health.ok', 'all systems go')}${tail}`;
            summary.className = 'text-[10.5px] text-tg-green';
        } else if (s.mode === 'starting' || s.mode === 'downloading') {
            summary.textContent = `· ${i18nT('maintenance.seekbar.health.warming', 'sidecar warming up')}`;
            summary.className = 'text-[10.5px] text-tg-orange';
        } else if (!r.ffmpegAvailable) {
            summary.textContent = `· ${i18nT('maintenance.seekbar.health.no_ffmpeg', 'ffmpeg missing on PATH')}`;
            summary.className = 'text-[10.5px] text-red-400';
        } else {
            summary.textContent = `· ${s.error || s.mode || i18nT('maintenance.seekbar.health.unknown', 'unhealthy')}`;
            summary.className = 'text-[10.5px] text-red-400';
        }
    }

    const errEl = document.getElementById('seekbar-health-error');
    if (errEl) {
        if (s.error && !s.ok) {
            errEl.textContent = s.error;
            errEl.classList.remove('hidden');
        } else {
            errEl.textContent = '';
            errEl.classList.add('hidden');
        }
    }
}

/**
 * Populate the group selector from the monitored-groups list. Groups that
 * have no videos are included — the rebuild endpoint handles the empty case.
 * Bounded at 200 groups to stay consistent with the big-data rules.
 */
async function _loadGroupsSelector() {
    const sel = document.getElementById('seekbar-group-select');
    if (!sel) return;
    try {
        const r = await api.get('/api/groups?limit=200');
        const groups = Array.isArray(r?.groups) ? r.groups : Array.isArray(r) ? r : [];
        if (!groups.length) return;
        // Remove old dynamic options (keep the placeholder).
        while (sel.options.length > 1) sel.remove(1);
        for (const g of groups) {
            const id = String(g.groupId || g.id || '');
            if (!id) continue;
            const name = String(g.name || g.title || g.groupId || id);
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = name.length > 50 ? `${name.slice(0, 47)}…` : name;
            sel.appendChild(opt);
        }
    } catch (e) {
        console.warn('[seekbar] group selector load failed:', e?.message || e);
    }
}

/**
 * Rebuild sprites for a single group. POSTs to
 * /api/maintenance/seekbar/build-group with { groupId }. The server runs the
 * same JobTracker as build-all — progress lands on the existing seekbar_progress
 * WS event so the header progress bar updates automatically.
 */
async function _rebuildGroup(groupId) {
    if (!groupId) return;
    const btn = document.getElementById('seekbar-rebuild-group-btn');
    if (btn) btn.disabled = true;
    try {
        const r = await api.post('/api/maintenance/seekbar/build-group', { groupId });
        if (r?.started) {
            _setBuildUi(true);
            showToast(i18nT('maintenance.seekbar.scan_started', 'Scan started'));
        } else if (r?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT('maintenance.seekbar.already_running', 'A scan is already running'),
                'info',
            );
            _setBuildUi(true);
        } else if (r?.error) {
            showToast(r.error, 'error');
        }
    } catch (e) {
        if (e?.status === 409 || e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT('maintenance.seekbar.already_running', 'A scan is already running'),
                'info',
            );
            _setBuildUi(true);
        } else {
            showToast(e?.data?.error || e?.message || 'Rebuild failed', 'error');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * Refresh the generation-activity section.
 * When a scan is running: show the 4-tile grid with live counts.
 * When idle: collapse to a single summary line.
 */
async function _refreshQueueStats() {
    const r = await _safeGet('/api/maintenance/seekbar/queue/stats');
    if (!r) return;

    const running = Boolean(r.running);
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val != null ? Number(val).toLocaleString() : '—';
    };

    // Toggle badges
    const idleBadge = document.getElementById('seekbar-queue-idle-badge');
    const liveBadge = document.getElementById('seekbar-queue-live-badge');
    if (idleBadge) idleBadge.classList.toggle('hidden', running);
    if (liveBadge) liveBadge.classList.toggle('hidden', !running);

    // Toggle grid vs idle line
    const activeGrid = document.getElementById('seekbar-queue-active');
    const idleLine = document.getElementById('seekbar-queue-idle-line');
    if (activeGrid) activeGrid.classList.toggle('hidden', !running);
    if (idleLine) idleLine.classList.toggle('hidden', running);

    if (running) {
        set('seekbar-queue-queued', r.queued);
        set('seekbar-queue-processing', r.processing);
        set('seekbar-queue-completed', r.completed);
        set('seekbar-queue-failed', r.failed);
    } else {
        // Idle: show a friendly summary using the DB total (completed = countSeekbarSprites)
        const total = Number(r.completed || 0);
        if (idleLine) {
            idleLine.textContent =
                total > 0
                    ? `${total.toLocaleString()} sprites generated · no scan running`
                    : i18nT(
                          'maintenance.seekbar.queue.idle_none',
                          'No sprites yet — click Scan now to generate previews for your library.',
                      );
        }
    }
}

async function _safeGet(url) {
    try {
        return await api.get(url);
    } catch {
        return null;
    }
}
