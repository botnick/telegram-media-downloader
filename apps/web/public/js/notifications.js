// Browser notifications. Opt-in: the user explicitly enables in Settings.
// We throttle so a fast queue doesn't spam the system tray.

import { t as i18nT, tf as i18nTf } from './i18n.js';

const KEY = 'tgdl-notifications-enabled';

let lastBatch = { ts: 0, count: 0 };

export function isSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
}

export function isEnabled() {
    return isSupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted';
}

export async function requestEnable() {
    if (!isSupported()) return false;
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    localStorage.setItem(KEY, '1');
    return true;
}

export function disable() {
    localStorage.removeItem(KEY);
}

export function notifyDownloadComplete(payload) {
    if (!isEnabled()) return;
    // Coalesce: bursts of completions within 4s become a single "5 files done" notification.
    const now = Date.now();
    if (now - lastBatch.ts < 4000) {
        lastBatch.count += 1;
        return;
    }
    lastBatch = { ts: now, count: 1 };
    const fileName = payload?.filePath ? payload.filePath.split(/[\\/]/).pop() : i18nT('notify.download_complete_file', 'a file');
    const n = new Notification(i18nT('notify.download_complete', 'Download complete'), {
        body: fileName,
        icon: '/favicon.ico',
        tag: 'tgdl-download',
    });
    // Click → focus the dashboard tab and route to the library (same UX
    // every native client does for completed downloads). The receiving
    // page's hash router handles the navigation; we keep the wire format
    // simple here so notifications.js doesn't grow a viewer dep.
    n.onclick = () => {
        try {
            window.focus();
            if (typeof window.navigateTo === 'function') window.navigateTo('viewer');
        } catch { /* best-effort */ }
        n.close();
    };
}

/**
 * Generic notification — fires regardless of the per-file coalesce window
 * since the caller (NSFW scan finished, integrity check, etc.) is its
 * own one-shot event. No-op if notifications aren't enabled.
 */
export function notifyGeneric(title, body) {
    if (!isEnabled()) return;
    try {
        const n = new Notification(title, { body: body || '', icon: '/favicon.ico', tag: 'tgdl-generic' });
        n.onclick = () => { try { window.focus(); } catch {} n.close(); };
    } catch { /* permission revoked since enable */ }
}

export function flushPending() {
    if (lastBatch.count > 1 && isEnabled()) {
        new Notification(i18nTf('notify.batch_complete', { n: lastBatch.count }, `${lastBatch.count} downloads complete`), { tag: 'tgdl-batch' });
    }
    lastBatch = { ts: 0, count: 0 };
}
