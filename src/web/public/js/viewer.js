import { state } from './store.js';
import { api } from './api.js';
import { escapeHtml, getFileIcon, formatDate, showToast } from './utils.js';
import { attachSwipe, attachDragDismiss } from './gestures.js';
import { tf as i18nTf } from './i18n.js';

// ============ Media Viewer ============
let zoomState = { scale: 1, panning: false, pointX: 0, pointY: 0, startX: 0, startY: 0 };

export function openMediaViewer(index) {
    state.currentFileIndex = index;
    const file = state.files[index];
    if (!file) return;
    
    const modal = document.getElementById('media-modal');
    const imageContainer = document.getElementById('image-container');
    const image = document.getElementById('modal-image');
    const videoContainer = document.getElementById('video-container');
    const video = document.getElementById('modal-video');
    const url = `/files/${encodeURIComponent(file.fullPath)}?inline=1`;
    
    // Reset Views
    imageContainer.classList.add('hidden');
    videoContainer.classList.add('hidden');

    // Reset States — fully unload the previous media so it stops
    // streaming/buffering in the background. Without this, swiping
    // from a 100 MB video to an image leaves the video network-fetching
    // and pinned in memory.
    resetZoom();
    if (document.fullscreenElement) document.exitFullscreen();
    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch {}
    image.removeAttribute('src');

    if (file.type === 'images') {
        image.src = url;
        imageContainer.classList.remove('hidden');
        setupImageZoom();
    } else if (file.type === 'videos') {
        video.src = url;
        videoContainer.classList.remove('hidden');
        setupVideoPlayer(file.fullPath);
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

    // Warm the cache for the NEXT image only (not all of them — that
    // would defeat the lazy-load gains in the gallery). When the user
    // hits → / swipes left, the file is already in the browser cache
    // so the modal updates instantly. Skipped for non-image media to
    // avoid pulling multi-megabyte video files the user may never view.
    prefetchNeighbor(index + 1);
}

// Track the currently-prefetched URL so we can swap the <link> instead of
// piling up a new one on every navigation step.
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
    // ... (Zoom logic from original app.js can be simplified or omitted for brevity if no major changes)
    // For now, keeping it basic as the user focused on Modules & Video Resume
    img.onwheel = (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        zoomState.scale = Math.min(Math.max(1, zoomState.scale * delta), 5);
        img.style.transform = `scale(${zoomState.scale})`;
    };
}

// ============ Video Resume Feature ============
function setupVideoPlayer(fileId) {
    const video = document.getElementById('modal-video');
    const STORAGE_KEY = `video-progress-${fileId}`;

    // Reset the time-display UI immediately. Without this, the previous
    // clip's time + duration + progress fill stays on screen until the
    // new src fires its first `timeupdate` event (which can take a few
    // hundred ms while the network buffer fills).
    const cur = document.getElementById('video-current-time');
    const dur = document.getElementById('video-duration');
    const fill = document.getElementById('video-progress-fill');
    const dot = document.getElementById('video-progress-dot');
    const playBtnIcon = document.getElementById('video-play-btn');
    if (cur)  cur.textContent  = '00:00';
    if (dur)  dur.textContent  = '00:00';
    if (fill) fill.style.width = '0%';
    if (dot)  dot.style.left   = '0%';
    // Force the play/pause icon back to "play" — a new clip is always
    // paused at start. Without this, the icon stuck on "pause" from the
    // previous clip until the user pressed play.
    if (playBtnIcon) playBtnIcon.innerHTML = '<i class="ri-play-fill text-2xl"></i>';

    // Resume-from-saved-time. Race-safe: if metadata is already loaded
    // when this runs (small clip / cached / fast network), the
    // loadedmetadata event has already fired and our handler would
    // never run — so we apply the seek inline. Otherwise wait for the
    // event.
    const applyResume = () => {
        const savedTime = localStorage.getItem(STORAGE_KEY);
        if (!savedTime) return;
        const time = parseFloat(savedTime);
        if (!isNaN(time) && time > 0 && time < (video.duration || Infinity)) {
            try { video.currentTime = time; } catch {}
            const ts = formatTime(time);
            showToast(i18nTf('viewer.video.resumed', { time: ts }, `Resumed at ${ts}`));
        }
    };
    if (video.readyState >= 1) applyResume();
    else video.onloadedmetadata = applyResume;

    // Save progress — throttled to once per 2 s so we don't hammer
    // localStorage 4×/sec. Near the end of the clip, drop the saved
    // entry so a fresh re-watch doesn't auto-jump back to the credits.
    let lastSavedAt = 0;
    video.ontimeupdate = () => {
        updateVideoUI(video);
        if (!(video.duration > 0)) return;
        if (video.currentTime / video.duration > 0.95) {
            localStorage.removeItem(STORAGE_KEY);
            return;
        }
        const now = Date.now();
        if (now - lastSavedAt < 2000) return;
        lastSavedAt = now;
        localStorage.setItem(STORAGE_KEY, String(video.currentTime));
    };
    
    // Restore persisted volume + mute from prior session.
    const savedVol = parseFloat(localStorage.getItem('video-volume') ?? '1');
    if (Number.isFinite(savedVol)) video.volume = Math.max(0, Math.min(1, savedVol));
    video.muted = localStorage.getItem('video-muted') === '1';

    // Play / pause.
    const playBtn = document.getElementById('video-play-btn');
    if (playBtn) {
        playBtn.onclick = () => video.paused ? video.play() : video.pause();
        video.onplay  = () => { playBtn.innerHTML = '<i class="ri-pause-fill text-2xl"></i>'; };
        video.onpause = () => { playBtn.innerHTML = '<i class="ri-play-fill text-2xl"></i>'; };
    }

    // Seek bar — click + drag to scrub. Pointer events cover mouse,
    // touch, and pen with the same code path; setPointerCapture keeps
    // the drag tracking even when the cursor leaves the bar.
    const progressBar = document.getElementById('video-progress-container');
    if (progressBar) {
        let dragging = false;
        const seekTo = (clientX) => {
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            const rect = progressBar.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            video.currentTime = ratio * video.duration;
        };
        progressBar.onpointerdown = (e) => {
            dragging = true;
            try { progressBar.setPointerCapture?.(e.pointerId); } catch {}
            seekTo(e.clientX);
            e.preventDefault();
        };
        progressBar.onpointermove = (e) => { if (dragging) seekTo(e.clientX); };
        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            try { progressBar.releasePointerCapture?.(e.pointerId); } catch {}
        };
        progressBar.onpointerup = endDrag;
        progressBar.onpointercancel = endDrag;
    }

    // Volume slider — live-update on input; persist value.
    const volumeSlider = document.getElementById('video-volume');
    const refreshVolumeUi = () => {
        if (volumeSlider) volumeSlider.value = video.muted ? 0 : video.volume;
    };
    if (volumeSlider) {
        refreshVolumeUi();
        volumeSlider.oninput = () => {
            const v = parseFloat(volumeSlider.value);
            if (!Number.isFinite(v)) return;
            video.volume = Math.max(0, Math.min(1, v));
            if (v > 0 && video.muted) video.muted = false;
            if (v === 0 && !video.muted) video.muted = true;
            localStorage.setItem('video-volume', String(video.volume));
        };
    }

    // Mute toggle.
    const muteBtn = document.getElementById('video-mute-btn');
    const refreshMuteIcon = () => {
        if (!muteBtn) return;
        muteBtn.innerHTML = (video.muted || video.volume === 0)
            ? '<i class="ri-volume-mute-line text-lg"></i>'
            : '<i class="ri-volume-up-line text-lg"></i>';
    };
    refreshMuteIcon();
    if (muteBtn) {
        muteBtn.onclick = () => {
            video.muted = !video.muted;
            // Bump volume off zero so unmuting actually plays sound.
            if (!video.muted && video.volume === 0) video.volume = 0.5;
        };
    }
    video.onvolumechange = () => {
        refreshMuteIcon();
        refreshVolumeUi();
        localStorage.setItem('video-muted', video.muted ? '1' : '0');
    };

    // Playback-speed menu — open/close + per-option select. Trigger
    // label updates to reflect the current rate; checkmark moves to
    // the active option.
    const speedTrigger = document.getElementById('video-settings-btn');
    const speedMenu    = document.getElementById('video-speed-menu');
    const speedOpts    = document.querySelectorAll('.speed-opt[data-speed]');
    const refreshSpeedUi = () => {
        if (speedTrigger) {
            const rate = video.playbackRate || 1;
            speedTrigger.textContent = (rate === 1 ? '1x' : `${rate}x`);
        }
        speedOpts.forEach(opt => {
            const isActive = parseFloat(opt.dataset.speed) === video.playbackRate;
            opt.classList.toggle('text-tg-blue', isActive);
            const check = opt.querySelector('i.ri-check-line');
            if (isActive && !check) {
                opt.insertAdjacentHTML('beforeend', '<i class="ri-check-line"></i>');
            } else if (!isActive && check) {
                check.remove();
            }
        });
    };
    refreshSpeedUi();
    if (speedTrigger && speedMenu) {
        speedTrigger.onclick = (e) => {
            e.stopPropagation();
            speedMenu.classList.toggle('hidden');
        };
    }
    speedOpts.forEach(opt => {
        opt.onclick = () => {
            const r = parseFloat(opt.dataset.speed);
            if (Number.isFinite(r) && r > 0) {
                video.playbackRate = r;
                refreshSpeedUi();
                speedMenu?.classList.add('hidden');
            }
        };
    });

    // Picture-in-Picture (best-effort — Safari iOS rejects it).
    const pipBtn = document.getElementById('video-pip-btn');
    if (pipBtn) {
        pipBtn.onclick = async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (document.pictureInPictureEnabled) {
                    await video.requestPictureInPicture();
                }
            } catch (e) {
                showToast(i18nTf('viewer.video.pip_failed', { msg: e.message }, `PiP unavailable: ${e.message}`), 'error');
            }
        };
    }

    // Fullscreen — full-screen the whole video container so custom
    // controls remain visible (going fullscreen on the <video> element
    // itself shows the browser's native bar instead).
    const fsBtn = document.getElementById('video-fullscreen-btn');
    if (fsBtn) {
        const container = document.getElementById('video-container');
        fsBtn.onclick = async () => {
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                } else if (container?.requestFullscreen) {
                    await container.requestFullscreen();
                }
            } catch (e) {
                showToast(i18nTf('viewer.video.fullscreen_failed', { msg: e.message }, `Fullscreen unavailable: ${e.message}`), 'error');
            }
        };
    }
}

function updateVideoUI(video) {
    const current = document.getElementById('video-current-time');
    const duration = document.getElementById('video-duration');
    const fill = document.getElementById('video-progress-fill');
    const dot = document.getElementById('video-progress-dot');

    if (current) current.textContent = formatTime(video.currentTime);
    if (duration && video.duration) duration.textContent = formatTime(video.duration);
    if (video.duration) {
        const pct = Math.max(0, Math.min(100, (video.currentTime / video.duration) * 100));
        if (fill) fill.style.width = `${pct}%`;
        if (dot) dot.style.left = `${pct}%`;
    }
}

function formatTime(seconds) {
    if (!seconds) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function closeMediaViewer() {
    const modal = document.getElementById('media-modal');
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    const video = document.getElementById('modal-video');
    video.pause();
}

export function setupViewerEvents() {
    document.getElementById('modal-close')?.addEventListener('click', closeMediaViewer);
    document.getElementById('modal-prev')?.addEventListener('click', () => navigateMedia(-1));
    document.getElementById('modal-next')?.addEventListener('click', () => navigateMedia(1));

    // Click outside speed menu closes it. Attached once at boot so we
    // don't pile up a duplicate listener every time setupVideoPlayer
    // runs.
    document.addEventListener('pointerdown', (ev) => {
        const menu = document.getElementById('video-speed-menu');
        const trigger = document.getElementById('video-settings-btn');
        if (!menu || menu.classList.contains('hidden')) return;
        if (menu.contains(ev.target) || trigger?.contains(ev.target)) return;
        menu.classList.add('hidden');
    });

    // Keyboard support — Esc / Arrow / Space. Skip when the user is
    // typing in an input/textarea so the global hotkeys don't fight
    // text entry inside the viewer (e.g. file-rename in the future).
    document.addEventListener('keydown', (e) => {
        if (document.getElementById('media-modal').classList.contains('hidden')) return;
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
        if (e.key === 'Escape') closeMediaViewer();
        else if (e.key === 'ArrowLeft') navigateMedia(-1);
        else if (e.key === 'ArrowRight') navigateMedia(1);
        else if (e.key === ' ' || e.code === 'Space') {
            const v = document.getElementById('modal-video');
            if (v && !v.paused) v.pause(); else v?.play?.();
            e.preventDefault();
        }
    });

    // Touch / pen gestures: swipe left/right = prev/next, drag down on the
    // empty area below the controls = dismiss (Telegram-style). Mouse
    // pointer-down inside an image / video / control still works for clicks
    // because attachSwipe only fires once on pointerup past threshold.
    const swipeArea = document.getElementById('modal-swipe');
    if (swipeArea) {
        attachSwipe(swipeArea, {
            onSwipe: (dir) => navigateMedia(dir === 'left' ? 1 : -1),
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
    // tapping → in the Photos filter shouldn't jump to a video. The
    // filter list lives on `state.currentFilter` (set by the gallery
    // tab handler in app.js); fall back to walking everything when no
    // filter is set.
    const currentFilter = state.currentFilter || 'all';
    const visible = currentFilter === 'all'
        ? state.files
        : state.files.filter(f => f.type === currentFilter);

    // Map the unfiltered currentFileIndex to its position in the
    // filtered list, then step.
    const currentFile = state.files[state.currentFileIndex];
    const visibleIndex = currentFile ? visible.indexOf(currentFile) : -1;
    if (visibleIndex < 0) {
        // Current file is filtered out (rare — filter changed mid-view).
        // Just step inside state.files and let the user notice.
        const newIndex = state.currentFileIndex + dir;
        if (newIndex >= 0 && newIndex < state.files.length) openMediaViewer(newIndex);
        return;
    }
    const nextVisible = visible[visibleIndex + dir];
    if (!nextVisible) return; // hit the edge
    const newIndex = state.files.indexOf(nextVisible);
    if (newIndex >= 0 && newIndex < state.files.length) {
        openMediaViewer(newIndex);
    }
}
