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

const SOURCES = ['app', 'nsfw', 'thumbs', 'dedup', 'integrity', 'gramjs', 'downloader', 'monitor'];
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };
const MAX_LINES = 1000;

let _wsWired = false;
let _pageWired = false;
let _paused = false;
let _autoscroll = true;
const _filter = {
    sources: new Set(SOURCES),
    minLevel: 'info',
    search: '',
};
const _lines = []; // ring buffer of {ts,source,level,msg}

function _formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function _matchesFilter(entry) {
    if (!_filter.sources.has(entry.source)) return false;
    const rank = LEVEL_RANK[entry.level] ?? 0;
    if (rank < (LEVEL_RANK[_filter.minLevel] ?? 0)) return false;
    if (_filter.search) {
        const needle = _filter.search.toLowerCase();
        if (!String(entry.msg || '').toLowerCase().includes(needle)) return false;
    }
    return true;
}

// Per-source colour palette — every source gets a stable hue so the eye
// can scan a chatty terminal and pick out the line it cares about. Same
// pattern as how `tail -f` colour wrappers (lnav, multitail, etc.) work.
const SOURCE_HUE = {
    app:        'text-emerald-400',
    nsfw:       'text-pink-400',
    thumbs:     'text-cyan-400',
    dedup:      'text-amber-400',
    integrity:  'text-violet-400',
    gramjs:     'text-sky-400',
    downloader: 'text-lime-400',
    monitor:    'text-fuchsia-400',
    backup:     'text-teal-400',
    ai:         'text-indigo-400',
    settings:   'text-orange-400',
    backfill:   'text-yellow-400',
};

function _renderLine(entry) {
    // Terminal-style row: timestamp dimmed (so it doesn't fight the message),
    // source pill in its own hue, level glyph (info=•, warn=▲, error=✖)
    // colour-coded, message in default body colour. Selectable text;
    // copy-paste pulls the raw line.
    const tsCls = 'text-tg-textSecondary/70';
    const srcCls = SOURCE_HUE[entry.source] || 'text-tg-textSecondary';
    const levelGlyph = entry.level === 'error' ? '✖'
        : entry.level === 'warn' ? '▲'
        : '•';
    const levelCls = entry.level === 'error' ? 'text-red-400'
        : entry.level === 'warn' ? 'text-yellow-400'
        : 'text-emerald-400/80';
    const msgCls = entry.level === 'error' ? 'text-red-300'
        : entry.level === 'warn' ? 'text-yellow-200'
        : 'text-tg-text';
    return `<div class="logline" data-level="${escapeHtml(entry.level)}" data-source="${escapeHtml(entry.source)}">`
        + `<span class="${tsCls}">${_formatTime(entry.ts)}</span> `
        + `<span class="${levelCls}">${levelGlyph}</span> `
        + `<span class="${srcCls}">${escapeHtml(entry.source.padEnd(10))}</span> `
        + `<span class="${msgCls}">${escapeHtml(entry.msg)}</span>`
        + `</div>`;
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

// Render the chip group's HTML once, then keep the per-chip count badge
// in sync via a separate update pass — avoids re-rendering the whole row
// on every log line. Bound on first wire; later log events just call
// `_updateSourceCounts` to bump the badges.
function _renderSourceChips() {
    const wrap = $('logs-filter-sources');
    if (!wrap) return;
    // Two quick-action chips on the left ("All" / "None") + one chip per
    // known source. Each chip carries its own bg-on-pressed style + a
    // count badge that tracks how many buffered lines currently match.
    const sourceChips = SOURCES.map((s) => {
        const dotCls = SOURCE_HUE[s] || 'text-tg-textSecondary';
        const pressed = _filter.sources.has(s);
        return `
            <button type="button" class="log-src-chip" data-source="${escapeHtml(s)}"
                    aria-pressed="${pressed ? 'true' : 'false'}">
                <span class="log-src-chip__dot ${dotCls}">●</span>
                <span class="log-src-chip__label">${escapeHtml(s)}</span>
                <span class="log-src-chip__count" data-source-count="${escapeHtml(s)}">0</span>
            </button>`;
    }).join('');
    wrap.innerHTML = `
        <div class="log-src-quick">
            <button type="button" class="log-src-quick__btn" data-action="all"
                data-i18n="maintenance.logs.filter.all">All</button>
            <button type="button" class="log-src-quick__btn" data-action="none"
                data-i18n="maintenance.logs.filter.none">None</button>
        </div>
        ${sourceChips}
    `;
}

function _updateSourceCounts() {
    const wrap = $('logs-filter-sources');
    if (!wrap) return;
    const counts = Object.create(null);
    for (const s of SOURCES) counts[s] = 0;
    for (const e of _lines) {
        if (counts[e.source] != null) counts[e.source] += 1;
    }
    for (const s of SOURCES) {
        const badge = wrap.querySelector(`[data-source-count="${s}"]`);
        if (badge) badge.textContent = counts[s] > 999 ? '999+' : String(counts[s]);
    }
}

function _wireFilters() {
    const sourceWrap = $('logs-filter-sources');
    if (sourceWrap) {
        _renderSourceChips();
        _updateSourceCounts();
        // Single delegated listener — chip clicks toggle the source and
        // quick-action clicks flip the whole set.
        sourceWrap.addEventListener('click', (e) => {
            const quick = e.target.closest('.log-src-quick__btn');
            if (quick) {
                const action = quick.dataset.action;
                if (action === 'all') {
                    SOURCES.forEach(s => _filter.sources.add(s));
                } else if (action === 'none') {
                    _filter.sources.clear();
                }
                sourceWrap.querySelectorAll('.log-src-chip').forEach(btn => {
                    btn.setAttribute('aria-pressed', _filter.sources.has(btn.dataset.source) ? 'true' : 'false');
                });
                _renderAll();
                return;
            }
            const chip = e.target.closest('.log-src-chip');
            if (!chip) return;
            const src = chip.dataset.source;
            if (_filter.sources.has(src)) _filter.sources.delete(src);
            else _filter.sources.add(src);
            chip.setAttribute('aria-pressed', _filter.sources.has(src) ? 'true' : 'false');
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
        autoCb.addEventListener('change', () => { _autoscroll = autoCb.checked; });
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
            showToast(i18nT('maintenance.logs.cleared', 'Cleared (visual only — server buffer untouched).'), 'info');
        });
    }
    const dlBtn = $('logs-download-btn');
    if (dlBtn) {
        dlBtn.addEventListener('click', () => {
            const filtered = _lines.filter(_matchesFilter);
            const text = filtered.map((e) => {
                const ts = new Date(e.ts).toISOString();
                return `[${ts}] [${e.source}] [${e.level}] ${e.msg}`;
            }).join('\n');
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
        for (const e of logs) _lines.push(e);
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
