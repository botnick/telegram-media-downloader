// Archive listing helper for the in-app viewer. Calls
// `GET /api/files/archive-list?path=<encoded>` and renders the response
// as a simple file tree (folder icons + names + byte sizes). Kept in
// its own module so the viewer dispatcher doesn't grow unbounded as we
// add format-specific renderers.

import { escapeHtml } from './utils.js';

/**
 * Fetch + render the archive listing into `targetEl`. Shows a loading
 * placeholder first, then either the tree or a graceful fallback if
 * the server can't enumerate the contents (no unzip/tar/7z on the
 * host, malformed archive, or the format itself is unsupported).
 *
 *   opts:
 *     targetEl:    container to fill (e.g. #archive-container content slot)
 *     statusEl:    optional element for loading / error text
 *     filePath:    relative path of the archive (passed to the endpoint)
 *     downloadUrl: fallback "Download file" target
 *     fileName:    display name
 */
export async function renderArchiveInto(opts) {
    const { targetEl, statusEl, filePath, downloadUrl, fileName } = opts;
    if (!targetEl) return;
    targetEl.innerHTML = '';
    if (statusEl) {
        statusEl.innerHTML = `
            <div class="flex items-center justify-center gap-2 py-6 text-tg-textSecondary text-sm">
                <i class="ri-loader-4-line animate-spin text-lg"></i>
                <span>Inspecting archive…</span>
            </div>
        `;
    }
    let data;
    try {
        const url = `/api/files/archive-list?path=${encodeURIComponent(filePath)}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (err) {
        if (statusEl) statusEl.innerHTML = '';
        targetEl.innerHTML = _fallbackHtml({
            fileName,
            downloadUrl,
            reason: 'list_failed',
            message: err?.message || 'Failed to load',
        });
        return;
    }
    if (statusEl) statusEl.innerHTML = '';

    if (!data?.supported || !Array.isArray(data.entries) || !data.entries.length) {
        targetEl.innerHTML = _fallbackHtml({
            fileName,
            downloadUrl,
            reason: data?.reason || 'no_entries',
            tool: data?.tool,
        });
        return;
    }

    // Sort: directories first, then by full path. The server caps the
    // list at 5000 entries; we render in DOM-friendly chunks (<= 1000)
    // to keep the modal responsive even on a worst-case archive.
    const rows = data.entries
        .slice()
        .sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return String(a.name).localeCompare(String(b.name));
        })
        .slice(0, 1000);

    const totalSize = rows.reduce((acc, r) => acc + (r.size || 0), 0);
    const truncated = data.entries.length > rows.length;
    const html = [];
    html.push(`
        <div class="px-4 py-3 border-b border-white/10 text-sm text-tg-textSecondary flex items-center gap-3 flex-wrap">
            <i class="ri-folder-zip-line text-lg text-tg-blue"></i>
            <span class="text-tg-text font-medium truncate">${escapeHtml(data.name || fileName || 'Archive')}</span>
            <span class="text-xs">${rows.length} entries · ${_formatBytes(totalSize)}</span>
            ${truncated ? '<span class="text-xs text-yellow-400">(truncated)</span>' : ''}
            ${
                downloadUrl
                    ? `<a href="${escapeHtml(downloadUrl)}" download
                        class="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 bg-tg-blue/15 hover:bg-tg-blue/25 text-tg-blue rounded-lg text-xs font-medium transition">
                        <i class="ri-download-line"></i> <span>Download</span>
                    </a>`
                    : ''
            }
        </div>
    `);
    html.push('<ul class="archive-tree text-sm font-mono">');
    for (const row of rows) {
        const icon = row.isDir ? 'ri-folder-line text-yellow-400' : _iconForName(row.name);
        const sizeCell = row.isDir ? '' : _formatBytes(row.size);
        html.push(`
            <li class="archive-row flex items-center gap-3 px-4 py-1.5 border-b border-white/5">
                <i class="${icon} text-base shrink-0"></i>
                <span class="flex-1 truncate text-tg-text/90">${escapeHtml(row.name)}</span>
                <span class="text-xs text-tg-textSecondary tabular-nums shrink-0">${sizeCell}</span>
            </li>
        `);
    }
    html.push('</ul>');
    targetEl.innerHTML = html.join('');
}

function _iconForName(name) {
    const ext = String(name || '')
        .split('.')
        .pop()
        ?.toLowerCase();
    if (!ext) return 'ri-file-line text-tg-textSecondary';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext))
        return 'ri-image-line text-blue-300';
    if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'ri-video-line text-purple-300';
    if (['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus', 'aac'].includes(ext))
        return 'ri-music-line text-green-300';
    if (['pdf'].includes(ext)) return 'ri-file-pdf-line text-red-300';
    if (['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz'].includes(ext))
        return 'ri-folder-zip-line text-yellow-300';
    if (['txt', 'md', 'log', 'csv'].includes(ext)) return 'ri-file-text-line text-tg-textSecondary';
    if (['js', 'ts', 'py', 'go', 'rs', 'c', 'cpp', 'java', 'rb', 'php'].includes(ext))
        return 'ri-code-line text-cyan-300';
    return 'ri-file-line text-tg-textSecondary';
}

function _formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function _fallbackHtml({ fileName, downloadUrl, reason, tool, message }) {
    const name = escapeHtml(fileName || 'Archive');
    const explain =
        reason === 'tool_missing'
            ? `Preview requires <code class="px-1 bg-white/10 rounded">${escapeHtml(tool || 'unzip / tar / 7z')}</code> on the host — not installed.`
            : reason === 'single_stream'
              ? 'Single-stream compression (no archive index). Download and extract to inspect.'
              : reason === 'unknown_format'
                ? "Archive format isn't supported for inline preview."
                : reason === 'no_entries'
                  ? 'Archive appears empty or unreadable.'
                  : message
                    ? escapeHtml(message)
                    : "Couldn't enumerate this archive.";
    return `
        <div class="text-center px-6 py-10">
            <i class="ri-folder-zip-line text-5xl text-yellow-400 mb-3 inline-block"></i>
            <p class="text-tg-text mb-1 font-medium">${name}</p>
            <p class="text-sm text-tg-textSecondary mb-4">${explain}</p>
            ${
                downloadUrl
                    ? `<a href="${escapeHtml(downloadUrl)}" download
                        class="inline-flex items-center gap-2 px-4 py-2 bg-tg-blue hover:bg-tg-darkBlue rounded-lg text-sm text-white font-medium transition">
                        <i class="ri-download-line"></i> <span>Download archive</span>
                    </a>`
                    : ''
            }
        </div>
    `;
}
