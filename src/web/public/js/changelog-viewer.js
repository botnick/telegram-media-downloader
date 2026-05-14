/**
 * In-app CHANGELOG viewer — overlay sheet that fetches `/CHANGELOG.md`,
 * parses it with a tiny inline Markdown subset (~50 lines), and renders
 * a versioned timeline. Triggered by clicking the version chip in the
 * status bar.
 *
 * Cross-platform: pure DOM, no third-party deps.
 */

import { openSheet } from './sheet.js';
import { t as i18nT } from './i18n.js';

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

    function inline(s) {
        return escapeHtml(s)
            .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
            .replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`)
            .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, e) => `<em>${e}</em>`)
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => {
                const safe = href.startsWith('http') ? href : '#';
                return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
            });
    }

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

async function _load() {
    if (_cache) return _cache;
    const res = await fetch('/CHANGELOG.md', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _cache = await res.text();
    return _cache;
}

export async function openChangelogViewer() {
    const wrap = document.createElement('div');
    wrap.className = 'changelog-body text-tg-text text-sm leading-relaxed';
    wrap.innerHTML = `<div class="text-tg-textSecondary">${i18nT('changelog.viewer.loading', 'Loading…')}</div>`;
    const handle = openSheet({
        title: i18nT('changelog.viewer.title', 'Release notes'),
        content: wrap,
        size: 'lg',
    });
    try {
        const md = await _load();
        wrap.innerHTML = mdToHtml(md);
    } catch (e) {
        wrap.innerHTML = `<div class="text-red-400">${escapeHtml(e?.message || 'Failed to load CHANGELOG.md')}</div>`;
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
