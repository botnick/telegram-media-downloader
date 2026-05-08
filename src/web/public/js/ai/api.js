// AI-specific fetch wrapper.
//
// Wraps the generic `api` helper with two extras the AI page actually needs:
//   1. Tighter default timeout (15 s) — every AI route either streams via WS
//      or returns metadata; nothing should take longer than that. Was 60 s
//      before, which left the UI stuck after a backend hang.
//   2. `withButton(btn, fn)` — disables a button + swaps its content for a
//      spinner glyph, restores on settle. Applied universally so no UI
//      element can fire two requests in a row by accident.
//
// Also normalises the new envelope shape: when the server returns
// `{ ok: false, code, message, ... }` with status 200, throw it as if it
// were a 4xx so the caller's `catch` always fires for the failure path.

import { api } from '../api.js';
import { showToast } from '../utils.js';

export const AI_TIMEOUT_MS = 15_000;

function _normaliseEnvelope(data) {
    if (!data || typeof data !== 'object') return data;
    if (data.ok === false) {
        const err = new Error(data.message || data.error || data.code || 'AI request failed');
        err.code = data.code || 'AI_ERROR';
        err.envelope = data;
        throw err;
    }
    return data;
}

export async function aiGet(url, opts = {}) {
    const data = await api.get(url, { timeoutMs: AI_TIMEOUT_MS, ...opts });
    return _normaliseEnvelope(data);
}

export async function aiPost(url, body, opts = {}) {
    const data = await api.post(url, body, { timeoutMs: AI_TIMEOUT_MS, ...opts });
    return _normaliseEnvelope(data);
}

export async function aiPut(url, body, opts = {}) {
    const data = await api.put(url, body, { timeoutMs: AI_TIMEOUT_MS, ...opts });
    return _normaliseEnvelope(data);
}

export async function aiDelete(url, body, opts = {}) {
    const data = await api.delete(url, body, { timeoutMs: AI_TIMEOUT_MS, ...opts });
    return _normaliseEnvelope(data);
}

/**
 * Run `fn` while disabling the button + showing a spinner glyph. Restores
 * the button on settle. Catches errors so the caller doesn't have to wrap
 * its own try/finally for the disable lifecycle.
 *
 * Returns the promise from `fn` so callers can `.then()` on the result.
 *
 * @param {HTMLElement|null} button
 * @param {() => Promise<any>} fn
 */
export async function withButton(button, fn) {
    if (!button) return fn();
    if (button.dataset.busy === '1') return; // already in flight
    button.dataset.busy = '1';
    button.disabled = true;
    const orig = button.innerHTML;
    const spinner = '<i class="ri-loader-4-line animate-spin" aria-hidden="true"></i>';
    // Preserve the original label width by replacing only the icon if there's one.
    if (button.querySelector('i')) {
        button.querySelector('i').outerHTML = spinner;
    } else {
        button.innerHTML = spinner;
    }
    try {
        return await fn();
    } finally {
        button.disabled = false;
        button.innerHTML = orig;
        delete button.dataset.busy;
    }
}

/** Friendly error toast that prefers `err.envelope.message` if present. */
export function toastError(err, fallback = 'Failed') {
    const msg = err?.envelope?.message || err?.message || err || fallback;
    showToast(String(msg).slice(0, 200), 'error');
}
