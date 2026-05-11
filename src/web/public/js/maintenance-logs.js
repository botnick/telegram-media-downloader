// Maintenance — Realtime log viewer (admin page).
//
// Boots from /api/maintenance/logs/recent (newest 200) then tails the
// `log` WS stream live. DOM is capped at 1000 lines (oldest evicted) so
// a chatty failure mode doesn't blow up memory.
//
// Filters: source (multi-select chip group), level (radio), free-text
// search. Pause + Clear + Download .log + auto-scroll toggle.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml } from './utils.js';
import { t as i18nT } from './i18n.js';

const $ = (id) => document.getElementById(id);

// Dynamic source registry. Sources are discovered from the live log
// stream and the initial /api/maintenance/logs/recent batch — anything
// the server emits via `log()` gets its own chip without a frontend
// release. Hue is derived from a stable hash of the source name so the
// eye learns "the indigo lines are ai-faces-spawn" within a session
// and the assignment doesn't shuffle on refresh.
//
// Replaces the previous hardcoded 9-source table that silently dropped
// every `ai-faces-spawn`, `aiPeople`, `monitor`, `rescue`, `console`
// line because the chip key didn't match.
const _HUE_PALETTE = [
    'text-emerald-400',
    'text-indigo-400',
    'text-yellow-400',
    'text-teal-400',
    'text-amber-400',
    'text-lime-400',
    'text-rose-400',
    'text-pink-400',
    'text-cyan-400',
    'text-sky-400',
    'text-fuchsia-400',
    'text-orange-400',
    'text-violet-400',
    'text-green-400',
    'text-red-400',
    'text-blue-400',
];

// FNV-1a 32-bit hash — fast, deterministic, stable across reloads so
// "ai-faces-spawn" picks the same palette slot every time.
function _hashSource(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function _sourceHue(source) {
    const idx = _hashSource(String(source || '')) % _HUE_PALETTE.length;
    return _HUE_PALETTE[idx];
}

// Set of every source we've actually seen in the log stream so far.
// Populated by `_recordSource()` on every incoming line; chips
// re-render when a new source appears.
const _knownSources = new Set();
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };
// Per-viewport cap — 500 on mobile (each row carries listeners + DOM
// children so 1 000 rows on an old phone gets jank-y), 1 000 on desktop.
const MAX_LINES =
    typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 640 ? 500 : 1000;

let _wsWired = false;
let _pageWired = false;
let _paused = false;
let _autoscroll = true;
// `sources: null` means "no source filter applied — show everything".
// A Set with entries means "show only these sources". This is cleaner
// than the previous "Set seeded with every known source" approach,
// which silently dropped any new source not in the seed list.
const _filter = {
    sources: null,
    minLevel: 'info',
    search: '',
};
const _lines = []; // ring buffer of {ts,source,level,msg}

// Track every unique source we see. If a new one appears, re-render
// the chip group + bump the count badge. Cheap (Set.has is O(1)).
function _recordSource(source) {
    if (!source) return false;
    const s = String(source);
    if (_knownSources.has(s)) return false;
    _knownSources.add(s);
    return true;
}

function _formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function _matchesFilter(entry) {
    // `sources === null` means no source filter → show all.
    // Otherwise show only entries whose source is in the set.
    if (_filter.sources && !_filter.sources.has(entry.source)) return false;
    const rank = LEVEL_RANK[entry.level] ?? 0;
    if (rank < (LEVEL_RANK[_filter.minLevel] ?? 0)) return false;
    if (_filter.search) {
        const needle = _filter.search.toLowerCase();
        if (
            !String(entry.msg || '')
                .toLowerCase()
                .includes(needle)
        )
            return false;
    }
    return true;
}

function _renderLine(entry) {
    // Terminal-style row: timestamp dimmed (so it doesn't fight the message),
    // source pill in its own hue, level glyph (info=•, warn=▲, error=✖)
    // colour-coded, message in default body colour. Selectable text;
    // copy-paste pulls the raw line.
    const tsCls = 'text-tg-textSecondary/70';
    const srcCls = _sourceHue(entry.source);
    const levelGlyph = entry.level === 'error' ? '✖' : entry.level === 'warn' ? '▲' : '•';
    const levelCls =
        entry.level === 'error'
            ? 'text-red-400'
            : entry.level === 'warn'
              ? 'text-yellow-400'
              : 'text-emerald-400/80';
    const msgCls =
        entry.level === 'error'
            ? 'text-red-300'
            : entry.level === 'warn'
              ? 'text-yellow-200'
              : 'text-tg-text';
    return (
        `<div class="logline" data-level="${escapeHtml(entry.level)}" data-source="${escapeHtml(entry.source)}">` +
        `<span class="${tsCls}">${_formatTime(entry.ts)}</span> ` +
        `<span class="${levelCls}">${levelGlyph}</span> ` +
        `<span class="${srcCls}">${escapeHtml(entry.source.padEnd(10))}</span> ` +
        `<span class="${msgCls}">${escapeHtml(entry.msg)}</span>` +
        `</div>`
    );
}

function _renderAll() {
    const pre = $('logs-stream');
    if (!pre) return;
    const html = _lines.filter(_matchesFilter).map(_renderLine).join('');
    pre.innerHTML = html;
    if (_autoscroll) pre.scrollTop = pre.scrollHeight;
}

// Coalesced redraw of the source-count badges. Called from _appendOne
// on every log entry; we batch into a single rAF so a 200 lines/sec
// burst doesn't trip 200 querySelector loops per second.
let _countsDirty = false;
function _scheduleCountsUpdate() {
    if (_countsDirty) return;
    _countsDirty = true;
    requestAnimationFrame(() => {
        _countsDirty = false;
        _updateSourceCounts();
    });
}

function _appendOne(entry) {
    _lines.push(entry);
    if (_lines.length > MAX_LINES) _lines.shift();
    // Dynamic source discovery — if this source hasn't been seen
    // before, register it and re-render the chip group so the operator
    // can filter on it. Subsequent lines from the same source just
    // bump the count badge.
    const newSrc = _recordSource(entry.source);
    if (newSrc) _renderSourceChips();
    _scheduleCountsUpdate();
    if (_paused) return;
    if (!_matchesFilter(entry)) return;
    const pre = $('logs-stream');
    if (!pre) return;
    pre.insertAdjacentHTML('beforeend', _renderLine(entry));
    // Cap rendered lines too — if filters keep most, the DOM can still
    // bloat past MAX_LINES. Drop the oldest visible line.
    while (pre.children.length > MAX_LINES) pre.removeChild(pre.firstChild);
    if (_autoscroll) pre.scrollTop = pre.scrollHeight;
}

// Render the chip group's HTML. Re-runs whenever a new source is
// discovered (~3-15 times per session — initial backfill + each new
// subsystem that emits its first line). Sorts alphabetically so chip
// order is predictable across sessions.
function _renderSourceChips() {
    const wrap = $('logs-filter-sources');
    if (!wrap) return;
    const sources = [..._knownSources].sort();
    // Each chip: dot in the source's stable hue + name + match count.
    // `aria-pressed` reflects current filter state — `null` filter (no
    // active filter) means every chip reads as pressed. A `Set` filter
    // makes only the included sources pressed.
    const isPressed = (s) => _filter.sources === null || _filter.sources.has(s);
    const sourceChips = sources
        .map((s) => {
            const dotCls = _sourceHue(s);
            const pressed = isPressed(s);
            return `
                <button type="button" class="log-src-chip" data-source="${escapeHtml(s)}"
                        aria-pressed="${pressed ? 'true' : 'false'}"
                        title="${escapeHtml(s)} — click to toggle, shift-click to isolate">
                    <span class="log-src-chip__dot ${dotCls}">●</span>
                    <span class="log-src-chip__label">${escapeHtml(s)}</span>
                    <span class="log-src-chip__count" data-source-count="${escapeHtml(s)}">0</span>
                </button>`;
        })
        .join('');
    wrap.innerHTML = `
        <div class="log-src-quick">
            <button type="button" class="log-src-quick__btn" data-action="all"
                data-i18n="maintenance.logs.filter.all">All</button>
            <button type="button" class="log-src-quick__btn" data-action="none"
                data-i18n="maintenance.logs.filter.none">None</button>
        </div>
        ${sourceChips}
    `;
    _updateSourceCounts();
}

function _updateSourceCounts() {
    const wrap = $('logs-filter-sources');
    if (!wrap) return;
    const counts = Object.create(null);
    for (const e of _lines) {
        counts[e.source] = (counts[e.source] || 0) + 1;
    }
    for (const s of _knownSources) {
        const badge = wrap.querySelector(`[data-source-count="${CSS.escape(s)}"]`);
        if (badge) {
            const n = counts[s] || 0;
            badge.textContent = n > 999 ? '999+' : String(n);
        }
    }
}

function _wireFilters() {
    const sourceWrap = $('logs-filter-sources');
    if (sourceWrap) {
        _renderSourceChips();
        // Single delegated listener. Three interaction modes:
        //   1. Quick action "All"  → clear filter (`sources = null`)
        //   2. Quick action "None" → empty filter (`sources = new Set()`)
        //   3. Plain click  → toggle just that source
        //   4. Shift-click  → SOLO that source (filter shows only it)
        // Mirrors the source-isolation pattern from Chrome DevTools'
        // network panel + iTerm's color tags.
        sourceWrap.addEventListener('click', (e) => {
            const quick = e.target.closest('.log-src-quick__btn');
            if (quick) {
                const action = quick.dataset.action;
                if (action === 'all') {
                    _filter.sources = null; // no filter → everything visible
                } else if (action === 'none') {
                    _filter.sources = new Set(); // empty set → nothing visible
                }
                _renderSourceChips();
                _renderAll();
                return;
            }
            const chip = e.target.closest('.log-src-chip');
            if (!chip) return;
            const src = chip.dataset.source;
            if (e.shiftKey) {
                // Solo mode — show only this source, hide all others.
                _filter.sources = new Set([src]);
            } else {
                // Plain click — toggle this source. Start from current
                // visible set (null → expand to "all known", then
                // remove this one).
                if (_filter.sources === null) {
                    _filter.sources = new Set(_knownSources);
                }
                if (_filter.sources.has(src)) {
                    _filter.sources.delete(src);
                } else {
                    _filter.sources.add(src);
                }
                // If the user just re-included every known source, fold
                // back to `null` so newly-discovered sources auto-show.
                if (_filter.sources.size === _knownSources.size) {
                    _filter.sources = null;
                }
            }
            _renderSourceChips();
            _renderAll();
        });
    }
    const levelWrap = $('logs-filter-level');
    if (levelWrap) {
        levelWrap.querySelectorAll('input[name="logs-level"]').forEach((rb) => {
            rb.addEventListener('change', () => {
                if (rb.checked) _filter.minLevel = rb.value;
                _renderAll();
            });
        });
    }
    const searchInput = $('logs-search');
    if (searchInput) {
        // Debounce — at 1 000 buffered lines a full re-render on every
        // keystroke turned a 12-character query into 12 sluggish renders
        // on mid-tier mobile.
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                _filter.search = String(searchInput.value || '');
                _renderAll();
            }, 150);
        });
    }
    const autoCb = $('logs-autoscroll');
    if (autoCb) {
        autoCb.addEventListener('change', () => {
            _autoscroll = autoCb.checked;
        });
    }
    const pauseBtn = $('logs-pause-btn');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            _paused = !_paused;
            pauseBtn.textContent = _paused
                ? i18nT('maintenance.logs.resume', 'Resume')
                : i18nT('maintenance.logs.pause', 'Pause');
            pauseBtn.dataset.paused = _paused ? '1' : '0';
            if (!_paused) _renderAll();
        });
    }
    const clearBtn = $('logs-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            _lines.length = 0;
            const pre = $('logs-stream');
            if (pre) pre.innerHTML = '';
            showToast(
                i18nT(
                    'maintenance.logs.cleared',
                    'Cleared (visual only — server buffer untouched).',
                ),
                'info',
            );
        });
    }
    const dlBtn = $('logs-download-btn');
    if (dlBtn) {
        dlBtn.addEventListener('click', () => {
            const filtered = _lines.filter(_matchesFilter);
            const text = filtered
                .map((e) => {
                    const ts = new Date(e.ts).toISOString();
                    return `[${ts}] [${e.source}] [${e.level}] ${e.msg}`;
                })
                .join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tgdl-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 0);
        });
    }
}

async function _loadBackfill() {
    try {
        const r = await api.get('/api/maintenance/logs/recent?limit=200');
        const logs = Array.isArray(r.logs) ? r.logs : [];
        _lines.length = 0;
        for (const e of logs) {
            _lines.push(e);
            // Seed the known-source set from the backfill batch so the
            // chip group renders the full source roster on first paint,
            // not just whichever sources happen to emit a line within
            // the first second of WS subscription.
            _recordSource(e.source);
        }
        _renderSourceChips();
        _renderAll();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed to load logs', 'error');
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('log', (m) => {
        // m has shape { type:'log', ts, source, level, msg } per server.js
        _appendOne({
            ts: m.ts || Date.now(),
            source: m.source || 'app',
            level: m.level || 'info',
            msg: m.msg || '',
        });
    });
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        _wireFilters();
    }
    // Refresh backfill every time the user opens the page so they're not
    // staring at a stale tail from a previous visit.
    _loadBackfill();
}
