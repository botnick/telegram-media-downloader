// Viewer preview helpers for text, code, and markdown files. Pulled out
// of viewer.js so the dispatcher stays compact and these dependencies
// (highlight.js, marked, DOMPurify) only load on demand.
//
// All three renderers cap the fetched payload at a few MB — anything
// bigger paints a "too large" placeholder + download link so the modal
// never freezes the tab on a 100 MB log.
//
// CDN libs (highlight.js / marked / DOMPurify) are fetched the first
// time the operator opens a matching file type, then cached by the
// browser. Promises are memoised at module scope so repeat opens don't
// re-fetch.

import { escapeHtml } from './utils.js';

const HLJS_CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0';
const MARKED_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js';
const DOMPURIFY_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.9/purify.min.js';

const CODE_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_MAX_BYTES = 5 * 1024 * 1024;
const MARKDOWN_MAX_BYTES = 5 * 1024 * 1024;

// Map common extensions to highlight.js language identifiers. Anything
// not in this map falls back to auto-detection (more CPU but covers the
// long tail).
const EXT_TO_LANG = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    jsonc: 'json',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    ps1: 'powershell',
    bat: 'dos',
    cmd: 'dos',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    php: 'php',
    lua: 'lua',
    pl: 'perl',
    dart: 'dart',
    vue: 'xml',
    svelte: 'xml',
    astro: 'xml',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    cmake: 'cmake',
    vim: 'vim',
    toml: 'ini',
    yaml: 'yaml',
    yml: 'yaml',
    ini: 'ini',
    conf: 'ini',
    env: 'ini',
};

/** Map a file extension to a highlight.js language id (or null for auto). */
export function langFromExt(ext) {
    return EXT_TO_LANG[(ext || '').toLowerCase()] || null;
}

// Memoised CDN-load promises. Each .then(() => window.X) so callers can
// `await ensureHljs()` and immediately use window.hljs / window.marked.
let _hljsReady = null;
let _markedReady = null;
let _domPurifyReady = null;

function _loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

function _loadStylesheet(href) {
    return new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`Failed to load ${href}`));
        document.head.appendChild(link);
    });
}

export function ensureHljs() {
    if (window.hljs) return Promise.resolve(window.hljs);
    if (_hljsReady) return _hljsReady;
    _hljsReady = Promise.all([
        _loadStylesheet(`${HLJS_CDN_BASE}/styles/github-dark.min.css`),
        _loadScript(`${HLJS_CDN_BASE}/highlight.min.js`),
    ])
        .then(() => window.hljs)
        .catch((err) => {
            // Allow a retry on the next call instead of caching the failure.
            _hljsReady = null;
            throw err;
        });
    return _hljsReady;
}

export function ensureMarked() {
    if (window.marked) return Promise.resolve(window.marked);
    if (_markedReady) return _markedReady;
    _markedReady = _loadScript(MARKED_CDN)
        .then(() => window.marked)
        .catch((err) => {
            _markedReady = null;
            throw err;
        });
    return _markedReady;
}

export function ensureDomPurify() {
    if (window.DOMPurify) return Promise.resolve(window.DOMPurify);
    if (_domPurifyReady) return _domPurifyReady;
    _domPurifyReady = _loadScript(DOMPURIFY_CDN)
        .then(() => window.DOMPurify)
        .catch((err) => {
            _domPurifyReady = null;
            throw err;
        });
    return _domPurifyReady;
}

/**
 * Fetch a URL with a hard byte cap. Aborts the response stream as soon
 * as the body exceeds `maxBytes` so a multi-GB log can't blow the heap.
 * Returns `{ text, truncated, size }` on success, or throws on network
 * failure.
 */
export async function fetchTextCapped(url, maxBytes) {
    const ctrl = new AbortController();
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cl = Number(res.headers.get('content-length'));
    if (Number.isFinite(cl) && cl > maxBytes) {
        ctrl.abort();
        return { text: '', truncated: true, size: cl };
    }
    const reader = res.body?.getReader();
    if (!reader) {
        const text = await res.text();
        return { text, truncated: false, size: text.length };
    }
    const chunks = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            ctrl.abort();
            return { text: '', truncated: true, size: total };
        }
        chunks.push(value);
    }
    // Concatenate + decode at the end — single allocation beats many
    // small string concatenations for the worst-case 5 MB log.
    const blob = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        blob.set(c, offset);
        offset += c.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(blob);
    return { text, truncated: false, size: total };
}

/**
 * Render a plain-text file (no syntax highlight) into the supplied
 * `<pre>` element. Caller is responsible for showing / hiding the
 * surrounding container.
 *
 *   opts:
 *     preEl:     <pre> to fill (text goes into a child <code>)
 *     statusEl:  optional element to receive "Loading…" / error / "too large" text
 *     url:       fetch URL (usually `/files/<path>?inline=1`)
 *     downloadUrl: download fallback for the "too large" path
 *     fileName:  display name for the placeholder
 *     maxBytes:  byte cap (default 5 MB)
 *     onLoaded:  optional callback fired after the text lands in the DOM
 */
export async function renderTextInto(opts) {
    const {
        preEl,
        statusEl,
        url,
        downloadUrl,
        fileName,
        maxBytes = TEXT_MAX_BYTES,
        onLoaded,
    } = opts;
    if (!preEl) return;
    preEl.textContent = '';
    if (statusEl) statusEl.textContent = '';
    try {
        const { text, truncated, size } = await fetchTextCapped(url, maxBytes);
        if (truncated) {
            preEl.innerHTML = '';
            if (statusEl) {
                statusEl.innerHTML = _tooLargeHtml({
                    fileName,
                    size,
                    maxBytes,
                    downloadUrl,
                });
            }
            return;
        }
        // Use textContent for the plain-text renderer — no HTML escape
        // dance and the browser handles wide characters / CRLF / etc.
        preEl.textContent = text;
        if (onLoaded) onLoaded({ text, size });
    } catch (err) {
        preEl.textContent = '';
        if (statusEl) {
            statusEl.innerHTML = _errorHtml({ fileName, err, downloadUrl });
        }
    }
}

/**
 * Render a code file with syntax highlighting. Lazy-loads highlight.js
 * the first time it's called. Same shape as renderTextInto but adds
 * `ext` (extension) to drive language detection.
 */
export async function renderCodeInto(opts) {
    const {
        codeEl,
        statusEl,
        url,
        downloadUrl,
        fileName,
        ext,
        maxBytes = CODE_MAX_BYTES,
        onLoaded,
    } = opts;
    if (!codeEl) return;
    codeEl.textContent = '';
    codeEl.className = '';
    if (statusEl) statusEl.textContent = '';
    try {
        const { text, truncated, size } = await fetchTextCapped(url, maxBytes);
        if (truncated) {
            codeEl.innerHTML = '';
            if (statusEl) {
                statusEl.innerHTML = _tooLargeHtml({
                    fileName,
                    size,
                    maxBytes,
                    downloadUrl,
                });
            }
            return;
        }
        codeEl.textContent = text;
        const lang = langFromExt(ext);
        if (lang) {
            codeEl.className = `language-${lang}`;
        }
        try {
            const hljs = await ensureHljs();
            // Reset the highlight state on the element so re-renders
            // don't compound classes from the previous file.
            codeEl.removeAttribute('data-highlighted');
            hljs.highlightElement(codeEl);
        } catch {
            // Highlight is best-effort — if the CDN is blocked the
            // operator still sees readable plain text.
        }
        if (onLoaded) onLoaded({ text, size, lang });
    } catch (err) {
        codeEl.textContent = '';
        if (statusEl) {
            statusEl.innerHTML = _errorHtml({ fileName, err, downloadUrl });
        }
    }
}

/**
 * Render a markdown file as sanitised HTML. Lazy-loads marked +
 * DOMPurify. Renders into `targetEl.innerHTML`.
 */
export async function renderMarkdownInto(opts) {
    const {
        targetEl,
        statusEl,
        url,
        downloadUrl,
        fileName,
        maxBytes = MARKDOWN_MAX_BYTES,
        onLoaded,
    } = opts;
    if (!targetEl) return;
    targetEl.innerHTML = '';
    if (statusEl) statusEl.textContent = '';
    try {
        const { text, truncated, size } = await fetchTextCapped(url, maxBytes);
        if (truncated) {
            if (statusEl) {
                statusEl.innerHTML = _tooLargeHtml({
                    fileName,
                    size,
                    maxBytes,
                    downloadUrl,
                });
            }
            return;
        }
        let html;
        try {
            const [marked, DOMPurify] = await Promise.all([ensureMarked(), ensureDomPurify()]);
            const parsed = marked.parse(text, { breaks: true, gfm: true });
            html = DOMPurify.sanitize(parsed, {
                USE_PROFILES: { html: true },
                // Strip any inline event handlers — defence in depth on
                // top of marked's escaping.
                FORBID_ATTR: ['onerror', 'onload', 'onclick'],
            });
        } catch {
            // CDN unreachable — fall back to escaped plain text so the
            // operator still gets something readable.
            html = `<pre class="text-sm text-tg-text/90 whitespace-pre-wrap">${escapeHtml(text)}</pre>`;
        }
        targetEl.innerHTML = html;
        if (onLoaded) onLoaded({ text, size });
    } catch (err) {
        targetEl.innerHTML = '';
        if (statusEl) {
            statusEl.innerHTML = _errorHtml({ fileName, err, downloadUrl });
        }
    }
}

function _formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function _tooLargeHtml({ fileName, size, maxBytes, downloadUrl }) {
    const name = escapeHtml(fileName || 'file');
    const sizeFmt = _formatBytes(size);
    const capFmt = _formatBytes(maxBytes);
    return `
        <div class="text-center px-6 py-10">
            <i class="ri-file-warning-line text-5xl text-yellow-400 mb-3 inline-block"></i>
            <p class="text-tg-text mb-1 font-medium">${name}</p>
            <p class="text-sm text-tg-textSecondary mb-4">
                ${sizeFmt} — too large to preview inline (cap ${capFmt})
            </p>
            ${
                downloadUrl
                    ? `<a href="${escapeHtml(downloadUrl)}" download
                        class="inline-flex items-center gap-2 px-4 py-2 bg-tg-blue hover:bg-tg-darkBlue rounded-lg text-sm text-white font-medium transition">
                        <i class="ri-download-line"></i> <span>Download file</span>
                    </a>`
                    : ''
            }
        </div>
    `;
}

function _errorHtml({ fileName, err, downloadUrl }) {
    const name = escapeHtml(fileName || 'file');
    const msg = escapeHtml(err?.message || String(err) || 'Failed to load');
    return `
        <div class="text-center px-6 py-10">
            <i class="ri-error-warning-line text-5xl text-red-400 mb-3 inline-block"></i>
            <p class="text-tg-text mb-1 font-medium">${name}</p>
            <p class="text-sm text-tg-textSecondary mb-4">${msg}</p>
            ${
                downloadUrl
                    ? `<a href="${escapeHtml(downloadUrl)}" download
                        class="inline-flex items-center gap-2 px-4 py-2 bg-tg-blue hover:bg-tg-darkBlue rounded-lg text-sm text-white font-medium transition">
                        <i class="ri-download-line"></i> <span>Download file</span>
                    </a>`
                    : ''
            }
        </div>
    `;
}
