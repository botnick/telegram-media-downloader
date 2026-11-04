// Detects a page that died while it was in use and was reloaded by the
// browser (iOS Safari kills a tab that runs out of memory and silently
// reloads it). Each visible session keeps a small heartbeat in
// localStorage; a normal unload, a deliberate reload or hiding the page
// marks it closed. If the next boot finds a recent heartbeat still open,
// the previous page did not end on its own, and the user is told how far
// the gallery had scrolled so the report can be acted on.

import { showToast } from './utils.js';
import { tf as i18nTf } from './i18n.js';

const KEY = 'tgdl.pageLife';
const LAST_KEY = 'tgdl.lastUnexpectedReload';
const BEAT_MS = 5000;
// A heartbeat older than this is a page closed long ago, not a crash.
const FRESH_MS = 30000;

let _life = null;
let _galleryItems = 0;

function _read(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
        return null;
    }
}

function _write() {
    if (!_life) return;
    try {
        localStorage.setItem(KEY, JSON.stringify(_life));
    } catch {
        /* storage full or disabled: detection is best-effort */
    }
}

function _beat() {
    if (!_life || document.visibilityState !== 'visible') return;
    _life.t = Date.now();
    _life.items = Math.max(_life.items, _galleryItems);
    _life.closed = false;
    _write();
}

function _close() {
    if (!_life) return;
    _life.t = Date.now();
    _life.closed = true;
    _write();
}

/** The gallery reports how many items it holds after each page load. */
export function noteGalleryItems(count) {
    if (Number.isFinite(count)) _galleryItems = Math.max(_galleryItems, count);
}

export function startReloadWatch() {
    if (_life || typeof localStorage === 'undefined') return null;
    const prev = _read(KEY);
    let report = null;
    if (prev && !prev.closed && Date.now() - prev.t < FRESH_MS) {
        report = {
            at: Date.now(),
            items: prev.items || 0,
            minutes: Math.max(0, Math.round((prev.t - prev.start) / 60000)),
        };
        try {
            localStorage.setItem(LAST_KEY, JSON.stringify(report));
        } catch {
            /* ignore */
        }
        showToast(
            i18nTf(
                'reload_watch.unexpected',
                report,
                `The page was reloaded by the browser after {items} items ({minutes} min). Please report this.`,
            ),
            'warning',
            12000,
        );
    }
    _life = { start: Date.now(), t: Date.now(), items: 0, closed: false };
    _write();
    setInterval(_beat, BEAT_MS);
    window.addEventListener('pagehide', _close);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _beat();
        else _close();
    });
    return report;
}
