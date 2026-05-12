/* Maintenance → AI page module.
 *
 * Faces-only build. The Python face-clustering sidecar (insightface
 * buffalo_l, 512-dim embeddings) is the only AI surface here today;
 * Search + Auto-tag were removed in v2.14. NSFW classification lives
 * on its own Maintenance → NSFW tab.
 *
 * Init contract: `init()` is called every time the SPA navigates to
 * `#/maintenance/ai`. It must be idempotent — repeated calls re-bind
 * listeners but don't double-fire requests.
 */

import { api } from './api.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { showToast, escapeHtml } from './utils.js';
import { ws } from './ws.js';
import { confirmSheet, promptSheet } from './sheet.js';

const $ = (sel) => document.querySelector(sel);

// Module state.
let _initOnce = false;
let _lastStatus = null;
let _selectedPerson = null;
let _selectedPersonName = '';
let _peopleCache = []; // full people list (un-filtered) for client-side search
const _peopleFilter = { query: '', unlabeledOnly: false };

// Scan phase tracking — distinguishes Phase A (per-image detect) from
// Phase B (DBSCAN clustering, runs after A completes, typically seconds).
let _scanPhase = 'A'; // 'A' | 'B'

export async function init() {
    if (!_initOnce) {
        _bindOnce();
        _initOnce = true;
    }
    await refreshStatus();
    _refreshDoctor().catch(() => {});
    _loadPeople().catch(() => {});
}

// Public refresher — exported so the SPA shell can poke us after a
// settings save lands somewhere else (Settings → Advanced → AI).
export async function refreshStatus() {
    try {
        const r = await api.get('/api/ai/status');
        if (!r.success) return;
        _lastStatus = r;
        _renderStatus(r);
    } catch (e) {
        console.warn('ai/status:', e);
    }
}

// ---- Wire-once listeners --------------------------------------------------

function _bindOnce() {
    // Header action buttons. All three follow the maintenance/thumbs
    // pattern: a primary `Scan now`, an always-rendered `Cancel`
    // (disabled while idle), and a secondary destructive `Reindex from
    // scratch`. The legacy `#ai-master-badge` + `#ai-recluster-btn`
    // hosts live as hidden no-op spans so old bookmarks / extensions
    // don't crash on missing nodes.
    $('#ai-scan-btn')?.addEventListener('click', () => _startScan('faces'));
    $('#ai-cancel-btn')?.addEventListener('click', () => _cancelScan('faces'));
    $('#ai-reindex-btn')?.addEventListener('click', _reindexFromScratch);
    $('#ai-recluster-btn')?.addEventListener('click', _recluster);
    $('#ai-detect-test-btn')?.addEventListener('click', _runDetectTest);

    // Sensitivity preset buttons — one-click apply ε + minPoints, then
    // immediately re-cluster so the operator sees results in seconds.
    document.querySelectorAll('.ai-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => _applyPreset(btn.dataset.preset));
    });

    // Master + auto toggles — both live as labelled rows in the Face
    // clustering settings section. Click-anywhere on the toggle flips
    // the underlying config flag and immediately re-renders so the
    // visual state matches the API result.
    $('#ai-master-toggle')?.addEventListener('click', _onMasterToggle);
    $('#ai-master-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onMasterToggle();
        }
    });
    $('#ai-auto-toggle')?.addEventListener('click', _onAutoToggle);
    $('#ai-auto-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onAutoToggle();
        }
    });

    // Settings inputs — model / threshold / minPoints / provider.
    // `change` (not `input`) so dragging the slider doesn't spam saves.
    $('#ai-faces-model')?.addEventListener('change', (e) =>
        _saveSetting('facesDetectorModel', String(e.target.value || 'buffalo_l'), {
            restartSidecar: true,
        }),
    );
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    if (epsInp) {
        // Live readout: update the <output> as the slider moves so the
        // operator can see the value before letting go.
        epsInp.addEventListener('input', () => {
            if (epsOut) epsOut.textContent = Number(epsInp.value).toFixed(2);
        });
        epsInp.addEventListener('change', () => _saveSetting('facesEpsilon', Number(epsInp.value)));
    }
    $('#ai-faces-min-points')?.addEventListener('change', (e) =>
        _saveSetting('facesMinPoints', Number(e.target.value || 3)),
    );

    // Hardware-acceleration sub-card — same UX as the thumbs page.
    $('#ai-faces-provider-probe-btn')?.addEventListener('click', _runFacesProviderProbe);
    $('#ai-faces-provider')?.addEventListener('change', _onFacesProviderChange);

    // Doctor refresh
    $('#ai-doctor-refresh-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _refreshDoctor().catch(() => {});
    });

    // People — search + filter chip + refresh.
    $('#ai-people-search')?.addEventListener('input', (e) => {
        _peopleFilter.query = String(e.target.value || '').toLowerCase();
        _renderPeopleGrid();
    });
    $('#ai-people-unlabeled')?.addEventListener('change', (e) => {
        _peopleFilter.unlabeledOnly = !!e.target.checked;
        _renderPeopleGrid();
    });
    $('#ai-people-refresh-btn')?.addEventListener('click', () => _loadPeople());

    // Person action buttons.
    $('#ai-person-rename-btn')?.addEventListener('click', _renameSelectedPerson);
    $('#ai-person-merge-btn')?.addEventListener('click', _mergeSelectedPerson);
    $('#ai-person-split-btn')?.addEventListener('click', _splitSelectedPerson);
    $('#ai-person-delete-btn')?.addEventListener('click', _deleteSelectedPerson);

    // WebSocket — only the people / scan events survive in the faces-only
    // build. ai_index_* / ai_tags_* were removed with the Search + Tags
    // pipelines. ai_faces_status surfaces sidecar lifecycle changes so the
    // header badge updates without a polling loop.
    // ai_people_phase_b fires when Phase A (detection) is complete and Phase B
    // (DBSCAN clustering) starts — the payload carries { faceCount } so the
    // UI can switch to "Clustering N faces..." without a polling round-trip.
    ws.on('ai_people_progress', (m) => _onScanProgress('faces', m));
    ws.on('ai_people_done', (m) => _onScanDone('faces', m));
    ws.on('ai_people_phase_b', (m) => _onScanPhaseB(m));
    ws.on('ai_faces_status', () => refreshStatus());

    // Auto-installer feedback. Streams stdout from `python -m
    // tgdl_faces.install` line-by-line so the operator sees pip progress
    // (downloading wheels, resolving deps, etc.) without leaving the
    // page. `ai_faces_install_done` flips the spinner off + reveals the
    // result toast.
    $('#ai-install-btn')?.addEventListener('click', _runInstaller);
    ws.on('ai_faces_install_progress', _onInstallProgress);
    ws.on('ai_faces_install_done', _onInstallDone);

    // Overflow menu → "Manage GPU support". Reveals the install card
    // even when the sidecar is healthy (so operators can switch EP),
    // closes the <details> menu, scrolls the card into view.
    $('#ai-open-install-btn')?.addEventListener('click', () => {
        const card = document.getElementById('ai-install-card');
        if (card) {
            card.classList.remove('hidden');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        const menu = document.getElementById('ai-more-menu');
        if (menu instanceof HTMLDetailsElement) menu.open = false;
    });
}

async function _runInstaller() {
    const btn = $('#ai-install-btn');
    const sel = $('#ai-install-force');
    const force = String(sel?.value || '').trim() || undefined;
    const wrap = $('#ai-install-progress');
    const log = $('#ai-install-log');
    const status = $('#ai-install-status');
    if (log) log.textContent = '';
    if (wrap) wrap.classList.remove('hidden');
    if (status) status.textContent = i18nT('maintenance.ai.install.running', 'Installing…');
    if (btn) {
        btn.disabled = true;
        btn.dataset.busy = '1';
    }
    try {
        const r = await api.post('/api/ai/faces/install-deps', force ? { force } : {});
        if (!r.started && r.error) throw new Error(r.error);
    } catch (e) {
        if (status) status.textContent = i18nT('common.error', 'Error');
        if (log) log.textContent += `\n${e?.message || e}\n`;
        if (btn) {
            btn.disabled = false;
            delete btn.dataset.busy;
        }
        showToast(
            `${i18nT('maintenance.ai.install.failed', 'Install failed')}: ${e?.message || e}`,
            'error',
        );
    }
}

function _onInstallProgress(m) {
    const wrap = $('#ai-install-progress');
    const log = $('#ai-install-log');
    if (wrap) wrap.classList.remove('hidden');
    if (log && m && typeof m.line === 'string') {
        log.textContent += m.line + '\n';
        log.scrollTop = log.scrollHeight;
    }
}

function _onInstallDone(m) {
    const btn = $('#ai-install-btn');
    const status = $('#ai-install-status');
    if (btn) {
        btn.disabled = false;
        delete btn.dataset.busy;
    }
    if (m?.ok) {
        if (status)
            status.textContent = i18nT(
                'maintenance.ai.install.done',
                'Install complete — restarting sidecar…',
            );
        showToast(
            i18nT('maintenance.ai.install.done', 'Install complete — restarting sidecar…'),
            'success',
        );
        // Server kicks startSidecar() automatically; refresh status so
        // the badge flips to healthy as soon as the probe lands.
        setTimeout(() => refreshStatus().catch(() => {}), 1500);
    } else {
        const reason = m?.reason || i18nT('common.error', 'Error');
        if (status) status.textContent = reason;
        showToast(
            `${i18nT('maintenance.ai.install.failed', 'Install failed')}: ${reason}`,
            'error',
        );
    }
}

/**
 * Save a single config key + its nested `faces.*` alias (per Track I's
 * dual-write rule so `_mergeAi` doesn't quietly revert the value). For
 * keys not in the alias map this just writes the flat path.
 * `restartSidecar=true` (used for `facesDetectorModel`) also fire-and-
 * forgets a `/api/ai/faces/restart` so the new model loads next /detect.
 */
async function _saveSetting(cfgKey, value, { restartSidecar = false } = {}) {
    // Map UI control cfgKey → canonical save path. The slider/number controls
    // read from legacy flat keys (`cfg.facesEpsilon`, `cfg.facesMinPoints`),
    // but the new nested `advanced.ai.faces.*` block is the canonical home —
    // `_mergeAi` precedence is `faces.* > flat`, so a flat-key save gets
    // silently overridden on the next load. Save into BOTH paths so the
    // nested block actually changes.
    const saveAliases = {
        facesEpsilon: ['facesEpsilon', 'epsilon'],
        facesMinPoints: ['facesMinPoints', 'minPoints'],
        facesDetectorModel: ['facesDetectorModel', 'detectorModel'],
    };
    try {
        const body = { advanced: { ai: {} } };
        const alias = saveAliases[cfgKey];
        if (alias) {
            body.advanced.ai[alias[0]] = value;
            body.advanced.ai.faces = { [alias[1]]: value };
        } else {
            body.advanced.ai[cfgKey] = value;
        }
        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        if (restartSidecar) {
            try {
                await api.post('/api/ai/faces/restart', {});
            } catch (e) {
                console.warn('faces/restart on setting change:', e);
            }
        }
    } catch (e) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

async function _onAutoToggle() {
    const el = $('#ai-auto-toggle');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip so the click feels instant.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', {
            advanced: { ai: { faceClustering: next } },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        // Roll back optimistic flip.
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Status / settings ----------------------------------------------------

function _renderStatus(status) {
    if (!status) return;
    const cfg = status.config || {};
    const counts = status.counts || {};
    const scans = status.scans || {};
    const models = status.models || {};

    // Sidecar status pill — always rendered now (the prior hide-on-
    // empty path silently dropped the chip during partial rollouts).
    _renderSidecarBadge(status);

    // Progress + scan buttons. Cancel is always rendered and just
    // toggles its disabled state; the thumbs page uses the same
    // contract so the controls feel consistent across the app.
    const facesScan = scans?.faces || {};
    const running = !!facesScan.running;
    const scanBtn = $('#ai-scan-btn');
    const cancelBtn = $('#ai-cancel-btn');
    if (scanBtn) scanBtn.disabled = running;
    if (cancelBtn) cancelBtn.disabled = !running;
    const prog = $('#ai-progress');
    if (prog) prog.classList.toggle('hidden', !running);
    if (running) {
        const scanned = Number(facesScan.scanned) || 0;
        const total = Number(facesScan.total) || 0;
        const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
        const bar = $('#ai-progress-bar');
        const pctEl = $('#ai-progress-pct');
        const statusEl = $('#ai-progress-status');
        if (bar) bar.style.width = `${pct}%`;
        if (pctEl)
            pctEl.textContent = total
                ? `${scanned.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`
                : `${scanned.toLocaleString()} processed`;
        if (statusEl) statusEl.textContent = i18nT('maintenance.ai.scanning', 'Scanning…');
    }

    // KPI tiles. peopleCount is the canonical "how many clusters"
    // metric; withFaces (distinct downloads that have at least one
    // face) gives a different shape and was confusing operators.
    const indexedEl = $('#ai-stat-indexed');
    if (indexedEl) {
        const indexed = Number(counts.indexed) || 0;
        const total = Number(counts.totalEligible) || 0;
        indexedEl.textContent = `${indexed.toLocaleString()} / ${total.toLocaleString()}`;
    }
    const peopleEl = $('#ai-stat-people');
    if (peopleEl) peopleEl.textContent = String(counts.peopleCount ?? counts.withFaces ?? 0);
    const lastEl = $('#ai-stat-last');
    if (lastEl) {
        const finishedAt = Number(scans?.faces?.finishedAt) || 0;
        lastEl.textContent =
            finishedAt > 0 ? new Date(finishedAt).toLocaleString() : i18nT('common.never', 'Never');
    }
    // Noise / unclassified faces count — DBSCAN marks faces that don't fit
    // any cluster as noise points. Surfacing this helps operators decide
    // whether to lower minPoints or accept the noise level.
    const noiseEl = $('#ai-stat-noise');
    if (noiseEl) {
        const noise = Number(counts.noiseFaces ?? counts.unclassified ?? 0);
        noiseEl.textContent = noise.toLocaleString();
    }

    // Toggles. Click handlers in `_bindOnce` flip the underlying flag
    // optimistically; this is the "render from server truth" pass that
    // runs on init + after every save round-trip.
    const masterToggle = $('#ai-master-toggle');
    if (masterToggle) {
        const on = !!cfg.enabled;
        masterToggle.classList.toggle('active', on);
        masterToggle.setAttribute('aria-checked', String(on));
    }
    const autoToggle = $('#ai-auto-toggle');
    if (autoToggle) {
        const on = cfg.faceClustering !== false;
        autoToggle.classList.toggle('active', on);
        autoToggle.setAttribute('aria-checked', String(on));
    }

    // Model line — id + dim + provider, served by /api/ai/status.
    const facesModel = models.faces || {};
    const modelId =
        facesModel.id || (facesModel.bundled ? 'insightface buffalo_l (Python sidecar)' : '—');
    const dim = facesModel.dim || (facesModel.bundled ? 512 : null);
    const provider = _resolveProvider(facesModel);
    const modelLine = [modelId, dim ? `${dim}-dim` : null, provider || null]
        .filter(Boolean)
        .join(' · ');
    const modelLineEl = $('#ai-model-line');
    if (modelLineEl) {
        modelLineEl.textContent = modelLine;
        modelLineEl.title = modelId;
    }

    // Settings inputs — sync values from config so F5 doesn't appear
    // to revert local changes. The `value =` write fires before any
    // change listener, so this is safe even when the slider is in the
    // operator's focus.
    const modelSel = $('#ai-faces-model');
    if (modelSel) {
        const cur = String(cfg.facesDetectorModel || cfg.faces?.detectorModel || 'buffalo_l');
        if (modelSel.value !== cur) modelSel.value = cur;
    }
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    if (epsInp) {
        const cur = Number.isFinite(cfg.facesEpsilon) ? Number(cfg.facesEpsilon) : 1.05;
        if (Number(epsInp.value) !== cur) epsInp.value = String(cur);
        if (epsOut) epsOut.textContent = Number(cur).toFixed(2);
    }
    const minInp = $('#ai-faces-min-points');
    if (minInp) {
        const cur = Number.isFinite(cfg.facesMinPoints) ? Number(cfg.facesMinPoints) : 2;
        if (Number(minInp.value) !== cur) minInp.value = String(cur);
    }
    // Highlight whichever preset matches the live ε + minPoints combo so
    // the operator can see at a glance which mode is active.
    _highlightPreset(
        Number.isFinite(cfg.facesEpsilon) ? cfg.facesEpsilon : 1.05,
        Number.isFinite(cfg.facesMinPoints) ? cfg.facesMinPoints : 2,
    );
    const provSel = $('#ai-faces-provider');
    if (provSel) {
        const cur = String(cfg.faces?.providers || 'auto').toLowerCase();
        if (provSel.value !== cur) provSel.value = cur;
    }
}

function _renderSidecarBadge(status) {
    const badge = $('#ai-sidecar-badge');
    const text = $('#ai-sidecar-badge-text');
    if (!badge || !text) return;
    // The pill is always rendered now — operators want to see the
    // sidecar's state at a glance regardless of payload shape.
    badge.classList.remove('hidden');
    const faces = (status?.models && status.models.faces) || {};
    const state = String(faces.state || (faces.loaded ? 'healthy' : 'unknown')).toLowerCase();
    const provider = _resolveProvider(faces);
    let label;
    let cls = 'text-tg-textSecondary';
    let healthy = false;
    if (state === 'healthy' || state === 'ready' || faces.loaded === true) {
        // Show both provider (GPU chip) and model id in the badge so operators
        // can confirm which hardware + model is active without opening System health.
        const providerTag = provider || 'CPU';
        const modelTag = faces.id ? String(faces.id).replace(/insightface\s*/i, '').trim() : '';
        const parts = [providerTag, modelTag].filter(Boolean).join(' · ');
        label = i18nTf(
            'maintenance.ai.sidecar.healthy',
            { provider: parts },
            `Sidecar: ready (${parts})`,
        );
        cls = 'text-green-300';
        healthy = true;
    } else if (state === 'downloading' || state === 'pulling') {
        const pct = Number.isFinite(faces.downloadPct) ? Math.round(faces.downloadPct) : 0;
        label = i18nTf(
            'maintenance.ai.sidecar.downloading',
            { pct },
            `Sidecar: downloading… (${pct}%)`,
        );
        cls = 'text-yellow-300';
    } else if (state === 'starting' || state === 'loading') {
        label = i18nT('maintenance.ai.sidecar.starting', 'Sidecar: starting…');
        cls = 'text-yellow-300';
    } else if (state === 'disabled' || state === 'idle') {
        label = i18nT('maintenance.ai.sidecar.idle', 'Sidecar: idle');
        cls = 'text-tg-textSecondary';
    } else {
        label = i18nT('maintenance.ai.sidecar.down', 'Sidecar offline — start the faces service');
        cls = 'text-red-300';
    }
    text.textContent = label;
    badge.classList.remove(
        'text-green-300',
        'text-yellow-300',
        'text-red-300',
        'text-tg-textSecondary',
    );
    badge.classList.add(cls);

    // Dot indicator — swap the icon class to reflect the health colour.
    const dotIcon = badge.querySelector('.ai-sidecar-dot');
    if (dotIcon) {
        dotIcon.classList.remove(
            'text-green-400',
            'text-yellow-400',
            'text-red-400',
            'text-tg-textSecondary',
        );
        if (cls === 'text-green-300') dotIcon.classList.add('text-green-400');
        else if (cls === 'text-yellow-300') dotIcon.classList.add('text-yellow-400');
        else if (cls === 'text-red-300') dotIcon.classList.add('text-red-400');
        else dotIcon.classList.add('text-tg-textSecondary');
    }

    // Auto-surface the Install card when the sidecar isn't healthy and
    // we're not mid-installation already. Hide it once it's up so the
    // page reads as "everything's working" with no extra panels. The
    // operator can still trigger /api/ai/faces/install-deps from the
    // Re-cluster era (re-installing manually) by reopening the page
    // when offline — the card reappears on the next status flip.
    const installCard = $('#ai-install-card');
    if (installCard) {
        const installBusy = $('#ai-install-btn')?.dataset?.busy === '1';
        const showInstall = !healthy && !installBusy;
        installCard.classList.toggle('hidden', !showInstall);
    }
}

// Map onnxruntime's full provider name to the friendly tag we show in
// the UI. Without this, "DmlExecutionProvider" → "Dml" reads as a typo;
// "CUDAExecutionProvider" → "CUDA" is fine but it's worth normalising
// the whole table so the chip text stays consistent regardless of EP.
const _PROVIDER_LABEL = {
    DmlExecutionProvider: 'DirectML',
    CUDAExecutionProvider: 'CUDA',
    CoreMLExecutionProvider: 'CoreML',
    OpenVINOExecutionProvider: 'OpenVINO',
    TensorrtExecutionProvider: 'TensorRT',
    AzureExecutionProvider: 'Azure',
    CPUExecutionProvider: 'CPU',
};

function _resolveProvider(faces) {
    // The Python sidecar reports `providers: ["DmlExecutionProvider", ...]`.
    // Display the friendly tag (DirectML / CUDA / CoreML / CPU) — the
    // ExecutionProvider suffix is noise in a one-line badge.
    const list = Array.isArray(faces.providers)
        ? faces.providers
        : faces.provider
          ? [faces.provider]
          : [];
    if (!list.length) return '';
    const first = String(list[0] || '');
    return _PROVIDER_LABEL[first] || first.replace(/ExecutionProvider$/i, '').trim();
}

async function _onMasterToggle() {
    const el = $('#ai-master-toggle');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip — feels instant; rolled back below on save failure.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', { advanced: { ai: { enabled: next } } });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Hardware provider probe ----------------------------------------------

// Dropdown short-key ↔ onnxruntime full provider name. Kept in sync with
// `faces-service/tgdl_faces/insight.py:_PROVIDER_ALIASES` so the UI and
// the sidecar agree on which probe entry maps to which dropdown option.
const _ONNX_PROVIDER_MAP = {
    cuda: 'CUDAExecutionProvider',
    coreml: 'CoreMLExecutionProvider',
    directml: 'DmlExecutionProvider',
    openvino: 'OpenVINOExecutionProvider',
    cpu: 'CPUExecutionProvider',
};

function _providerShortKey(fullName) {
    for (const [k, v] of Object.entries(_ONNX_PROVIDER_MAP)) {
        if (v === fullName) return k;
    }
    return null;
}

/**
 * Apply probe results to the provider dropdown:
 *   - disable + line-through every option whose underlying onnxruntime
 *     provider didn't verify (so the operator can't pick a broken one)
 *   - auto-select the recommended provider when the operator was on
 *     'auto', so the active choice matches the chip list at a glance
 *   - keep 'auto' always enabled (the sidecar resolves it at runtime)
 */
function _applyProbeToProviderSelect(probe) {
    const sel = $('#ai-faces-provider');
    if (!sel) return;
    const details = Array.isArray(probe?.details) ? probe.details : [];
    const detailsByShort = new Map();
    for (const d of details) {
        const shortKey = _providerShortKey(d.name);
        if (shortKey) detailsByShort.set(shortKey, d);
    }
    const recommendedShort = _providerShortKey(probe?.recommended);

    for (const opt of sel.options) {
        const v = String(opt.value || '').toLowerCase();
        if (v === 'auto') {
            opt.disabled = false;
            const recLabel = recommendedShort
                ? ` — ${i18nT('maintenance.ai.faces.providers.auto_picks', 'picks')} ${(_ONNX_PROVIDER_MAP[recommendedShort] || recommendedShort).replace('ExecutionProvider', '')}`
                : '';
            const base = i18nT('maintenance.ai.faces.providers.auto', 'Auto (best available)');
            opt.textContent = base + recLabel;
            continue;
        }
        const d = detailsByShort.get(v);
        const labelKey = `maintenance.ai.faces.providers.${v}`;
        const defaultLabel = opt.dataset._baseLabel || opt.textContent;
        if (!opt.dataset._baseLabel) opt.dataset._baseLabel = defaultLabel;
        const baseLabel = i18nT(labelKey, defaultLabel);
        if (!d) {
            opt.disabled = true;
            opt.textContent = `${baseLabel} — ${i18nT('maintenance.ai.faces.providers.unsupported', 'not available on this host')}`;
            continue;
        }
        if (d.verified) {
            opt.disabled = false;
            const star = v === recommendedShort ? '★ ' : '✓ ';
            opt.textContent = `${star}${baseLabel}`;
        } else {
            opt.disabled = true;
            opt.textContent = `✗ ${baseLabel} — ${i18nT('maintenance.ai.faces.providers.driver_missing', 'driver missing')}`;
        }
    }

    // If the operator was on 'auto', leave 'auto' selected — the sidecar
    // will pick `recommendedShort` itself. If they had a specific choice
    // that is now disabled, fall back to 'auto' so saves don't fail.
    const cur = String(sel.value || 'auto').toLowerCase();
    const curOpt = Array.from(sel.options).find((o) => String(o.value).toLowerCase() === cur);
    if (curOpt?.disabled) {
        sel.value = 'auto';
        // Persist the safe default so the next save round-trip matches.
        _onFacesProviderChange({ target: { value: 'auto' } });
    }
}

async function _runFacesProviderProbe() {
    const resultEl = $('#ai-faces-provider-probe-result');
    const btn = $('#ai-faces-provider-probe-btn');
    if (!resultEl) return;
    resultEl.textContent = i18nT('maintenance.ai.faces.providers.probing', 'Probing…');
    if (btn) btn.disabled = true;
    try {
        const r = await api.get('/api/ai/faces/provider-probe');
        const details = Array.isArray(r?.details) ? r.details : [];
        const available = Array.isArray(r?.available) ? r.available : [];
        if (!available.length) {
            resultEl.innerHTML = `<span class="text-yellow-300">${escapeHtml(
                i18nT(
                    'maintenance.ai.faces.providers.none',
                    'No working provider — falling back to CPU',
                ),
            )}</span>`;
            _applyProbeToProviderSelect(r);
            return;
        }
        // Render every candidate so the operator sees the full picture
        // (e.g. CUDA listed but unverified = driver missing; CPU
        // verified = always usable as a fallback). Verified chips get
        // the tg-blue accent; unverified ones are dimmed + struck.
        const chips = details
            .map((p) => {
                const okCls = p.verified
                    ? 'bg-tg-blue/20 text-tg-blue'
                    : 'bg-tg-bg/30 text-tg-textSecondary line-through';
                const icon = p.verified ? 'ri-check-line' : 'ri-close-line';
                return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${okCls} text-[10px] font-medium" title="${escapeHtml(
                    p.error || '',
                )}"><i class="${icon}"></i>${escapeHtml(p.name)}</span>`;
            })
            .join(' ');
        const rec = r?.recommended
            ? `<div class="mt-1.5 text-[11px]"><span class="opacity-70">${escapeHtml(
                  i18nT('maintenance.ai.faces.providers.recommended', 'Recommended:'),
              )}</span> <span class="text-tg-blue font-medium">${escapeHtml(r.recommended)}</span></div>`
            : '';
        resultEl.innerHTML = chips + rec;
        _applyProbeToProviderSelect(r);
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        resultEl.innerHTML = `<span class="text-red-300">${escapeHtml(
            i18nT('maintenance.ai.faces.providers.probe_failed', 'Probe failed:'),
        )} ${escapeHtml(msg)}</span>`;
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function _onFacesProviderChange(e) {
    const v = String(e.target?.value || 'auto').toLowerCase();
    try {
        // The nested faces.providers key is the canonical home (Track I);
        // POST /api/config deep-merges so we don't overwrite siblings.
        const r = await api.post('/api/config', {
            advanced: { ai: { faces: { providers: v } } },
        });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        // Trigger a sidecar relaunch so the new provider takes effect on
        // the next scan. Best-effort — failures are surfaced as toasts
        // but the saved value still wins on the next process boot.
        try {
            await api.post('/api/ai/faces/restart', {});
        } catch (relaunchErr) {
            // Older builds may not expose the restart endpoint yet; the
            // saved value still applies on next process boot.
            console.warn('faces/restart:', relaunchErr);
        }
    } catch (err) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${err?.data?.error || err?.message || 'unknown'}`,
            'error',
        );
    }
}

// ---- Sensitivity presets --------------------------------------------------
//
// Three opinionated combinations of ε + minPoints. Calibrated on real
// 900+ photo data (see scripts/calibrate-faces-eps.js). One click saves
// both values + immediately re-clusters so the operator sees new people
// within seconds instead of waiting for a full re-scan.

const _PRESETS = {
    precise:   { epsilon: 0.90, minPoints: 3 },
    balanced:  { epsilon: 1.05, minPoints: 2 },
    sensitive: { epsilon: 1.20, minPoints: 2 },
};

function _highlightPreset(eps, min) {
    document.querySelectorAll('.ai-preset-btn').forEach((btn) => {
        const p = _PRESETS[btn.dataset.preset];
        const active =
            p &&
            Math.abs(p.epsilon - eps) < 0.005 &&
            p.minPoints === min;
        btn.classList.toggle('border-tg-blue', active);
        btn.classList.toggle('bg-tg-blue/10', active);
    });
}

async function _applyPreset(name) {
    const p = _PRESETS[name];
    if (!p) return;
    // Update slider + number box immediately so the page feels responsive.
    const epsInp = $('#ai-faces-epsilon');
    const epsOut = $('#ai-faces-epsilon-out');
    const minInp = $('#ai-faces-min-points');
    if (epsInp) epsInp.value = String(p.epsilon);
    if (epsOut) epsOut.textContent = p.epsilon.toFixed(2);
    if (minInp) minInp.value = String(p.minPoints);
    _highlightPreset(p.epsilon, p.minPoints);
    // Persist both values in one save, then re-cluster.
    try {
        const body = {
            advanced: {
                ai: {
                    facesEpsilon: p.epsilon,
                    facesMinPoints: p.minPoints,
                    faces: { epsilon: p.epsilon, minPoints: p.minPoints },
                },
            },
        };
        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(
            i18nT('maintenance.ai.preset_applied', `Preset "${name}" applied — re-clustering…`),
            'success',
        );
        await _recluster();
    } catch (e) {
        showToast(
            `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
            'error',
        );
    }
}

async function _recluster() {
    // Phase B only — keeps the existing face embeddings, just re-runs
    // DBSCAN with the current ε / minPoints. The /api/ai/faces/recluster
    // endpoint pipelines into the same scan-runner Phase B as a full
    // scan, but skips Phase A so it lands in seconds instead of minutes.
    try {
        const r = await api.post('/api/ai/faces/recluster', {});
        if (!r.success) throw new Error(r.error || 'recluster failed');
        showToast(
            i18nT('maintenance.ai.recluster_kicked', 'Re-clustering existing faces…'),
            'success',
        );
        await refreshStatus();
        await _loadPeople();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(
            `${i18nT('maintenance.ai.recluster_failed', 'Re-cluster failed')}: ${msg}`,
            'error',
        );
    }
}

async function _reindexFromScratch() {
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.reindex_confirm_title', 'Reindex from scratch?'),
        body: i18nT(
            'maintenance.ai.reindex_confirm_body',
            'This wipes EVERY face detection and EVERY person cluster, then re-scans every photo. Existing labels survive only if matching faces are detected again.',
        ),
        confirmLabel: i18nT('maintenance.ai.reindex_confirm_action', 'Reindex'),
        cancelLabel: i18nT('common.cancel', 'Cancel'),
        danger: true,
    });
    if (!ok) return;
    try {
        const r = await api.post('/api/ai/faces/reindex', {});
        if (!r.success) throw new Error(r.error || 'reindex failed');
        showToast(
            i18nT(
                'maintenance.ai.reindex_kicked',
                'Reindex started — every photo will be re-detected.',
            ),
            'success',
        );
        // Wipe local people cache + status to reflect the clean slate; the
        // scan progress events will refresh both as the run rebuilds them.
        _peopleCache = [];
        _selectedPerson = null;
        _renderPeopleGrid();
        await refreshStatus();
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        showToast(`${i18nT('maintenance.ai.reindex_failed', 'Reindex failed')}: ${msg}`, 'error');
    }
}

// ---- Detect-test (single-photo diagnostic) --------------------------------

async function _runDetectTest() {
    const idInput = $('#ai-detect-test-id');
    const resultEl = $('#ai-detect-test-result');
    const btn = $('#ai-detect-test-btn');
    const id = parseInt(idInput?.value, 10);
    if (!id || id < 1) {
        showToast(i18nT('maintenance.ai.detect_test_need_id', 'Enter a Download ID first'), 'info');
        return;
    }
    if (btn) btn.disabled = true;
    if (resultEl) { resultEl.textContent = '…'; resultEl.classList.remove('hidden'); }
    try {
        const r = await api.post('/api/ai/detect-test', { downloadId: id });
        if (!r.success) throw new Error(r.error || 'detect-test failed');
        const lines = [];
        lines.push(`File:    ${r.filePath || '—'}`);
        lines.push(`Abs:     ${r.absPath || '(not found on disk)'}`);
        lines.push(`Type:    ${r.fileType || '—'}`);
        if (r.error) {
            lines.push(`Error:   ${r.error}`);
        } else if (r.rawCount === null) {
            lines.push('Result:  sidecar returned null (unreachable or hard error)');
        } else if (r.rawCount === 0) {
            lines.push('Result:  0 faces detected after quality filter');
        } else {
            lines.push(`Result:  ${r.rawCount} face(s) detected`);
            for (const f of r.raw || []) {
                lines.push(`  • box=${f.w}×${f.h}px, score=${f.score?.toFixed(3)}, emb=${f.embeddingDim}d`);
            }
        }
        if (r.warnings?.length) {
            lines.push('');
            lines.push('Warnings:');
            for (const w of r.warnings) lines.push(`  ${w}`);
        }
        if (resultEl) resultEl.textContent = lines.join('\n');
    } catch (e) {
        const msg = e?.data?.error || e?.message || 'unknown';
        if (resultEl) resultEl.textContent = `Error: ${msg}`;
        showToast(`${i18nT('common.error', 'Error')}: ${msg}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ---- Scan controls --------------------------------------------------------

async function _startScan(feature) {
    // Auto-enable the AI subsystem if the operator hits Scan with the
    // master toggle off — there's no real cost (faces clustering is
    // already gated by its own per-capability toggle) and operators
    // shouldn't have to find two switches to start a scan. The master
    // toggle remains visible so it can be turned off explicitly to
    // pause auto-index on new downloads.
    if (!_lastStatus?.config?.enabled) {
        try {
            await api.post('/api/config', {
                advanced: { ai: { enabled: true } },
            });
            await refreshStatus();
        } catch (e) {
            showToast(
                `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
                'error',
            );
            return;
        }
    }
    try {
        const r = await api.post('/api/ai/scan/start', { feature });
        if (r.error) {
            showToast(r.error, 'error');
            return;
        }
        showToast(i18nT('maintenance.ai.scan_started', 'Scan started'), 'success');
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
}

async function _cancelScan(feature) {
    try {
        await api.post('/api/ai/scan/cancel', { feature });
        showToast(i18nT('maintenance.ai.scan_cancelled', 'Scan cancelled'), 'info');
    } catch (e) {
        showToast(`${i18nT('common.error', 'Error')}: ${e.message}`, 'error');
    }
}

function _onScanProgress(feature, msg) {
    // Faces is the only feature today — `feature` arg kept for future
    // OCR / object detection drops that reuse this WS handler.
    if (feature !== 'faces') return;
    const running = !!msg.running;
    const scanned = Number(msg.scanned) || 0;
    const total = Number(msg.total) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;

    const scanBtn = $('#ai-scan-btn');
    const cancelBtn = $('#ai-cancel-btn');
    const progressWrap = $('#ai-progress');
    const progressBar = $('#ai-progress-bar');
    const progressPct = $('#ai-progress-pct');
    const progressStatus = $('#ai-progress-status');
    const phaseTag = $('#ai-progress-phase');

    // If progress is arriving we're in Phase A — Phase B has its own event.
    if (running) _scanPhase = 'A';

    if (scanBtn) scanBtn.disabled = running;
    if (cancelBtn) cancelBtn.disabled = !running;
    if (progressWrap) progressWrap.classList.toggle('hidden', !running);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressPct) {
        progressPct.textContent = running
            ? total
                ? `${scanned.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`
                : `${scanned.toLocaleString()} processed`
            : '';
    }
    if (progressStatus && running) {
        progressStatus.textContent = i18nT('maintenance.ai.scanning', 'Scanning…');
    }
    // Phase tag — shows "Phase 1: detection" during A; hidden when idle.
    if (phaseTag) {
        phaseTag.textContent = running
            ? i18nT('maintenance.ai.scan_phase_a', 'Phase 1: face detection')
            : '';
        phaseTag.classList.toggle('hidden', !running);
    }
}

/**
 * Phase B starts once every photo has been detected. The payload carries
 * { faceCount } — the total number of face embeddings about to be clustered.
 * We swap the progress bar to indeterminate (pulse animation) and show a
 * "Clustering N faces…" label. The bar stays full-width so the operator
 * sees "almost done" at a glance.
 */
function _onScanPhaseB(msg) {
    _scanPhase = 'B';
    const progressWrap = $('#ai-progress');
    const progressBar = $('#ai-progress-bar');
    const progressPct = $('#ai-progress-pct');
    const progressStatus = $('#ai-progress-status');
    const phaseTag = $('#ai-progress-phase');

    if (progressWrap) progressWrap.classList.remove('hidden');
    // Full-width bar with shimmer class to signal "indeterminate but close".
    if (progressBar) {
        progressBar.style.width = '100%';
        progressBar.classList.add('ai-progress-clustering');
    }
    const faceCount = Number(msg?.faceCount) || 0;
    if (progressPct) progressPct.textContent = '';
    if (progressStatus) {
        progressStatus.textContent = faceCount > 0
            ? i18nTf(
                  'maintenance.ai.scan_phase_b_faces',
                  { n: faceCount.toLocaleString() },
                  `Clustering ${faceCount.toLocaleString()} faces…`,
              )
            : i18nT('maintenance.ai.scan_phase_b', 'Clustering faces…');
    }
    if (phaseTag) {
        phaseTag.textContent = i18nT('maintenance.ai.scan_phase_b_tag', 'Phase 2: DBSCAN clustering');
        phaseTag.classList.remove('hidden');
    }
}

function _onScanDone(feature, msg) {
    // Reset phase state + remove shimmer from the bar.
    _scanPhase = 'A';
    const progressBar = $('#ai-progress-bar');
    if (progressBar) progressBar.classList.remove('ai-progress-clustering');
    const phaseTag = $('#ai-progress-phase');
    if (phaseTag) phaseTag.classList.add('hidden');

    _onScanProgress(feature, { ...msg, running: false });
    if (msg?.error) {
        showToast(`${feature}: ${msg.error}`, 'error');
    } else {
        // Show "Found Y people in Z faces" summary on successful completion.
        const people = Number(msg?.peopleCount ?? msg?.people) || 0;
        const faces = Number(msg?.faceCount ?? msg?.faces) || 0;
        if (people > 0 || faces > 0) {
            const summary = i18nTf(
                'maintenance.ai.scan_done_summary',
                { people: people.toLocaleString(), faces: faces.toLocaleString() },
                `Found ${people.toLocaleString()} people in ${faces.toLocaleString()} faces`,
            );
            showToast(summary, 'success');
        } else {
            showToast(i18nT('maintenance.ai.scan_done', 'Scan complete'), 'success');
        }
    }
    refreshStatus();
    if (feature === 'faces') _loadPeople();
}

// ---- People (face clusters) ----------------------------------------------

async function _loadPeople() {
    try {
        const r = await api.get('/api/ai/people?limit=500');
        if (!r.success) return;
        _peopleCache = Array.isArray(r.people) ? r.people : [];
        _renderPeopleGrid();
    } catch (e) {
        console.warn('ai/people:', e);
    }
}

function _renderPeopleGrid() {
    const grid = $('#ai-people-grid');
    const empty = $('#ai-people-empty');
    const emptyHelp = $('#ai-people-empty-help');
    const epsilonWarn = $('#ai-epsilon-warning');
    const count = $('#ai-people-count');
    if (!grid) return;

    // Apply filters client-side. The list is bounded at 500 by the
    // API request limit; a >500-cluster library is rare and would
    // be addressed by a server-side filter param later (paginate +
    // search).
    const q = _peopleFilter.query;
    const unlabeled = _peopleFilter.unlabeledOnly;
    const filtered = _peopleCache.filter((p) => {
        if (unlabeled && p.label) return false;
        if (q) {
            const hay = `${p.label || ''} ${p.id}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    if (count) {
        count.textContent = filtered.length
            ? `(${filtered.length}${
                  filtered.length !== _peopleCache.length ? `/${_peopleCache.length}` : ''
              })`
            : '';
    }

    const testForm = $('#ai-detect-test-form');
    if (!filtered.length) {
        grid.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        // Help message: "no faces detected" — only shown when the full
        // (unfiltered) cache is also empty, i.e. not just a filter miss.
        let showTestForm = false;
        if (emptyHelp) {
            if (_peopleCache.length === 0) {
                // Determine whether the sidecar is reachable to give context.
                const faces = _lastStatus?.models?.faces || {};
                const counts = _lastStatus?.counts || {};
                const sidecarUp = faces.loaded === true || faces.state === 'healthy' || faces.state === 'ready';
                const lastScan = _lastStatus?.scans?.faces?.finishedAt || 0;
                const scannedPhotos = Number(counts.indexed) || 0;
                if (!sidecarUp) {
                    emptyHelp.textContent = i18nT(
                        'maintenance.ai.people_empty_sidecar_down',
                        'No faces detected — ensure the faces sidecar is running and photos exist.',
                    );
                } else if (lastScan > 0 && scannedPhotos > 0) {
                    // Scan ran + photos indexed but 0 clusters. Most likely
                    // cause: epsilon too tight or minPoints too high. Suggest
                    // the Sensitive preset as the one-click fix.
                    const noiseFaces = Number(_lastStatus?.counts?.noiseFaces ?? _lastStatus?.counts?.unclassified ?? 0);
                    if (noiseFaces > 0) {
                        emptyHelp.innerHTML = i18nT(
                            'maintenance.ai.people_empty_noise',
                            `Faces were detected but none clustered into people (${noiseFaces.toLocaleString()} unclassified). Try <strong>Sensitive</strong> preset above, then Re-cluster.`,
                        ).replace('{noise}', noiseFaces.toLocaleString());
                    } else {
                        emptyHelp.textContent = i18nT(
                            'maintenance.ai.people_empty_scan_ran',
                            'Scan complete — no faces were detected. Try the Sensitive preset or use the test tool to check a specific photo.',
                        );
                    }
                    showTestForm = true;
                } else {
                    emptyHelp.textContent = i18nT(
                        'maintenance.ai.people_empty_no_faces',
                        'No faces detected — run a scan above to index your photos.',
                    );
                }
                emptyHelp.classList.remove('hidden');
            } else {
                emptyHelp.classList.add('hidden');
            }
        }
        if (testForm) testForm.classList.toggle('hidden', !showTestForm);
        return;
    }
    if (empty) empty.classList.add('hidden');
    if (emptyHelp) emptyHelp.classList.add('hidden');
    if (testForm) testForm.classList.add('hidden');

    // Epsilon warning — surface when a single cluster contains an unusually
    // large share of all faces (>25%), which is the canonical symptom of
    // the epsilon being too high and merging everyone together.
    if (epsilonWarn) {
        const totalFaces = _peopleCache.reduce((s, p) => s + (Number(p.face_count) || 0), 0);
        const maxCluster = Math.max(..._peopleCache.map((p) => Number(p.face_count) || 0));
        const dominance = totalFaces > 0 ? maxCluster / totalFaces : 0;
        // Also warn when fewer than expected clusters exist — a common sign
        // of over-merging is having 1–3 clusters for a large library.
        const megaMerge = dominance > 0.25 && totalFaces > 20;
        epsilonWarn.classList.toggle('hidden', !megaMerge);
    }

    grid.innerHTML = filtered.map(_personTile).join('');
    // Restore selection highlight after re-render.
    if (_selectedPerson) {
        const sel = grid.querySelector(`[data-person="${_selectedPerson}"]`);
        if (sel) sel.classList.add('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10');
    }
    grid.querySelectorAll('[data-person]').forEach((b) => {
        b.addEventListener('click', () => {
            grid.querySelectorAll('.ai-person-card').forEach((el) =>
                el.classList.remove('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10'),
            );
            b.classList.add('ring-2', 'ring-tg-blue/50', 'bg-tg-blue/10');
            _selectedPerson = Number(b.dataset.person);
            _selectedPersonName = b.dataset.name || '';
            _showPersonPhotos();
        });
        // Double-click on the name label → inline rename shortcut.
        b.addEventListener('dblclick', (e) => {
            // Only trigger if the click landed on the name area (not the image).
            if (e.target.closest('.ai-person-name')) {
                e.preventDefault();
                e.stopPropagation();
                _selectedPerson = Number(b.dataset.person);
                _selectedPersonName = b.dataset.name || '';
                _renameSelectedPerson();
            }
        });
    });
}

function _personTile(p) {
    const isUnclassified = p.id === -1 || p.noise === true;
    const name = isUnclassified
        ? i18nT('maintenance.ai.person_unclassified', 'Unclassified')
        : p.label || `Person #${p.id}`;
    const faceCount = Number(p.face_count) || 0;
    const safeName = escapeHtml(name);

    const faceUrl = !isUnclassified && p.id > 0 ? `/api/ai/person/${p.id}/face?w=128` : '';
    const fallbackUrl = p.cover_download_id ? `/api/thumbs/${p.cover_download_id}?w=128` : '';

    let imgHtml;
    if (faceUrl) {
        const fb = fallbackUrl
            ? `this.onerror=null;this.src='${fallbackUrl}'`
            : `this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-2xl text-tg-textSecondary/40\\'></i>'`;
        imgHtml = `<img src="${faceUrl}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover" onerror="${fb}">`;
    } else if (fallbackUrl) {
        imgHtml = `<img src="${fallbackUrl}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover">`;
    } else {
        imgHtml = `<i class="ri-user-line text-2xl text-tg-textSecondary/40"></i>`;
    }

    const badge = faceCount > 0
        ? `<span class="absolute -bottom-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-tg-blue text-white text-[9px] font-bold flex items-center justify-center leading-none border-2 border-tg-panel">${faceCount}</span>`
        : '';

    return `<button type="button" data-person="${p.id}" data-name="${safeName}"
        title="${safeName} · ${faceCount} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}"
        class="ai-person-card flex flex-col items-center gap-1.5 px-1 py-2.5 rounded-xl hover:bg-tg-blue/5 active:scale-95 transition-all group text-center select-none">
        <div class="relative flex-shrink-0">
            <div class="w-16 h-16 rounded-full overflow-hidden ring-2 ring-tg-border/30 group-hover:ring-tg-blue/60 transition-all flex items-center justify-center bg-tg-bg/40">
                ${imgHtml}
            </div>
            ${badge}
        </div>
        <div class="w-full min-w-0">
            <div class="ai-person-name text-[10.5px] font-medium text-tg-text leading-tight line-clamp-2 break-words px-0.5">${safeName}</div>
        </div>
    </button>`;
}

async function _showPersonPhotos() {
    if (!_selectedPerson) return;
    const photosPanel = $('#ai-people-photos');
    if (photosPanel) photosPanel.classList.remove('hidden');
    const nameEl = $('#ai-people-photos-name');
    if (nameEl) nameEl.textContent = _selectedPersonName;

    // Populate detail avatar immediately from the face crop endpoint.
    const detailAvatar = $('#ai-person-detail-avatar');
    if (detailAvatar) {
        if (_selectedPerson > 0) {
            detailAvatar.innerHTML = `<img src="/api/ai/person/${_selectedPerson}/face?w=80" alt="${escapeHtml(_selectedPersonName)}" loading="lazy" class="w-full h-full object-cover" onerror="this.onerror=null;this.parentElement.innerHTML='<i class=\\'ri-user-line text-lg text-tg-textSecondary/40\\'></i>'">`;
        } else {
            detailAvatar.innerHTML = `<i class="ri-user-line text-lg text-tg-textSecondary/40"></i>`;
        }
    }

    const grid = $('#ai-people-photos-grid');
    if (!grid) return;
    grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;

    // Scroll the panel into view on mobile so the operator doesn't miss it.
    photosPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
        // Prefer /api/ai/person/{id}/downloads (singular "person") which may
        // return richer face-box metadata. Fall back to the people endpoint.
        let r = null;
        let files = [];
        try {
            r = await api.get(`/api/ai/person/${_selectedPerson}/downloads?limit=120`);
            if (r?.success) files = r.downloads || r.files || [];
        } catch (_e) {
            // Older backend — fall back to the people photos endpoint.
        }
        if (!files.length) {
            r = await api.get(`/api/ai/people/${_selectedPerson}/photos?limit=120`);
            if (!r?.success) throw new Error(r?.error || 'load failed');
            files = r.files || [];
        }
        if (!files.length) {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.no_photos', 'No photos in this cluster.'))}</div>`;
            const photoCount = $('#ai-person-photo-count');
            if (photoCount) photoCount.textContent = '';
            return;
        }
        const photoCount = $('#ai-person-photo-count');
        if (photoCount) {
            photoCount.textContent = `${files.length.toLocaleString()} ${i18nT('maintenance.ai.faces_short', 'appearances')}`;
        }
        grid.innerHTML = files.map(_photoTile).join('');
    } catch (e) {
        grid.innerHTML = `<div class="col-span-full text-center text-xs text-red-300 py-8">${escapeHtml(e.message)}</div>`;
    }
}

function _photoTile(row) {
    const id = row.download_id || row.id;
    const faceId = row.face_id || '';
    const name = escapeHtml(row.file_name || `#${id}`);

    // Prefer the face-cropped thumbnail — shows exactly which face was matched.
    // Falls back to full-photo thumb when no face_id (legacy API).
    const imgSrc = faceId
        ? `/api/ai/faces/${faceId}/crop?w=160`
        : `/api/thumbs/${id}?w=160`;
    const fallbackSrc = `/api/thumbs/${id}?w=160`;

    const onerror = faceId
        ? `this.onerror=null;this.src='${fallbackSrc}'`
        : '';

    const onerrorAttr = onerror ? ` onerror="${onerror}"` : '';

    return `
        <a href="#/files/${id}" class="block group relative rounded-lg overflow-hidden" title="${name}" data-face-id="${faceId}">
            <img src="${imgSrc}" alt="${name}" loading="lazy"${onerrorAttr}
                class="aspect-square w-full object-cover bg-tg-bg/40 transition-transform duration-200 group-hover:scale-105">
            <div class="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
        </a>
    `;
}

async function _renameSelectedPerson() {
    if (!_selectedPerson) return;
    const label = await promptSheet({
        title: i18nT('maintenance.ai.person_rename', 'Rename'),
        message: i18nT('maintenance.ai.rename_prompt', 'Name this person:'),
        defaultValue: _selectedPersonName || '',
        confirmLabel: i18nT('common.save', 'Save'),
    });
    if (label == null) return;
    try {
        const r = await api.patch(`/api/ai/people/${_selectedPerson}`, { label });
        if (!r.success) throw new Error(r.error || 'rename failed');
        _selectedPersonName = label;
        showToast(i18nT('common.saved', 'Saved'), 'success');
        const nameEl = $('#ai-people-photos-name');
        if (nameEl) nameEl.textContent = label;
        _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _mergeSelectedPerson() {
    if (!_selectedPerson) return;
    const candidates = _peopleCache.filter((p) => p.id !== _selectedPerson);
    if (!candidates.length) {
        showToast(
            i18nT('maintenance.ai.merge_no_other', 'No other clusters to merge with.'),
            'info',
        );
        return;
    }
    const lines = candidates
        .map((p) => `  ${p.id}: ${p.label || `Person #${p.id}`} (${p.face_count} faces)`)
        .join('\n');
    const targetIdRaw = await promptSheet({
        title: i18nT('maintenance.ai.person_merge', 'Merge…'),
        message: `${i18nT('maintenance.ai.merge_prompt', 'Type the cluster id of the target — every face in this cluster moves there.')}\n\n${lines}`,
        confirmLabel: i18nT('maintenance.ai.person_merge', 'Merge'),
    });
    if (targetIdRaw == null) return;
    const targetId = Number(String(targetIdRaw).trim());
    if (!Number.isFinite(targetId) || !candidates.some((p) => p.id === targetId)) {
        showToast(i18nT('maintenance.ai.merge_invalid', 'Invalid cluster id.'), 'error');
        return;
    }
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.person_merge', 'Merge'),
        message: i18nT(
            'maintenance.ai.merge_confirm',
            'This cluster will be deleted and its faces will move to the target cluster. Cannot be undone.',
        ),
        destructive: true,
        confirmText: i18nT('maintenance.ai.person_merge', 'Merge'),
    });
    if (!ok) return;
    try {
        const res = await api.post(`/api/ai/people/${targetId}/merge`, {
            otherId: _selectedPerson,
        });
        if (!res.success) throw new Error(res.error || 'merge failed');
        showToast(
            `${i18nT('maintenance.ai.merge_done', 'Merged')} — ${res.moved || 0} ${i18nT('maintenance.ai.faces_short', 'faces')}`,
            'success',
        );
        _selectedPerson = null;
        _selectedPersonName = '';
        $('#ai-people-photos')?.classList.add('hidden');
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _splitSelectedPerson() {
    if (!_selectedPerson) return;
    // Simple split flow: ask the operator for a comma-separated list of
    // face ids to peel into a new cluster. The face ids are surfaced in
    // the photo tile's `data-face-id` so power users can read them off
    // the DOM. A future upgrade would replace this with a click-to-mark
    // grid; today's interaction matches merge() in pattern.
    const raw = await promptSheet({
        title: i18nT('maintenance.ai.person_split', 'Split…'),
        message: i18nT(
            'maintenance.ai.split_prompt',
            'Comma-separated face ids to move into a new cluster. Find them in the photos grid (inspect element → data-face-id).',
        ),
        confirmLabel: i18nT('maintenance.ai.person_split', 'Split'),
    });
    if (raw == null) return;
    const faceIds = String(raw)
        .split(/[,\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    if (!faceIds.length) {
        showToast(i18nT('maintenance.ai.split_invalid', 'No valid face ids supplied.'), 'error');
        return;
    }
    const newLabel = await promptSheet({
        title: i18nT('maintenance.ai.person_split', 'Split'),
        message: i18nT(
            'maintenance.ai.split_label_prompt',
            'Label for the new cluster (optional):',
        ),
        confirmLabel: i18nT('common.save', 'Save'),
    });
    try {
        const res = await api.post(`/api/ai/people/${_selectedPerson}/split`, {
            faceIds,
            newLabel: newLabel || undefined,
        });
        if (!res.success) throw new Error(res.error || 'split failed');
        showToast(
            `${i18nT('maintenance.ai.split_done', 'Split complete')} — ${faceIds.length} ${i18nT('maintenance.ai.faces_short', 'faces')}`,
            'success',
        );
        _loadPeople();
        await refreshStatus();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _deleteSelectedPerson() {
    if (!_selectedPerson) return;
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.person_delete', 'Delete'),
        message: i18nT(
            'maintenance.ai.delete_confirm',
            'Delete this cluster? Faces will become unassigned.',
        ),
        destructive: true,
        confirmText: i18nT('maintenance.ai.person_delete', 'Delete'),
    });
    if (!ok) return;
    try {
        const r = await api.delete(`/api/ai/people/${_selectedPerson}`);
        if (!r.success) throw new Error(r.error || 'delete failed');
        showToast(i18nT('common.deleted', 'Deleted'), 'success');
        _selectedPerson = null;
        _selectedPersonName = '';
        $('#ai-people-photos')?.classList.add('hidden');
        _loadPeople();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ---- Doctor (system-health card) -----------------------------------------

async function _refreshDoctor() {
    const el = $('#ai-doctor-list');
    const sumEl = $('#ai-doctor-summary');
    if (!el) return;
    el.innerHTML = `<div class="text-tg-textSecondary text-xs py-2">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;
    if (sumEl) sumEl.textContent = `· ${i18nT('common.loading', 'Loading…')}`;
    try {
        const r = await api.get('/api/ai/doctor');
        if (!r.success) throw new Error(r.error || 'doctor failed');
        const checks = Array.isArray(r.checks) ? r.checks : [];
        // Summary chip — colour reflects the worst-state check.
        const fails = checks.filter((c) => c.status === 'fail').length;
        const warns = checks.filter((c) => c.status === 'warn').length;
        if (sumEl) {
            let text;
            if (fails) {
                text = `· ${fails} ${i18nT('maintenance.ai.doctor_failing', 'failing')}`;
                sumEl.className = 'text-[10.5px] text-red-300';
            } else if (warns) {
                text = `· ${warns} ${i18nT('maintenance.ai.doctor_warning', 'warning')}`;
                sumEl.className = 'text-[10.5px] text-yellow-300';
            } else {
                text = `· ${i18nT('maintenance.ai.doctor_all_ok', 'all checks ok')}`;
                sumEl.className = 'text-[10.5px] text-green-300';
            }
            sumEl.textContent = text;
        }
        const iconFor = (s) => (s === 'ok' ? '✓' : s === 'warn' ? '⚠' : s === 'fail' ? '✗' : 'ℹ');
        el.innerHTML = checks
            .map(
                (c) => `
            <div class="ai-doctor-row" title="${escapeHtml(c.detail || '')}">
                <span class="ai-doctor-icon ai-doctor-${escapeHtml(c.status || 'info')}">${iconFor(c.status)}</span>
                <span class="ai-doctor-label">${escapeHtml(c.label || c.id || '')}</span>
                <span class="ai-doctor-detail">${escapeHtml(c.detail || '')}</span>
            </div>`,
            )
            .join('');
    } catch (e) {
        el.innerHTML = `<div class="text-red-300 text-xs py-2">${escapeHtml(e.message)}</div>`;
        if (sumEl) {
            sumEl.className = 'text-[10.5px] text-red-300';
            sumEl.textContent = `· ${i18nT('common.error', 'Error')}`;
        }
    }
}
