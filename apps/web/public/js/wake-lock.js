/**
 * Screen Wake Lock — keep the laptop / phone display awake while
 * downloads are in flight so the user can leave the dashboard tab
 * visible and still see live progress.
 *
 * Feature-detected: `navigator.wakeLock` is unavailable on Safari iOS
 * (as of mid-2026), so we silently no-op there. The caller stays simple:
 *
 *   import { acquireIfActive, releaseIfIdle } from './wake-lock.js';
 *   acquireIfActive(activeJobs);   // re-checked on every WS update
 *   releaseIfIdle(activeJobs);
 *
 * No hardcoded thresholds — the caller decides what "active" means.
 */

const SUPPORTED = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
let _sentinel = null;
let _acquiring = null;

async function _acquire() {
    if (!SUPPORTED || _sentinel || _acquiring) return;
    try {
        _acquiring = navigator.wakeLock.request('screen');
        _sentinel = await _acquiring;
        _sentinel.addEventListener('release', () => { _sentinel = null; });
    } catch {
        // Browser refused (e.g. tab not visible). Caller will retry on
        // the next active-jobs change.
    } finally {
        _acquiring = null;
    }
}

async function _release() {
    if (!_sentinel) return;
    try { await _sentinel.release(); } catch { /* ignore */ }
    _sentinel = null;
}

/** Acquire the lock if we're not holding one and `activeJobs > 0`. */
export function acquireIfActive(activeJobs) {
    if (!SUPPORTED) return;
    if ((activeJobs | 0) <= 0) return;
    if (_sentinel) return;
    _acquire();
}

/** Release the lock if we're holding one and the queue has drained. */
export function releaseIfIdle(activeJobs) {
    if (!SUPPORTED) return;
    if ((activeJobs | 0) > 0) return;
    if (!_sentinel) return;
    _release();
}

/** Re-acquire after the tab regains visibility — browsers auto-release
 *  the sentinel when the tab is hidden, so we hook visibilitychange and
 *  re-grab as long as activeJobs is still positive. */
export function attachVisibilityRefresh(getActiveCount) {
    if (!SUPPORTED) return;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && (getActiveCount() | 0) > 0) {
            _acquire();
        }
    });
}

export const isSupported = SUPPORTED;
