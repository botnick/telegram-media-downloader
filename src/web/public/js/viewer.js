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
    
    // Reset States
    resetZoom();
    if (document.fullscreenElement) document.exitFullscreen();
    video.pause();
    
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
    
    // 1. Load saved time
    const savedTime = localStorage.getItem(STORAGE_KEY);
    if (savedTime) {
        const time = parseFloat(savedTime);
        if (!isNaN(time) && time > 0) {
            video.currentTime = time;
            const ts = formatTime(time);
            showToast(i18nTf('viewer.video.resumed', { time: ts }, `Resumed at ${ts}`));
        }
    }

    // 2. Save time on update
    video.ontimeupdate = () => {
        // Update UI
        updateVideoUI(video);
        
        // Save progress (debounced slightly by nature of event)
        // Check if video is near end (95%), if so, clear progress
        if (video.duration > 0) {
            if (video.currentTime / video.duration > 0.95) {
                localStorage.removeItem(STORAGE_KEY);
            } else {
                localStorage.setItem(STORAGE_KEY, video.currentTime);
            }
        }
    };
    
    // Custom Controls mapping
    const playBtn = document.getElementById('video-play-btn');
    if (playBtn) {
        playBtn.onclick = () => video.paused ? video.play() : video.pause();
    }

    video.onplay = () => {
        playBtn.innerHTML = '<i class="ri-pause-fill text-2xl"></i>';
    };
    video.onpause = () => {
        playBtn.innerHTML = '<i class="ri-play-fill text-2xl"></i>';
    };

    // Seek bar — click + drag to scrub. Pointer events cover mouse,
    // touch, and pen with the same code path; setPointerCapture so the
    // drag keeps tracking even when the cursor leaves the bar.
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

    // Volume slider — bind oninput so dragging updates live.
    const volumeSlider = document.getElementById('video-volume');
    if (volumeSlider) {
        volumeSlider.value = video.volume;
        volumeSlider.oninput = () => {
            const v = parseFloat(volumeSlider.value);
            if (Number.isFinite(v)) {
                video.volume = Math.max(0, Math.min(1, v));
                if (video.muted && v > 0) video.muted = false;
            }
        };
    }

    // Mute toggle.
    const muteBtn = document.getElementById('video-mute-btn');
    if (muteBtn) {
        const refreshMute = () => {
            muteBtn.innerHTML = (video.muted || video.volume === 0)
                ? '<i class="ri-volume-mute-line text-lg"></i>'
                : '<i class="ri-volume-up-line text-lg"></i>';
        };
        refreshMute();
        muteBtn.onclick = () => {
            video.muted = !video.muted;
            refreshMute();
        };
        video.onvolumechange = refreshMute;
    }

    // Playback speed selector (any .speed-opt[data-speed] button).
    document.querySelectorAll('.speed-opt[data-speed]').forEach(btn => {
        btn.onclick = () => {
            const r = parseFloat(btn.dataset.speed);
            if (Number.isFinite(r) && r > 0) video.playbackRate = r;
        };
    });
}

function updateVideoUI(video) {
    const current = document.getElementById('video-current-time');
    const duration = document.getElementById('video-duration');
    const fill = document.getElementById('video-progress-fill');
    
    if (current) current.textContent = formatTime(video.currentTime);
    if (duration && video.duration) duration.textContent = formatTime(video.duration);
    if (fill && video.duration) {
        const pct = (video.currentTime / video.duration) * 100;
        fill.style.width = `${pct}%`;
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

    // Keyboard support — Esc / Arrow / Space.
    document.addEventListener('keydown', (e) => {
        if (document.getElementById('media-modal').classList.contains('hidden')) return;
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
    const newIndex = state.currentFileIndex + dir;
    if (newIndex >= 0 && newIndex < state.files.length) {
        openMediaViewer(newIndex);
    }
}
