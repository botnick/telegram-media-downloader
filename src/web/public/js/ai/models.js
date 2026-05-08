// Models panel — model status per capability + embedding presets +
// swap (apply/wipe) controls.

import { aiGet, aiPost, aiDelete, withButton, toastError } from './api.js';
import { showToast, escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';
import { update, get, on } from './state.js';

const PRESETS_ID = 'ai-embedding-presets';
const LIST_ID = 'ai-models-list';

const META = {
    embeddings: {
        icon: 'ri-search-eye-line',
        titleKey: 'maintenance.ai.model.embeddings.title',
        titleFb: 'Semantic search',
    },
    faces: {
        icon: 'ri-user-smile-line',
        titleKey: 'maintenance.ai.model.faces.title',
        titleFb: 'Face detection',
    },
    tags: {
        icon: 'ri-price-tag-3-line',
        titleKey: 'maintenance.ai.model.tags.title',
        titleFb: 'Auto-tag',
    },
};

function _bytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function _relative(ts) {
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

function _stateChip(m) {
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

function _detail(m) {
    const bits = [];
    if (m.error)
        bits.push(
            `<span class="ai-model-error" title="${escapeHtml(m.error)}">${escapeHtml(m.error.slice(0, 90))}</span>`,
        );
    if (m.loaded && m.lastLoadedAt) {
        const rel = _relative(m.lastLoadedAt);
        if (rel)
            bits.push(
                escapeHtml(
                    i18nTf('maintenance.ai.model.loaded_ago', { ago: rel }, `loaded ${rel}`),
                ),
            );
    }
    if (m.cacheBytes > 0) {
        bits.push(
            escapeHtml(
                i18nTf(
                    'maintenance.ai.model.cache_size',
                    { size: _bytes(m.cacheBytes) },
                    `${_bytes(m.cacheBytes)} cached`,
                ),
            ),
        );
    } else if (!m.loaded && !m.loading) {
        bits.push(
            escapeHtml(i18nT('maintenance.ai.model.hint_first_load', 'Loads on first scan.')),
        );
    }
    if (m.loading && m.lastProgress) {
        const p = m.lastProgress;
        if (p.file) bits.push(escapeHtml(p.file));
        if (Number.isFinite(p.loaded) && Number.isFinite(p.total)) {
            bits.push(`${_bytes(p.loaded)} / ${_bytes(p.total)}`);
        }
    }
    return bits.join(' · ');
}

function _renderPresets(state) {
    const wrap = document.getElementById(PRESETS_ID);
    if (!wrap) return;
    const presets = state.embeddingPresets || [];
    const current = state.currentEmbeddingModel || '';
    if (!presets.length) {
        wrap.innerHTML = '';
        return;
    }
    wrap.innerHTML = presets
        .map((p) => {
            const active = p.modelId === current;
            const langs = Array.isArray(p.languages) ? p.languages.join(', ') : '';
            const klass = active
                ? 'ai-preset-chip ai-preset-active tg-btn-primary'
                : 'ai-preset-chip tg-btn-secondary';
            const labelKey = `maintenance.ai.preset.${p.key.replace('-', '_')}.label`;
            const label = i18nT(labelKey, p.key);
            const sizeLbl = i18nTf(
                'maintenance.ai.preset.size_dim',
                { size: p.sizeMB, dim: p.dim },
                `${p.sizeMB} MB · ${p.dim}-d`,
            );
            return `
                <button type="button" class="${klass} text-[11px] px-2.5 py-1 rounded-full mr-1.5 mb-1"
                        data-preset-model="${escapeHtml(p.modelId)}"
                        ${active ? 'aria-pressed="true"' : ''}
                        title="${escapeHtml(`${langs} · ${sizeLbl}`)}">
                    <i class="ri-${active ? 'check-line' : 'arrow-left-right-line'}" aria-hidden="true"></i>
                    <span class="ml-1">${escapeHtml(label)}</span>
                    <span class="opacity-70 ml-1">· ${escapeHtml(sizeLbl)}</span>
                </button>
            `;
        })
        .join('');
    wrap.querySelectorAll('[data-preset-model]').forEach((btn) => {
        btn.addEventListener('click', () => _onPresetClick(btn));
    });
}

function _renderList(state) {
    const wrap = document.getElementById(LIST_ID);
    if (!wrap) return;
    const ms = state.modelStatus?.models || {};
    const caps = ['embeddings', 'faces', 'tags'];
    wrap.innerHTML = caps
        .map((cap) => {
            const m = ms[cap] || {};
            const meta = META[cap];
            const title = i18nT(meta.titleKey, meta.titleFb);
            const enabledBadge = m.enabled
                ? ''
                : `<span class="ai-model-disabled" title="${escapeHtml(i18nT('maintenance.ai.model.disabled_hint', 'Capability is disabled.'))}">${escapeHtml(i18nT('maintenance.ai.model.disabled', 'Disabled'))}</span>`;
            return `
                <div class="ai-model-card" data-cap="${cap}">
                    <div class="ai-model-head">
                        <i class="${meta.icon} ai-model-icon" aria-hidden="true"></i>
                        <div class="ai-model-titles">
                            <div class="ai-model-title">${escapeHtml(title)} ${enabledBadge}</div>
                            <div class="ai-model-id" title="${escapeHtml(m.modelId || '')}">${escapeHtml(m.modelId || '')}</div>
                        </div>
                        ${_stateChip(m)}
                    </div>
                    ${_detail(m) ? `<div class="ai-model-detail">${_detail(m)}</div>` : ''}
                    <div class="ai-model-swap" data-cap="${cap}">
                        <input type="text" class="ai-model-input" data-model-input value="${escapeHtml(m.modelId || '')}"
                               spellcheck="false" autocomplete="off"
                               aria-label="Hugging Face model id"/>
                        <button type="button" class="tg-btn-primary text-[11px] px-2 py-1" data-action="apply"
                                data-i18n="maintenance.ai.model.swap.apply">Apply</button>
                        <button type="button" class="tg-btn-secondary text-[11px] px-2 py-1" data-action="wipe"
                                title="${escapeHtml(i18nT('maintenance.ai.model.swap.wipe_title', 'Delete the cached weights so the next load redownloads.'))}"
                                data-i18n="maintenance.ai.model.swap.wipe">Wipe weights</button>
                    </div>
                </div>
            `;
        })
        .join('');
    wrap.querySelectorAll('.ai-model-swap').forEach((row) => {
        const cap = row.dataset.cap;
        const input = row.querySelector('[data-model-input]');
        row.querySelector('[data-action="apply"]')?.addEventListener('click', (e) =>
            _onApply(cap, input.value.trim(), e.currentTarget),
        );
        row.querySelector('[data-action="wipe"]')?.addEventListener('click', (e) =>
            _onWipe(cap, ms[cap]?.modelId, e.currentTarget),
        );
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                _onApply(cap, input.value.trim(), row.querySelector('[data-action="apply"]'));
            }
        });
    });
}

async function _onApply(cap, modelId, btn) {
    if (!modelId) {
        showToast(
            i18nT('maintenance.ai.model.swap.bad_id', 'Enter a Hugging Face model id'),
            'warning',
        );
        return;
    }
    await withButton(btn, async () => {
        try {
            await aiPost('/api/config', { advanced: { ai: { [cap]: { model: modelId } } } });
            showToast(
                i18nTf(
                    'maintenance.ai.model.swap.applied',
                    { cap, id: modelId },
                    `${cap}: ${modelId}`,
                ),
                'success',
            );
            await refresh();
        } catch (err) {
            toastError(err);
        }
    });
}

async function _onWipe(cap, modelId, btn) {
    if (!modelId) return;
    const { confirmSheet } = await import('../sheet.js');
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.model.swap.wipe_title', 'Wipe cached weights?'),
        body: i18nTf(
            'maintenance.ai.model.swap.wipe_confirm',
            { id: modelId },
            `Delete cached weights for ${modelId}? The next load will redownload.`,
        ),
        confirmText: i18nT('common.delete', 'Delete'),
        destructive: true,
    });
    if (!ok) return;
    await withButton(btn, async () => {
        try {
            await aiDelete(`/api/ai/models/cache?model=${encodeURIComponent(modelId)}`);
            showToast(
                i18nTf('maintenance.ai.model.swap.wiped', { id: modelId }, `Wiped ${modelId}`),
                'success',
            );
            await refresh();
        } catch (err) {
            toastError(err);
        }
    });
}

async function _onPresetClick(btn) {
    const target = String(btn.dataset.presetModel || '').trim();
    if (!target) return;
    const state = get();
    if (state.currentEmbeddingModel === target) return;
    const preset = (state.embeddingPresets || []).find((p) => p.modelId === target);
    if (!preset) return;
    const indexed = Number(state.counts?.indexed || 0);
    const langs = Array.isArray(preset.languages) ? preset.languages.join(', ') : '';
    const { confirmSheet } = await import('../sheet.js');
    const ok = await confirmSheet({
        title: i18nT('maintenance.ai.reembed.confirm_title', 'Switch embedding model?'),
        body: i18nTf(
            'maintenance.ai.reembed.confirm_body',
            { size: preset.sizeMB, langs, n: indexed },
            `Will download ~${preset.sizeMB} MB (${langs}) and re-embed ${indexed} photos.`,
        ),
        confirmText: i18nT('maintenance.ai.reembed.confirm_btn', 'Switch and re-index'),
    });
    if (!ok) return;
    await withButton(btn, async () => {
        try {
            await aiPost('/api/config', { advanced: { ai: { embeddings: { model: target } } } });
        } catch (err) {
            toastError(err, 'Apply failed');
            return;
        }
        try {
            await aiPost('/api/ai/index/reembed', {});
            showToast(i18nT('maintenance.ai.reembed.started_toast', 'Re-index started'), 'success');
        } catch (err) {
            const code = err?.code || err?.envelope?.code || '';
            if (code === 'ALREADY_RUNNING') {
                showToast(
                    i18nT(
                        'maintenance.ai.reembed.already_running',
                        'A scan is already running. Cancel it first.',
                    ),
                    'error',
                );
            } else {
                toastError(err, 'Re-index failed');
            }
        }
        await refresh();
    });
}

export async function refresh() {
    try {
        const r = await aiGet('/api/ai/models/status');
        update({ modelStatus: r });
    } catch {
        /* models endpoint may fail if AI module errored — don't break the page */
    }
}

let _off = null;
let _refreshTimer = null;
export function init() {
    if (!_off) {
        _off = on((state) => {
            _renderPresets(state);
            _renderList(state);
        });
        _renderPresets(get());
        _renderList(get());
        document.getElementById('ai-models-refresh')?.addEventListener('click', refresh);
    }
    refresh();
    if (!_refreshTimer) {
        // Cheap re-poll so cache-bytes + relative timestamps stay current.
        _refreshTimer = setInterval(() => {
            if (!document.getElementById(LIST_ID)?.isConnected) {
                clearInterval(_refreshTimer);
                _refreshTimer = null;
                return;
            }
            refresh();
        }, 8000);
    }
}

export function dispose() {
    if (_off) {
        _off();
        _off = null;
    }
    if (_refreshTimer) {
        clearInterval(_refreshTimer);
        _refreshTimer = null;
    }
}
