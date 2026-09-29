/**
 * In-app release notes — overlay sheet that fetches `/CHANGELOG.md`,
 * splits it into one card per released version (newest open, older ones
 * collapsed and rendered on first open), tags each section by kind
 * (security / fixed / performance / …) and offers a search filter.
 * Triggered by clicking the version chip in the status bar.
 *
 * Cross-platform: pure DOM, no third-party deps.
 */

import { openSheet } from './sheet.js';
import { t as i18nT } from './i18n.js';

const RELEASES_URL = 'https://github.com/botnick/telegram-media-downloader/releases';

let _cache = null;

function escapeHtml(s) {
    return String(s).replace(
        /[&<>"']/g,
        (c) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;',
            })[c],
    );
}

/** Inline Markdown: `code`, **bold**, *emphasis*, [text](url). */
function mdInline(s) {
    return escapeHtml(s)
        .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`)
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, e) => `<em>${e}</em>`)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
            const safe = href.startsWith('http') ? href : '#';
            return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        });
}

/**
 * Subset Markdown → HTML. Only the constructs that show up in our
 * CHANGELOG: headings (#, ##, ###), bullet lists (- ...), inline
 * code (`...`), bold (**...**), emphasis (*...*), links ([text](url)).
 * Anything else flows through as escaped text.
 */
function mdToHtml(md) {
    const lines = String(md || '').split(/\r?\n/);
    const out = [];
    const listStack = []; // depth tracking for nested lists
    let inTable = false;
    let inCode = false;
    const inline = mdInline;

    function closeLists(toDepth = 0) {
        while (listStack.length > toDepth) {
            listStack.pop();
            out.push('</ul>');
        }
    }

    function closeTable() {
        if (inTable) {
            out.push('</tbody></table></div>');
            inTable = false;
        }
    }

    for (let li = 0; li < lines.length; li++) {
        const raw = lines[li];
        const line = raw.trimEnd();
        let m;

        // Fenced code blocks
        if (line.match(/^```/)) {
            closeLists();
            closeTable();
            if (inCode) {
                out.push('</code></pre>');
                inCode = false;
            } else {
                inCode = true;
                out.push('<pre class="cl-code"><code>');
            }
            continue;
        }
        if (inCode) {
            out.push(escapeHtml(raw));
            continue;
        }

        // Headings
        if ((m = line.match(/^### (.+)$/))) {
            closeLists();
            closeTable();
            out.push(`<h4>${inline(m[1])}</h4>`);
            continue;
        }
        if ((m = line.match(/^## (.+)$/))) {
            closeLists();
            closeTable();
            out.push(`<h3 class="cl-version">${inline(m[1])}</h3>`);
            continue;
        }
        if ((m = line.match(/^# (.+)$/))) {
            closeLists();
            closeTable();
            out.push(`<h2>${inline(m[1])}</h2>`);
            continue;
        }

        // Horizontal rule
        if (line.match(/^---+$/)) {
            closeLists();
            closeTable();
            out.push('<hr>');
            continue;
        }

        // Table rows (| col | col |)
        if (line.match(/^\|.*\|$/)) {
            closeLists();
            if (line.match(/^\|[\s:|-]+\|$/)) continue; // separator row
            if (!inTable) {
                inTable = true;
                out.push('<div class="cl-table-wrap"><table class="cl-table"><tbody>');
            }
            const cells = line
                .split('|')
                .slice(1, -1)
                .map((c) => c.trim());
            const tag = !inTable || out[out.length - 1].includes('<tbody>') ? 'th' : 'td';
            out.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
            continue;
        }
        if (inTable) closeTable();

        // List items (top-level and nested via indentation)
        if ((m = line.match(/^(\s*)([-*])\s(.+)$/))) {
            const indent = m[1].length;
            const depth = Math.floor(indent / 2) + 1;
            while (listStack.length < depth) {
                listStack.push(depth);
                out.push('<ul>');
            }
            if (listStack.length > depth) closeLists(depth);
            out.push(`<li>${inline(m[3])}</li>`);
            continue;
        }
        if (listStack.length && line.trim() === '') {
            closeLists();
            out.push('');
            continue;
        }

        // Empty line
        if (line.trim() === '') {
            closeLists();
            out.push('');
            continue;
        }

        // Paragraph
        closeLists();
        out.push(`<p>${inline(line)}</p>`);
    }
    closeLists();
    closeTable();
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
}

// ---- Release-notes model ----------------------------------------------------
//
// CHANGELOG.md → [{ version, date, intro, sections: [{ title, lines }] }].
// The preamble and `[Unreleased]` are dropped (users only care about
// shipped versions), as are maintainer-only sections such as the
// service-worker cache version.

const HIDDEN_SECTIONS = /^service worker$/i;

function parseChangelog(md) {
    const versions = [];
    let cur = null;
    let sec = null;
    for (const raw of String(md || '').split(/\r?\n/)) {
        const line = raw.trimEnd();
        let m;
        if ((m = line.match(/^## \[([^\]]+)\]\s*(?:[—–-]\s*(.+))?$/))) {
            cur = { version: m[1].trim(), date: (m[2] || '').trim(), intro: [], sections: [] };
            versions.push(cur);
            sec = null;
            continue;
        }
        if (!cur) continue; // preamble
        if ((m = line.match(/^### (.+)$/))) {
            sec = { title: m[1].trim(), lines: [] };
            cur.sections.push(sec);
            continue;
        }
        (sec ? sec.lines : cur.intro).push(raw);
    }
    return versions
        .filter((v) => !/^unreleased$/i.test(v.version))
        .map((v) => ({
            ...v,
            sections: v.sections.filter(
                (s) => !HIDDEN_SECTIONS.test(s.title) && s.lines.some((l) => l.trim()),
            ),
        }));
}

// Section title → visual kind. First match wins, so "Fixed — duplicates"
// lands on `fixed` and "Security" beats the generic keywords.
const KINDS = [
    { re: /secur/i, kind: 'security', icon: 'ri-shield-keyhole-line' },
    { re: /fix|bug/i, kind: 'fixed', icon: 'ri-bug-line' },
    { re: /perf|speed|fast/i, kind: 'perf', icon: 'ri-flashlight-line' },
    { re: /memory|\bram\b/i, kind: 'memory', icon: 'ri-cpu-line' },
    { re: /add|new|feature/i, kind: 'added', icon: 'ri-sparkling-2-line' },
    { re: /remov|deprecat/i, kind: 'removed', icon: 'ri-delete-bin-6-line' },
    { re: /config|setting|env/i, kind: 'config', icon: 'ri-settings-3-line' },
    { re: /database|schema|migrat/i, kind: 'database', icon: 'ri-database-2-line' },
];

function kindOf(title) {
    return KINDS.find((k) => k.re.test(title)) || { kind: 'changed', icon: 'ri-refresh-line' };
}

// "Fixed — duplicates / deleting files" → ["Fixed", "duplicates / deleting files"]
function splitTitle(title) {
    const m = title.match(/^(.+?)\s+[—–]\s+(.+)$/);
    return m ? [m[1], m[2]] : [title, ''];
}

function formatDate(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (!iso || Number.isNaN(d.getTime())) return escapeHtml(iso || '');
    const lang = document.documentElement.lang || navigator.language || 'en';
    return escapeHtml(
        d.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' }),
    );
}

function installedVersion() {
    const text = document.getElementById('status-version')?.textContent || '';
    const m = text.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
}

function renderSections(v) {
    return v.sections
        .map((s) => {
            const { kind, icon } = kindOf(s.title);
            const [label, sub] = splitTitle(s.title);
            return `
                <section class="rn-section">
                    <div class="rn-section-head">
                        <span class="rn-kind rn-kind--${kind}"><i class="${icon}" aria-hidden="true"></i>${escapeHtml(label)}</span>
                        ${sub ? `<span class="rn-sub">${escapeHtml(sub)}</span>` : ''}
                    </div>
                    <div class="changelog-body">${mdToHtml(s.lines.join('\n'))}</div>
                </section>`;
        })
        .join('');
}

function renderCard(v, { open, installed }) {
    // Per-kind label + number of top-level entries, shown while collapsed.
    const kinds = new Map();
    for (const s of v.sections) {
        const k = kindOf(s.title);
        const n = s.lines.filter((l) => /^[-*]\s/.test(l)).length;
        const prev = kinds.get(k.kind);
        kinds.set(k.kind, {
            ...k,
            label: prev?.label || splitTitle(s.title)[0],
            n: (prev?.n || 0) + n,
        });
    }
    const intro = v.intro.join(' ').trim();
    const badge = installed
        ? `<span class="rn-badge">${escapeHtml(i18nT('changelog.viewer.installed', 'Installed'))}</span>`
        : '';
    return `
        <details class="rn-card" data-version="${escapeHtml(v.version)}"${open ? ' open' : ''}>
            <summary>
                <div class="rn-head">
                    <div class="rn-title-row">
                        <span class="rn-ver">v${escapeHtml(v.version)}</span>
                        ${badge}
                        <span class="rn-date">${formatDate(v.date)}</span>
                    </div>
                    ${intro ? `<p class="rn-intro">${mdInline(intro)}</p>` : ''}
                    <div class="rn-kinds">${[...kinds.values()]
                        .map(
                            (k) =>
                                `<span class="rn-chip rn-kind--${k.kind}"><i class="${k.icon}" aria-hidden="true"></i>${escapeHtml(k.label)}${k.n ? ` <b>${k.n}</b>` : ''}</span>`,
                        )
                        .join('')}</div>
                </div>
                <i class="ri-arrow-down-s-line rn-chevron" aria-hidden="true"></i>
            </summary>
            <div class="rn-body"></div>
        </details>`;
}

async function _load() {
    if (_cache) return _cache;
    // no-cache: revalidate (ETag → 304) so a copy the browser kept from
    // before an update never hides the newer releases.
    const res = await fetch('/CHANGELOG.md', { credentials: 'same-origin', cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _cache = await res.text();
    return _cache;
}

export async function openChangelogViewer() {
    const wrap = document.createElement('div');
    wrap.className = 'rn-root text-tg-text text-sm';
    wrap.innerHTML = `<div class="text-tg-textSecondary">${i18nT('changelog.viewer.loading', 'Loading…')}</div>`;
    const handle = openSheet({
        title: i18nT('changelog.viewer.title', 'Release notes'),
        content: wrap,
        size: 'lg',
    });
    try {
        const versions = parseChangelog(await _load());
        const current = installedVersion();
        const byVersion = new Map(versions.map((v) => [v.version, v]));
        const searchLabel = i18nT('changelog.viewer.search', 'Search release notes');
        wrap.innerHTML = `
            <label class="rn-search">
                <i class="ri-search-line" aria-hidden="true"></i>
                <input type="search" placeholder="${escapeHtml(searchLabel)}" aria-label="${escapeHtml(searchLabel)}" autocomplete="off" spellcheck="false">
            </label>
            <div class="rn-list">${versions
                .map((v, i) => renderCard(v, { open: i === 0, installed: v.version === current }))
                .join('')}</div>
            <p class="rn-empty hidden">${escapeHtml(i18nT('changelog.viewer.no_matches', 'No release notes match your search.'))}</p>
            <a class="rn-all" href="${RELEASES_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(i18nT('changelog.viewer.all_releases', 'All releases on GitHub'))}<i class="ri-external-link-line" aria-hidden="true"></i></a>`;

        // Card bodies render on first open — the full history is long.
        const fill = (card) => {
            const body = card.querySelector('.rn-body');
            if (body.childElementCount) return;
            body.innerHTML = renderSections(byVersion.get(card.dataset.version));
        };
        const cards = [...wrap.querySelectorAll('.rn-card')];
        for (const card of cards) {
            if (card.open) fill(card);
            card.addEventListener('toggle', () => {
                if (card.open) fill(card);
            });
        }

        const haystack = new Map(
            versions.map((v) => [
                v.version,
                [v.version, v.date, ...v.intro, ...v.sections.flatMap((s) => [s.title, ...s.lines])]
                    .join('\n')
                    .toLowerCase(),
            ]),
        );
        const input = wrap.querySelector('.rn-search input');
        const empty = wrap.querySelector('.rn-empty');
        let timer = 0;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const q = input.value.trim().toLowerCase();
                let shown = 0;
                cards.forEach((card, i) => {
                    const hit = !q || haystack.get(card.dataset.version).includes(q);
                    card.hidden = !hit;
                    if (hit) shown++;
                    card.open = q ? hit : i === 0;
                });
                empty.classList.toggle('hidden', shown > 0);
            }, 120);
        });
    } catch (e) {
        wrap.innerHTML = `<div class="text-red-400">${escapeHtml(e?.message || i18nT('changelog.viewer.unavailable', 'Could not load CHANGELOG.md'))}</div>`;
    }
    return handle;
}

export function wireChangelogTrigger() {
    const versionEl = document.getElementById('status-version');
    if (!versionEl) return;
    // Replace the link's default github navigation with the in-app sheet
    // so users discover the release notes without leaving the dashboard.
    // The link's existing href stays as a fallback (right-click → open
    // in new tab still works).
    versionEl.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        openChangelogViewer().catch(() => {});
    });
}
