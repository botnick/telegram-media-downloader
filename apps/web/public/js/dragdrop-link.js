/**
 * Drag-drop t.me URL onto the dashboard → auto-paste into the link picker
 * + start a download. Works on desktop browsers that surface drag-data
 * for hyperlinks (Chromium, Firefox); harmlessly no-ops on browsers that
 * don't (the operator can still paste manually).
 *
 * Visual feedback is the dashed-border overlay #dragdrop-overlay (CSS
 * lives in main.css). Listener is global because users drag onto any
 * area of the dashboard — gallery, sidebar, settings; all surface a
 * single drop target.
 */

import { showToast } from './utils.js';
import { api } from './api.js';
import { t as i18nT } from './i18n.js';

const TG_URL_RE = /\bhttps?:\/\/t\.me\/[^\s<>"]+/i;
let _wired = false;
let _depth = 0;

function _overlay() { return document.getElementById('dragdrop-overlay'); }

function _hasUrl(dt) {
    if (!dt) return false;
    if (dt.types && Array.from(dt.types).some(t => /text\/uri-list|text\/plain|text\/x-moz-url/i.test(t))) return true;
    return false;
}

function _extractUrl(dt) {
    if (!dt) return null;
    const candidates = [
        dt.getData('text/uri-list'),
        dt.getData('text/plain'),
        dt.getData('text/x-moz-url'),
        dt.getData('URL'),
    ].filter(Boolean);
    for (const text of candidates) {
        const m = text.match(TG_URL_RE);
        if (m) return m[0];
    }
    return null;
}

async function _submit(url) {
    try {
        // Mirror the existing paste-link picker's POST shape — single
        // canonical endpoint, server handles parsing + queueing.
        await api.post('/api/download/url', { url });
        showToast(i18nT('dragdrop.queued', 'Queued for download'), 'success');
    } catch (e) {
        showToast(e?.message || i18nT('dragdrop.failed', 'Could not queue'), 'error');
    }
}

export function setupDragDropLink() {
    if (_wired) return;
    _wired = true;

    document.addEventListener('dragenter', (e) => {
        if (!_hasUrl(e.dataTransfer)) return;
        e.preventDefault();
        _depth++;
        _overlay()?.classList.add('is-active');
    });

    document.addEventListener('dragover', (e) => {
        if (!_hasUrl(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    document.addEventListener('dragleave', (e) => {
        if (!_hasUrl(e.dataTransfer)) return;
        _depth = Math.max(0, _depth - 1);
        if (_depth === 0) _overlay()?.classList.remove('is-active');
    });

    document.addEventListener('drop', async (e) => {
        if (!_hasUrl(e.dataTransfer)) return;
        e.preventDefault();
        _depth = 0;
        _overlay()?.classList.remove('is-active');
        const url = _extractUrl(e.dataTransfer);
        if (!url) {
            showToast(i18nT('dragdrop.no_url', 'No t.me link found in the dropped data'), 'error');
            return;
        }
        await _submit(url);
    });
}
