/**
 * Maintenance — Database stats (admin page).
 *
 * Fetches /api/db/stats and renders a dashboard of table sizes, group
 * breakdown, file type distribution, recent activity, and AI indexing.
 * Includes SVG bar charts and a donut chart. Auto-refreshes every 15 seconds.
 */

import { api } from './api.js';
import { escapeHtml } from './utils.js';

const $ = (id) => document.getElementById(id);
let _interval = null;

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmt(n) {
    return Number(n || 0).toLocaleString();
}

// ── SVG helpers ──────────────────────────────────────────────────────────────

/** Horizontal bar chart — each bar is a labelled row. */
function hbarChart(
    bars,
    {
        maxLabel = '',
        barColor = 'var(--tg-theme-accent, #2ea6ff)',
        height = 20,
        showValues = true,
    } = {},
) {
    const max = bars.reduce((m, b) => Math.max(m, b.value), 0) || 1;
    const pct = (v) => ((v / max) * 100).toFixed(1);
    let html = '<div class="space-y-1">';
    for (const b of bars) {
        if (b.value === 0) continue;
        const w = pct(b.value);
        const label = escapeHtml((b.label || '').slice(0, 22));
        html += `<div class="flex items-center gap-1.5 text-xs">
            <span class="text-tg-textSecondary truncate flex-shrink-0 max-w-[100px] sm:max-w-none" style="${maxLabel ? 'width:' + maxLabel : 'width:100px'}">${label}</span>
            <div class="flex-1 bg-tg-bg rounded-full overflow-hidden min-w-0" style="height:${height}px">
                <div class="h-full rounded-full transition-all duration-500" style="width:${w}%;background:${barColor}"></div>
            </div>
            ${showValues ? `<span class="text-tg-text tabular-nums flex-shrink-0 w-10 sm:w-[60px] text-right">${fmt(b.value)}</span>` : ''}
        </div>`;
    }
    html += '</div>';
    return html;
}

/**
 * Simple SVG donut chart.
 * segments: [{ label, value, color }]
 * Returns an SVG string with a centred total.
 */
function donutChart(segments, total, { size = 120, stroke = 18 } = {}) {
    const r = (size - stroke) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const sorted = segments.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    const slices = sorted.map((s) => {
        const pct = s.value / total;
        const len = pct * circ;
        const o = offset;
        offset += len;
        return { ...s, pct, len, offset: o };
    });

    let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" class="max-w-full h-auto">
        <style>
            .donut-segment{transition:stroke-dashoffset 0.6s ease}
            .donut-hole{fill:transparent}
        </style>`;
    // Background ring
    svg += `<circle class="donut-hole" cx="${cx}" cy="${cy}" r="${r}" stroke="var(--tg-theme-bg-color,#17212b)" stroke-width="${stroke}"/>`;
    // Slices
    for (const s of slices) {
        const dash = s.len;
        const gap = circ - dash;
        svg += `<circle class="donut-segment" cx="${cx}" cy="${cy}" r="${r}"
            fill="transparent" stroke="${s.color}" stroke-width="${stroke}"
            stroke-dasharray="${dash} ${gap}"
            stroke-dashoffset="${-s.offset}"
            transform="rotate(-90 ${cx} ${cy})"/>`;
    }
    // Centre text
    svg += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" dominant-baseline="central"
        fill="var(--tg-theme-text-color,#fff)" font-size="20" font-weight="700">${Math.round((sorted.reduce((s, v) => s + v.value, 0) / total) * 100)}%</text>
        <text x="${cx}" y="${cy + 12}" text-anchor="middle" dominant-baseline="central"
        fill="var(--tg-theme-text-secondary,#7f8c8d)" font-size="8">of ${fmt(total)}</text>`;
    svg += '</svg>';

    // Legend
    let legend = '<div class="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs">';
    const COLORS = ['#2ea6ff', '#a8d8ff', '#c084fc', '#fbbf24', '#f87171', '#34d399'];
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        const c = s.color || COLORS[i % COLORS.length];
        legend += `<span class="flex items-center gap-1 text-tg-textSecondary">
            <span class="inline-block rounded-full" style="width:8px;height:8px;background:${c}"></span>
            ${escapeHtml(s.label)} <strong class="text-tg-text">${fmt(s.value)}</strong>
        </span>`;
    }
    legend += '</div>';
    return `<div class="flex flex-col items-center">${svg}${legend}</div>`;
}

/** Simple vertical bar chart (SVG). */
function vbarChart(
    bars,
    { height = 120, barColor = 'var(--tg-theme-accent, #2ea6ff)', barWidth = 24 } = {},
) {
    const max = bars.reduce((m, b) => Math.max(m, b.value), 0) || 1;
    const pad = { top: 6, bottom: 20, left: 4, right: 4 };
    const count = bars.length;
    const totalW = count * (barWidth + 4) + pad.left + pad.right;
    const h = height;
    const scale = (v) => (v / max) * (h - pad.top - pad.bottom);

    let svg = `<svg width="${totalW}" height="${h}" viewBox="0 0 ${totalW} ${h}" xmlns="http://www.w3.org/2000/svg">
        <style>.vbar{transition:height 0.5s ease}</style>`;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (b.value === 0) continue;
        const barH = scale(b.value);
        const x = pad.left + i * (barWidth + 4);
        const y = h - pad.bottom - barH;
        svg += `<rect class="vbar" x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="2" fill="${barColor}" opacity="0.85"/>
            <text x="${x + barWidth / 2}" y="${h - 4}" text-anchor="middle" fill="var(--tg-theme-text-secondary,#7f8c8d)" font-size="7">${escapeHtml((b.label || '').slice(0, 6))}</text>`;
        // Value on top
        if (barH > 14) {
            svg += `<text x="${x + barWidth / 2}" y="${y - 2}" text-anchor="middle" fill="var(--tg-theme-text-color,#fff)" font-size="7" font-weight="600">${fmt(b.value)}</text>`;
        }
    }
    svg += '</svg>';
    return svg;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderTable(headers, rows) {
    let html =
        '<div class="overflow-x-auto -mx-3 px-3"><table class="w-full text-xs whitespace-nowrap sm:whitespace-normal"><thead><tr class="text-tg-textSecondary">';
    for (const h of headers) {
        html += `<th class="text-left py-1.5 px-2 font-medium${h.right ? ' text-right' : ''}">${escapeHtml(h.label)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const row of rows) {
        html += '<tr class="border-t border-tg-border">';
        for (let i = 0; i < row.length; i++) {
            const cls = headers[i]?.right ? ' text-right' : '';
            html += `<td class="py-1 px-2 text-tg-text${cls}">${row[i]}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
}

function renderCard(title, content) {
    return `<div class="bg-tg-panel rounded-xl p-3 mb-3">
        <h3 class="text-tg-text text-sm font-semibold mb-2">${escapeHtml(title)}</h3>
        ${content}
    </div>`;
}

function ago(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso + 'Z').getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ${min % 60}m ago`;
    return `${Math.floor(h / 24)}d ago`;
}

const COLORS = [
    '#2ea6ff',
    '#a8d8ff',
    '#c084fc',
    '#fbbf24',
    '#f87171',
    '#34d399',
    '#fb923c',
    '#a78bfa',
];

// ── Main load ────────────────────────────────────────────────────────────────

async function load() {
    // Don't fetch if the page isn't visible (teardown guard)
    const pageEl = document.getElementById('page-maintenance-db-stats');
    if (!pageEl || pageEl.classList.contains('hidden')) return;
    try {
        const res = await api.get('/api/db/stats');
        if (!res?.success) throw new Error('API error');
        const { tableCounts, groups, totals, recent, ai } = res;
        let html = '';

        // ── Summary cards ──
        html += '<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">';
        const summaryItems = [
            { label: 'Downloads', value: fmt(totals?.total || 0), color: 'text-tg-accent' },
            { label: 'Faces', value: fmt(ai?.faces || 0), color: 'text-tg-accent' },
            { label: 'People', value: fmt(ai?.people || 0), color: 'text-tg-accent' },
            { label: 'Tags', value: fmt(ai?.tags || 0), color: 'text-tg-accent' },
            { label: 'Total size', value: formatBytes(totals?.bytes || 0), color: '' },
            {
                label: 'Indexed',
                value: `${fmt(ai?.indexed || 0)} / ${fmt(ai?.total || 0)} (${ai?.pct || 0}%)`,
                color: '',
            },
            { label: 'Photos', value: fmt(totals?.photos || 0), color: '' },
            { label: 'Videos', value: fmt(totals?.videos || 0), color: '' },
        ];
        for (const item of summaryItems) {
            html += `<div class="bg-tg-panel rounded-xl p-2 sm:p-3 text-center truncate">
                <div class="text-sm sm:text-lg font-bold ${item.color} truncate">${item.value}</div>
                <div class="text-[9px] sm:text-[10px] text-tg-textSecondary mt-0.5 truncate">${escapeHtml(item.label)}</div>
            </div>`;
        }
        html += '</div>';

        // ── Table sizes ──
        if (tableCounts) {
            const rows = Object.entries(tableCounts).map(([name, count]) => [name, fmt(count)]);
            html += renderCard(
                'Table sizes',
                renderTable([{ label: 'Table' }, { label: 'Rows', right: true }], rows),
            );
        }

        // ── Groups chart + table ──
        if (groups?.length) {
            // Horizontal bar chart for top groups
            const topGroups = groups.slice(0, 15);
            const bars = topGroups.map((g, i) => ({
                label: (g.group_name || '?').slice(0, 28),
                value: g.n,
                color: COLORS[i % COLORS.length],
            }));
            const maxLabel = Math.min(
                Math.max(...topGroups.map((g) => (g.group_name || '?').length)) * 6.5 + 8,
                160,
            );
            html += renderCard(
                'Files per group (top 15)',
                hbarChart(bars, { maxLabel: `${Math.min(maxLabel, 200)}px`, height: 18 }),
            );

            // Table
            const rows = groups.map((g) => [
                escapeHtml((g.group_name || '?').slice(0, 28)),
                fmt(g.n),
                fmt(g.photos),
                fmt(g.videos),
                formatBytes(g.bytes),
                `<span title="${g.last_activity || ''}">${ago(g.last_activity)}</span>`,
            ]);
            html += renderCard(
                'Groups by activity',
                renderTable(
                    [
                        { label: 'Group' },
                        { label: 'Files', right: true },
                        { label: 'Photos', right: true },
                        { label: 'Videos', right: true },
                        { label: 'Size', right: true },
                        { label: 'Last activity' },
                    ],
                    rows,
                ),
            );
        }

        // ── File type donut chart + table ──
        if (totals) {
            const totalFiles = Number(totals.total) || 1;
            const segs = [
                { label: 'Photos', value: Number(totals.photos || 0), color: '#2ea6ff' },
                { label: 'Videos', value: Number(totals.videos || 0), color: '#c084fc' },
                { label: 'Audio', value: Number(totals.audio || 0), color: '#34d399' },
                { label: 'Documents', value: Number(totals.documents || 0), color: '#fbbf24' },
                { label: 'Voice', value: Number(totals.voice || 0), color: '#f87171' },
            ];
            html += renderCard(
                'File type distribution',
                `<div class="flex flex-col sm:flex-row items-center gap-4">
                    <div class="flex-shrink-0">${donutChart(segs, totalFiles)}</div>
                    <div class="flex-1 w-full">${renderTable(
                        [
                            { label: 'Type' },
                            { label: 'Count', right: true },
                            { label: '%', right: true },
                        ],
                        segs.map((s) => [
                            s.label,
                            fmt(s.value),
                            `${Math.round((s.value / totalFiles) * 100)}%`,
                        ]),
                    )}</div>
                </div>`,
            );
        }

        // ── Recent activity chart ──
        if (recent?.length) {
            const topRecent = recent.slice(0, 10);
            const rb = topRecent.map((r) => ({
                label: (r.group_name || '?').slice(0, 10),
                value: r.n,
            }));
            html += renderCard(
                'Recent activity (last 30 min)',
                `<div class="overflow-x-auto">${vbarChart(rb, { height: 120, barWidth: 28 })}</div>` +
                    renderTable(
                        [
                            { label: 'Group' },
                            { label: 'Files', right: true },
                            { label: 'Size', right: true },
                        ],
                        recent.map((r) => [
                            escapeHtml((r.group_name || '?').slice(0, 28)),
                            fmt(r.n),
                            formatBytes(r.bytes),
                        ]),
                    ),
            );
        } else {
            html += renderCard(
                'Recent activity (last 30 min)',
                '<p class="text-xs text-tg-textSecondary">No activity in the last 30 minutes.</p>',
            );
        }

        // ── AI Indexing chart + table ──
        if (ai) {
            const indexed = Number(ai.indexed) || 0;
            const totalAi = Number(ai.total) || 1;
            const notIndexed = Math.max(0, totalAi - indexed);
            html += renderCard(
                'AI Indexing',
                `<div class="flex flex-col sm:flex-row items-center gap-4 mb-4">
                    <div class="flex-shrink-0">${donutChart(
                        [
                            { label: 'Indexed', value: indexed, color: '#34d399' },
                            { label: 'Not indexed', value: notIndexed, color: '#4b5563' },
                        ],
                        totalAi,
                        { size: 100, stroke: 14 },
                    )}</div>
                    <div class="flex-1 w-full">${renderTable(
                        [{ label: 'Metric' }, { label: 'Value', right: true }],
                        [
                            ['Indexed', `${fmt(indexed)} / ${fmt(totalAi)} (${ai.pct}%)`],
                            ['Faces detected', fmt(ai.faces)],
                            ['People clusters', fmt(ai.people)],
                            ['Image tags', fmt(ai.tags)],
                        ],
                    )}</div>
                </div>`,
            );
        }

        const root = $('db-stats-root');
        if (root) root.innerHTML = html;
    } catch (e) {
        const root = $('db-stats-root');
        if (root)
            root.innerHTML = `<div class="text-center py-8 text-xs text-tg-textSecondary">Failed to load: ${escapeHtml(e.message || e)}</div>`;
    }
}

export function showDbStatsPage() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
    load();
    _interval = setInterval(load, 15000);
}

export function stopDbStatsPage() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}
