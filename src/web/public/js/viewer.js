import { state } from './store.js';
import { formatDate, showToast } from './utils.js';
import { attachSwipe, attachDragDismiss } from './gestures.js';
import { tf as i18nTf, t as i18nT } from './i18n.js';
import { getMediaUrl, getDownloadUrl } from './media-url.js';
import { ws } from './ws.js';
import { renderTextInto, renderCodeInto, renderMarkdownInto, langFromExt } from './viewer-text.js';
import { renderArchiveInto } from './viewer-archive.js';

// ---- Seekbar feature flag — lazy, module-scoped --------------------------
//
// The hover-preview only runs when `advanced.seekbar.enabled` is true in the
// kv config. We fetch it once on first need and cache for the session; a
// `config_updated` WS event invalidates so a toggle from the Maintenance →
// Seekbar page is picked up live (no reload). Falsey by default while the
// promise is in flight — the viewer falls through to time-only tooltips
// during that brief window.
let _seekbarEnabledCache = null;
let _seekbarEnabledFetch = null;
function _getSeekbarEnabled() {
    if (_seekbarEnabledCache !== null) return Promise.resolve(_seekbarEnabledCache);
    if (_seekbarEnabledFetch) return _seekbarEnabledFetch;
    _seekbarEnabledFetch = fetch('/api/config', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => {
            _seekbarEnabledCache = cfg?.advanced?.seekbar?.enabled !== false;
            return _seekbarEnabledCache;
        })
        .catch(() => {
            _seekbarEnabledCache = false;
            return false;
        })
        .finally(() => {
            _seekbarEnabledFetch = null;
        });
    return _seekbarEnabledFetch;
}
// Invalidate the cache when an operator flips the toggle from the
// Maintenance → Seekbar page. The matching server-side broadcast is fired
// from POST /api/config. We subscribe once at module load (idempotent).
try {
    ws.on('seekbar_config_changed', () => {
        _seekbarEnabledCache = null;
    });
    ws.on('config_updated', () => {
        _seekbarEnabledCache = null;
    });
} catch {
    /* ws not available in tests */
}

// ============================================================================
// Media Viewer
// ----------------------------------------------------------------------------
//   Public surface (callers in app.js):
//     openMediaViewer(index)
//     closeMediaViewer()
//     setupViewerEvents()       — wire boot-time / document-level listeners
//   Plus the back-compat zoom helper for images.
//
//   The video player is encapsulated in `VideoPlayer` (instantiated lazily on
//   first video open). All per-video DOM listeners are attached via .onX = …
//   (assignment) so re-opening a video automatically replaces the previous
//   handlers — no leaks, no double-fires.
// ============================================================================

let zoomState = { scale: 1, panning: false, pointX: 0, pointY: 0, startX: 0, startY: 0 };
/** @type {VideoPlayer|null} */
let videoPlayer = null;

// Review-mode action toolbar — populated by openMediaViewerForReview and
// cleared on close. Each entry: { key, label, icon?, danger?, handler }.
// `handler(file, index)` is invoked on click or matching keydown; if it
// returns `'advance'` the viewer auto-navigates forward (so e.g. `w`
// whitelist + advance keeps the operator moving without extra clicks).
let _reviewActions = null;
// Optional per-row metadata renderer for review mode (e.g. NSFW score
// badge). Receives the current file and returns an HTML string painted
// into #viewer-review-meta on every openMediaViewer call.
let _reviewMetaRender = null;

/**
 * One-shot open: hand a `{ fullPath, type, name, … }` record straight to
 * the modal without first walking it through a gallery list. Used by the
 * Queue page to surface a finished download in the in-app viewer with one
 * click. Stages the file into `state.files` so the existing prev/next +
 * delete + share pipeline keeps working — the user doesn't notice the
 * difference, but Queue page state is never overwritten because it owns
 * its own store.
 */
export function openMediaViewerSingle(file) {
    if (!file?.fullPath) return;
    state.files = [file];
    openMediaViewer(0);
}

/**
 * Review-mode open: hand the viewer an arbitrary list of files plus a
 * set of action buttons (whitelist / delete / re-classify, etc.) to
 * render alongside the existing controls. Same `state.files` swap as
 * openMediaViewerSingle so prev/next + zoom + swipe-dismiss all work,
 * but with a custom action toolbar wired to single-letter shortcuts.
 *
 *   files:   [{ fullPath, type, name, sizeFormatted, modified }, ...]
 *   index:   start index into `files`
 *   opts.actions:    Array<{ key, label, icon?, danger?, handler }>
 *                    handler(file, index) may return 'advance' to auto-step
 *                    forward (whitelist/delete style) or 'remove-and-advance'
 *                    to drop the current item from `files` first.
 *   opts.metaRender: (file, index) => HTML string painted into the review
 *                    meta slot (score badge etc.). Optional.
 */
export function openMediaViewerForReview(files, index, opts = {}) {
    if (!Array.isArray(files) || !files.length) return;
    state.files = files;
    _reviewActions = Array.isArray(opts.actions) ? opts.actions : [];
    _reviewMetaRender = typeof opts.metaRender === 'function' ? opts.metaRender : null;
    openMediaViewer(Math.max(0, Math.min(index || 0, files.length - 1)));
}

// Render the review action toolbar + per-file meta into the modal. Pulls
// from module-level state set by openMediaViewerForReview; safe to call
// when the modal is opened in normal (non-review) mode — the elements
// stay hidden because _reviewActions is null.
function _renderReviewToolbar(file, index) {
    const wrapper = document.getElementById('viewer-review-bar');
    const bar = document.getElementById('viewer-review-actions');
    const meta = document.getElementById('viewer-review-meta');
    if (!bar || !meta) return;
    if (!_reviewActions?.length) {
        wrapper?.classList.add('hidden');
        bar.classList.add('hidden');
        meta.classList.add('hidden');
        return;
    }
    wrapper?.classList.remove('hidden');
    bar.classList.remove('hidden');
    meta.classList.toggle('hidden', !_reviewMetaRender);
    if (_reviewMetaRender) meta.innerHTML = _reviewMetaRender(file, index) || '';
    bar.innerHTML = _reviewActions
        .map((a, i) => {
            const danger = a.danger
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30 border-red-500/30'
                : 'border-tg-border text-tg-text hover:bg-tg-hover';
            const iconHtml = a.icon ? `<i class="${a.icon}"></i>` : '';
            const keyHtml = a.key
                ? `<span class="ml-1 text-[10px] opacity-60 uppercase">${a.key}</span>`
                : '';
            return `<button type="button" data-review-act="${i}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${danger} text-sm transition">${iconHtml}<span>${a.label || ''}</span>${keyHtml}</button>`;
        })
        .join('');
    for (const btn of bar.querySelectorAll('[data-review-act]')) {
        btn.onclick = async () => {
            const i = Number(btn.dataset.reviewAct);
            const action = _reviewActions?.[i];
            if (!action) return;
            await _runReviewAction(action);
        };
    }
}

async function _runReviewAction(action) {
    const idx = state.currentFileIndex;
    const file = state.files[idx];
    if (!file) return;
    let outcome;
    try {
        outcome = await action.handler(file, idx);
    } catch {
        return;
    }
    if (outcome === 'remove-and-advance') {
        const removed = state.files.splice(idx, 1);
        if (!state.files.length) {
            closeMediaViewer();
            return;
        }
        const nextIdx = Math.min(idx, state.files.length - 1);
        openMediaViewer(nextIdx);
        if (typeof action.afterRemove === 'function') {
            try {
                action.afterRemove(removed[0]);
            } catch {}
        }
    } else if (outcome === 'advance') {
        if (idx + 1 < state.files.length) openMediaViewer(idx + 1);
    }
}

// File-kind classifier shared by openMediaViewer + the unit test in
// tests/viewer-classifier.test.js. Re-exported as
// `_classifyFileForTests` so the test doesn't depend on a DOM.
function _classifyFile(file) {
    const ext = (file?.name || '').split('.').pop()?.toLowerCase() || '';
    const t = file?.type;
    if (t === 'images') return 'image';
    if (t === 'videos') return 'video';
    if (
        t === 'audio' ||
        ['mp3', 'm4a', 'ogg', 'wav', 'flac', 'opus', 'aac', 'wma', 'alac'].includes(ext)
    ) {
        return 'audio';
    }
    if (ext === 'pdf') return 'pdf';
    if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return 'markdown';
    if (['txt', 'log', 'csv', 'tsv', 'ini', 'conf', 'env', 'toml'].includes(ext)) return 'text';
    if (
        [
            'js',
            'mjs',
            'cjs',
            'ts',
            'jsx',
            'tsx',
            'json',
            'jsonc',
            'html',
            'htm',
            'css',
            'scss',
            'sass',
            'less',
            'xml',
            'svg',
            'sql',
            'sh',
            'bash',
            'zsh',
            'fish',
            'ps1',
            'bat',
            'cmd',
            'py',
            'rb',
            'go',
            'rs',
            'c',
            'cpp',
            'cc',
            'h',
            'hpp',
            'java',
            'kt',
            'swift',
            'php',
            'lua',
            'pl',
            'dart',
            'vue',
            'svelte',
            'astro',
            'graphql',
            'dockerfile',
            'makefile',
            'cmake',
            'vim',
            'yaml',
            'yml',
        ].includes(ext)
    ) {
        return 'code';
    }
    if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', '7z', 'rar', 'xz', 'txz'].includes(ext)) {
        return 'archive';
    }
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(ext)) {
        return 'office';
    }
    return 'fallback';
}

// Friendly label for the chip next to the filename. Code files surface
// the language ("JavaScript", "Python", "YAML", ...) when the extension
// maps to a known highlight.js language; otherwise we fall back to a
// generic "Code".
function _typeLabelFor(file) {
    const ext = (file?.name || '').split('.').pop()?.toLowerCase() || '';
    const kind = _classifyFile(file);
    switch (kind) {
        case 'image':
            return i18nT('viewer.kind.image', 'Image');
        case 'video':
            return i18nT('viewer.kind.video', 'Video');
        case 'audio':
            return i18nT('viewer.kind.audio', 'Audio');
        case 'pdf':
            return 'PDF';
        case 'markdown':
            return i18nT('viewer.kind.markdown', 'Markdown');
        case 'text':
            return i18nT('viewer.kind.text', 'Text');
        case 'code': {
            const lang = langFromExt(ext);
            if (!lang) return i18nT('viewer.kind.code', 'Code');
            return lang
                .replace(/-/g, ' ')
                .replace(/\b\w/g, (c) => c.toUpperCase())
                .replace(/Javascript/i, 'JavaScript')
                .replace(/Typescript/i, 'TypeScript');
        }
        case 'archive':
            return i18nT('viewer.kind.archive', 'Archive');
        case 'office':
            return i18nT('viewer.kind.office', 'Document');
        default:
            return ext ? ext.toUpperCase() : i18nT('viewer.kind.file', 'File');
    }
}

// Test-only export so the classifier can be exercised without a DOM.
// Hidden behind an underscore-prefix to keep it out of the public surface.
export const _classifyFileForTests = _classifyFile;

// Tear every preview container down so the next openMediaViewer() call
// can re-show exactly one. Called at the top of every open, on close,
// and on file navigation. Defensive against missing nodes so older
// index.html builds (mid-deploy) don't crash the viewer.
function _resetAllPreviewContainers() {
    for (const id of [
        'image-container',
        'video-container',
        'pdf-container',
        'audio-container',
        'text-container',
        'code-container',
        'markdown-container',
        'archive-container',
        'office-container',
        'fallback-container',
    ]) {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    }
    // Detach any in-flight previews so abandoning a clip mid-load
    // doesn't leak its src into the background.
    const audio = document.getElementById('modal-audio');
    if (audio) {
        try {
            audio.pause();
        } catch {}
        try {
            audio.removeAttribute('src');
            audio.load();
        } catch {}
    }
    const pdfFrame = document.getElementById('pdf-frame');
    if (pdfFrame) {
        try {
            pdfFrame.src = 'about:blank';
        } catch {}
    }
}

function _setTypeChip(file) {
    const chip = document.getElementById('modal-type-chip');
    if (!chip) return;
    const label = _typeLabelFor(file);
    chip.textContent = label;
    chip.classList.toggle('hidden', !label);
}

export function openMediaViewer(index) {
    state.currentFileIndex = index;
    const file = state.files[index];
    if (!file) return;

    const modal = document.getElementById('media-modal');
    const imageContainer = document.getElementById('image-container');
    const image = document.getElementById('modal-image');
    const videoContainer = document.getElementById('video-container');
    // Federated rows (file.peer_id !== 'self') get the cluster-proxy
    // form `/files/<peerSidePath>?inline=1&peer=<peerId>`; see media-url.js.
    const url = getMediaUrl(file);
    const downloadUrl = getDownloadUrl(file) || url;

    // Reset every preview container before swapping the new one in. Image +
    // video are first-class so we keep direct refs around for the existing
    // zoom / video-player wiring; the rest live behind _resetAllPreviewContainers.
    _resetAllPreviewContainers();

    // Always tear the previous clip down BEFORE swapping in the new src so a
    // 100 MB video doesn't keep streaming in the background after you flip
    // to an image.
    resetZoom();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (videoPlayer) videoPlayer.unload();
    image.removeAttribute('src');

    const kind = _classifyFile(file);
    const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';

    switch (kind) {
        case 'image':
            image.src = url;
            imageContainer.classList.remove('hidden');
            setupImageZoom();
            break;
        case 'video': {
            videoContainer.classList.remove('hidden');
            if (!videoPlayer) videoPlayer = new VideoPlayer();
            videoPlayer.load(url, file.fullPath, file);
            break;
        }
        case 'pdf': {
            const c = document.getElementById('pdf-container');
            const frame = document.getElementById('pdf-frame');
            if (c && frame) {
                c.classList.remove('hidden');
                // `#toolbar=1` is a Chrome / Edge hint; Firefox / Safari
                // ignore it gracefully and still render the document.
                frame.src = `${url}${url.includes('?') ? '&' : '?'}#toolbar=1`;
            } else {
                _showFallback(file, downloadUrl);
            }
            break;
        }
        case 'audio': {
            const c = document.getElementById('audio-container');
            const audio = document.getElementById('modal-audio');
            const titleEl = document.getElementById('audio-title');
            const metaEl = document.getElementById('audio-meta');
            if (c && audio) {
                c.classList.remove('hidden');
                audio.src = url;
                audio.load();
                if (titleEl) titleEl.textContent = file.name || '';
                if (metaEl) {
                    metaEl.textContent =
                        `${file.sizeFormatted || ''} • ${formatDate(file.modified) || ''}`.trim();
                }
            } else {
                _showFallback(file, downloadUrl);
            }
            break;
        }
        case 'text': {
            const c = document.getElementById('text-container');
            const preEl = document.getElementById('text-block');
            const statusEl = document.getElementById('text-status');
            if (c && preEl) {
                c.classList.remove('hidden');
                renderTextInto({
                    preEl,
                    statusEl,
                    url,
                    downloadUrl,
                    fileName: file.name,
                });
            } else {
                _showFallback(file, downloadUrl);
            }
            break;
        }
        case 'code': {
            const c = document.getElementById('code-container');
            const codeEl = document.getElementById('code-block');
            const statusEl = document.getElementById('code-status');
            if (c && codeEl) {
                c.classList.remove('hidden');
                renderCodeInto({
                    codeEl,
                    statusEl,
                    url,
                    downloadUrl,
                    fileName: file.name,
                    ext,
                });
            } else {
                _showFallback(file, downloadUrl);
            }
            break;
        }
        case 'markdown': {
            const c = document.getElementById('markdown-container');
            const targetEl = document.getElementById('markdown-body');
            const statusEl = document.getElementById('markdown-status');
            if (c && targetEl) {
                c.classList.remove('hidden');
                renderMarkdownInto({
                    targetEl,
                    statusEl,
                    url,
                    downloadUrl,
                    fileName: file.name,
                });
            } else {
                _showFallback(file, downloadUrl);
            }
            break;
        }
        case 'archive': {
            const c = document.getElementById('archive-container');
            const targetEl = document.getElementById('archive-body');
            const statusEl = document.getElementById('archive-status');
            if (c && targetEl) {
                c.classList.remove('hidden');
                renderArchiveInto({
                    targetEl,
                    statusEl,
                    filePath: file.fullPath,
                    downloadUrl,
                    fileName: file.name,
                });
            } else {
                _showFallback(file, downloadUrl);
            }
            break;
        }
        case 'office':
        default:
            _showFallback(file, downloadUrl);
            break;
    }

    document.getElementById('modal-filename').textContent = file.name;
    document.getElementById('modal-meta').textContent =
        `${file.sizeFormatted} • ${formatDate(file.modified)}`;
    document.getElementById('modal-counter').textContent = `${index + 1} / ${state.files.length}`;
    document.getElementById('modal-download').href = downloadUrl;
    _setTypeChip(file);

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    prefetchNeighbor(index + 1);

    _renderReviewToolbar(file, index);
}

// Generic "no inline preview" pane — used by the office case and as the
// safety net for any classifier branch whose markup is missing (which
// would otherwise leave the modal blank on a stale deploy).
function _showFallback(file, downloadUrl) {
    const c =
        document.getElementById('fallback-container') ||
        document.getElementById('office-container');
    if (!c) return;
    const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
    const isOffice = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(
        ext,
    );
    const titleKey = isOffice ? 'viewer.fallback.office_title' : 'viewer.fallback.title';
    const messageKey = isOffice ? 'viewer.fallback.office_message' : 'viewer.fallback.message';
    const title = i18nT(titleKey, isOffice ? 'Office document' : 'No inline preview');
    const msg = i18nT(
        messageKey,
        isOffice
            ? 'Office documents render best in their native app — download to open.'
            : "This file type doesn't have a built-in preview.",
    );
    const dlLabel = i18nT('viewer.fallback.download', 'Download file');
    c.classList.remove('hidden');
    c.innerHTML = `
        <div class="text-center px-6 py-10 max-w-md mx-auto">
            <i class="ri-file-line text-6xl text-tg-textSecondary mb-4 inline-block"></i>
            <p class="text-tg-text mb-2 font-medium">${_escape(file.name || title)}</p>
            <p class="text-sm text-tg-textSecondary mb-5">${_escape(msg)}</p>
            <a href="${_escape(downloadUrl)}" download
                class="inline-flex items-center gap-2 px-5 py-2.5 bg-tg-blue hover:bg-tg-darkBlue rounded-lg text-sm text-white font-medium transition">
                <i class="ri-download-line"></i> <span>${_escape(dlLabel)}</span>
            </a>
        </div>
    `;
}

function _escape(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

let _prefetchLink = null;
function prefetchNeighbor(nextIndex) {
    const next = state.files[nextIndex];
    if (!next || next.type !== 'images') {
        if (_prefetchLink) {
            _prefetchLink.remove();
            _prefetchLink = null;
        }
        return;
    }
    // Same federated routing as the active-file URL. Prefetch link
    // tag's `.href` may be absolute, so endsWith() is the right comparator.
    const href = getMediaUrl(next);
    if (_prefetchLink && _prefetchLink.href.endsWith(href)) return;
    if (!_prefetchLink) {
        _prefetchLink = document.createElement('link');
        _prefetchLink.rel = 'prefetch';
        _prefetchLink.as = 'image';
        document.head.appendChild(_prefetchLink);
    }
    _prefetchLink.href = href;
}

function resetZoom() {
    zoomState = { scale: 1, panning: false, pointX: 0, pointY: 0 };
    const img = document.getElementById('modal-image');
    if (img) img.style.transform = `translate(0px, 0px) scale(1)`;
}

function setupImageZoom() {
    const img = document.getElementById('modal-image');
    img.onwheel = (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoomState.scale = Math.min(Math.max(1, zoomState.scale * delta), 5);
        img.style.transform = `scale(${zoomState.scale})`;
    };
}

// ============================================================================
// VideoPlayer — class-based controller for #modal-video and friends.
// ============================================================================

const VOL_LS_KEY = 'video-volume';
const MUTED_LS_KEY = 'video-muted';
const SPEED_LS_KEY = 'video-speed';
const AUTOPLAY_LS_KEY = 'viewer-autoplay';
const HOVER_TIMEOUT_MS = 2000;

const SUPPORTS_HOVER =
    typeof window.matchMedia === 'function' ? window.matchMedia('(hover: hover)').matches : true;

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

class VideoPlayer {
    constructor() {
        this.video = document.getElementById('modal-video');
        this.container = document.getElementById('video-container');
        this.tapLayer = document.getElementById('video-tap-layer');
        this.controls = document.getElementById('video-controls');
        this.playBtn = document.getElementById('video-play-btn');
        this.centerPlay = document.getElementById('video-center-play');
        this.muteBtn = document.getElementById('video-mute-btn');
        this.volume = document.getElementById('video-volume');
        this.curTime = document.getElementById('video-current-time');
        this.durTime = document.getElementById('video-duration');
        this.progressBar = document.getElementById('video-progress-container');
        this.progressFill = document.getElementById('video-progress-fill');
        this.progressDot = document.getElementById('video-progress-dot');
        this.bufferedLayer = document.getElementById('video-buffered-layer');
        this.hoverTime = document.getElementById('video-hover-time');
        this.spritePreview = document.getElementById('video-sprite-preview');
        // Inner Netflix-style preview parts. The frame paints the sprite
        // background (size set inline per clip), the time pill labels it,
        // and the pending overlay surfaces the spinner while a sidecar
        // generation is still in flight.
        this.spriteFrame = document.getElementById('video-sprite-frame');
        this.spriteTime = document.getElementById('video-sprite-time');
        this.spritePending = document.getElementById('video-sprite-pending');
        this.filmstrip = document.getElementById('video-filmstrip');
        this.filmstripTrack = document.getElementById('filmstrip-track');
        this.filmstripPrev = document.getElementById('filmstrip-prev');
        this.filmstripNext = document.getElementById('filmstrip-next');
        this._filmstripTimeFloat = document.getElementById('filmstrip-time-float');
        this._filmstripLastIdx = -1;
        this.spinner = document.getElementById('video-spinner');
        this.errorOverlay = document.getElementById('video-error');
        this.errorMsg = document.getElementById('video-error-msg');
        this.retryBtn = document.getElementById('video-retry-btn');
        this.speedBtn = document.getElementById('video-settings-btn');
        this.speedMenu = document.getElementById('video-speed-menu');
        this.speedOpts = Array.from(document.querySelectorAll('.speed-opt[data-speed]'));
        this.pipBtn = document.getElementById('video-pip-btn');
        this.fsBtn = document.getElementById('video-fullscreen-btn');

        // Hide PiP button if browser lacks support.
        if (this.pipBtn && !document.pictureInPictureEnabled) {
            this.pipBtn.style.display = 'none';
        }
        // Honour user's "Show PiP / Show speed button" preferences from
        // Settings → Video Player. Inverted-sense keys ('1' = hidden) so
        // the legacy default (both visible) survives without migration.
        if (this.pipBtn && localStorage.getItem('viewer-hide-pip') === '1') {
            this.pipBtn.style.display = 'none';
        }
        if (this.speedBtn && localStorage.getItem('viewer-hide-speed') === '1') {
            this.speedBtn.style.display = 'none';
        }

        this._currentUrl = null;
        this._storageKey = null;
        this._lastSavedAt = 0;
        this._dragging = false;
        this._wasPlayingBeforeDrag = false;
        this._resumePlayed = false;
        this._hideTimer = null;
        this._lastDoubleTapAt = 0;
        this._lastTapAt = 0;
        this._lastTapX = 0;

        this._wireOnce();
    }

    /** Boot-time wiring — runs once per VideoPlayer instance. */
    _wireOnce() {
        // Play / pause.
        this.playBtn.onclick = () => this.togglePlay();
        this.centerPlay.onclick = () => this.togglePlay();

        // Tap layer = anywhere on the video pane that ISN'T a control.
        this.tapLayer.onclick = (e) => {
            if (SUPPORTS_HOVER) {
                this.togglePlay();
            } else {
                // Mobile: first tap reveals controls, second tap toggles play.
                if (this._controlsVisible()) {
                    this.togglePlay();
                } else {
                    this._showControls(true);
                }
            }
            e.stopPropagation();
        };
        this.tapLayer.ondblclick = (e) => {
            // Settings → Video Player → Double-tap to fullscreen. Default
            // is ON (legacy behaviour); explicit '0' opts out.
            if (localStorage.getItem('viewer-dbl-tap-fs') === '0') {
                e.stopPropagation();
                return;
            }
            this.toggleFullscreen();
            e.stopPropagation();
        };

        // Mobile double-tap left/right halves to seek -/+10 s (YouTube-style).
        this.tapLayer.onpointerdown = (e) => {
            if (SUPPORTS_HOVER) return;
            const now = Date.now();
            if (now - this._lastTapAt < 320 && Math.abs(e.clientX - this._lastTapX) < 60) {
                const rect = this.tapLayer.getBoundingClientRect();
                const isLeft = e.clientX - rect.left < rect.width / 2;
                this.seekRelative(isLeft ? -10 : 10);
                this._lastTapAt = 0;
            } else {
                this._lastTapAt = now;
                this._lastTapX = e.clientX;
            }
        };

        // Auto-hide on desktop when the cursor wanders inside the modal.
        this.container.onpointermove = (e) => {
            if (e.pointerType === 'touch') return;
            this._showControls();
        };
        this.container.onpointerleave = () => {
            if (!SUPPORTS_HOVER) return;
            if (!this.video.paused) this._scheduleHide(800);
        };

        // Wheel = volume.
        this.container.onwheel = (e) => {
            e.preventDefault();
            const step = e.deltaY > 0 ? -0.05 : 0.05;
            this._setVolume(Math.max(0, Math.min(1, this.video.volume + step)));
        };

        // Seek bar — pointer events for unified mouse / touch / pen.
        this._wireSeekBar();

        // Volume slider.
        this.volume.oninput = () => {
            const v = parseFloat(this.volume.value);
            if (!Number.isFinite(v)) return;
            this._setVolume(v);
        };

        // Mute button.
        this.muteBtn.onclick = () => {
            this.video.muted = !this.video.muted;
            // Bump volume off zero so unmuting actually plays sound.
            if (!this.video.muted && this.video.volume === 0) this._setVolume(0.5);
        };

        // Speed menu trigger.
        this.speedBtn.onclick = (e) => {
            e.stopPropagation();
            this.speedMenu.classList.toggle('hidden');
        };
        this.speedOpts.forEach((opt) => {
            opt.onclick = () => {
                const r = parseFloat(opt.dataset.speed);
                if (!Number.isFinite(r) || r <= 0) return;
                this._setSpeed(r);
                this.speedMenu.classList.add('hidden');
            };
        });

        // PiP.
        this.pipBtn.onclick = async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (document.pictureInPictureEnabled) {
                    await this.video.requestPictureInPicture();
                }
            } catch (e) {
                showToast(
                    i18nTf(
                        'viewer.video.pip_failed',
                        { msg: e.message },
                        `PiP unavailable: ${e.message}`,
                    ),
                    'error',
                );
            }
        };

        // Fullscreen — fullscreen the container so our custom controls stay.
        this.fsBtn.onclick = () => this.toggleFullscreen();
        // Keep a ref so unload() can detach — otherwise every viewer open
        // adds another listener and stale ones fire after the modal closes.
        this._onFullscreenChange = () => this._refreshFsIcon();
        document.addEventListener('fullscreenchange', this._onFullscreenChange);

        // Retry button (error overlay).
        this.retryBtn.onclick = () => {
            if (!this._currentUrl) return;
            this._hideError();
            this.video.src = this._currentUrl;
            this.video.load();
            this.video.play().catch(() => {});
        };

        // Stop pointerdown inside the controls from bubbling to the
        // attachDragDismiss handler on #modal-swipe — without this the
        // pull-down-to-dismiss fires while you're scrubbing the seek bar.
        this.controls.addEventListener('pointerdown', (e) => e.stopPropagation());

        // ---- per-element video event hooks (re-assigned on each .load(), but
        // these handlers are stateless wrt the source so we can wire once). ----
        this.video.onplay = () => {
            this._refreshPlayIcons();
            if (this.video.paused === false) this._scheduleHide();
        };
        this.video.onpause = () => {
            this._refreshPlayIcons();
            this._showControls(true);
        };
        this.video.onended = () => {
            this._refreshPlayIcons();
            this._showControls(true);
            if (this._storageKey) localStorage.removeItem(this._storageKey);
            // Auto-advance: jump to the next file in the gallery list
            // when the user opted in. Skipped when looping is on (loop
            // would re-fire onended forever) or when the modal has
            // already been closed.
            if (localStorage.getItem('viewer-auto-advance') === '1' && !this.video.loop) {
                try {
                    const idx = state.currentFileIndex;
                    if (Number.isFinite(idx) && idx + 1 < state.files.length) {
                        // Defer one tick so this onended handler returns
                        // before we tear down + re-init for the next clip.
                        setTimeout(() => {
                            try {
                                openMediaViewer(idx + 1);
                            } catch {}
                        }, 60);
                    }
                } catch {}
            }
        };
        this.video.onvolumechange = () => {
            this._refreshVolumeUi();
            try {
                localStorage.setItem(VOL_LS_KEY, String(this.video.volume));
                localStorage.setItem(MUTED_LS_KEY, this.video.muted ? '1' : '0');
            } catch {}
        };
        this.video.ontimeupdate = () => this._onTimeUpdate();
        this.video.onprogress = () => this._renderBuffered();
        this.video.ondurationchange = () => {
            this.durTime.textContent = formatTime(this.video.duration || 0);
            this._renderBuffered();
        };
        this.video.onwaiting = () => this._showSpinner(true);
        this.video.onstalled = () => this._showSpinner(true);
        this.video.oncanplay = () => this._showSpinner(false);
        this.video.onplaying = () => this._showSpinner(false);
        this.video.onloadeddata = () => this._showSpinner(false);
        this.video.onerror = () => this._showError();
        this.video.onratechange = () => this._refreshSpeedUi();

        // ---- Sidecar sprite WS subscriptions --------------------------------
        // When the Go sidecar (or in-process ffmpeg fallback) finishes
        // generating sprites for one or more videos, it broadcasts
        // `seekbar_done` per file. If the finished id matches the clip
        // currently open in the viewer AND we were in "pending" state,
        // kick `_fetchSpriteMeta`'s tryFetch closure immediately so the
        // preview tile flips to "ready" without waiting for the backoff
        // poll. The `_spriteRetry` callable is rebound on every load();
        // null-check makes events between clips safe.
        const _onSeekbarFinish = (msg) => {
            if (!msg) return;
            const finishedId = String(msg.download_id ?? msg.video_id ?? msg.id ?? '');
            if (!finishedId || !this._spriteFileId) return;
            if (finishedId !== this._spriteFileId) return;
            // Only re-poke when we're still waiting (pending). When
            // already ready, the operator may just be doing a wipe-and-
            // re-gen sweep — still useful to refetch so the new sprite
            // bytes show up, but we use the same retry function so it
            // re-loads the image with the latest URL.
            if (typeof this._spriteRetry === 'function') {
                try {
                    this._spriteRetry();
                } catch {
                    /* swallow — fallthrough leaves the preview as-is */
                }
            }
        };
        // The `seekbar_*` event family carries individual file
        // completions; the rebuild family carries them too after a
        // wipe sweep. Subscribe to both so a "Wipe + scan" cycle
        // refreshes the viewer's tile mid-watch.
        ws.on('seekbar_done', _onSeekbarFinish);
        ws.on('seekbar_rebuild_done', _onSeekbarFinish);
        // Per-file completion notifications fired by `pregenerateSeekbar`
        // (server-side broadcast helper) when a single video finishes.
        ws.on('seekbar_sprite_ready', _onSeekbarFinish);
    }

    // ----- public lifecycle --------------------------------------------------

    /** Load a new clip. Resets all UI BEFORE any event fires. */
    load(url, fileFullPath, file = null) {
        this._currentUrl = url;
        this._storageKey = `video-progress-${fileFullPath}`;
        this._resumePlayed = false;
        this._lastSavedAt = 0;
        this._sprite = null;
        this._spriteTileH = 0;
        this._fetchSpriteMeta(file);
        // Reset the auto-retry counter — a fresh clip gets a fresh
        // chance to recover from the spurious mobile-Safari error 4
        // that fires on initial src assignment. See `_showError()`.
        this._errorRetries = 0;

        // Pause + rewind the OLD source first so a stale ontimeupdate /
        // onloadedmetadata can't fire after the new clip's UI reset and
        // re-paint the seek bar with the previous clip's position. Without
        // this, switching clips from the gallery left the playhead and
        // play-icon mid-track.
        try {
            this.video.pause();
        } catch {}
        try {
            this.video.currentTime = 0;
        } catch {}
        try {
            this.video.onloadedmetadata = null;
        } catch {}

        // Reset UI synchronously so the previous clip's state never bleeds in.
        this.curTime.textContent = '00:00';
        this.durTime.textContent = '00:00';
        this.progressFill.style.width = '0%';
        this.progressDot.style.left = '0%';
        if (this.bufferedLayer) this.bufferedLayer.innerHTML = '';
        this.playBtn.innerHTML = '<i class="ri-play-fill text-2xl"></i>';
        this.playBtn.setAttribute('aria-label', i18nT('viewer.video.play', 'Play'));
        this.centerPlay.classList.remove('hidden');
        this._hideError();
        this._showSpinner(true);

        // Restore persisted volume + mute + speed.
        const savedVol = parseFloat(localStorage.getItem(VOL_LS_KEY) ?? '1');
        if (Number.isFinite(savedVol)) this.video.volume = Math.max(0, Math.min(1, savedVol));
        this.video.muted = localStorage.getItem(MUTED_LS_KEY) === '1';
        const savedSpeed = parseFloat(localStorage.getItem(SPEED_LS_KEY) ?? '1');
        this.video.playbackRate = Number.isFinite(savedSpeed) && savedSpeed > 0 ? savedSpeed : 1;
        this._refreshVolumeUi();
        this._refreshSpeedUi();
        this._refreshFsIcon();

        // Apply the loop preference — re-read every load() so a setting
        // change between clips takes effect on the next open.
        try {
            this.video.loop = localStorage.getItem('viewer-loop') === '1';
        } catch {}

        // Resume — race-safe (apply inline if metadata's already there).
        // Honour the "Remember position" toggle: when the user disables
        // it via Settings → Video Player, the saved key is still read on
        // the file's own per-clip path (so old saves don't disappear)
        // but we never SEEK to it.
        const resumeAllowed = localStorage.getItem('viewer-no-resume') !== '1';
        const applyResume = () => {
            if (this._resumePlayed) return;
            this._resumePlayed = true;
            if (!resumeAllowed) return;
            const saved = localStorage.getItem(this._storageKey);
            if (!saved) return;
            const time = parseFloat(saved);
            const dur = this.video.duration;
            if (!Number.isFinite(time) || time <= 0) return;
            if (Number.isFinite(dur) && time >= dur) return;
            try {
                this.video.currentTime = time;
            } catch {}
            const ts = formatTime(time);
            showToast(i18nTf('viewer.video.resumed', { time: ts }, `Resumed at ${ts}`));
        };
        this.video.onloadedmetadata = applyResume;

        // Swap the source.
        this.video.src = url;
        try {
            this.video.load();
        } catch {}

        if (this.video.readyState >= 1) applyResume();

        this._showControls(true);

        // Honour the user's "Autoplay videos" setting (Settings → Video
        // Player). Browsers block autoplay-with-sound on first
        // interaction, so if we ever can't start with audio we fall back
        // to a muted start — the user can unmute with one click. The
        // mute state we already restored above wins when present.
        if (localStorage.getItem(AUTOPLAY_LS_KEY) === '1') {
            const tryPlay = () => {
                this.video.play().catch(() => {
                    // Browser refused (autoplay policy) — flip mute on
                    // and try once more. If that also fails we silently
                    // leave the centre play button up for the user.
                    if (!this.video.muted) {
                        this.video.muted = true;
                        this._refreshVolumeUi();
                        this.video.play().catch(() => {});
                    }
                });
            };
            // Wait for at least metadata so the play() promise resolves
            // cleanly on slow links; oncanplay covers cold cache too.
            if (this.video.readyState >= 2) tryPlay();
            else this.video.addEventListener('canplay', tryPlay, { once: true });
        }
    }

    /** Stop any in-flight network activity and reset playback. */
    unload() {
        try {
            this.video.pause();
        } catch {}
        // Suppress the `error` event that some browsers (mobile Safari
        // especially) fire when the in-flight fetch is aborted by
        // `removeAttribute('src') + load()`. Without this guard the
        // spurious teardown error trips `_showError()` and the next
        // .load() call sees a stale errorOverlay state racing against
        // the new src assignment — which is exactly how the "Error 4 →
        // tap Retry → plays fine" report happens.
        try {
            this.video.onerror = null;
        } catch {}
        try {
            this.video.removeAttribute('src');
        } catch {}
        try {
            this.video.load();
        } catch {}
        // Drop the metadata-loaded handler so a stale resume from the
        // previous clip can't seek the next file to the wrong position.
        try {
            this.video.onloadedmetadata = null;
        } catch {}
        // Re-arm the error handler so a future .load() on the same
        // VideoPlayer instance can still surface real errors. The
        // handler itself does the auto-retry-once dance.
        try {
            this.video.onerror = () => this._showError();
        } catch {}
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
        this._currentUrl = null;
        this._storageKey = null;
        this._resumePlayed = false;
        if (this._hideTimer) {
            clearTimeout(this._hideTimer);
            this._hideTimer = null;
        }
        // Kill any in-flight sprite poll. The Symbol token already makes
        // late image-load callbacks no-op, but the timer would otherwise
        // keep firing for up to 60 s after the modal closed.
        if (this._spritePollTimer) {
            clearTimeout(this._spritePollTimer);
            this._spritePollTimer = null;
        }
        this._spriteRetry = null;
        this._spriteFileId = null;
        this._spriteState = 'disabled';
        if (this.spritePreview) {
            this.spritePreview.classList.add('hidden');
            this.spritePreview.dataset.state = 'disabled';
        }
        if (this.filmstrip) this.filmstrip.classList.add('hidden');
        if (this.filmstripTrack) this.filmstripTrack.innerHTML = '';
        if (this._filmstripTimeFloat) this._filmstripTimeFloat.classList.remove('visible');
        this._filmstripLastIdx = -1;
        this.speedMenu.classList.add('hidden');
        this._hideError();
        this._showSpinner(false);
    }

    /** Permanently tear down — call when the player is being thrown away. */
    destroy() {
        this.unload();
        if (this._onFullscreenChange) {
            document.removeEventListener('fullscreenchange', this._onFullscreenChange);
            this._onFullscreenChange = null;
        }
    }

    togglePlay() {
        if (this.video.paused) this.video.play().catch(() => {});
        else this.video.pause();
    }

    seekRelative(delta) {
        if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
        const next = Math.max(0, Math.min(this.video.duration, this.video.currentTime + delta));
        this.video.currentTime = next;
    }

    seekToFraction(frac) {
        if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
        const f = Math.max(0, Math.min(1, frac));
        this.video.currentTime = f * this.video.duration;
    }

    async toggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else if (this.container.requestFullscreen) {
                await this.container.requestFullscreen();
            }
        } catch (e) {
            showToast(
                i18nTf(
                    'viewer.video.fullscreen_failed',
                    { msg: e.message },
                    `Fullscreen unavailable: ${e.message}`,
                ),
                'error',
            );
        }
    }

    /** Routes a viewer-scoped keydown event. Returns true if handled. */
    handleKey(e) {
        const v = this.video;
        switch (e.key) {
            case ' ':
            case 'k':
            case 'K':
                this.togglePlay();
                return true;
            case 'ArrowLeft': {
                // Configurable skip step (Settings → Video Player). Shift
                // jumps 2× the step for power users.
                const step = parseInt(localStorage.getItem('viewer-skip-step'), 10) || 5;
                this.seekRelative(e.shiftKey ? -step * 2 : -step);
                return true;
            }
            case 'ArrowRight': {
                const step = parseInt(localStorage.getItem('viewer-skip-step'), 10) || 5;
                this.seekRelative(e.shiftKey ? step * 2 : step);
                return true;
            }
            case 'ArrowUp':
                this._setVolume(Math.min(1, v.volume + 0.05));
                return true;
            case 'ArrowDown':
                this._setVolume(Math.max(0, v.volume - 0.05));
                return true;
            case 'm':
            case 'M':
                v.muted = !v.muted;
                if (!v.muted && v.volume === 0) this._setVolume(0.5);
                return true;
            case 'f':
            case 'F':
                this.toggleFullscreen();
                return true;
            case ',':
            case '<':
                this._setSpeed(Math.max(0.25, +(v.playbackRate - 0.25).toFixed(2)));
                return true;
            case '.':
            case '>':
                this._setSpeed(Math.min(2, +(v.playbackRate + 0.25).toFixed(2)));
                return true;
            default:
                if (/^[0-9]$/.test(e.key)) {
                    this.seekToFraction(parseInt(e.key, 10) / 10);
                    return true;
                }
                return false;
        }
    }

    // ----- internals ---------------------------------------------------------

    _wireSeekBar() {
        const bar = this.progressBar;
        const seekTo = (clientX) => {
            if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
            const rect = bar.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            this.video.currentTime = ratio * this.video.duration;
        };
        bar.onpointerdown = (e) => {
            this._dragging = true;
            this._wasPlayingBeforeDrag = !this.video.paused;
            if (this._wasPlayingBeforeDrag) this.video.pause();
            try {
                bar.setPointerCapture?.(e.pointerId);
            } catch {}
            seekTo(e.clientX);
            e.preventDefault();
        };
        bar.onpointermove = (e) => {
            if (this._dragging) {
                seekTo(e.clientX);
            }
            this._renderHoverPreview(e.clientX);
        };
        bar.onpointerleave = () => this._hideHoverPreview();
        const endDrag = (e) => {
            if (!this._dragging) return;
            this._dragging = false;
            try {
                bar.releasePointerCapture?.(e.pointerId);
            } catch {}
            if (this._wasPlayingBeforeDrag) this.video.play().catch(() => {});
        };
        bar.onpointerup = endDrag;
        bar.onpointercancel = endDrag;
    }

    _renderHoverPreview(clientX) {
        if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
        const rect = this.progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const x = clientX - rect.left;
        const sec = ratio * this.video.duration;
        const timeStr = formatTime(sec);

        const sp = this._sprite;
        const tileH = this._spriteTileH;
        const wrap = this.spritePreview;
        const frame = this.spriteFrame;
        const timeEl = this.spriteTime;
        const state = this._spriteState || 'disabled';

        // No wrapper / sidecar feature disabled → fall through to the
        // native time-only tooltip we've shipped since v1.
        if (!wrap || state === 'disabled') {
            this.hoverTime.textContent = timeStr;
            this.hoverTime.style.left = `${x}px`;
            this.hoverTime.classList.remove('hidden');
            if (wrap) wrap.classList.add('hidden');
            return;
        }

        // Sprite-aware path (Netflix-style). Hide the native time pill —
        // the wrapper carries its own time chip below the frame so we
        // never paint two tooltips at the same y.
        this.hoverTime.classList.add('hidden');
        if (timeEl) timeEl.textContent = timeStr;

        // Position the wrapper centered on the cursor x, but clamp into
        // the progress-bar bounds so the tile never overhangs the player
        // chrome. CSS owns the translateX(-50%); we only set `left`.
        const tileW = state === 'ready' && sp ? sp.tile_w || 160 : 160;
        const halfW = tileW / 2;
        const clampedX = Math.max(halfW + 4, Math.min(rect.width - halfW - 4, x));
        wrap.style.left = `${clampedX}px`;

        // State paint. `ready` swaps in the real sprite frame; `pending`
        // keeps the CSS placeholder + shimmer.
        if (state === 'ready' && sp && tileH && frame) {
            const interval =
                sp.interval_sec ||
                (Number.isFinite(sp.duration_sec) && sp.frames > 0
                    ? sp.duration_sec / sp.frames
                    : 1);
            const sourceSec = ratio * (sp.duration_sec || this.video.duration);
            const idx = Math.max(
                0,
                Math.min((sp.frames || 1) - 1, Math.floor(sourceSec / interval)),
            );
            const col = idx % (sp.cols || 1);
            const row = Math.floor(idx / (sp.cols || 1));
            frame.style.width = `${tileW}px`;
            frame.style.height = `${tileH}px`;
            frame.style.backgroundPosition = `-${col * tileW}px -${row * tileH}px`;
        }
        // No data-state mutation here — it was set during fetch/poll. We
        // just reveal the wrapper.
        wrap.classList.remove('hidden');
    }

    _hideHoverPreview() {
        this.hoverTime.classList.add('hidden');
        if (this.spritePreview) this.spritePreview.classList.add('hidden');
    }

    /**
     * Fetch the per-clip sprite metadata sidecar. Three terminal states:
     *
     *   - `ready`     — sprite + meta exist on disk; render full preview.
     *   - `pending`   — feature enabled but sidecar hasn't generated yet
     *                   (404 / 202). Show the "Generating preview…"
     *                   shimmer and poll on a backoff schedule, plus
     *                   listen for the matching WS `seekbar_done` event
     *                   so a sidecar finish flips the state instantly.
     *   - `disabled`  — feature off, peer row, or no file id. Hide the
     *                   wrapper completely; the native time-only tooltip
     *                   takes over.
     */
    async _fetchSpriteMeta(file) {
        const wrap = this.spritePreview;
        // Cancel any in-flight poll from a previous clip before starting
        // a new one. The Symbol-based `_spriteReq` token already makes
        // late image-load callbacks no-op; clearing the timer kills any
        // pending retry.
        if (this._spritePollTimer) {
            clearTimeout(this._spritePollTimer);
            this._spritePollTimer = null;
        }
        this._spriteFileId = file?.id ? String(file.id) : null;
        this._sprite = null;
        this._spriteTileH = 0;
        this._spriteState = 'disabled';

        if (!wrap) return;
        wrap.classList.add('hidden');
        wrap.dataset.state = 'disabled';

        const id = file?.id;
        if (!id) return;
        // Layer 1 — peer rows skipped (federated sprite proxy is a
        // follow-up). Local rows fetch the sidecar once per clip; the
        // CSS `[data-state="disabled"]` rule keeps the wrapper out of
        // the layout entirely so peer videos just get the time-only
        // tooltip we shipped before sprites existed.
        if (file.peer_id && file.peer_id !== 'self') return;

        // Feature flag — module-scoped cached so repeated opens don't
        // hammer /api/config. Invalidated by WS `seekbar_config_changed`
        // / `config_updated` so a toggle takes effect on next open
        // without a page reload.
        const enabled = await _getSeekbarEnabled();
        if (!enabled) return;

        // Token + state flip into "pending" so the spinner overlay paints
        // while the meta request races with whatever sidecar work is in
        // flight. If meta arrives ready, we'll flip to "ready" below.
        const req = (this._spriteReq = Symbol('sprite-fetch'));
        this._spriteState = 'pending';
        wrap.dataset.state = 'pending';

        // Polling schedule for the 404 / pending branch. Bounded so we
        // don't poll forever for a clip the sidecar can't process at
        // all (missing source file, unsupported codec, etc.). Each
        // attempt is fire-and-forget; the WS listener below can short-
        // circuit if a sidecar finish fires before our next tick.
        const POLL_DELAYS_MS = [4000, 8000, 16000, 32000, 60000];
        let pollIdx = 0;

        const tryFetch = async () => {
            try {
                const r = await fetch(`/api/seekbar/meta/${encodeURIComponent(id)}`, {
                    credentials: 'same-origin',
                });
                if (this._spriteReq !== req) return; // clip switched
                if (r.status === 200) {
                    const meta = await r.json();
                    if (this._spriteReq !== req || !meta) return;
                    this._sprite = meta;
                    // Pre-load the sprite image to learn the real
                    // tile_h, then flip the state to ready. Until then
                    // we stay on "pending" so the spinner keeps
                    // surfacing — avoids the brief "checkered empty
                    // tile" flash that would happen if we flipped early.
                    const img = new Image();
                    img.onload = () => {
                        if (this._spriteReq !== req) return;
                        this._spriteTileH =
                            meta.tile_h || (meta.rows > 0 ? img.naturalHeight / meta.rows : 0);
                        if (this.spriteFrame) {
                            this.spriteFrame.style.backgroundImage = `url(/api/seekbar/sprite/${encodeURIComponent(id)})`;
                            this.spriteFrame.style.backgroundSize = `${img.naturalWidth}px ${img.naturalHeight}px`;
                        }
                        this._spriteState = 'ready';
                        if (wrap) wrap.dataset.state = 'ready';
                        this._renderFilmstrip();
                    };
                    img.onerror = () => {
                        if (this._spriteReq !== req) return;
                        // Image 404 even though meta was 200 — sidecar
                        // race where the JSON landed before the rename.
                        // Re-poll, the second pass usually succeeds.
                        this._sprite = null;
                        this._scheduleSpritePoll(req, tryFetch, POLL_DELAYS_MS, pollIdx++);
                    };
                    img.src = `/api/seekbar/sprite/${encodeURIComponent(id)}`;
                    return;
                }
                if (r.status === 404 || r.status === 204 || r.status === 202) {
                    // Pending — sidecar hasn't finished yet. Keep the
                    // spinner up and poll on a backoff. The WS listener
                    // in _wireOnce will also nudge tryFetch on a
                    // matching `seekbar_done`.
                    this._scheduleSpritePoll(req, tryFetch, POLL_DELAYS_MS, pollIdx++);
                    return;
                }
                // Other 4xx/5xx — disable so the operator just gets the
                // time-only tooltip. Don't burn battery polling.
                this._spriteState = 'disabled';
                if (wrap) wrap.dataset.state = 'disabled';
            } catch {
                // Network blip → schedule another poll.
                this._scheduleSpritePoll(req, tryFetch, POLL_DELAYS_MS, pollIdx++);
            }
        };
        this._spriteRetry = tryFetch;
        tryFetch();
    }

    /** Schedule the next sprite poll on a clamped backoff. */
    _scheduleSpritePoll(req, fn, delays, idx) {
        if (this._spriteReq !== req) return;
        if (idx >= delays.length) return; // gave up; only WS can revive
        if (this._spritePollTimer) clearTimeout(this._spritePollTimer);
        this._spritePollTimer = setTimeout(() => {
            this._spritePollTimer = null;
            if (this._spriteReq !== req) return;
            fn();
        }, delays[idx]);
    }

    _onTimeUpdate() {
        const v = this.video;
        this.curTime.textContent = formatTime(v.currentTime);
        if (Number.isFinite(v.duration) && v.duration > 0) {
            const pct = Math.max(0, Math.min(100, (v.currentTime / v.duration) * 100));
            this.progressFill.style.width = `${pct}%`;
            this.progressDot.style.left = `${pct}%`;
            this._updateFilmstripHighlight();
            // Save throttled progress; clear once we're past 95%.
            if (this._storageKey) {
                if (v.currentTime / v.duration > 0.95) {
                    localStorage.removeItem(this._storageKey);
                } else {
                    const now = Date.now();
                    if (now - this._lastSavedAt >= 2000) {
                        this._lastSavedAt = now;
                        try {
                            localStorage.setItem(this._storageKey, String(v.currentTime));
                        } catch {}
                    }
                }
            }
        }
    }

    _renderBuffered() {
        const v = this.video;
        if (!this.bufferedLayer || !Number.isFinite(v.duration) || v.duration <= 0) return;
        let html = '';
        for (let i = 0; i < v.buffered.length; i++) {
            const start = (v.buffered.start(i) / v.duration) * 100;
            const end = (v.buffered.end(i) / v.duration) * 100;
            html += `<div class="absolute top-0 h-full bg-white/50 rounded-full" style="left:${start}%;width:${end - start}%"></div>`;
        }
        this.bufferedLayer.innerHTML = html;
    }

    _refreshPlayIcons() {
        const playing = !this.video.paused && !this.video.ended;
        this.playBtn.innerHTML = playing
            ? '<i class="ri-pause-fill text-2xl"></i>'
            : '<i class="ri-play-fill text-2xl"></i>';
        this.playBtn.setAttribute(
            'aria-label',
            playing ? i18nT('viewer.video.pause', 'Pause') : i18nT('viewer.video.play', 'Play'),
        );
        if (playing) this.centerPlay.classList.add('hidden');
        else this.centerPlay.classList.remove('hidden');
    }

    _refreshVolumeUi() {
        const v = this.video.muted ? 0 : this.video.volume;
        // Avoid stomping the slider while the user is dragging it.
        if (document.activeElement !== this.volume) {
            this.volume.value = String(v);
        }
        let icon;
        if (this.video.muted || this.video.volume === 0) icon = 'ri-volume-mute-line';
        else if (this.video.volume < 0.5) icon = 'ri-volume-down-line';
        else icon = 'ri-volume-up-line';
        this.muteBtn.innerHTML = `<i class="${icon} text-lg"></i>`;
    }

    _setVolume(v) {
        this.video.volume = Math.max(0, Math.min(1, v));
        if (this.video.volume > 0 && this.video.muted) this.video.muted = false;
        if (this.video.volume === 0 && !this.video.muted) this.video.muted = true;
    }

    _setSpeed(rate) {
        this.video.playbackRate = rate;
        try {
            localStorage.setItem(SPEED_LS_KEY, String(rate));
        } catch {}
        // _refreshSpeedUi() runs from the ratechange handler.
    }

    _refreshSpeedUi() {
        const rate = this.video.playbackRate || 1;
        this.speedBtn.textContent = rate === 1 ? '1x' : `${rate}x`;
        this.speedOpts.forEach((opt) => {
            const r = parseFloat(opt.dataset.speed);
            const active = r === rate;
            opt.classList.toggle('text-tg-blue', active);
            const check = opt.querySelector('i.ri-check-line');
            if (active && !check) {
                opt.insertAdjacentHTML('beforeend', '<i class="ri-check-line"></i>');
            } else if (!active && check) {
                check.remove();
            }
        });
    }

    _refreshFsIcon() {
        if (!this.fsBtn) return;
        const inFs = !!document.fullscreenElement;
        this.fsBtn.innerHTML = inFs
            ? '<i class="ri-fullscreen-exit-line text-lg"></i>'
            : '<i class="ri-fullscreen-line text-lg"></i>';
    }

    // ---- visibility / spinner / error --------------------------------------

    _controlsVisible() {
        return (
            this.controls.style.opacity !== '0' && !this.controls.classList.contains('opacity-0')
        );
    }

    _showControls(force = false) {
        this.controls.style.opacity = '1';
        this.container.style.cursor = '';
        if (!force && SUPPORTS_HOVER && !this.video.paused) {
            this._scheduleHide();
        }
    }

    _scheduleHide(delay) {
        // Honour the user's "Hide controls after" setting on the
        // implicit-default code path; explicit callers (e.g. _scheduleHide(800)
        // for a fast post-seek hide) keep their literal value.
        if (delay === undefined) {
            const cfg = parseInt(localStorage.getItem('viewer-hide-delay'), 10);
            delay = Number.isFinite(cfg) && cfg > 0 ? cfg * 1000 : HOVER_TIMEOUT_MS;
        }
        return this.__scheduleHide(delay);
    }

    __scheduleHide(delay = HOVER_TIMEOUT_MS) {
        if (!SUPPORTS_HOVER) return; // touch devices: keep visible
        if (this.video.paused) return; // paused: keep visible
        if (this._hideTimer) clearTimeout(this._hideTimer);
        this._hideTimer = setTimeout(() => {
            if (this.video.paused) return;
            // Don't hide while the speed menu is open.
            if (!this.speedMenu.classList.contains('hidden')) return;
            this.controls.style.opacity = '0';
            this.container.style.cursor = 'none';
        }, delay);
    }

    _showSpinner(on) {
        this.spinner.classList.toggle('hidden', !on);
    }

    _showError() {
        const err = this.video.error;
        // Mobile Safari (and occasionally Chrome on Android) fires a
        // spurious MEDIA_ERR_SRC_NOT_SUPPORTED right after the first
        // `src=` assignment, even when the URL serves a perfectly valid
        // MP4. The user-visible symptom is "Error 4: playback failed →
        // tap Retry → plays fine," because the retry button does
        // exactly the same thing the auto-retry below does: re-assign
        // the same URL and re-call load(). Silently retry once before
        // surfacing the overlay so the user never sees the flash.
        //
        // We bound retries (1 per clip) to avoid masking a genuine
        // unsupported-codec failure that would otherwise loop forever.
        const code = err?.code;
        const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
        if (
            code === MEDIA_ERR_SRC_NOT_SUPPORTED &&
            this._currentUrl &&
            (this._errorRetries || 0) < 1
        ) {
            this._errorRetries = (this._errorRetries || 0) + 1;
            try {
                this.video.src = this._currentUrl;
            } catch {}
            try {
                this.video.load();
            } catch {}
            return;
        }
        const msg = err
            ? `Error ${err.code}: ${err.message || 'playback failed'}`
            : 'Playback failed';
        this.errorMsg.textContent = msg;
        this.errorOverlay.classList.remove('hidden');
        this.errorOverlay.classList.add('flex');
        this._showSpinner(false);
    }

    _hideError() {
        this.errorOverlay.classList.add('hidden');
        this.errorOverlay.classList.remove('flex');
    }

    /**
     * Build the horizontal filmstrip from the loaded sprite sheet.
     * Called once per clip when the sprite image load succeeds.
     * Each cell is a background-position crop of the same sprite URL.
     */
    _renderFilmstrip() {
        const track = this.filmstripTrack;
        const wrap = this.filmstrip;
        const sp = this._sprite;
        if (!track || !wrap || !sp || this._spriteState !== 'ready') return;
        const id = this._spriteFileId;
        if (!id) return;
        const frames = sp.frames || 0;
        if (frames < 3) return; // not useful for very short clips
        const tileW = sp.tile_w || 160;
        const tileH = this._spriteTileH || sp.tile_h || 90;
        const cols = sp.cols || 1;
        const interval =
            sp.interval_sec ||
            (Number.isFinite(sp.duration_sec) && sp.frames > 0
                ? sp.duration_sec / sp.frames
                : 1);
        const spriteUrl = `/api/seekbar/sprite/${encodeURIComponent(id)}`;

        // Thumbnail display size: responsive height, aspect-ratio width.
        const thumbH = window.innerWidth <= 640 ? 44 : 56;
        const thumbW = Math.max(60, Math.round(thumbH * (tileW / tileH)));
        const scale = thumbH / tileH;
        const bgsW = Math.round(tileW * cols * scale);
        const bgsH = Math.round(tileH * Math.ceil(frames / cols) * scale);

        // Cache float label ref for use in highlight updates.
        if (!this._filmstripTimeFloat) {
            this._filmstripTimeFloat = document.getElementById('filmstrip-time-float');
        }

        let html = '';
        for (let i = 0; i < frames; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const bpX = -Math.round(col * tileW * scale);
            const bpY = -Math.round(row * tileH * scale);
            const sec = i * interval;
            const timeStr = formatTime(sec);
            html +=
                `<div class="filmstrip-thumb" style="width:${thumbW}px;height:${thumbH}px" data-idx="${i}" data-sec="${sec.toFixed(2)}" role="option" aria-label="${timeStr}">` +
                `<div class="filmstrip-thumb-inner" style="background-image:url(${spriteUrl});background-size:${bgsW}px ${bgsH}px;background-position:${bpX}px ${bpY}px"></div>` +
                `</div>`;
        }
        track.innerHTML = html;
        wrap.classList.remove('hidden');

        // Click-to-seek (event delegation).
        track.onclick = (e) => {
            const thumb = e.target.closest?.('.filmstrip-thumb');
            if (!thumb) return;
            const sec = parseFloat(thumb.dataset.sec);
            if (!Number.isFinite(sec)) return;
            if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
                this.video.currentTime = Math.min(sec, this.video.duration);
            }
        };

        // Scroll-arrow buttons.
        if (this.filmstripPrev) {
            this.filmstripPrev.onclick = () =>
                track.scrollBy({ left: -Math.round(track.clientWidth * 0.8), behavior: 'smooth' });
        }
        if (this.filmstripNext) {
            this.filmstripNext.onclick = () =>
                track.scrollBy({ left: Math.round(track.clientWidth * 0.8), behavior: 'smooth' });
        }

        this._filmstripLastIdx = -1;
        this._updateFilmstripHighlight();
    }

    /** Highlight the filmstrip cell that matches the current playback position. */
    _updateFilmstripHighlight() {
        if (!this.filmstripTrack || !this._sprite || this._spriteState !== 'ready') return;
        if (this.filmstrip?.classList.contains('hidden')) return;
        const sp = this._sprite;
        const v = this.video;
        if (!Number.isFinite(v.duration) || v.duration <= 0) return;
        const interval =
            sp.interval_sec ||
            (Number.isFinite(sp.duration_sec) && sp.frames > 0
                ? sp.duration_sec / sp.frames
                : 1);
        const idx = Math.max(0, Math.min((sp.frames || 1) - 1, Math.floor(v.currentTime / interval)));
        if (idx === this._filmstripLastIdx) return;
        this._filmstripLastIdx = idx;
        const thumbs = this.filmstripTrack.children;
        for (let i = 0; i < thumbs.length; i++) {
            thumbs[i].classList.toggle('current', i === idx);
        }
        // Scroll current thumb into view within the track (no page scroll).
        const current = thumbs[idx];
        if (current) {
            const tLeft = this.filmstripTrack.scrollLeft;
            const tW = this.filmstripTrack.clientWidth;
            const cLeft = current.offsetLeft;
            const cW = current.offsetWidth;
            if (cLeft < tLeft + 30 || cLeft + cW > tLeft + tW - 30) {
                this.filmstripTrack.scrollTo({
                    left: Math.max(0, cLeft - tW / 2 + cW / 2),
                    behavior: 'smooth',
                });
            }
        }

        // Update floating time label above current thumb.
        // The float is absolutely positioned inside #video-filmstrip, so we
        // measure `left` relative to the filmstrip container element.
        const float = this._filmstripTimeFloat;
        if (float && current && this.filmstrip) {
            float.textContent = formatTime(idx * interval);
            const stripRect = this.filmstrip.getBoundingClientRect();
            const thumbRect = current.getBoundingClientRect();
            const centerX = thumbRect.left - stripRect.left + thumbRect.width / 2;
            float.style.left = `${centerX}px`;
            float.classList.add('visible');
        } else if (float) {
            float.classList.remove('visible');
        }
    }
}

// ============================================================================
// Close + boot-time wiring
// ============================================================================

export function closeMediaViewer() {
    const modal = document.getElementById('media-modal');
    // If the user is closing while a video is mid-playback, hand off to
    // the mini-player BEFORE we tear the modal video down so playback
    // continues seamlessly. Opt-in: only shrinks when the user has set
    // `viewer-shrink-on-close=1` (Settings → Video Player), so the
    // existing close-stops-everything behaviour stays the default.
    const big = document.getElementById('modal-video');
    const isVideoLive = big && !big.paused && (big.currentSrc || big.src);
    if (
        isVideoLive &&
        localStorage.getItem('viewer-shrink-on-close') === '1' &&
        typeof window.tgdlShrinkToMini === 'function'
    ) {
        try {
            window.tgdlShrinkToMini();
        } catch {}
    }
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (videoPlayer) videoPlayer.unload();
    const image = document.getElementById('modal-image');
    if (image) image.removeAttribute('src');
    // Stop / blank every other preview container so an audio clip or
    // PDF iframe doesn't keep loading in the background after close.
    _resetAllPreviewContainers();
    // Drop review-mode wiring so the next normal open doesn't render
    // the action toolbar by mistake.
    _reviewActions = null;
    _reviewMetaRender = null;
    document.getElementById('viewer-review-bar')?.classList.add('hidden');
    document.getElementById('viewer-review-actions')?.classList.add('hidden');
    document.getElementById('viewer-review-meta')?.classList.add('hidden');
}

export function setupViewerEvents() {
    document.getElementById('modal-close')?.addEventListener('click', closeMediaViewer);
    document.getElementById('modal-prev')?.addEventListener('click', () => navigateMedia(-1));
    document.getElementById('modal-next')?.addEventListener('click', () => navigateMedia(1));

    // Share button — opens the share-link sheet for the current file.
    // Lazy-import keeps the module out of the cold-load path; it only
    // gets fetched the first time an admin opens this sheet.
    document.getElementById('modal-share')?.addEventListener('click', async () => {
        const file = state.files[state.currentFileIndex];
        if (!file?.id) {
            showToast(i18nT('share.error.no_id', 'No file selected'), 'error');
            return;
        }
        try {
            const m = await import('./share.js');
            await m.openShareSheet({ downloadId: file.id, fileName: file.name });
        } catch (e) {
            console.error('share sheet load:', e);
            showToast(i18nT('share.error.load', 'Could not open Share — try again'), 'error');
        }
    });

    // Modal-level fullscreen button (top-right). Picks the smallest
    // active container so we don't drag the full modal chrome (counter
    // pill, prev/next buttons) into the fullscreen surface unless we
    // have to. Walks the same container ids as the dispatcher; first
    // visible wins, falls back to the whole modal.
    document.getElementById('modal-fullscreen-btn')?.addEventListener('click', async () => {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                return;
            }
            const candidates = [
                'video-container',
                'image-container',
                'pdf-container',
                'text-container',
                'code-container',
                'markdown-container',
                'archive-container',
                'audio-container',
                'office-container',
                'fallback-container',
            ];
            let target = null;
            for (const id of candidates) {
                const el = document.getElementById(id);
                if (el && !el.classList.contains('hidden')) {
                    target = el;
                    break;
                }
            }
            if (!target) target = document.getElementById('media-modal');
            await target?.requestFullscreen?.();
        } catch (e) {
            showToast(
                i18nTf(
                    'viewer.video.fullscreen_failed',
                    { msg: e.message },
                    `Fullscreen unavailable: ${e.message}`,
                ),
                'error',
            );
        }
    });

    // Click outside the speed menu closes it. Wired ONCE here so it doesn't
    // accumulate per video open.
    document.addEventListener('pointerdown', (ev) => {
        const menu = document.getElementById('video-speed-menu');
        const trigger = document.getElementById('video-settings-btn');
        if (!menu || menu.classList.contains('hidden')) return;
        if (menu.contains(ev.target) || trigger?.contains(ev.target)) return;
        menu.classList.add('hidden');
    });

    // Wrap-toggle for the text + code preview panes. State is shared per
    // session (localStorage) so the operator's wrap preference survives
    // navigation between files in the same modal session.
    const wrapKey = 'viewer-text-wrap';
    function _applyWrapPref() {
        const wrap = localStorage.getItem(wrapKey) === '1';
        for (const id of ['text-block', 'code-block']) {
            const el = document.getElementById(id);
            if (!el) continue;
            // Toggle the wrap modifier class on the <pre> ancestor so
            // both the plain-text <pre> and the highlight.js code <pre>
            // (which wraps the <code> in #code-block) flip together.
            const target = el.tagName === 'PRE' ? el : el.parentElement;
            if (target) target.classList.toggle('wrap', wrap);
        }
    }
    _applyWrapPref();
    for (const id of ['text-wrap-toggle', 'code-wrap-toggle']) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.addEventListener('click', () => {
            const cur = localStorage.getItem(wrapKey) === '1';
            localStorage.setItem(wrapKey, cur ? '0' : '1');
            _applyWrapPref();
        });
    }

    // Keyboard shortcuts. Only fire when the modal is open AND focus isn't
    // inside an input / textarea / contenteditable. Esc / arrow nav stay
    // global; everything video-specific is delegated to the player.
    document.addEventListener('keydown', (e) => {
        if (document.getElementById('media-modal').classList.contains('hidden')) return;
        const tag = (e.target?.tagName || '').toLowerCase();
        if (
            tag === 'input' ||
            tag === 'textarea' ||
            tag === 'select' ||
            e.target?.isContentEditable
        )
            return;

        if (e.key === 'Escape') {
            closeMediaViewer();
            return;
        }
        // Don't gobble arrow-keys for nav while a video is loaded — those
        // shortcuts mean "seek" inside the player. Use the modal nav only
        // for image (and other) media.
        const videoActive = !document
            .getElementById('video-container')
            .classList.contains('hidden');
        if (!videoActive) {
            if (e.key === 'ArrowLeft') {
                navigateMedia(-1);
                return;
            }
            if (e.key === 'ArrowRight') {
                navigateMedia(1);
                return;
            }
        }

        // Review-mode action shortcuts — match by single-letter key
        // (case-insensitive) so j/k/w/d feel native. Skip when modifiers
        // are held so Cmd/Ctrl combos still bubble to the browser.
        if (
            _reviewActions?.length &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            e.key &&
            e.key.length === 1
        ) {
            const want = e.key.toLowerCase();
            const action = _reviewActions.find(
                (a) => typeof a.key === 'string' && a.key.toLowerCase() === want,
            );
            if (action) {
                e.preventDefault();
                _runReviewAction(action);
                return;
            }
        }

        if (videoActive && videoPlayer) {
            if (videoPlayer.handleKey(e)) {
                e.preventDefault();
                return;
            }
        }
    });

    // Touch / pen gestures: swipe left/right = prev/next, drag down on the
    // empty area below the controls = dismiss (Telegram-style).
    const swipeArea = document.getElementById('modal-swipe');
    if (swipeArea) {
        attachSwipe(swipeArea, {
            onSwipe: (dir) => {
                // Swiping while dragging the seek bar would jump clips. The
                // controls' pointerdown already stops bubbling, so this is
                // belt-and-braces: the pointer-up fires on the controls
                // and never reaches the swipe handler in the first place.
                navigateMedia(dir === 'left' ? 1 : -1);
            },
            threshold: 60,
        });
        attachDragDismiss(swipeArea, {
            onDismiss: closeMediaViewer,
            threshold: 100,
        });
    }
}

function navigateMedia(dir) {
    // Walk through the active filter, not the unfiltered state.files —
    // tapping → in the Photos filter shouldn't jump to a video.
    const currentFilter = state.currentFilter || 'all';
    const visible =
        currentFilter === 'all' ? state.files : state.files.filter((f) => f.type === currentFilter);

    const currentFile = state.files[state.currentFileIndex];
    const visibleIndex = currentFile ? visible.indexOf(currentFile) : -1;
    if (visibleIndex < 0) {
        const newIndex = state.currentFileIndex + dir;
        if (newIndex >= 0 && newIndex < state.files.length) openMediaViewer(newIndex);
        return;
    }
    const nextVisible = visible[visibleIndex + dir];
    if (!nextVisible) return;
    const newIndex = state.files.indexOf(nextVisible);
    if (newIndex >= 0 && newIndex < state.files.length) {
        openMediaViewer(newIndex);
    }
}
