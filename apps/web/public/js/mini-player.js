/**
 * Mini-player — sticky bottom-right preview that keeps a video clip
 * playing after the operator closes the viewer modal (or scrolls past
 * it). Click → re-expand back into the full viewer at the same position.
 *
 * Implementation notes:
 *   - We REUSE `<video id="modal-video">`'s currentTime + src so playback
 *     is seamless when shrinking/expanding (no re-buffer round trip).
 *     The mini player has its own `<video>` element, but we sync state
 *     on shrink/expand only.
 *   - PiP support is in viewer.js; this module is the in-document
 *     fallback for browsers where PiP is unavailable (Firefox, iOS Safari)
 *     OR for users who prefer a docked panel over a floating PiP window.
 *
 * Cross-platform: pure DOM, no third-party deps.
 */

import { state } from './store.js';

let _wired = false;
let _shown = false;
let _restoreIndex = null;

function _miniEl()      { return document.getElementById('mini-player'); }
function _miniVideo()   { return document.getElementById('mini-player-video'); }
function _modalVideo()  { return document.getElementById('modal-video'); }

export function setupMiniPlayer() {
    if (_wired) return;
    _wired = true;

    const mini = _miniEl();
    if (!mini) return;
    const expandBtn = document.getElementById('mini-player-expand');
    const closeBtn  = document.getElementById('mini-player-close');
    const vid       = _miniVideo();

    expandBtn?.addEventListener('click', expand);
    vid?.addEventListener('click', expand);
    closeBtn?.addEventListener('click', dismiss);
}

/**
 * Pull the in-flight modal-video's source + position into the mini
 * player and reveal it. Idempotent — calling twice keeps the same
 * playback.
 */
export function shrinkToMini() {
    const big = _modalVideo();
    const mini = _miniEl();
    const v = _miniVideo();
    if (!big || !mini || !v) return;
    if (!big.src && !big.currentSrc) return;

    const src = big.currentSrc || big.src;
    if (v.src !== src) v.src = src;
    try { v.currentTime = big.currentTime || 0; } catch {}
    v.muted = big.muted;
    v.volume = big.volume;
    v.playbackRate = big.playbackRate || 1;
    v.play().catch(() => {});

    _restoreIndex = state.currentFileIndex;
    mini.classList.remove('hidden');
    mini.setAttribute('aria-hidden', 'false');
    _shown = true;
}

/** Re-open the full viewer at the index we shrank from. */
export async function expand() {
    if (!_shown) return;
    const v = _miniVideo();
    const t = v?.currentTime || 0;
    dismiss();
    if (_restoreIndex == null) return;
    try {
        const { openMediaViewer } = await import('./viewer.js');
        openMediaViewer(_restoreIndex);
        // Restore the play position once the viewer's <video> finishes
        // loading metadata so the full-size player picks up where mini
        // left off.
        const big = _modalVideo();
        if (big) {
            const seek = () => {
                try { big.currentTime = t; } catch {}
                big.removeEventListener('loadedmetadata', seek);
            };
            big.addEventListener('loadedmetadata', seek);
        }
    } catch {}
}

/** Hide and stop the mini player. */
export function dismiss() {
    const mini = _miniEl();
    const v = _miniVideo();
    if (!mini) return;
    try { v?.pause(); } catch {}
    try { v?.removeAttribute('src'); v?.load(); } catch {}
    mini.classList.add('hidden');
    mini.setAttribute('aria-hidden', 'true');
    _shown = false;
    _restoreIndex = null;
}

export function isMiniVisible() { return _shown; }
