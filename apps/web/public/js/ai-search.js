// AI semantic search — Apple Photos / Visual Look Up style hero.
//
// Owns:
//   - The hero search input + magnifier / clear / mic affordances.
//   - Suggestion chips (Recent, Try these, Top tags, People).
//   - Live debounced search (250 ms) into POST /api/ai/search.
//   - "More like this" similar-search via POST /api/ai/search/similar with a
//     dismissible breadcrumb above the input.
//   - Result grid with hover overlay (Open / More like this / Open in viewer).
//   - Keyboard navigation (↑↓←→ + Enter) over the result tiles.
//   - Recent-searches persisted in localStorage[tgdl-ai-search-recent].
//   - Index-scan CTA when there's nothing to search yet.
//
// Idempotent — bindSearchUi() guards against double-wiring on re-mount.

import { api } from './api.js';
import { escapeHtml, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { openResultViewer } from './ai-result-viewer.js';

const DEBOUNCE_MS = 250;
const RECENT_LS_KEY = 'tgdl-ai-search-recent';
const RECENT_LIMIT = 8;
const TRY_CHIPS = ['cat', 'sunset', 'beach', 'document', 'text', 'food', 'screenshot', 'person'];
const TOP_TAGS_LIMIT = 8;
const PEOPLE_LIMIT = 6;

// Latest issued query token. Bumped on every input — older results that
// resolve out of order get discarded so a slow request can't overwrite a
// newer typed query.
let _queryToken = 0;
let _lastResults = [];
let _focusIdx = -1;
let _similarSource = null;  // {download_id, file_name, ...}
let _hasEmbeddings = null;

// ---- localStorage recent-searches ----------------------------------------

function _loadRecent() {
    try {
        const raw = localStorage.getItem(RECENT_LS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string').slice(0, RECENT_LIMIT) : [];
    } catch { return []; }
}

function _saveRecent(query) {
    const q = String(query || '').trim();
    if (!q) return;
    let recent = _loadRecent();
    // Case-insensitive dedup, newest first.
    recent = recent.filter((s) => s.toLowerCase() !== q.toLowerCase());
    recent.unshift(q);
    recent = recent.slice(0, RECENT_LIMIT);
    try { localStorage.setItem(RECENT_LS_KEY, JSON.stringify(recent)); }
    catch { /* quota or disabled — silent */ }
}

// ---- Suggestion chip rendering -------------------------------------------

function _renderChipRow(rowEl, chips, onClick) {
    if (!rowEl) return;
    const list = rowEl.querySelector('.ai-chip-list');
    if (!list) return;
    if (!chips.length) {
        rowEl.classList.add('hidden');
        list.innerHTML = '';
        return;
    }
    rowEl.classList.remove('hidden');
    list.innerHTML = chips.map((c) => {
        if (c.kind === 'person') {
            const cover = c.cover_download_id
                ? `<img src="/api/thumbs/${c.cover_download_id}?w=64" alt="" class="ai-chip-avatar" onerror="this.style.display='none'"/>`
                : `<span class="ai-chip-avatar ai-chip-avatar-fallback"><i class="ri-user-line"></i></span>`;
            return `
                <button type="button" class="ai-chip ai-chip-person" data-chip-query="${escapeHtml(c.query)}" data-chip-kind="person" role="listitem">
                    ${cover}
                    <span class="ai-chip-text">${escapeHtml(c.label)}</span>
                </button>
            `;
        }
        const icon = c.icon ? `<i class="${c.icon}" aria-hidden="true"></i>` : '';
        const count = c.count != null ? `<span class="ai-chip-count tabular-nums">${c.count}</span>` : '';
        return `
            <button type="button" class="ai-chip" data-chip-query="${escapeHtml(c.query)}" role="listitem">
                ${icon}<span class="ai-chip-text">${escapeHtml(c.label)}</span>${count}
            </button>
        `;
    }).join('');
    list.querySelectorAll('.ai-chip').forEach((b) => {
        b.addEventListener('click', () => onClick(b.dataset.chipQuery, b.dataset.chipKind || ''));
    });
}

async function _refreshChips({ inputEl, resultsEl, emptyEl, ctaEl, metaEl }) {
    // Recent
    const recentEl = document.getElementById('ai-chips-recent');
    const recent = _loadRecent();
    _renderChipRow(recentEl, recent.map((q) => ({ query: q, label: q, icon: 'ri-history-line' })),
        (q) => _runSearchFromChip(q, { inputEl, resultsEl, emptyEl, ctaEl, metaEl }));

    // Try
    const tryEl = document.getElementById('ai-chips-try');
    _renderChipRow(tryEl, TRY_CHIPS.map((q) => ({ query: q, label: q })),
        (q) => _runSearchFromChip(q, { inputEl, resultsEl, emptyEl, ctaEl, metaEl }));

    // Top tags + people — best-effort, fail silent.
    try {
        const r = await api.get('/api/ai/tags?min_count=2');
        const tags = (r?.tags || []).slice(0, TOP_TAGS_LIMIT);
        _renderChipRow(document.getElementById('ai-chips-tags'),
            tags.map((t) => ({ query: t.tag, label: t.tag, count: t.count, icon: 'ri-price-tag-3-line' })),
            (q) => _runSearchFromChip(q, { inputEl, resultsEl, emptyEl, ctaEl, metaEl }));
    } catch { _renderChipRow(document.getElementById('ai-chips-tags'), [], () => {}); }

    try {
        const r = await api.get('/api/ai/people');
        const people = (r?.people || []).slice(0, PEOPLE_LIMIT);
        _renderChipRow(document.getElementById('ai-chips-people'),
            people.map((p) => ({
                kind: 'person',
                query: (p.label && p.label.trim()) || i18nT('maintenance.ai.people.unnamed', 'Unnamed person'),
                label: (p.label && p.label.trim()) || i18nT('maintenance.ai.people.unnamed', 'Unnamed person'),
                cover_download_id: p.cover_download_id,
            })),
            (q) => _runSearchFromChip(q, { inputEl, resultsEl, emptyEl, ctaEl, metaEl }));
    } catch { _renderChipRow(document.getElementById('ai-chips-people'), [], () => {}); }
}

function _runSearchFromChip(query, ctx) {
    if (ctx.inputEl) ctx.inputEl.value = query;
    _clearSimilar(ctx);
    runSearch({ query, ...ctx });
}

// ---- Result tile rendering -----------------------------------------------

function _renderThumbCard(r, idx) {
    const score = (Number(r.score) || 0).toFixed(3);
    const fname = escapeHtml(r.file_name || '');
    const groupName = escapeHtml(r.group_name || r.group_id || '');
    const scoreLabel = i18nTf('maintenance.ai.search.score', { n: score }, `score ${score}`);
    return `
        <div class="ai-result-tile" role="gridcell" aria-rowindex="${Math.floor(idx / 4) + 1}" aria-colindex="${(idx % 4) + 1}"
             tabindex="0" data-result-idx="${idx}" data-download-id="${r.download_id}" title="${fname}">
            <div class="ai-result-thumb">
                <img src="/api/thumbs/${r.download_id}?w=240" alt="${fname}"
                     loading="lazy" decoding="async"
                     onerror="this.style.display='none'"/>
                <span class="ai-result-score" title="${escapeHtml(scoreLabel)}">${score}</span>
                <div class="ai-result-overlay" aria-hidden="true">
                    <button type="button" class="ai-result-action" data-action="open" data-i18n="maintenance.ai.search.action.open">Open</button>
                    <button type="button" class="ai-result-action" data-action="similar" data-i18n="maintenance.ai.search.action.similar">More like this</button>
                </div>
            </div>
            <div class="ai-result-meta">
                <div class="ai-result-name">${fname}</div>
                <div class="ai-result-group">${groupName}</div>
            </div>
        </div>
    `;
}

function _renderShimmerTiles(count = 8) {
    const tiles = Array.from({ length: count }, () => `
        <div class="ai-result-tile ai-result-skeleton" aria-hidden="true">
            <div class="ai-result-thumb"></div>
            <div class="ai-result-meta">
                <div class="ai-result-name"></div>
                <div class="ai-result-group"></div>
            </div>
        </div>
    `).join('');
    return tiles;
}

function _hideAllStates(els) {
    els.emptyEl?.classList.add('hidden');
    els.ctaEl?.classList.add('hidden');
}

function _setSimilarBar(source) {
    const bar = document.getElementById('ai-search-similar-bar');
    const name = document.getElementById('ai-similar-name');
    if (!bar) return;
    if (!source) {
        bar.classList.add('hidden');
        if (name) name.textContent = '';
        return;
    }
    bar.classList.remove('hidden');
    if (name) name.textContent = source.file_name || `#${source.download_id}`;
}

function _clearSimilar(ctx) {
    _similarSource = null;
    _setSimilarBar(null);
    if (ctx?.inputEl?.value?.trim()) {
        // Re-run the live text search so the user sees their query results
        // back, not a stale similar-result list.
        runSearch({ query: ctx.inputEl.value, ...ctx });
    } else {
        if (ctx?.resultsEl) ctx.resultsEl.innerHTML = '';
        if (ctx?.metaEl) ctx.metaEl.textContent = '';
    }
}

// ---- Search execution ----------------------------------------------------

/**
 * Run a single semantic search and render the result grid.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.limit=24]
 * @param {string[]} [opts.fileTypes]
 * @param {Element} [opts.resultsEl]
 * @param {Element} [opts.emptyEl]
 * @param {Element} [opts.ctaEl]
 * @param {Element} [opts.metaEl]
 */
export async function runSearch({ query, limit = 24, fileTypes = null,
                                   resultsEl, emptyEl, ctaEl, metaEl } = {}) {
    if (!query || !query.trim()) {
        if (resultsEl) resultsEl.innerHTML = '';
        if (metaEl) metaEl.textContent = '';
        _lastResults = [];
        _focusIdx = -1;
        return;
    }
    _hideAllStates({ emptyEl, ctaEl });
    const myToken = ++_queryToken;
    if (resultsEl) resultsEl.innerHTML = _renderShimmerTiles();
    if (metaEl) metaEl.textContent = i18nT('maintenance.ai.search.searching', 'Searching…');
    let r;
    try {
        r = await api.post('/api/ai/search', { query: query.trim(), limit, fileTypes });
    } catch (e) {
        if (myToken !== _queryToken) return;
        if (resultsEl) resultsEl.innerHTML = '';
        // 503 EMBEDDINGS_DISABLED / AI_DISABLED → show the index CTA
        // instead of an error message; the operator's next move is to
        // enable AI / kick a scan.
        const code = e?.data?.code || '';
        const isDisabled = code === 'EMBEDDINGS_DISABLED' || code === 'AI_DISABLED' || e?.status === 503;
        if (isDisabled) {
            if (ctaEl) ctaEl.classList.remove('hidden');
            if (metaEl) metaEl.textContent = '';
        } else if (metaEl) {
            const msg = String(e?.message || '');
            metaEl.textContent = i18nTf('maintenance.ai.search.error', { msg }, `Search failed: ${msg}`);
        }
        return;
    }
    if (myToken !== _queryToken) return;  // stale response — discard
    _saveRecent(query);

    const results = r?.results || [];
    _lastResults = results;
    _focusIdx = -1;
    if (!results.length) {
        if (resultsEl) resultsEl.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (metaEl) metaEl.textContent = '';
        return;
    }
    if (resultsEl) resultsEl.innerHTML = results.map(_renderThumbCard).join('');
    if (metaEl) {
        metaEl.textContent = i18nTf('maintenance.ai.search.found',
            { n: results.length },
            `${results.length} matches`);
    }
}

/**
 * Run a "More like this" similar-search and render the grid in place.
 */
async function runSimilar({ source, limit = 24, resultsEl, emptyEl, ctaEl, metaEl }) {
    _hideAllStates({ emptyEl, ctaEl });
    const myToken = ++_queryToken;
    if (resultsEl) resultsEl.innerHTML = _renderShimmerTiles();
    if (metaEl) metaEl.textContent = i18nT('maintenance.ai.search.searching', 'Searching…');
    let r;
    try {
        r = await api.post('/api/ai/search/similar', {
            downloadId: Number(source.download_id),
            limit,
        });
    } catch (e) {
        if (myToken !== _queryToken) return;
        if (resultsEl) resultsEl.innerHTML = '';
        if (metaEl) metaEl.textContent = i18nTf('maintenance.ai.search.error', { msg: e.message }, `Search failed: ${e.message}`);
        showToast(i18nTf('maintenance.ai.search.similar_failed', { msg: e.message }, `Couldn't find similar: ${e.message}`));
        return;
    }
    if (myToken !== _queryToken) return;
    _similarSource = r?.source || source;
    _setSimilarBar(_similarSource);
    const results = r?.results || [];
    _lastResults = results;
    _focusIdx = -1;
    if (!results.length) {
        if (resultsEl) resultsEl.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (metaEl) metaEl.textContent = '';
        return;
    }
    if (resultsEl) resultsEl.innerHTML = results.map(_renderThumbCard).join('');
    if (metaEl) {
        metaEl.textContent = i18nTf('maintenance.ai.search.found',
            { n: results.length },
            `${results.length} matches`);
    }
}

// ---- Keyboard navigation -------------------------------------------------

function _focusTile(idx, resultsEl) {
    if (!resultsEl) return;
    const tiles = resultsEl.querySelectorAll('.ai-result-tile:not(.ai-result-skeleton)');
    if (!tiles.length) return;
    const clamped = Math.max(0, Math.min(tiles.length - 1, idx));
    _focusIdx = clamped;
    tiles[clamped].focus();
}

function _columnsForViewport() {
    const w = window.innerWidth || 1024;
    if (w < 480) return 2;
    if (w < 768) return 3;
    if (w < 1024) return 4;
    return 5;
}

// ---- Public mount --------------------------------------------------------

/**
 * Wire the hero search + chip rows + result grid + similar bar.
 * Idempotent — guarded by a wired-flag stored on the input element.
 */
export function bindSearchUi({ inputEl, buttonEl, resultsEl, emptyEl, metaEl, ctaEl } = {}) {
    if (!inputEl) return () => {};
    if (inputEl._aiSearchWired) return inputEl._aiSearchWired;

    const ctaElResolved = ctaEl || document.getElementById('ai-search-cta');
    const ctx = { inputEl, resultsEl, emptyEl, metaEl, ctaEl: ctaElResolved };
    const clearBtn = document.getElementById('ai-search-clear');
    const similarClear = document.getElementById('ai-similar-clear');
    const ctaBtn = document.getElementById('ai-search-cta-btn');

    let timer = null;
    const fire = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            // Typing while in similar-mode drops out of similar-mode.
            if (_similarSource) { _similarSource = null; _setSimilarBar(null); }
            runSearch({ query: inputEl.value, ...ctx });
            _toggleClearBtn();
        }, DEBOUNCE_MS);
    };
    const _toggleClearBtn = () => {
        if (clearBtn) clearBtn.classList.toggle('hidden', !inputEl.value);
    };
    const onInput = () => fire();
    const onKey = (e) => {
        if (e.key === 'Enter') {
            clearTimeout(timer);
            if (_similarSource) { _similarSource = null; _setSimilarBar(null); }
            runSearch({ query: inputEl.value, ...ctx });
        } else if (e.key === 'Escape' && inputEl.value) {
            inputEl.value = '';
            clearTimeout(timer);
            runSearch({ query: '', ...ctx });
            _toggleClearBtn();
        } else if (e.key === 'ArrowDown' && _lastResults.length) {
            e.preventDefault();
            _focusTile(0, resultsEl);
        }
    };
    const onClickGo = () => {
        clearTimeout(timer);
        runSearch({ query: inputEl.value, ...ctx });
    };
    const onClear = () => {
        inputEl.value = '';
        clearTimeout(timer);
        if (_similarSource) { _similarSource = null; _setSimilarBar(null); }
        runSearch({ query: '', ...ctx });
        inputEl.focus();
        _toggleClearBtn();
    };
    const onSimilarClear = () => _clearSimilar(ctx);

    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKey);
    if (buttonEl) buttonEl.addEventListener('click', onClickGo);
    if (clearBtn) clearBtn.addEventListener('click', onClear);
    if (similarClear) similarClear.addEventListener('click', onSimilarClear);
    if (ctaBtn) ctaBtn.addEventListener('click', async () => {
        try {
            await api.post('/api/ai/index/scan', {});
            showToast(i18nT('maintenance.ai.scan.started', 'Scan started'));
        } catch (e) {
            // The most common cause is the whole AI subsystem being off
            // in Settings → Advanced. Surface the toast verbatim — the
            // 503 body usually says exactly that.
            showToast(i18nTf('maintenance.ai.scan.failed', { msg: e.message }, `Failed: ${e.message}`));
        }
    });

    // Result grid — event delegation for actions + keyboard nav.
    if (resultsEl) {
        resultsEl.addEventListener('click', (e) => {
            const tile = e.target.closest('.ai-result-tile');
            if (!tile || tile.classList.contains('ai-result-skeleton')) return;
            const idx = Number(tile.dataset.resultIdx);
            const row = _lastResults[idx];
            if (!row) return;
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'similar') {
                e.stopPropagation();
                runSimilar({ source: row, ...ctx });
                return;
            }
            // Default click → open viewer.
            openResultViewer(row, {
                onSimilar: (r) => runSimilar({ source: r, ...ctx }),
                onTagClick: (tag) => _runSearchFromChip(tag, ctx),
            });
        });
        resultsEl.addEventListener('keydown', (e) => {
            const tile = e.target.closest?.('.ai-result-tile');
            if (!tile) return;
            const idx = Number(tile.dataset.resultIdx);
            const cols = _columnsForViewport();
            if (e.key === 'Enter') {
                e.preventDefault();
                const row = _lastResults[idx];
                if (row) openResultViewer(row, {
                    onSimilar: (r) => runSimilar({ source: r, ...ctx }),
                    onTagClick: (tag) => _runSearchFromChip(tag, ctx),
                });
            } else if (e.key === 'ArrowRight') {
                e.preventDefault(); _focusTile(idx + 1, resultsEl);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault(); _focusTile(idx - 1, resultsEl);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault(); _focusTile(idx + cols, resultsEl);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (idx - cols < 0) inputEl.focus();
                else _focusTile(idx - cols, resultsEl);
            }
        });
    }

    // Initial chip-row population.
    _refreshChips({ inputEl, resultsEl, emptyEl, ctaEl: ctaElResolved, metaEl }).catch(() => {});

    const teardown = () => {
        inputEl.removeEventListener('input', onInput);
        inputEl.removeEventListener('keydown', onKey);
        if (buttonEl) buttonEl.removeEventListener('click', onClickGo);
        if (clearBtn) clearBtn.removeEventListener('click', onClear);
        if (similarClear) similarClear.removeEventListener('click', onSimilarClear);
        inputEl._aiSearchWired = null;
    };
    inputEl._aiSearchWired = teardown;
    _toggleClearBtn();
    return teardown;
}

/**
 * Re-fetch the chip rows on demand — used by maintenance-ai.js after a
 * scan finishes so the "Top tags" and "People" rows reflect new data.
 */
export function refreshChips() {
    _refreshChips({
        inputEl: document.getElementById('ai-search-input'),
        resultsEl: document.getElementById('ai-search-results'),
        emptyEl: document.getElementById('ai-search-empty'),
        ctaEl: document.getElementById('ai-search-cta'),
        metaEl: document.getElementById('ai-search-meta'),
    }).catch(() => {});
}

/** Probe whether any embeddings exist — used by the search box to decide
 *  between the "No results" and "Index your library" empty states. */
export async function probeHasEmbeddings() {
    if (_hasEmbeddings != null) return _hasEmbeddings;
    try {
        const s = await api.get('/api/ai/status');
        _hasEmbeddings = !!(s?.counts?.indexed > 0);
    } catch { _hasEmbeddings = false; }
    return _hasEmbeddings;
}
