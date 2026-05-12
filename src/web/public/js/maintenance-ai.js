/* Maintenance → AI page module.
 *
 * Faces-only build. The Python face-clustering sidecar (insightface
 * buffalo_l, 512-dim embeddings) is the only AI surface here today;
 * Search + Auto-tag were removed in v2.14. The page is structured as
 * a capability grid so future drops (OCR, object detection, face
 * quality scoring) can land by pushing a single entry into the
 * CAPABILITIES array — no layout surgery, no new endpoints.
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
let _tagListCache = [];
let _tagSelected = '';
let _tagFilterQuery = '';
let _tagSortMode = 'count_desc';
let _tagPhotosOffset = 0;
let _tagPhotosTotal = 0;
const _tagPhotosLimit = 50;
const LS_FACES_COLLAPSED = 'tgdl.ai.faces.collapsed';
const LS_TAGS_COLLAPSED = 'tgdl.ai.tags.collapsed';

/* ----------------------------------------------------------------------
 * Capability registry.
 *
 * Drives the capability grid. Adding a new capability later (OCR /
 * object detection / face quality) is a single push here + matching
 * i18n keys + (optionally) a renderer override. The defaults work
 * as English fallbacks so a fresh install reads cleanly even before
 * locale files load.
 *
 * Shape:
 *   id            — internal key, matches `models.<id>` in /api/ai/status
 *   i18n          — { title, desc, scanLabel } translation keys
 *   defaults      — fallback strings used when the i18n key is absent
 *   statusKey     — dotted path into /api/ai/status (e.g. 'models.faces')
 *   scanFeature   — POST /api/ai/scan/start `body.feature` value
 *   autoToggleKey — config.advanced.ai.<key> for the per-cap toggle
 *   controls      — array of slider/number controls bound to config keys
 * ------------------------------------------------------------------- */
const CAPABILITIES = [
    {
        id: 'faces',
        icon: 'ri-user-smile-line',
        i18n: {
            title: 'maintenance.ai.faces.title',
            desc: 'maintenance.ai.faces.desc',
            scanLabel: 'maintenance.ai.faces.scan',
            cancelLabel: 'common.cancel',
        },
        defaults: {
            title: 'Face clustering',
            desc: 'Detects faces with insightface buffalo_l, groups recurring people into clusters via DBSCAN.',
            scanLabel: 'Scan now',
            cancelLabel: 'Cancel',
        },
        statusKey: 'models.faces',
        scanFeature: 'faces',
        autoToggleKey: 'faceClustering',
        controls: [
            {
                type: 'select',
                cfgKey: 'facesDetectorModel',
                labelKey: 'maintenance.ai.faces.model',
                labelDefault: 'Detector model',
                default: 'buffalo_l',
                options: [
                    {
                        value: 'buffalo_l',
                        labelKey: 'maintenance.ai.faces.model_buffalo_l',
                        labelDefault: 'buffalo_l — balanced (99.5% LFW, default)',
                    },
                    {
                        value: 'antelopev2',
                        labelKey: 'maintenance.ai.faces.model_antelopev2',
                        labelDefault: 'antelopev2 — best accuracy (99.6%, Glint360K)',
                    },
                    {
                        value: 'buffalo_m',
                        labelKey: 'maintenance.ai.faces.model_buffalo_m',
                        labelDefault: 'buffalo_m — faster (99.3%)',
                    },
                    {
                        value: 'buffalo_s',
                        labelKey: 'maintenance.ai.faces.model_buffalo_s',
                        labelDefault: 'buffalo_s — fastest (99.0%)',
                    },
                ],
                helpKey: 'maintenance.ai.faces.model_help',
                helpDefault:
                    'Switching the model requires a Re-cluster — embedding spaces differ across presets.',
            },
            {
                type: 'slider',
                cfgKey: 'facesEpsilon',
                labelKey: 'maintenance.ai.faces.threshold',
                labelDefault: 'Cluster threshold (DBSCAN ε)',
                // Calibrated against real 926-photo / 689-face data:
                //   0.8-1.0 = strict (78 clusters, high precision)
                //   1.05    = PEAK (80 clusters, balanced) ← default
                //   1.10    = starting to merge (top cluster jumps)
                //   1.15+   = mega-merge — DON'T
                min: 0.3,
                max: 1.5,
                step: 0.01,
                default: 1.05,
            },
            {
                type: 'number',
                cfgKey: 'facesMinPoints',
                labelKey: 'maintenance.ai.faces.min_points',
                labelDefault: 'Min cluster size',
                min: 2,
                max: 20,
                step: 1,
                default: 2,
            },
        ],
    },
    // Placeholder card — communicates the extensible nature of the grid
    // to operators without leaving an empty section. Rendered separately
    // (no controls / no toggle / dashed border).
    {
        id: '__comingSoon__',
        comingSoon: true,
        icon: 'ri-flask-line',
        i18n: {
            title: 'maintenance.ai.coming_soon.title',
            desc: 'maintenance.ai.coming_soon.list',
        },
        defaults: {
            title: 'Coming soon',
            desc: 'Object detection · OCR · Face quality ranking · Smart albums',
        },
    },
    {
        id: 'tags',
        icon: 'ri-price-tag-3-line',
        i18n: {
            title: 'maintenance.ai.tags.title',
            desc: 'maintenance.ai.tags.desc',
            scanLabel: 'maintenance.ai.tags.scan',
            cancelLabel: 'common.cancel',
        },
        defaults: {
            title: 'Image tagging',
            desc: 'Zero-shot CLIP tagging — detects objects, scenes, concepts in every photo. Runs via the Python sidecar.',
            scanLabel: 'Tag all',
            cancelLabel: 'Cancel',
        },
        statusKey: 'models.tags',
        scanFeature: 'tags',
        autoToggleKey: 'imageTagging',
        customHtml: true, // renders extra tag-labels editor + tag browser
        controls: [
            {
                type: 'custom',
                cfgKey: 'tagLabels',
                labelKey: 'maintenance.ai.tags.labels',
                labelDefault: 'Custom tags (comma-separated, leave empty for defaults)',
                placeholder: 'e.g. cat, dog, sunset, document, screenshot',
            },
        ],
    },
];

// ---- Tag browser ----------------------------------------------------------

/**
 * Fetch all detected tags from the server and render chip buttons.
 * Shows the tag browser section when tags exist, hides it otherwise.
 */
async function _renderTagBrowser(forceReload = true) {
    const section = $('#ai-tag-browser');
    const chips = $('#ai-tag-chips');
    const empty = $('#ai-tag-empty');
    const photos = $('#ai-tag-photos');
    if (!section || !chips) return;

    try {
        if (forceReload || !_tagListCache.length) {
            const r = await api.get('/api/ai/tags/list');
            _tagListCache = Array.isArray(r?.tags) ? r.tags : [];
        }
        section.classList.remove('hidden');
        if (!_tagListCache.length) {
            chips.innerHTML = '';
            if (photos) {
                photos.innerHTML =
                    '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6">No tags yet — run a tag scan to populate.</p>';
            }
            if (empty) empty.classList.remove('hidden');
            _setTagLoadMoreVisible(false);
            return;
        }
        if (empty) empty.classList.add('hidden');
        const tags = _getVisibleTags();
        chips.innerHTML = tags
            .map(
                (t) =>
                    `<button type="button" class="tg-btn-input text-[11px] px-2.5 py-1 inline-flex items-center gap-1 tag-chip" data-tag="${escapeHtml(t.tag)}" aria-pressed="false">
                        ${escapeHtml(t.tag)}
                        <span class="text-[10px] text-tg-textSecondary tabular-nums">${t.count}</span>
                    </button>`,
            )
            .join('');

        // Wire chip clicks — load photos for the selected tag
        chips.querySelectorAll('.tag-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                chips.querySelectorAll('.tag-chip').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                const tag = btn.dataset.tag;
                btn.setAttribute('aria-pressed', 'true');
                if (tag) {
                    _tagSelected = tag;
                    _loadTagPhotos(tag);
                }
            });
            btn.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    _moveTagChipFocus(btn, 1);
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    _moveTagChipFocus(btn, -1);
                } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    btn.click();
                }
            });
        });
        chips.querySelectorAll('.tag-chip').forEach((b) => {
            if (b.dataset.tag !== _tagSelected) b.setAttribute('aria-pressed', 'false');
        });

        // Keep selected tag if it still exists after refresh/filtering.
        const selectedBtn = _tagSelected
            ? Array.from(chips.querySelectorAll('.tag-chip')).find(
                  (el) => el.dataset.tag === _tagSelected,
              )
            : null;
        const pick = selectedBtn || chips.querySelector('.tag-chip');
        if (pick) {
            pick.classList.add('active');
            pick.setAttribute('aria-pressed', 'true');
            const tag = pick.dataset.tag || '';
            if (tag) {
                if (_tagSelected !== tag) _tagSelected = tag;
                _loadTagPhotos(tag);
            }
            return;
        }
        // No tags match current filter.
        if (photos) {
            photos.innerHTML =
                '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6">No tags match the current filter.</p>';
        }
        _setTagLoadMoreVisible(false);
    } catch (e) {
        console.warn('tag browser:', e);
        section.classList.add('hidden');
    }
}

/**
 * Load photos for a specific tag and render them as a grid.
 */
async function _loadTagPhotos(tag) {
    const photos = $('#ai-tag-photos');
    if (!photos) return;
    _tagSelected = String(tag || '');
    _tagPhotosOffset = 0;
    _tagPhotosTotal = 0;
    _setTagLoadMoreVisible(false);
    photos.innerHTML =
        '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6"><i class="ri-loader-4-line animate-spin mr-1"></i>Loading…</p>';
    try {
        const r = await api.get(
            `/api/ai/tags/photos?tag=${encodeURIComponent(tag)}&limit=${_tagPhotosLimit}&offset=0`,
        );
        const files = Array.isArray(r?.files) ? r.files : [];
        _tagPhotosTotal = Number(r?.total) || files.length;
        _tagPhotosOffset = files.length;
        if (!files.length) {
            photos.innerHTML =
                '<p class="text-[11px] text-tg-textSecondary col-span-full text-center py-6">No photos with this tag.</p>';
            return;
        }
        photos.innerHTML = files
            .map((f) => {
                const thumb = `/api/thumbs/${encodeURIComponent(f.id)}?w=320`;
                const score = f.tag_score ? Math.round(f.tag_score * 100) + '%' : '';
                return `<div class="relative aspect-square rounded-md overflow-hidden bg-tg-bg/40 group cursor-pointer" onclick="navigateTo('viewer/${encodeURIComponent(f.group_name || '')}')">
                    <img loading="lazy" class="absolute inset-0 w-full h-full object-cover" src="${escapeHtml(thumb)}" onerror="this.style.display='none'">
                    <span class="absolute bottom-1 right-1 text-[10px] px-1 py-0.5 rounded bg-black/60 text-white tabular-nums">${escapeHtml(score)}</span>
                </div>`;
            })
            .join('');
        _setTagLoadMoreVisible(_tagPhotosOffset < _tagPhotosTotal);
    } catch (e) {
        _setTagLoadMoreVisible(false);
        photos.innerHTML = `<p class="text-[11px] text-red-400 col-span-full text-center py-6">Failed: ${escapeHtml(e?.message || 'unknown')}</p>`;
    }
}

async function _loadMoreTagPhotos() {
    const photos = $('#ai-tag-photos');
    const tag = _tagSelected;
    if (!photos || !tag) return;
    if (_tagPhotosOffset >= _tagPhotosTotal) {
        _setTagLoadMoreVisible(false);
        return;
    }
    const loadMoreBtn = $('#ai-tag-load-more');
    if (loadMoreBtn) loadMoreBtn.disabled = true;
    try {
        const r = await api.get(
            `/api/ai/tags/photos?tag=${encodeURIComponent(tag)}&limit=${_tagPhotosLimit}&offset=${_tagPhotosOffset}`,
        );
        const files = Array.isArray(r?.files) ? r.files : [];
        _tagPhotosTotal = Number(r?.total) || _tagPhotosTotal;
        if (!files.length) {
            _setTagLoadMoreVisible(false);
            return;
        }
        const html = files
            .map((f) => {
                const thumb = `/api/thumbs/${encodeURIComponent(f.id)}?w=320`;
                const score = f.tag_score ? Math.round(f.tag_score * 100) + '%' : '';
                return `<div class="relative aspect-square rounded-md overflow-hidden bg-tg-bg/40 group cursor-pointer" onclick="navigateTo('viewer/${encodeURIComponent(f.group_name || '')}')">
                    <img loading="lazy" class="absolute inset-0 w-full h-full object-cover" src="${escapeHtml(thumb)}" onerror="this.style.display='none'">
                    <span class="absolute bottom-1 right-1 text-[10px] px-1 py-0.5 rounded bg-black/60 text-white tabular-nums">${escapeHtml(score)}</span>
                </div>`;
            })
            .join('');
        photos.insertAdjacentHTML('beforeend', html);
        _tagPhotosOffset += files.length;
        _setTagLoadMoreVisible(_tagPhotosOffset < _tagPhotosTotal);
    } catch (e) {
        showToast(`Failed to load more: ${e?.message || 'unknown'}`, 'error');
    } finally {
        if (loadMoreBtn) loadMoreBtn.disabled = false;
    }
}

function _setTagLoadMoreVisible(show) {
    const btn = $('#ai-tag-load-more');
    if (!btn) return;
    btn.classList.toggle('hidden', !show);
}

function _moveTagChipFocus(currentBtn, dir) {
    const chips = $('#ai-tag-chips');
    if (!chips || !currentBtn) return;
    const list = Array.from(chips.querySelectorAll('.tag-chip'));
    if (!list.length) return;
    const idx = list.indexOf(currentBtn);
    if (idx < 0) return;
    let next = idx + dir;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    list[next]?.focus();
}

// ---- Tag suggestions ---------------------------------------------------

/**
 * Fetch tag co-occurrence suggestions and render them.
 */
async function _renderTagSuggestions(forceReload = true) {
    const section = $('#ai-tag-suggestions');
    const list = $('#ai-tag-suggestions-list');
    const empty = $('#ai-tag-suggestions-empty');
    if (!section || !list) return;

    try {
        const r = await api.get('/api/ai/tags/suggestions?minRate=0.6&minImages=2');
        const suggestions = Array.isArray(r?.suggestions) ? r.suggestions : [];

        if (!suggestions.length) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        if (empty) empty.classList.add('hidden');

        list.innerHTML = suggestions
            .map(
                (s) =>
                    `<div class="bg-tg-panelOverlay rounded p-3 text-xs space-y-1.5">
                        <div class="flex items-start justify-between gap-2">
                            <div>
                                <span class="font-mono text-tg-text">${escapeHtml(s.tag1)}</span>
                                <span class="text-tg-textSecondary">←→</span>
                                <span class="font-mono text-tg-text">${escapeHtml(s.tag2)}</span>
                            </div>
                            <span class="text-tg-textSecondary tabular-nums">${Math.round(s.cooccurrence_rate * 100)}%</span>
                        </div>
                        <p class="text-[10px] text-tg-textSecondary">
                            Appear together in ${s.images_together} images
                            (${s.tag1}: ${s.images_tag1}, ${s.tag2}: ${s.images_tag2})
                        </p>
                        <button type="button" class="tg-btn-secondary text-[10px] px-2 py-1 merge-suggestion-btn" data-tag1="${escapeHtml(s.tag1)}" data-tag2="${escapeHtml(s.tag2)}">
                            Merge → keep first
                        </button>
                    </div>`,
            )
            .join('');

        // Wire merge buttons
        list.querySelectorAll('.merge-suggestion-btn').forEach((btn) => {
            btn.addEventListener('click', () => _applyTagMerge(btn.dataset.tag1, btn.dataset.tag2));
        });
    } catch (e) {
        console.warn('tag suggestions:', e);
        section.classList.add('hidden');
    }
}

/**
 * Apply a tag merge by updating the tagLabels config to remove tag2 and keep tag1.
 */
async function _applyTagMerge(tag1, tag2) {
    try {
        // Fetch current config to get existing tagLabels
        const cfgRes = await api.get('/api/config');
        const labels = Array.isArray(cfgRes?.advanced?.ai?.tagLabels)
            ? cfgRes.advanced.ai.tagLabels
            : [];

        // Remove tag2, keep tag1
        const updated = labels.filter((t) => String(t).trim() !== String(tag2).trim());

        // Make sure tag1 is still there
        if (!updated.find((t) => String(t).trim() === String(tag1).trim())) {
            updated.push(tag1);
        }

        // Save config
        const saveRes = await api.post('/api/config', {
            advanced: { ai: { tagLabels: updated } },
        });
        if (!saveRes.success) throw new Error(saveRes.error || 'save failed');

        showToast(`Merged "${tag2}" into "${tag1}". Refresh suggestions to see the change.`);
        _renderTagSuggestions(true);
    } catch (e) {
        console.error('merge failed:', e);
        showToast(`Error merging tags: ${e.message}`, 'error');
    }
}

function _getVisibleTags() {
    const q = _tagFilterQuery.trim().toLowerCase();
    let tags = _tagListCache.slice();
    if (q)
        tags = tags.filter((t) =>
            String(t?.tag || '')
                .toLowerCase()
                .includes(q),
        );
    if (_tagSortMode === 'avg_score_desc') {
        tags.sort((a, b) => (Number(b.avg_score) || 0) - (Number(a.avg_score) || 0));
    } else if (_tagSortMode === 'tag_asc') {
        tags.sort((a, b) => String(a.tag || '').localeCompare(String(b.tag || '')));
    } else {
        tags.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
    }
    return tags;
}

function _initDetailsCollapsedState({ detailsId, storageKey, defaultOpen = false }) {
    const details = document.getElementById(detailsId);
    if (!details) return;
    const stored = localStorage.getItem(storageKey);
    const open = stored === null ? defaultOpen : stored === '0';
    details.open = open;
    details.addEventListener('toggle', () => {
        try {
            localStorage.setItem(storageKey, details.open ? '0' : '1');
        } catch {}
    });
}

export async function init() {
    if (!_initOnce) {
        _bindOnce();
        _initOnce = true;
    }
    await refreshStatus();
    _refreshDoctor().catch(() => {});
    _loadPeople().catch(() => {});
    _renderTagBrowser().catch(() => {});
    _renderTagSuggestions().catch(() => {});
}

// Public refresher — exported so the SPA shell can poke us after a
// settings save lands somewhere else (Settings → Advanced → AI).
export async function refreshStatus() {
    try {
        const r = await api.get('/api/ai/status');
        if (!r.success) return;
        _lastStatus = r;
        _renderStatus(r);
        _renderTagBrowser().catch(() => {});
        _renderTagSuggestions().catch(() => {});
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
    // Re-cluster button — runs Phase B only (DBSCAN over existing
    // embeddings, no re-detect). Fast (seconds, not minutes) — useful
    // for tweaking ε / minPoints + seeing the new cluster count
    // immediately without waiting for a full re-scan.
    $('#ai-recluster-btn')?.addEventListener('click', _recluster);

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
    $('#ai-faces-include-videos')?.addEventListener('click', _onIncludeVideosToggle);
    $('#ai-faces-include-videos')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            _onIncludeVideosToggle();
        }
    });
    $('#ai-faces-video-interval')?.addEventListener('change', (e) => {
        const v = Number(e.target.value || 8);
        if (!Number.isFinite(v)) return;
        _saveSetting('videoFrameIntervalSec', Math.max(1, Math.min(120, Math.round(v))));
    });
    $('#ai-faces-video-max-frames')?.addEventListener('change', (e) => {
        const v = Number(e.target.value || 24);
        if (!Number.isFinite(v)) return;
        _saveSetting('videoMaxFrames', Math.max(1, Math.min(200, Math.round(v))));
    });

    // Hardware-acceleration sub-card — same UX as the thumbs page.
    $('#ai-faces-provider-probe-btn')?.addEventListener('click', _runFacesProviderProbe);
    $('#ai-faces-provider')?.addEventListener('change', _onFacesProviderChange);

    // Image tagging card — toggle, labels textarea, scan + cancel.
    $('#ai-tags-toggle')?.addEventListener('click', async () => {
        const el = $('#ai-tags-toggle');
        if (!el) return;
        const cur = el.classList.contains('active');
        const next = !cur;
        el.classList.toggle('active', next);
        el.setAttribute('aria-checked', String(next));
        try {
            const r = await api.post('/api/config', {
                advanced: { ai: { imageTagging: next } },
            });
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
    });
    $('#ai-tags-toggle')?.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            $('#ai-tags-toggle')?.click();
        }
    });
    $('#ai-tags-labels')?.addEventListener('change', async (e) => {
        const raw = String(e.target?.value || '');
        const parts = raw
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        const value = parts.length ? parts : [];
        try {
            const r = await api.post('/api/config', {
                advanced: { ai: { tagLabels: value } },
            });
            if (!r.success) throw new Error(r.error || 'save failed');
            showToast(i18nT('common.saved', 'Saved'), 'success');
        } catch (e) {
            showToast(
                `${i18nT('common.save_failed', 'Save failed')}: ${e?.data?.error || e?.message || 'unknown'}`,
                'error',
            );
        }
    });
    $('#ai-tags-scan-btn')?.addEventListener('click', () => _startScan('tags'));
    $('#ai-tags-cancel-btn')?.addEventListener('click', () => _cancelScan('tags'));

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

    // Tag browser — refresh + chip clicks.
    $('#ai-tag-browser-refresh')?.addEventListener('click', () => _renderTagBrowser());
    $('#ai-tag-filter')?.addEventListener('input', (e) => {
        _tagFilterQuery = String(e.target?.value || '');
        _renderTagBrowser(false);
    });
    $('#ai-tag-sort')?.addEventListener('change', (e) => {
        _tagSortMode = String(e.target?.value || 'count_desc');
        _renderTagBrowser(false);
    });
    $('#ai-tag-load-more')?.addEventListener('click', _loadMoreTagPhotos);
    $('#ai-tag-suggestions-refresh')?.addEventListener('click', () => _renderTagSuggestions());
    _initDetailsCollapsedState({
        detailsId: 'ai-pane-faces',
        storageKey: LS_FACES_COLLAPSED,
        defaultOpen: false,
    });
    _initDetailsCollapsedState({
        detailsId: 'ai-pane-tags',
        storageKey: LS_TAGS_COLLAPSED,
        defaultOpen: false,
    });

    // Person action buttons.
    $('#ai-person-rename-btn')?.addEventListener('click', _renameSelectedPerson);
    $('#ai-person-merge-btn')?.addEventListener('click', _mergeSelectedPerson);
    $('#ai-person-split-btn')?.addEventListener('click', _splitSelectedPerson);
    $('#ai-person-delete-btn')?.addEventListener('click', _deleteSelectedPerson);

    // WebSocket — only the people / scan events survive in the faces-only
    // build. ai_index_* / ai_tags_* were removed with the Search + Tags
    // pipelines. ai_faces_status surfaces sidecar lifecycle changes so the
    // header badge updates without a polling loop.
    ws.on('ai_people_progress', (m) => _onScanProgress('faces', m));
    ws.on('ai_people_done', (m) => _onScanDone('faces', m));
    ws.on('ai_tags_progress', (m) => _onScanProgress('tags', m));
    ws.on('ai_tags_done', (m) => _onScanDone('tags', m));
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
    try {
        const body = { advanced: { ai: {} } };
        const map = _CTRL_SAVE_PATHS[cfgKey];
        if (map) {
            body.advanced.ai[map[0]] = value;
            body.advanced.ai.faces = { [map[2]]: value };
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

async function _onIncludeVideosToggle() {
    const el = $('#ai-faces-include-videos');
    if (!el) return;
    const cur = el.classList.contains('active');
    const next = !cur;
    // Optimistic flip so the click feels instant.
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', {
            advanced: {
                ai: {
                    includeVideos: next,
                    faces: {
                        includeVideos: next,
                    },
                },
            },
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
    const taggedEl = $('#ai-stat-tagged');
    if (taggedEl) {
        taggedEl.textContent = String(counts.withTags ?? 0);
    }
    const lastEl = $('#ai-stat-last');
    if (lastEl) {
        const finishedAt = Number(scans?.faces?.finishedAt) || 0;
        lastEl.textContent =
            finishedAt > 0 ? new Date(finishedAt).toLocaleString() : i18nT('common.never', 'Never');
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
        const cur = Number.isFinite(cfg.facesEpsilon) ? Number(cfg.facesEpsilon) : 0.5;
        if (Number(epsInp.value) !== cur) epsInp.value = String(cur);
        if (epsOut) epsOut.textContent = Number(cur).toFixed(2);
    }
    const minInp = $('#ai-faces-min-points');
    if (minInp) {
        const cur = Number.isFinite(cfg.facesMinPoints) ? Number(cfg.facesMinPoints) : 3;
        if (Number(minInp.value) !== cur) minInp.value = String(cur);
    }
    const provSel = $('#ai-faces-provider');
    if (provSel) {
        const cur = String(cfg.faces?.providers || 'auto').toLowerCase();
        if (provSel.value !== cur) provSel.value = cur;
    }
    const includeVideosEl = $('#ai-faces-include-videos');
    if (includeVideosEl) {
        const on = cfg.faces?.includeVideos === true;
        includeVideosEl.classList.toggle('active', on);
        includeVideosEl.setAttribute('aria-checked', String(on));
    }
    const videoIntervalEl = $('#ai-faces-video-interval');
    if (videoIntervalEl) {
        const cur = Number(cfg.faces?.videoFrameIntervalSec || 8);
        if (Number(videoIntervalEl.value) !== cur) videoIntervalEl.value = String(cur);
    }
    const videoMaxFramesEl = $('#ai-faces-video-max-frames');
    if (videoMaxFramesEl) {
        const cur = Number(cfg.faces?.videoMaxFrames || 24);
        if (Number(videoMaxFramesEl.value) !== cur) videoMaxFramesEl.value = String(cur);
    }
    const videoRuntimeEl = $('#ai-faces-video-runtime');
    if (videoRuntimeEl) {
        const on = cfg.faces?.includeVideos === true;
        const interval = Number(cfg.faces?.videoFrameIntervalSec || 8);
        const maxFrames = Number(cfg.faces?.videoMaxFrames || 24);
        videoRuntimeEl.textContent = on
            ? `video sampling: on · every ${interval}s · max ${maxFrames} frames/video`
            : 'video sampling: off';
    }

    // Image tagging card — toggle, model line, scan state, labels.
    const tagsToggle = $('#ai-tags-toggle');
    if (tagsToggle) {
        const on = cfg.imageTagging !== false;
        tagsToggle.classList.toggle('active', on);
        tagsToggle.setAttribute('aria-checked', String(on));
    }
    const tagsModel = models.tags || {};
    const tagsModelId = tagsModel.id || (tagsModel.loaded ? 'CLIP loaded' : '—');
    const tagsVocab = tagsModel.vocabularySize ? `${tagsModel.vocabularySize} tags` : '';
    const tagsModelLineEl = $('#ai-tags-model-line');
    if (tagsModelLineEl) {
        const parts = [tagsModelId, tagsVocab].filter(Boolean);
        tagsModelLineEl.textContent = parts.join(' · ') || '—';
        tagsModelLineEl.title = tagsModelId;
    }
    const tagsRunning = !!scans?.tags?.running;
    const tagsScanBtn = $('#ai-tags-scan-btn');
    const tagsCancelBtn = $('#ai-tags-cancel-btn');
    if (tagsScanBtn) tagsScanBtn.disabled = tagsRunning;
    if (tagsCancelBtn) tagsCancelBtn.disabled = !tagsRunning;
    // Hydrate tag labels textarea from config.
    const tagsLabelsEl = $('#ai-tags-labels');
    if (tagsLabelsEl) {
        const cur = Array.isArray(cfg.tagLabels) ? cfg.tagLabels.join(', ') : '';
        if (tagsLabelsEl.value !== cur) tagsLabelsEl.value = cur;
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
    let cls;
    let healthy = false;
    if (state === 'healthy' || state === 'ready' || faces.loaded === true) {
        label = i18nTf(
            'maintenance.ai.sidecar.healthy',
            { provider: provider || 'CPU' },
            `Sidecar: healthy (${provider || 'CPU'})`,
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
        label = i18nT('maintenance.ai.sidecar.down', 'Sidecar: unreachable');
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

// ---- Capability cards -----------------------------------------------------

function _renderCapabilities(status) {
    const root = $('#ai-capabilities-grid');
    if (!root) return;
    const cfg = status?.config || {};
    const models = status?.models || {};

    const html = CAPABILITIES.map((cap) => {
        if (cap.comingSoon) return _renderComingSoonCard(cap);
        const m = models[cap.id] || {};
        return _renderCapabilityCard(cap, m, cfg);
    }).join('');
    root.innerHTML = html;

    // Wire controls. Per-card toggle, control inputs, scan buttons —
    // bound once per render because the markup is rebuilt on every
    // status refresh.
    for (const cap of CAPABILITIES) {
        if (cap.comingSoon) continue;
        const card = root.querySelector(`[data-cap="${cap.id}"]`);
        if (!card) continue;

        // Capability auto-toggle (e.g. faceClustering).
        const toggle = card.querySelector('[data-cap-toggle]');
        if (toggle && cap.autoToggleKey) {
            toggle.addEventListener('click', () => _toggleCapability(cap.autoToggleKey, toggle));
        }

        // Scan controls.
        card.querySelector('[data-cap-scan]')?.addEventListener('click', () =>
            _startScan(cap.scanFeature),
        );
        card.querySelector('[data-cap-cancel]')?.addEventListener('click', () =>
            _cancelScan(cap.scanFeature),
        );

        // Each control input — slider / number. Persist on `change`
        // so the operator can tweak the slider without spamming saves
        // while dragging.
        for (const ctrl of cap.controls || []) {
            const inp = card.querySelector(`[data-cap-ctrl="${ctrl.cfgKey}"]`);
            if (!inp) continue;
            inp.addEventListener('change', () => _saveControl(ctrl, inp));
            // Live slider readout — updates the adjacent <output> as
            // the operator drags, even before the change fires.
            if (ctrl.type === 'slider') {
                inp.addEventListener('input', () => {
                    const out = card.querySelector(`[data-cap-out="${ctrl.cfgKey}"]`);
                    if (out) out.textContent = Number(inp.value).toFixed(2);
                });
            }
        }

        // Faces-only: hardware-provider probe + dropdown. The card itself
        // is markup-only — wiring lives here so the renderer stays
        // declarative.
        if (cap.id === 'faces' && card.querySelector('[data-faces-provider-card]')) {
            _wireFacesProviderCard(card);
        }
    }
}

/**
 * Wire the provider sub-card embedded in the faces capability card:
 *   - "Run hardware probe" button → GET /api/ai/faces/provider-probe,
 *     renders verified/unverified chips. Mirrors `setting-adv-ffmpeg-
 *     hwaccel-probe` from maintenance-thumbs.js.
 *   - Provider <select> change → POST /api/config with the nested
 *     `advanced.ai.faces.providers` key, then asks the server to
 *     relaunch the sidecar so the new provider takes effect.
 */
function _wireFacesProviderCard(card) {
    const btn = card.querySelector('#ai-faces-provider-probe-btn');
    const sel = card.querySelector('#ai-faces-provider');
    if (btn && !btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', _runFacesProviderProbe);
    }
    if (sel && !sel.dataset.wired) {
        sel.dataset.wired = '1';
        sel.addEventListener('change', _onFacesProviderChange);
    }
}

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

function _renderCapabilityCard(cap, model, cfg) {
    const title = escapeHtml(i18nT(cap.i18n?.title, cap.defaults.title));
    const desc = escapeHtml(i18nT(cap.i18n?.desc, cap.defaults.desc));
    const enabled = cfg[cap.autoToggleKey] !== false;
    const running = !!_lastStatus?.scans?.[cap.scanFeature]?.running;
    const scanned = Number(_lastStatus?.scans?.[cap.scanFeature]?.scanned) || 0;
    const total = Number(_lastStatus?.scans?.[cap.scanFeature]?.total) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
    const scanLabel = escapeHtml(i18nT(cap.i18n?.scanLabel, cap.defaults.scanLabel || 'Scan now'));
    const cancelLabel = escapeHtml(
        i18nT(cap.i18n?.cancelLabel, cap.defaults.cancelLabel || 'Cancel'),
    );

    // Model line — id + provider + dim. Falls back to a sidecar-aligned
    // label when the status payload hasn't been enriched yet (early boot
    // or fresh install without a scan).
    const modelId = model?.id || (model?.bundled ? 'insightface buffalo_l (Python sidecar)' : '—');
    const dim = model?.dim || (model?.bundled ? 512 : null);
    const provider = _resolveProvider(model);
    const modelLine = [escapeHtml(modelId), dim ? `${dim}-dim` : null, provider || null]
        .filter(Boolean)
        .join(' · ');

    const controlsHtml = (cap.controls || []).map((ctrl) => _renderControl(ctrl, cfg)).join('');

    // Hardware-acceleration sub-card — faces capability only. Mirrors
    // the UX of `#setting-adv-ffmpeg-hwaccel-probe` in the Build
    // thumbnails page: dropdown of provider hints + a "Run hardware
    // probe" button that actually attempts each backend on the host
    // and surfaces which ones initialise.
    const providerHtml = cap.id === 'faces' ? _renderFacesProviderCard(cfg) : '';

    return `
        <div class="ai-capability-card bg-tg-bg/30 rounded-lg p-3 border border-tg-border/30" data-cap="${escapeHtml(cap.id)}">
            <div class="flex items-start gap-3 flex-wrap">
                <i class="${escapeHtml(cap.icon || 'ri-sparkling-line')} text-tg-blue text-xl shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-tg-text text-sm font-semibold">${title}</span>
                        ${
                            !enabled
                                ? `<span class="ai-model-disabled" title="${escapeHtml(i18nT('maintenance.ai.disabled_pill_help', 'Capability is disabled.'))}">${escapeHtml(i18nT('maintenance.ai.disabled_pill', 'Disabled'))}</span>`
                                : ''
                        }
                    </div>
                    <p class="text-[11px] text-tg-textSecondary mt-0.5">${desc}</p>
                    <div class="text-[10px] text-tg-textSecondary mt-1 font-mono truncate" title="${escapeHtml(modelId)}">${modelLine}</div>
                </div>
                <div class="ai-cap-toggle tg-toggle ${enabled ? 'active' : ''}" data-cap-toggle role="switch" aria-checked="${enabled}" tabindex="0"
                    title="Enable or disable this capability"></div>
            </div>

            <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                ${controlsHtml}
            </div>

            ${providerHtml}

            <div class="mt-3 flex items-center gap-2 flex-wrap">
                <button type="button" class="tg-btn-input text-xs px-3 py-1.5" data-cap-scan ${running ? 'disabled' : ''}>
                    <i class="ri-play-fill"></i> ${scanLabel}
                </button>
                <button type="button" class="tg-btn-input-secondary text-xs px-3 py-1.5 ${running ? '' : 'hidden'}" data-cap-cancel>
                    <i class="ri-stop-fill"></i> ${cancelLabel}
                </button>
                <span class="text-[11px] text-tg-textSecondary" data-cap-progress-text>
                    ${running ? `${scanned.toLocaleString()} / ${total.toLocaleString()}` : ''}
                </span>
            </div>

            <div class="ai-cap-progress-track mt-2 h-1 rounded-full bg-tg-bg/50 overflow-hidden ${running ? '' : 'hidden'}" data-cap-progress-wrap>
                <div class="h-full bg-tg-blue transition-all" style="width: ${pct}%" data-cap-progress-bar></div>
            </div>
        </div>
    `;
}

/**
 * Render the "Hardware acceleration" sub-card embedded inside the faces
 * capability card. The dropdown's value is hydrated from
 * `config.advanced.ai.faces.providers` (defaulting to 'auto'); the
 * probe button + chip list are wired in `_wireFacesProviderCard()`.
 */
function _renderFacesProviderCard(cfg) {
    // The providers knob lives under the nested `faces` block (Track I);
    // fall back to the legacy `facesProviders` flat key for safety, then
    // 'auto' as the canonical default.
    const cur = String(cfg?.faces?.providers || cfg?.facesProviders || 'auto').toLowerCase();
    const opts = ['auto', 'cuda', 'coreml', 'directml', 'openvino', 'cpu'];
    const labelKeyMap = {
        auto: ['maintenance.ai.faces.providers.auto', 'Auto (best available)'],
        cuda: ['maintenance.ai.faces.providers.cuda', 'CUDA — NVIDIA GPU'],
        coreml: ['maintenance.ai.faces.providers.coreml', 'CoreML — Apple Silicon'],
        directml: ['maintenance.ai.faces.providers.directml', 'DirectML — Windows'],
        openvino: ['maintenance.ai.faces.providers.openvino', 'OpenVINO — Intel'],
        cpu: ['maintenance.ai.faces.providers.cpu', 'CPU only'],
    };
    const optionsHtml = opts
        .map((v) => {
            const [k, def] = labelKeyMap[v];
            const sel = v === cur ? ' selected' : '';
            return `<option value="${v}"${sel} data-i18n="${k}">${escapeHtml(i18nT(k, def))}</option>`;
        })
        .join('');
    return `
        <div class="bg-tg-bg/30 rounded-lg p-3 border border-tg-border/40 mt-3" data-faces-provider-card>
            <div class="flex items-center justify-between gap-2 flex-wrap mb-2">
                <div class="text-xs text-tg-text font-medium" data-i18n="maintenance.ai.faces.providers.probe_label">Test which inference provider this host can use</div>
                <button id="ai-faces-provider-probe-btn" type="button"
                    class="tg-btn-secondary text-xs px-3 py-1.5 inline-flex items-center justify-center gap-1.5 shrink-0">
                    <i class="ri-radar-line"></i>
                    <span data-i18n="maintenance.ai.faces.providers.probe_action">Run hardware probe</span>
                </button>
            </div>
            <div id="ai-faces-provider-probe-result"
                 class="text-[11px] text-tg-textSecondary leading-relaxed min-h-[24px] flex flex-wrap gap-1 items-center"
                 role="status" aria-live="polite"></div>
            <label for="ai-faces-provider" class="text-tg-text text-xs block mt-3 mb-1" data-i18n="maintenance.ai.faces.providers.label">Inference provider</label>
            <select id="ai-faces-provider" class="tg-input w-full text-sm">
                ${optionsHtml}
            </select>
            <p class="text-[10px] text-tg-textSecondary mt-1" data-i18n="maintenance.ai.faces.providers.help">Auto is the safe default; pick a specific backend only after a probe shows it works. Falls back to CPU if the chosen backend isn't available.</p>
        </div>
    `;
}

function _renderControl(ctrl, cfg) {
    const label = escapeHtml(i18nT(ctrl.labelKey, ctrl.labelDefault));
    // Pull current value generically — string for selects, number for
    // sliders/numbers. Fall back to ctrl.default when the config doesn't
    // yet hold the key (fresh install or just-added setting).
    const rawCur = cfg[ctrl.cfgKey];
    const numCur = Number.isFinite(rawCur) ? rawCur : ctrl.default;
    if (ctrl.type === 'slider') {
        return `
            <label class="block">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-[11px] text-tg-textSecondary">${label}</span>
                    <output class="text-[11px] text-tg-text font-mono tabular-nums" data-cap-out="${escapeHtml(ctrl.cfgKey)}">${Number(numCur).toFixed(2)}</output>
                </div>
                <input type="range" class="tg-range w-full mt-1" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}"
                    min="${ctrl.min}" max="${ctrl.max}" step="${ctrl.step}" value="${numCur}">
            </label>
        `;
    }
    if (ctrl.type === 'number') {
        return `
            <label class="block">
                <span class="text-[11px] text-tg-textSecondary">${label}</span>
                <input type="number" class="tg-input text-xs py-1 mt-1" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}"
                    min="${ctrl.min}" max="${ctrl.max}" step="${ctrl.step || 1}" value="${numCur}">
            </label>
        `;
    }
    if (ctrl.type === 'select') {
        const strCur = typeof rawCur === 'string' && rawCur ? rawCur : ctrl.default;
        const optionsHtml = (ctrl.options || [])
            .map((o) => {
                const optLabel = escapeHtml(i18nT(o.labelKey, o.labelDefault || o.value));
                const sel = o.value === strCur ? ' selected' : '';
                return `<option value="${escapeHtml(o.value)}"${sel} data-i18n="${escapeHtml(o.labelKey || '')}">${optLabel}</option>`;
            })
            .join('');
        const helpHtml = ctrl.helpKey
            ? `<p class="text-[10px] text-tg-textSecondary mt-1" data-i18n="${escapeHtml(ctrl.helpKey)}">${escapeHtml(i18nT(ctrl.helpKey, ctrl.helpDefault || ''))}</p>`
            : '';
        return `
            <label class="block sm:col-span-2">
                <span class="text-[11px] text-tg-textSecondary">${label}</span>
                <select class="tg-input text-xs py-1 mt-1 w-full" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}">
                    ${optionsHtml}
                </select>
                ${helpHtml}
            </label>
        `;
    }
    if (ctrl.type === 'custom') {
        const curVal = Array.isArray(rawCur)
            ? rawCur.join(', ')
            : String(rawCur || '').trim() || '';
        const placeholder = escapeHtml(ctrl.placeholder || '');
        return `
            <label class="block sm:col-span-2">
                <span class="text-[11px] text-tg-textSecondary">${label}</span>
                <textarea class="tg-input text-xs py-1 mt-1 w-full" rows="3" data-cap-ctrl="${escapeHtml(ctrl.cfgKey)}" placeholder="${placeholder}">${escapeHtml(curVal)}</textarea>
                <p class="text-[10px] text-tg-textSecondary mt-1">${escapeHtml(i18nT('maintenance.ai.tags.labels_help', "One tag per line or comma-separated. Leave empty to use the sidecar's built-in vocabulary."))}</p>
            </label>
        `;
    }
    return '';
}

function _renderComingSoonCard(cap) {
    const title = escapeHtml(i18nT(cap.i18n?.title, cap.defaults.title));
    const desc = escapeHtml(i18nT(cap.i18n?.desc, cap.defaults.desc));
    return `
        <div class="ai-coming-soon-card rounded-lg p-3 border border-dashed border-tg-border/40 bg-tg-bg/20 text-tg-textSecondary" aria-hidden="true">
            <div class="flex items-start gap-3 flex-wrap">
                <i class="${escapeHtml(cap.icon || 'ri-flask-line')} text-tg-textSecondary text-xl shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <div class="text-tg-text/70 text-sm font-medium">${title}</div>
                    <p class="text-[11px] text-tg-textSecondary mt-0.5">${desc}</p>
                </div>
            </div>
        </div>
    `;
}

async function _toggleCapability(toggleKey, el) {
    const cur = el.classList.contains('active');
    const next = !cur;
    el.classList.toggle('active', next);
    el.setAttribute('aria-checked', String(next));
    try {
        const r = await api.post('/api/config', { advanced: { ai: { [toggleKey]: next } } });
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        await refreshStatus();
    } catch (e) {
        el.classList.toggle('active', cur);
        el.setAttribute('aria-checked', String(cur));
        showToast(`${i18nT('common.save_failed', 'Save failed')}: ${e.message}`, 'error');
    }
}

// Map UI control cfgKey → canonical save path. The slider/number controls
// read from legacy flat keys (`cfg.facesEpsilon`, `cfg.facesMinPoints`),
// but the new nested `advanced.ai.faces.*` block is the canonical home —
// `_mergeAi` precedence is `faces.* > flat`, so a flat-key save gets
// silently overridden on the next load. Save into BOTH paths so the
// nested block actually changes.
const _CTRL_SAVE_PATHS = {
    facesEpsilon: ['facesEpsilon', 'faces', 'epsilon'],
    facesMinPoints: ['facesMinPoints', 'faces', 'minPoints'],
    facesDetectorModel: ['facesDetectorModel', 'faces', 'detectorModel'],
    includeVideos: ['includeVideos', 'faces', 'includeVideos'],
    videoFrameIntervalSec: ['videoFrameIntervalSec', 'faces', 'videoFrameIntervalSec'],
    videoMaxFrames: ['videoMaxFrames', 'faces', 'videoMaxFrames'],
};

async function _saveControl(ctrl, inp) {
    const raw = inp.value;
    let v;
    // Numeric controls (slider / number) save the parsed number; select
    // controls keep the value as a string — `_CTRL_SAVE_PATHS` carries
    // the alias mapping for both. Custom controls (textarea) save
    // comma-separated strings parsed into arrays.
    if (ctrl.type === 'custom') {
        const parts = String(raw || '')
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        v = parts.length ? parts : [];
    } else if (ctrl.type === 'select') {
        v = String(raw || '');
    } else {
        v = Number(raw);
        if (!Number.isFinite(v)) return;
    }
    try {
        // Build a payload that updates BOTH the legacy flat key AND
        // the nested faces.* path so the merger picks up the new value
        // regardless of which precedence rule fires.
        const body = { advanced: { ai: {} } };
        const map = _CTRL_SAVE_PATHS[ctrl.cfgKey];
        if (map) {
            body.advanced.ai[map[0]] = v;
            body.advanced.ai.faces = { [map[2]]: v };
        } else {
            body.advanced.ai[ctrl.cfgKey] = v;
        }
        const r = await api.post('/api/config', body);
        if (!r.success) throw new Error(r.error || 'save failed');
        showToast(i18nT('common.saved', 'Saved'), 'success');
        // For model change, also kick a sidecar relaunch so the new
        // insightface preset is loaded on the next /detect call.
        if (ctrl.cfgKey === 'facesDetectorModel') {
            try {
                await api.post('/api/ai/faces/restart', {});
            } catch (e) {
                console.warn('faces/restart on model change:', e);
            }
        }
        // Don't re-render the whole status — the slider's own output
        // already shows the live value, and a re-render would steal
        // focus from the operator's current input.
    } catch (e) {
        showToast(`${i18nT('common.save_failed', 'Save failed')}: ${e.message}`, 'error');
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
    const running = !!msg.running;
    const scanned = Number(msg.scanned) || 0;
    const total = Number(msg.total) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;

    if (feature === 'faces') {
        const scanBtn = $('#ai-scan-btn');
        const cancelBtn = $('#ai-cancel-btn');
        if (scanBtn) scanBtn.disabled = running;
        if (cancelBtn) cancelBtn.disabled = !running;
    } else if (feature === 'tags') {
        const scanBtn = $('#ai-tags-scan-btn');
        const cancelBtn = $('#ai-tags-cancel-btn');
        if (scanBtn) scanBtn.disabled = running;
        if (cancelBtn) cancelBtn.disabled = !running;
    }

    // Shared progress bar — shows whichever scan is currently running.
    const progressWrap = $('#ai-progress');
    const progressBar = $('#ai-progress-bar');
    const progressPct = $('#ai-progress-pct');
    const progressStatus = $('#ai-progress-status');

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
        const label =
            feature === 'faces'
                ? i18nT('maintenance.ai.scanning', 'Scanning…')
                : i18nT('maintenance.ai.scanning_tags', 'Tagging photos…');
        progressStatus.textContent = label;
    }
}

function _onScanDone(feature, msg) {
    _onScanProgress(feature, { ...msg, running: false });
    if (msg?.error) {
        showToast(`${feature}: ${msg.error}`, 'error');
    } else {
        showToast(i18nT('maintenance.ai.scan_done', 'Scan complete'), 'success');
    }
    refreshStatus();
    if (feature === 'faces') _loadPeople();
    if (feature === 'tags') _renderTagBrowser();
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

    if (!filtered.length) {
        grid.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');
    grid.innerHTML = filtered.map(_personTile).join('');
    grid.querySelectorAll('[data-person]').forEach((b) => {
        b.addEventListener('click', () => {
            _selectedPerson = Number(b.dataset.person);
            _selectedPersonName = b.dataset.name || '';
            _showPersonPhotos({ scrollIntoSection: true });
        });
    });
}

function _personTile(p) {
    const name = p.label || `${i18nT('maintenance.ai.person_default', 'Person')} #${p.id}`;
    const cover = p.cover_download_id ? `/api/thumbs/${p.cover_download_id}?w=320` : '';
    const faceCount = Number(p.face_count) || 0;
    const lastSeen = p.last_seen_at ? new Date(p.last_seen_at).toLocaleDateString() : '';
    const safeName = escapeHtml(name);
    return `<button type="button" data-person="${p.id}" data-name="${safeName}"
        class="block group relative bg-tg-bg/30 rounded-lg overflow-hidden hover:ring-2 hover:ring-tg-blue/40 transition-shadow"
        title="${safeName}">
        ${
            cover
                ? `<img src="${cover}" alt="${safeName}" loading="lazy" class="aspect-square w-full object-cover">`
                : '<div class="aspect-square w-full bg-tg-bg/40 flex items-center justify-center"><i class="ri-user-line text-3xl text-tg-textSecondary/50"></i></div>'
        }
        <div class="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/80 to-transparent text-left">
            <div class="text-[11px] text-white truncate font-medium">${safeName}</div>
            <div class="text-[10px] text-white/70 flex items-center justify-between gap-1">
                <span>${faceCount} ${escapeHtml(i18nT('maintenance.ai.faces_short', 'faces'))}</span>
                ${lastSeen ? `<span class="opacity-70">${escapeHtml(lastSeen)}</span>` : ''}
            </div>
        </div>
    </button>`;
}

async function _showPersonPhotos({ scrollIntoSection = false } = {}) {
    if (!_selectedPerson) return;
    const section = $('#ai-people-photos');
    section?.classList.remove('hidden');
    if (scrollIntoSection && section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const nameEl = $('#ai-people-photos-name');
    if (nameEl) nameEl.textContent = _selectedPersonName;
    const grid = $('#ai-people-photos-grid');
    if (!grid) return;
    grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('common.loading', 'Loading…'))}</div>`;
    try {
        const r = await api.get(`/api/ai/people/${_selectedPerson}/photos?limit=120`);
        if (!r.success) throw new Error(r.error || 'load failed');
        const files = r.files || [];
        if (!files.length) {
            grid.innerHTML = `<div class="col-span-full text-center text-xs text-tg-textSecondary py-8">${escapeHtml(i18nT('maintenance.ai.no_photos', 'No photos in this cluster.'))}</div>`;
            return;
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
    const q = Number(row.face_quality);
    const qualityScore = Number.isFinite(q) ? Math.round(Math.max(0, Math.min(1, q)) * 100) : null;
    return `
        <a href="#/files/${id}" class="block group relative" data-face-id="${escapeHtml(String(faceId))}">
            <img src="/api/thumbs/${id}?w=320" alt="${name}" loading="lazy"
                class="aspect-square w-full object-cover rounded-lg bg-tg-bg/40">
            ${
                qualityScore == null
                    ? ''
                    : `<span class="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-black/65 text-white tabular-nums">Q${qualityScore}</span>`
            }
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
