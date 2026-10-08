// In-SPA re-authentication modal.
//
// api.js calls `window.__tgdlReauth({method, url})` on a 401 (other than
// the auth-check + login endpoints). This module installs that handler
// at boot: it shows a password modal, posts to /api/login, and on
// success the original request is replayed once with `_skipReauth: true`
// so a stale-session click no longer yanks the user out of whatever
// page they were on.
//
// On cancel / login failure the api.js fallback runs the legacy
// `window.location.href = '/login.html'` redirect, so the user always
// has a way out.
//
// Design constraints:
//   - Single-flight: while a modal is open, every additional 401 is
//     queued onto the same outcome promise — three admin endpoints
//     racing on the same page mount get one prompt, three retries.
//   - No-loop: api.js already excludes /api/auth_check + /api/login;
//     this module does not call any other admin endpoint, so it cannot
//     re-enter itself.
//   - i18n-keyed labels with raw-text fallbacks, like every other
//     module in this SPA.

import { openSheet } from './sheet.js';
import { showToast, escapeHtml } from './utils.js';
import { t as i18nT } from './i18n.js';

let _inFlight = null; // Promise<'retry'|'cancel'> while a modal is open

function _renderModal() {
    return new Promise((resolve) => {
        let resolved = false;
        const settle = (outcome) => {
            if (resolved) return;
            resolved = true;
            resolve(outcome);
        };

        const id = `tgdl-reauth-${Math.random().toString(36).slice(2, 8)}`;
        const html = `
            <form id="${id}-form" class="space-y-3">
                <p class="text-sm text-tg-textSecondary">${escapeHtml(
                    i18nT(
                        'reauth.body',
                        'Your session expired. Re-enter your password to continue without losing this page.',
                    ),
                )}</p>
                <input
                    id="${id}-pw"
                    type="password"
                    autocomplete="current-password"
                    class="w-full px-3 py-2 bg-tg-bg/50 border border-tg-border/40 rounded-lg text-sm focus:outline-none focus:border-tg-blue/60"
                    placeholder="${escapeHtml(i18nT('reauth.placeholder', 'Password'))}"
                    required
                />
                <div id="${id}-err" class="hidden text-xs text-tg-red"></div>
                <div class="flex items-center justify-end gap-2 pt-1">
                    <button type="button" id="${id}-cancel" class="tg-btn-secondary text-xs px-3 py-1.5">
                        ${escapeHtml(i18nT('reauth.cancel', 'Sign in on a fresh page'))}
                    </button>
                    <button type="submit" id="${id}-submit" class="tg-btn text-xs px-3 py-1.5">
                        ${escapeHtml(i18nT('reauth.submit', 'Re-authenticate'))}
                    </button>
                </div>
            </form>`;

        const sheet = openSheet({
            title: i18nT('reauth.title', 'Session expired'),
            content: html,
            size: 'sm',
            onClose: () => settle('cancel'),
        });

        const root = sheet?.body || document;
        const form = root.querySelector(`#${id}-form`);
        const pw = root.querySelector(`#${id}-pw`);
        const submit = root.querySelector(`#${id}-submit`);
        const cancel = root.querySelector(`#${id}-cancel`);
        const errBox = root.querySelector(`#${id}-err`);

        // Focus the password field on next tick so the sheet's animation
        // doesn't steal focus mid-render.
        setTimeout(() => pw?.focus(), 50);

        cancel?.addEventListener('click', () => {
            sheet?.close?.();
            settle('cancel');
        });

        form?.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            if (!pw?.value) return;
            submit.disabled = true;
            submit.textContent = i18nT('reauth.submitting', 'Signing in…');
            if (errBox) {
                errBox.textContent = '';
                errBox.classList.add('hidden');
            }
            // Direct fetch — DON'T use api.js or we re-enter the 401 path
            // before the cookie has been refreshed.
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pw.value }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    const msg =
                        data.error ||
                        i18nT(
                            'reauth.failed',
                            'Sign-in failed. Check your password and try again.',
                        );
                    if (errBox) {
                        errBox.textContent = msg;
                        errBox.classList.remove('hidden');
                    }
                    submit.disabled = false;
                    submit.textContent = i18nT('reauth.submit', 'Re-authenticate');
                    return;
                }
                // Success — let listeners (app.js) refresh role from
                // /api/auth_check before any retried admin call lands.
                try {
                    window.dispatchEvent(new CustomEvent('tgdl:reauth-success'));
                } catch {
                    /* ignore */
                }
                showToast(
                    i18nT('reauth.success', 'Signed back in. Resuming where you left off.'),
                    'success',
                    3000,
                );
                sheet?.close?.();
                settle('retry');
            } catch (e) {
                if (errBox) {
                    errBox.textContent =
                        e?.message || i18nT('reauth.network', 'Network error. Try again.');
                    errBox.classList.remove('hidden');
                }
                submit.disabled = false;
                submit.textContent = i18nT('reauth.submit', 'Re-authenticate');
            }
        });
    });
}

async function _handle() {
    if (_inFlight) return _inFlight;
    _inFlight = _renderModal();
    try {
        return await _inFlight;
    } finally {
        _inFlight = null;
    }
}

/**
 * Install `window.__tgdlReauth` so `api.js` 401 handler can hand off.
 * Idempotent — repeat calls (hot-reload, multi-init) are no-ops.
 */
export function initReauthModal() {
    if (typeof window === 'undefined') return;
    if (window.__tgdlReauth) return;
    window.__tgdlReauth = _handle;
}
