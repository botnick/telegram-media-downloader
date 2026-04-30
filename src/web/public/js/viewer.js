import { state } from './store.js';
import { api } from './api.js';
import { escapeHtml, getFileIcon, formatDate, showToast } from './utils.js';
import { attachSwipe, attachDragDismiss } from './gestures.js';
import { tf as i18nTf, t as i18nT } from './i18n.js';

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

export function openMediaViewer(index) {
    state.currentFileIndex = index;
    const file = state.files[index];
    if (!file) return;

    const modal = document.getElementById('media-modal');
    const imageContainer = document.getElementById('image-container');
    const image = document.getElementById('modal-image');
    const videoContainer = document.getElementById('video-container');
    const url = `/files/${encodeURIComponent(file.fullPath)}?inline=1`;

    // Reset views.
    imageContainer.classList.add('hidden');
    videoContainer.classList.add('hidden');

    // Always tear the previous clip down BEFORE swapping in the new src so a
    // 100 MB video doesn't keep streaming in the background after you flip
    // to an image.
    resetZoom();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (videoPlayer) videoPlayer.unload();
    image.removeAttribute('src');

    if (file.type === 'images') {
        image.src = url;
        imageContainer.classList.remove('hidden');
        setupImageZoom();
    } else if (file.type === 'videos') {
        videoContainer.classList.remove('hidden');
        if (!videoPlayer) videoPlayer = new VideoPlayer();
        videoPlayer.load(url, file.fullPath);
    } else {
        window.open(url, '_blank');
        return;
    }

    document.getElementById('modal-filename').textContent = file.name;
    document.getElementById('modal-meta').textContent = `${file.sizeFormatted} • ${formatDate(file.modified)}`;
    document.getElementById('modal-counter').textContent = `${index + 1} / ${state.files.length}`;
    document.getElementById('modal-download').href = url;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    prefetchNeighbor(index + 1);
}

let _prefetchLink = null;
function prefetchNeighbor(nextIndex) {
    const next = state.files[nextIndex];
    if (!next || next.type !== 'images') {
        if (_prefetchLink) { _prefetchLink.remove(); _prefetchLink = null; }
        return;
    }
    const href = `/files/${encodeURIComponent(next.fullPath)}?inline=1`;
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

const SUPPORTS_HOVER = typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: hover)').matches
    : true;

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
                const isLeft = (e.clientX - rect.left) < rect.width / 2;
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
                showToast(i18nTf('viewer.video.pip_failed', { msg: e.message }, `PiP unavailable: ${e.message}`), 'error');
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
                            try { openMediaViewer(idx + 1); } catch {}
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
    }

    // ----- public lifecycle --------------------------------------------------

    /** Load a new clip. Resets all UI BEFORE any event fires. */
    load(url, fileFullPath) {
        this._currentUrl = url;
        this._storageKey = `video-progress-${fileFullPath}`;
        this._resumePlayed = false;
        this._lastSavedAt = 0;

        // Pause + rewind the OLD source first so a stale ontimeupdate /
        // onloadedmetadata can't fire after the new clip's UI reset and
        // re-paint the seek bar with the previous clip's position. Without
        // this, switching clips from the gallery left the playhead and
        // play-icon mid-track.
        try { this.video.pause(); } catch {}
        try { this.video.currentTime = 0; } catch {}
        try { this.video.onloadedmetadata = null; } catch {}

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
        try { this.video.loop = localStorage.getItem('viewer-loop') === '1'; } catch {}

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
            try { this.video.currentTime = time; } catch {}
            const ts = formatTime(time);
            showToast(i18nTf('viewer.video.resumed', { time: ts }, `Resumed at ${ts}`));
        };
        this.video.onloadedmetadata = applyResume;

        // Swap the source.
        this.video.src = url;
        try { this.video.load(); } catch {}

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
        try { this.video.pause(); } catch {}
        try { this.video.removeAttribute('src'); } catch {}
        try { this.video.load(); } catch {}
        // Drop the metadata-loaded handler so a stale resume from the
        // previous clip can't seek the next file to the wrong position.
        try { this.video.onloadedmetadata = null; } catch {}
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
        this._currentUrl = null;
        this._storageKey = null;
        this._resumePlayed = false;
        if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
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
            showToast(i18nTf('viewer.video.fullscreen_failed', { msg: e.message }, `Fullscreen unavailable: ${e.message}`), 'error');
        }
    }

    /** Routes a viewer-scoped keydown event. Returns true if handled. */
    handleKey(e) {
        const v = this.video;
        switch (e.key) {
            case ' ':
            case 'k':
            case 'K':
                this.togglePlay(); return true;
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
                this._setVolume(Math.min(1, v.volume + 0.05)); return true;
            case 'ArrowDown':
                this._setVolume(Math.max(0, v.volume - 0.05)); return true;
            case 'm':
            case 'M':
                v.muted = !v.muted;
                if (!v.muted && v.volume === 0) this._setVolume(0.5);
                return true;
            case 'f':
            case 'F':
                this.toggleFullscreen(); return true;
            case ',':
            case '<':
                this._setSpeed(Math.max(0.25, +(v.playbackRate - 0.25).toFixed(2))); return true;
            case '.':
            case '>':
                this._setSpeed(Math.min(2, +(v.playbackRate + 0.25).toFixed(2))); return true;
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
            try { bar.setPointerCapture?.(e.pointerId); } catch {}
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
            try { bar.releasePointerCapture?.(e.pointerId); } catch {}
            if (this._wasPlayingBeforeDrag) this.video.play().catch(() => {});
        };
        bar.onpointerup = endDrag;
        bar.onpointercancel = endDrag;
    }

    _renderHoverPreview(clientX) {
        if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
        const rect = this.progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        this.hoverTime.textContent = formatTime(ratio * this.video.duration);
        this.hoverTime.style.left = `${(clientX - rect.left)}px`;
        this.hoverTime.classList.remove('hidden');
    }

    _hideHoverPreview() {
        this.hoverTime.classList.add('hidden');
    }

    _onTimeUpdate() {
        const v = this.video;
        this.curTime.textContent = formatTime(v.currentTime);
        if (Number.isFinite(v.duration) && v.duration > 0) {
            const pct = Math.max(0, Math.min(100, (v.currentTime / v.duration) * 100));
            this.progressFill.style.width = `${pct}%`;
            this.progressDot.style.left = `${pct}%`;
            // Save throttled progress; clear once we're past 95%.
            if (this._storageKey) {
                if (v.currentTime / v.duration > 0.95) {
                    localStorage.removeItem(this._storageKey);
                } else {
                    const now = Date.now();
                    if (now - this._lastSavedAt >= 2000) {
                        this._lastSavedAt = now;
                        try { localStorage.setItem(this._storageKey, String(v.currentTime)); } catch {}
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
        this.playBtn.setAttribute('aria-label',
            playing ? i18nT('viewer.video.pause', 'Pause') : i18nT('viewer.video.play', 'Play'));
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
        try { localStorage.setItem(SPEED_LS_KEY, String(rate)); } catch {}
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
        return this.controls.style.opacity !== '0' && !this.controls.classList.contains('opacity-0');
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
            delay = (Number.isFinite(cfg) && cfg > 0) ? cfg * 1000 : HOVER_TIMEOUT_MS;
        }
        return this.__scheduleHide(delay);
    }

    __scheduleHide(delay = HOVER_TIMEOUT_MS) {
        if (!SUPPORTS_HOVER) return;          // touch devices: keep visible
        if (this.video.paused) return;        // paused: keep visible
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
        const msg = err ? `Error ${err.code}: ${err.message || 'playback failed'}` : 'Playback failed';
        this.errorMsg.textContent = msg;
        this.errorOverlay.classList.remove('hidden');
        this.errorOverlay.classList.add('flex');
        this._showSpinner(false);
    }

    _hideError() {
        this.errorOverlay.classList.add('hidden');
        this.errorOverlay.classList.remove('flex');
    }
}

// ============================================================================
// Close + boot-time wiring
// ============================================================================

export function closeMediaViewer() {
    const modal = document.getElementById('media-modal');
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (videoPlayer) videoPlayer.unload();
    const image = document.getElementById('modal-image');
    if (image) image.removeAttribute('src');
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
    // have to:
    //   - video showing  → #video-container (custom controls go FS too)
    //   - image showing  → #image-container (zoom/pan stays scoped)
    //   - neither        → #media-modal (defensive fallback)
    document.getElementById('modal-fullscreen-btn')?.addEventListener('click', async () => {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                return;
            }
            const video = document.getElementById('video-container');
            const image = document.getElementById('image-container');
            const target = (video && !video.classList.contains('hidden')) ? video
                : (image && !image.classList.contains('hidden')) ? image
                : document.getElementById('media-modal');
            await target?.requestFullscreen?.();
        } catch (e) {
            showToast(i18nTf('viewer.video.fullscreen_failed', { msg: e.message }, `Fullscreen unavailable: ${e.message}`), 'error');
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

    // Keyboard shortcuts. Only fire when the modal is open AND focus isn't
    // inside an input / textarea / contenteditable. Esc / arrow nav stay
    // global; everything video-specific is delegated to the player.
    document.addEventListener('keydown', (e) => {
        if (document.getElementById('media-modal').classList.contains('hidden')) return;
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;

        if (e.key === 'Escape') { closeMediaViewer(); return; }
        // Don't gobble arrow-keys for nav while a video is loaded — those
        // shortcuts mean "seek" inside the player. Use the modal nav only
        // for image (and other) media.
        const videoActive = !document.getElementById('video-container').classList.contains('hidden');
        if (!videoActive) {
            if (e.key === 'ArrowLeft') { navigateMedia(-1); return; }
            if (e.key === 'ArrowRight') { navigateMedia(1); return; }
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
    const visible = currentFilter === 'all'
        ? state.files
        : state.files.filter(f => f.type === currentFilter);

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
