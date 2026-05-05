// Maintenance — AI search & smart organisation page.
//
// Drives the page sections on /maintenance/ai:
//   - Hero search bar + suggestion chips + result grid (delegates to
//     ai-search.js)
//   - Models panel — per-capability status + on-disk cache size + swap UI
//   - Capability strip with one toggle + Re-index button per capability
//   - People grid (face clusters)
//   - Auto-tag cloud
//   - Near-duplicate groups (perceptual dedup)
//
// All long-running scans are background jobs — we kick them off via POST,
// re-mount progress from the matching /scan/status endpoint, and listen on
// the four `ai_*` WebSocket prefixes for live updates.
//
// Idempotent init() — safe to re-call when the page is re-mounted.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { bindSearchUi, refreshChips } from './ai-search.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _initOnce = false;
let _modelsRefreshTimer = null;

const CAPS = [
    { key: 'embeddings', titleKey: 'maintenance.ai.cap.embeddings', titleFb: 'Semantic search (CLIP)',
      helpKey: 'maintenance.ai.cap.embeddings.help',
      helpFb: 'Encode every photo + text query into a 512-dim vector and rank matches by cosine similarity. Model: Xenova/clip-vit-base-patch32 (~90 MB).',
      scanUrl: '/api/ai/index/scan', wsPrefix: 'ai_index' },
    { key: 'faces',      titleKey: 'maintenance.ai.cap.faces',      titleFb: 'Face clustering (people)',
      helpKey: 'maintenance.ai.cap.faces.help',
      helpFb: 'Detect faces, embed each crop, and cluster with DBSCAN. Re-runnable from this page.',
      scanUrl: '/api/ai/people/scan', wsPrefix: 'ai_people' },
    { key: 'tags',       titleKey: 'maintenance.ai.cap.tags',       titleFb: 'Auto-tag (ImageNet)',
      helpKey: 'maintenance.ai.cap.tags.help',
      helpFb: 'Top-K labels per photo from a small image classifier. Powers the tag cloud below.',
      scanUrl: '/api/ai/tags/scan', wsPrefix: 'ai_tags' },
    { key: 'phash',      titleKey: 'maintenance.ai.cap.phash',      titleFb: 'Perceptual dedup',
      helpKey: 'maintenance.ai.cap.phash.help',
      helpFb: 'DCT-based 64-bit pHash — finds near-duplicates that exact-hash dedup misses (resized / re-encoded).',
      scanUrl: '/api/ai/perceptual-dedup/scan', wsPrefix: 'ai_phash' },
];

const MODEL_META = {
    embeddings: { icon: 'ri-search-eye-line', titleKey: 'maintenance.ai.model.embeddings.title', titleFb: 'Semantic search' },
    faces:      { icon: 'ri-user-smile-line', titleKey: 'maintenance.ai.model.faces.title',      titleFb: 'Face detection' },
    tags:       { icon: 'ri-price-tag-3-line', titleKey: 'maintenance.ai.model.tags.title',      titleFb: 'Auto-tag' },
};

function _formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function _formatRelative(ts) {
    if (!ts) return '';
    const diff = Date.now() - Number(ts);
    if (diff < 0) return '';
    const s = Math.floor(diff / 1000);
    if (s < 60) return i18nTf('maintenance.ai.model.relative.sec', { n: s }, `${s}s ago`);
    const m = Math.floor(s / 60);
    if (m < 60) return i18nTf('maintenance.ai.model.relative.min', { n: m }, `${m}m ago`);
    const h = Math.floor(m / 60);
    if (h < 24) return i18nTf('maintenance.ai.model.relative.hr', { n: h }, `${h}h ago`);
    const d = Math.floor(h / 24);
    return i18nTf('maintenance.ai.model.relative.day', { n: d }, `${d}d ago`);
}

// Capability state lives on the server; we mirror it locally so the
// toggle-click handler can flip a value optimistically without waiting
// for the next /status round trip.
let _capState = { master: false, perCap: {} };

function _renderSettings(status) {
    const grid = $('ai-settings-grid');
    if (!grid) return;
    const caps = status?.capabilities || {};
    const counts = status?.counts || {};
    _capState = {
        master: caps.master === true,
        perCap: {
            embeddings: caps.embeddings === true,
            faces: caps.faces === true,
            tags: caps.tags === true,
            phash: caps.phash === true,
        },
    };
    // Master toggle is now STATIC HTML (`#ai-master-card` in index.html) so
    // it stays visible even if this render path fails. We just sync the
    // `.active` class + the inline state pill from the live config.
    const masterOn = _capState.master;
    const masterToggle = document.getElementById('setting-adv-ai-enabled');
    if (masterToggle) {
        masterToggle.classList.toggle('active', masterOn);
        masterToggle.setAttribute('aria-checked', masterOn ? 'true' : 'false');
    }
    const masterPill = document.getElementById('ai-master-state-pill');
    if (masterPill) {
        masterPill.innerHTML = masterOn
            ? `<span class="text-tg-green">● <span data-i18n="maintenance.ai.master.state.on">On</span></span>`
            : `<span class="text-tg-textSecondary">○ <span data-i18n="maintenance.ai.master.state.off">Off</span></span>`;
    }

    grid.innerHTML = CAPS.map((c) => {
        const enabled = !!_capState.perCap[c.key];
        const label = i18nT(c.titleKey, c.titleFb);
        const help = i18nT(c.helpKey, c.helpFb);
        const scanDisabled = !(enabled && masterOn);
        return `
            <div class="ai-cap-card bg-tg-bg/30 rounded-lg p-2.5 flex items-start gap-2.5" data-cap="${c.key}">
                <div class="flex-1 min-w-0">
                    <div class="text-tg-text font-medium">${escapeHtml(label)}</div>
                    ${help ? `<div class="text-tg-textSecondary text-[11px] leading-snug">${escapeHtml(help)}</div>` : ''}
                    <div class="ai-cap-progress text-[11px] text-tg-textSecondary tabular-nums mt-1"></div>
                </div>
                <div class="flex flex-col items-end gap-1.5 shrink-0">
                    <div id="setting-adv-ai-${c.key}-enabled" class="tg-toggle${enabled ? ' active' : ''}" data-cap-toggle="${c.key}"></div>
                    <button class="ai-cap-scan-btn tg-btn-secondary text-[11px] px-2 py-1 ${scanDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
                            ${scanDisabled ? 'disabled' : ''} data-scan-cap="${c.key}">
                        ${escapeHtml(i18nT('maintenance.ai.scan.start', 'Start scan'))}
                    </button>
                </div>
            </div>
        `;
    }).join('');
    // Wire the scan buttons.
    grid.querySelectorAll('[data-scan-cap]').forEach((btn) => {
        btn.addEventListener('click', () => _kickScan(btn.dataset.scanCap));
    });
    // Wire the toggles. Each click flips the local UI optimistically,
    // PATCHes /api/config, then re-fetches status so the perm state
    // mirrors back. On failure we revert the visual flip.
    grid.querySelectorAll('[data-cap-toggle]').forEach((tog) => {
        tog.addEventListener('click', async (e) => {
            e.preventDefault();
            const which = tog.dataset.capToggle;
            const willEnable = !tog.classList.contains('active');
            tog.classList.toggle('active', willEnable);
            try {
                const patch = { advanced: { ai: {} } };
                if (which === 'master') {
                    patch.advanced.ai.enabled = willEnable;
                } else {
                    patch.advanced.ai[which] = { enabled: willEnable };
                }
                await api.post('/api/config', patch);
                if (which === 'master') _capState.master = willEnable;
                else _capState.perCap[which] = willEnable;
                _refreshAll().catch(() => {});
            } catch (err) {
                tog.classList.toggle('active', !willEnable);
                showToast(i18nTf('maintenance.ai.toggle.failed', { msg: err?.message || err }, `Failed: ${err?.message || err}`), 'error');
            }
        });
    });

    const indexedPct = counts.totalEligible
        ? Math.floor((counts.indexed / counts.totalEligible) * 100)
        : 0;
    const meta = $('ai-vec-status');
    if (meta) {
        const parts = [];
        if (counts.totalEligible != null) {
            parts.push(i18nTf('maintenance.ai.indexed_pct',
                { p: indexedPct, n: counts.indexed || 0, t: counts.totalEligible || 0 },
                `${indexedPct}% indexed (${counts.indexed || 0}/${counts.totalEligible || 0})`));
        }
        meta.textContent = parts.join(' · ');
    }
}

async function _kickScan(capKey) {
    const cap = CAPS.find((c) => c.key === capKey);
    if (!cap) return;
    try {
        await api.post(cap.scanUrl, {});
        showToast(i18nT('maintenance.ai.scan.started', 'Scan started'));
    } catch (e) {
        showToast(i18nTf('maintenance.ai.scan.failed', { msg: e.message }, `Failed: ${e.message}`));
    }
}

function _onProgressUpdate(capKey, payload) {
    const card = document.querySelector(`.ai-cap-card[data-cap="${capKey}"] .ai-cap-progress`);
    if (!card) return;
    if (payload?.processed != null && payload?.total != null) {
        card.textContent = i18nTf('maintenance.ai.scan.running',
            { processed: payload.processed, total: payload.total },
            `Scanning… ${payload.processed} / ${payload.total}`);
    } else if (payload?.stage) {
        card.textContent = String(payload.stage);
    }
}

function _onDone(capKey) {
    const card = document.querySelector(`.ai-cap-card[data-cap="${capKey}"] .ai-cap-progress`);
    if (card) card.textContent = i18nT('maintenance.ai.scan.done', 'Done');
    // Refresh the static lists once a scan finishes.
    _refreshAll().catch(() => {});
    refreshChips();
}

async function _hydrateFromStatus() {
    // Each capability has its own /scan/status; query each in parallel and
    // map progress back into the corresponding card.
    const targets = [
        ['embeddings', '/api/ai/index/scan/status'],
        ['faces',      '/api/ai/people/scan/status'],
        ['tags',       '/api/ai/tags/scan/status'],
        ['phash',      '/api/ai/perceptual-dedup/scan/status'],
    ];
    await Promise.all(targets.map(async ([key, url]) => {
        try {
            const s = await api.get(url);
            if (s?.running) _onProgressUpdate(key, { ...s.progress });
        } catch { /* status endpoints are best-effort during hydrate */ }
    }));
}

// ---- Models panel + swap UI ----------------------------------------------

function _renderModelStateChip(m) {
    if (m.error) {
        return `<span class="ai-model-state ai-model-state-err"><i class="ri-error-warning-line"></i> ${escapeHtml(i18nT('maintenance.ai.model.state.failed', 'Failed'))}</span>`;
    }
    if (m.loaded) {
        return `<span class="ai-model-state ai-model-state-ok"><i class="ri-check-line"></i> ${escapeHtml(i18nT('maintenance.ai.model.state.ready', 'Ready'))}</span>`;
    }
    if (m.loading) {
        let pct = '';
        const p = m.lastProgress;
        if (p && Number.isFinite(p.progress)) pct = ` ${Math.floor(p.progress)}%`;
        return `<span class="ai-model-state ai-model-state-load">
            <span class="ai-spinner" aria-hidden="true"></span>
            ${escapeHtml(i18nT('maintenance.ai.model.state.loading', 'Downloading'))}${pct}
        </span>`;
    }
    return `<span class="ai-model-state ai-model-state-idle"><i class="ri-checkbox-blank-circle-line"></i> ${escapeHtml(i18nT('maintenance.ai.model.state.idle', 'Not loaded'))}</span>`;
}

function _renderModelDetail(m) {
    const bits = [];
    if (m.error) {
        bits.push(`<span class="ai-model-error" title="${escapeHtml(m.error)}">${escapeHtml(m.error.slice(0, 90))}</span>`);
    }
    if (m.loaded && m.lastLoadedAt) {
        const rel = _formatRelative(m.lastLoadedAt);
        if (rel) bits.push(escapeHtml(i18nTf('maintenance.ai.model.loaded_ago', { ago: rel }, `loaded ${rel}`)));
    }
    if (m.cacheBytes > 0) {
        bits.push(escapeHtml(i18nTf('maintenance.ai.model.cache_size', { size: _formatBytes(m.cacheBytes) },
            `${_formatBytes(m.cacheBytes)} cached`)));
    } else if (!m.loaded && !m.loading) {
        bits.push(escapeHtml(i18nT('maintenance.ai.model.hint_first_load', 'Loads on first scan.')));
    }
    if (m.loading && m.lastProgress) {
        const p = m.lastProgress;
        if (p.file) bits.push(escapeHtml(p.file));
        if (Number.isFinite(p.loaded) && Number.isFinite(p.total)) {
            bits.push(`${_formatBytes(p.loaded)} / ${_formatBytes(p.total)}`);
        }
    }
    return bits.join(' · ');
}

function _renderSwapControls(cap, m) {
    return `
        <div class="ai-model-swap" data-cap="${cap}">
            <input type="text" class="ai-model-input" data-model-input value="${escapeHtml(m.modelId || '')}"
                   spellcheck="false" autocomplete="off"
                   data-i18n-aria-label="maintenance.ai.model.swap.input"
                   aria-label="Hugging Face model id"/>
            <button type="button" class="tg-btn-primary text-[11px] px-2 py-1" data-action="apply"
                    data-i18n="maintenance.ai.model.swap.apply">Apply</button>
            <button type="button" class="tg-btn-secondary text-[11px] px-2 py-1" data-action="wipe"
                    title="${escapeHtml(i18nT('maintenance.ai.model.swap.wipe_title', 'Delete the cached weights so the next load redownloads.'))}"
                    data-i18n="maintenance.ai.model.swap.wipe">Wipe weights</button>
        </div>
    `;
}

function _renderModelsPanel(payload) {
    const wrap = $('ai-models-list');
    if (!wrap) return;
    const models = payload?.models || {};
    const caps = ['embeddings', 'faces', 'tags'];
    wrap.innerHTML = caps.map((cap) => {
        const m = models[cap] || {};
        const meta = MODEL_META[cap];
        const title = i18nT(meta.titleKey, meta.titleFb);
        const detail = _renderModelDetail(m);
        const stateChip = _renderModelStateChip(m);
        const enabledBadge = m.enabled
            ? ''
            : `<span class="ai-model-disabled" title="${escapeHtml(i18nT('maintenance.ai.model.disabled_hint', 'Capability is disabled. Flip its toggle in the Capabilities section above.'))}">${escapeHtml(i18nT('maintenance.ai.model.disabled', 'Disabled'))}</span>`;
        return `
            <div class="ai-model-card" data-cap="${cap}">
                <div class="ai-model-head">
                    <i class="${meta.icon} ai-model-icon" aria-hidden="true"></i>
                    <div class="ai-model-titles">
                        <div class="ai-model-title">${escapeHtml(title)} ${enabledBadge}</div>
                        <div class="ai-model-id" title="${escapeHtml(m.modelId || '')}">${escapeHtml(m.modelId || '')}</div>
                    </div>
                    ${stateChip}
                </div>
                ${detail ? `<div class="ai-model-detail">${detail}</div>` : ''}
                ${_renderSwapControls(cap, m)}
            </div>
        `;
    }).join('');

    // Wire swap controls.
    wrap.querySelectorAll('.ai-model-swap').forEach((row) => {
        const cap = row.dataset.cap;
        const input = row.querySelector('[data-model-input]');
        row.querySelector('[data-action="apply"]')?.addEventListener('click', () => _applyModel(cap, input.value.trim()));
        row.querySelector('[data-action="wipe"]')?.addEventListener('click', () => _wipeModel(cap, models[cap]?.modelId));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); _applyModel(cap, input.value.trim()); }
        });
    });
}

async function _applyModel(cap, modelId) {
    if (!modelId) {
        showToast(i18nT('maintenance.ai.model.swap.bad_id', 'Enter a Hugging Face model id'));
        return;
    }
    try {
        await api.post('/api/config', { advanced: { ai: { [cap]: { model: modelId } } } });
        showToast(i18nTf('maintenance.ai.model.swap.applied', { cap, id: modelId }, `${cap}: ${modelId}`));
        _refreshModels();
    } catch (e) {
        showToast(i18nTf('maintenance.ai.model.swap.apply_failed', { msg: e.message }, `Save failed: ${e.message}`));
    }
}

async function _wipeModel(cap, modelId) {
    if (!modelId) return;
    const { confirmSheet } = await import('./sheet.js');
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.model.swap.wipe_title', 'Wipe cached weights?'),
        body: i18nTf('maintenance.ai.model.swap.wipe_confirm',
            { id: modelId },
            `Delete cached weights for ${modelId}? The next load will redownload.`),
        confirmText: i18nT('common.delete', 'Delete'),
        destructive: true,
    });
    if (!ok) return;
    try {
        await api.delete(`/api/ai/models/cache?model=${encodeURIComponent(modelId)}`);
        showToast(i18nTf('maintenance.ai.model.swap.wiped', { id: modelId }, `Wiped ${modelId}`));
        _refreshModels();
    } catch (e) {
        showToast(i18nTf('maintenance.ai.model.swap.wipe_failed', { msg: e.message }, `Wipe failed: ${e.message}`));
    }
}

async function _refreshModels() {
    try {
        const r = await api.get('/api/ai/models/status');
        if (r) _renderModelsPanel(r);
    } catch { /* best-effort */ }
}

function _scheduleModelsRefresh() {
    // WS-driven progress updates feed the panel directly; this scheduled
    // refresh exists so the cache-bytes + relative timestamps stay current
    // without forcing a full re-render on every tick. 5 s cadence keeps
    // the page lightweight even when the user lingers.
    if (_modelsRefreshTimer) return;
    _modelsRefreshTimer = setInterval(() => {
        if (!$('ai-models-list')?.isConnected) {
            clearInterval(_modelsRefreshTimer);
            _modelsRefreshTimer = null;
            return;
        }
        _refreshModels();
    }, 5000);
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    for (const cap of CAPS) {
        ws.on(`${cap.wsPrefix}_progress`, (msg) => {
            _onProgressUpdate(cap.key, msg.progress || msg);
        });
        ws.on(`${cap.wsPrefix}_done`, () => _onDone(cap.key));
    }
    // Live model download progress — re-renders the model panel cheaply.
    ws.on('ai_model_progress', () => {
        if ($('ai-models-list')) _refreshModels();
    });
}

async function _loadPeople() {
    let r;
    try { r = await api.get('/api/ai/people'); } catch { r = null; }
    const grid = $('ai-people-grid');
    const empty = $('ai-people-empty');
    const count = $('ai-people-count');
    if (!grid) return;
    const list = r?.people || [];
    if (!list.length) {
        grid.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = i18nTf('maintenance.ai.people.count', { n: list.length }, `${list.length} clusters`);
    grid.innerHTML = list.map((p) => {
        const cover = p.cover_download_id
            ? `<img src="/api/thumbs/${p.cover_download_id}" class="w-full h-full object-cover" alt="" onerror="this.style.display='none'"/>`
            : '<i class="ri-user-line text-3xl text-tg-textSecondary"></i>';
        const lbl = p.label && p.label.trim()
            ? escapeHtml(p.label)
            : escapeHtml(i18nT('maintenance.ai.people.unnamed', 'Unnamed person'));
        return `
            <div class="ai-person-tile bg-tg-bg/40 rounded-lg overflow-hidden border border-tg-border" data-person-id="${p.id}">
                <div class="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">${cover}</div>
                <div class="p-2">
                    <input class="ai-person-rename w-full bg-transparent text-tg-text text-xs border-none focus:outline-none focus:ring-1 focus:ring-tg-blue/40 rounded px-1 py-0.5"
                           data-person-id="${p.id}"
                           data-i18n-placeholder="maintenance.ai.people.rename_placeholder"
                           placeholder="${escapeHtml(i18nT('maintenance.ai.people.rename_placeholder', 'Add a name…'))}"
                           value="${escapeHtml(p.label || '')}"
                           data-original="${escapeHtml(p.label || '')}"/>
                    <div class="text-[11px] text-tg-textSecondary tabular-nums mt-0.5">${escapeHtml(lbl)} · ${p.face_count || 0}</div>
                </div>
            </div>
        `;
    }).join('');
    grid.querySelectorAll('.ai-person-rename').forEach((inp) => {
        inp.addEventListener('change', async () => {
            const id = Number(inp.dataset.personId);
            const newLabel = inp.value.trim();
            if (newLabel === inp.dataset.original) return;
            try {
                await api.put(`/api/ai/people/${id}`, { label: newLabel || null });
                inp.dataset.original = newLabel;
                showToast(i18nT('maintenance.ai.people.saved', 'Name saved'));
            } catch (e) {
                showToast(i18nTf('maintenance.ai.people.save_failed', { msg: e.message }, `Failed: ${e.message}`));
            }
        });
    });
}

async function _loadTags() {
    let r;
    try { r = await api.get('/api/ai/tags'); } catch { r = null; }
    const cloud = $('ai-tags-cloud');
    const empty = $('ai-tags-empty');
    const count = $('ai-tags-count');
    if (!cloud) return;
    const tags = r?.tags || [];
    if (!tags.length) {
        cloud.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = i18nTf('maintenance.ai.tags.count', { n: tags.length }, `${tags.length} tags`);
    const max = Math.max(...tags.map((t) => t.count));
    cloud.innerHTML = tags.map((t) => {
        const ratio = max ? Math.max(0.7, Math.min(2.0, t.count / max + 0.7)) : 1;
        const size = Math.floor(ratio * 12);
        return `
            <button type="button" class="ai-tag-chip bg-tg-bg/40 hover:bg-tg-blue/15 text-tg-text rounded-full px-2.5 py-0.5"
                    style="font-size: ${size}px"
                    data-tag="${escapeHtml(t.tag)}">
                ${escapeHtml(t.tag)} <span class="text-tg-textSecondary tabular-nums">${t.count}</span>
            </button>
        `;
    }).join('');
    // Clicking a tag chip routes back through the search hero so the
    // results land in the same grid as text queries.
    cloud.querySelectorAll('.ai-tag-chip').forEach((b) => {
        b.addEventListener('click', () => {
            const input = $('ai-search-input');
            if (input) {
                input.value = b.dataset.tag;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

async function _loadPhashGroups() {
    let r;
    try { r = await api.get('/api/ai/perceptual-dedup/groups?threshold=6'); } catch { r = null; }
    const wrap = $('ai-phash-groups');
    const empty = $('ai-phash-empty');
    const count = $('ai-phash-count');
    if (!wrap) return;
    const groups = r?.groups || [];
    if (!groups.length) {
        wrap.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count) count.textContent = i18nTf('maintenance.ai.phash.count', { n: groups.length }, `${groups.length} groups`);
    wrap.innerHTML = groups.slice(0, 30).map((g) => {
        const tiles = (g.rows || []).slice(0, 8).map((row) => `
            <div class="ai-phash-tile bg-tg-bg/40 rounded overflow-hidden border border-tg-border">
                <div class="aspect-square bg-black/40 flex items-center justify-center">
                    <img src="/api/thumbs/${row.id}" class="w-full h-full object-cover" alt="" onerror="this.style.display='none'"/>
                </div>
                <div class="text-[10px] text-tg-textSecondary truncate px-1 py-0.5">${escapeHtml(row.file_name || '')}</div>
            </div>
        `).join('');
        return `
            <div class="ai-phash-group bg-tg-bg/30 rounded-lg p-2">
                <div class="text-[11px] text-tg-textSecondary mb-1.5">${i18nTf('maintenance.ai.phash.group_size', { n: g.size }, `${g.size} similar`)}</div>
                <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1.5">${tiles}</div>
            </div>
        `;
    }).join('');
}

async function _refreshAll() {
    let s;
    try { s = await api.get('/api/ai/status'); } catch { s = null; }
    if (s) _renderSettings(s);
    await Promise.all([_loadPeople(), _loadTags(), _loadPhashGroups()]).catch(() => {});
}

// Master AI start/stop click. Mirrors the optimistic-flip + PATCH /api/config
// pattern the per-capability toggles use. Lives outside _renderSettings so
// the static `#ai-master-card` toggle keeps working even if the grid render
// path fails (cached old JS, transient /api/ai/status error, etc.).
async function _onMasterToggleClick(e) {
    e.preventDefault();
    const tog = e.currentTarget;
    if (!tog) return;
    const willEnable = !tog.classList.contains('active');
    tog.classList.toggle('active', willEnable);
    // Sync the inline state pill immediately so the UI doesn't flicker
    // back-and-forth across the network round trip.
    const pill = document.getElementById('ai-master-state-pill');
    if (pill) {
        pill.innerHTML = willEnable
            ? `<span class="text-tg-green">● <span data-i18n="maintenance.ai.master.state.on">On</span></span>`
            : `<span class="text-tg-textSecondary">○ <span data-i18n="maintenance.ai.master.state.off">Off</span></span>`;
    }
    try {
        await api.post('/api/config', { advanced: { ai: { enabled: willEnable } } });
        _capState.master = willEnable;
        _refreshAll().catch(() => {});
        showToast(willEnable
            ? i18nT('maintenance.ai.master.toast_on',  'AI subsystem enabled.')
            : i18nT('maintenance.ai.master.toast_off', 'AI subsystem stopped.'),
            'success');
    } catch (err) {
        // Revert on failure.
        tog.classList.toggle('active', !willEnable);
        if (pill) {
            pill.innerHTML = !willEnable
                ? `<span class="text-tg-green">● <span data-i18n="maintenance.ai.master.state.on">On</span></span>`
                : `<span class="text-tg-textSecondary">○ <span data-i18n="maintenance.ai.master.state.off">Off</span></span>`;
        }
        showToast(i18nTf('maintenance.ai.toggle.failed',
            { msg: err?.message || err },
            `Failed: ${err?.message || err}`), 'error');
    }
}

// Ping huggingface.co/api/whoami-v2 with the typed (or saved) token. Surfaces
// success/error inline beneath the input so the operator gets immediate
// feedback before kicking off a heavy model preload.
async function _testHfToken() {
    const btn = $('ai-hf-token-test');
    const out = $('ai-hf-token-result');
    const inp = $('setting-adv-ai-hf-token');
    if (!btn || !out) return;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="ri-loader-4-line animate-spin"></i><span>${escapeHtml(i18nT('common.loading', 'Loading…'))}</span>`;
    out.innerHTML = '';
    try {
        // Pass the typed token directly so the operator can verify a
        // freshly-pasted value without waiting for the autosave round-
        // trip. Server falls back to the stored value when this is empty.
        const typed = (inp?.value || '').trim();
        const r = await api.post('/api/ai/hf/test', typed ? { token: typed } : {});
        if (r?.ok) {
            const name = String(r.name || '').replace(/[<>]/g, '');
            out.innerHTML = `
                <i class="ri-check-line text-tg-green"></i>
                <span class="text-tg-green">${escapeHtml(i18nTf('maintenance.ai.hf_token.test_ok',
                    { name }, `Token works — signed in as ${name}.`))}</span>`;
        } else {
            const msg = r?.message || i18nT('maintenance.ai.hf_token.test_fail_generic', 'Token did not work.');
            out.innerHTML = `
                <i class="ri-error-warning-line text-red-400"></i>
                <span class="text-red-400">${escapeHtml(msg)}</span>`;
        }
    } catch (e) {
        const msg = e?.data?.message || e?.message || 'Test failed';
        out.innerHTML = `
            <i class="ri-error-warning-line text-red-400"></i>
            <span class="text-red-400">${escapeHtml(msg)}</span>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
}

export async function init() {
    _wireWs();
    if (!_initOnce) {
        // First mount — wire the search hero + chips.
        bindSearchUi({
            inputEl: $('ai-search-input'),
            buttonEl: $('ai-search-btn'),
            resultsEl: $('ai-search-results'),
            emptyEl: $('ai-search-empty'),
            metaEl: $('ai-search-meta'),
            ctaEl: $('ai-search-cta'),
        });
        // Refresh model status panel on demand.
        $('ai-models-refresh')?.addEventListener('click', _refreshModels);
        // HF token — show/hide + Test button.
        $('ai-hf-token-reveal')?.addEventListener('click', () => {
            const inp = $('setting-adv-ai-hf-token');
            if (!inp) return;
            inp.type = inp.type === 'password' ? 'text' : 'password';
        });
        $('ai-hf-token-test')?.addEventListener('click', _testHfToken);
        // Master AI toggle — lives in static HTML (`#ai-master-card`) so
        // it's always visible. Same flip-and-PATCH handler the per-cap
        // toggles use; bound once at init.
        $('setting-adv-ai-enabled')?.addEventListener('click', _onMasterToggleClick);
        _initOnce = true;
    }
    await _refreshAll();
    await _refreshModels();
    await _hydrateFromStatus();
    _scheduleModelsRefresh();
}
