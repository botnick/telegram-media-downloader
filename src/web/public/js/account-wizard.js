// Add a Telegram account without leaving the dashboard — the sheet behind
// #/account/add, Settings → Accounts "Add account", the empty Chats page
// and onboarding step 2. Phone → code → 2FA password (only when the
// account has one) → pick chats to monitor.
//
// Same server flow as add-account.html (/api/accounts/auth/begin, /phone,
// /code, /2fa, /cancel), which stays for old links. The server keeps the
// step on a wrong number / code / password and says why (`code`:
// PHONE_CODE_INVALID, FLOOD_WAIT + `seconds`, …), so errors show inline
// under the field. "Resend code" starts a fresh sign-in for the same
// number (Telegram sends a new code). Cancel — the button, Esc, the
// backdrop, Back, or closing the tab — cancels the server-side flow.

import { api } from './api.js';
import { state } from './store.js';
import { escapeHtml } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { openSheet } from './sheet.js';
import { navigate } from './router.js';
import {
    getLatest as getMonitorStatus,
    refreshNow as refreshMonitorStatus,
} from './monitor-status.js';
import { renderChatResultRow, wireChatResultRows, humanWait } from './add-sheet.js';

const RESEND_AFTER_S = 60;
const STEPS = ['phone', 'code', 'password', 'chats'];

let open = null; // the one wizard that may be open

function stepLabel(s) {
    return {
        phone: i18nT('acct.step.phone', 'Phone'),
        code: i18nT('acct.step.code', 'Code'),
        password: i18nT('acct.step.password', 'Password'),
        chats: i18nT('acct.step.chats', 'Chats'),
    }[s];
}

function errorText(r, step) {
    const code = r?.code || '';
    if (code === 'FLOOD_WAIT' || /FLOOD/.test(code)) {
        const time = humanWait(r.seconds);
        return i18nTf(
            'acct.err.flood',
            { time },
            `Too many attempts. Telegram asks you to wait ${time}.`,
        );
    }
    if (code === 'PHONE_CODE_INVALID' || code === 'PHONE_CODE_EMPTY') {
        return i18nT(
            'acct.err.code_invalid',
            "That code isn't right. Check the latest message from Telegram.",
        );
    }
    if (code === 'PHONE_CODE_EXPIRED') {
        return i18nT('acct.err.code_expired', 'This code has expired. Tap “Resend code”.');
    }
    if (code === 'PHONE_NUMBER_INVALID' || code === 'PHONE_NUMBER_UNOCCUPIED') {
        return i18nT(
            'acct.err.phone_invalid',
            "Telegram doesn't recognise this number. Include the country code, e.g. +66812345678.",
        );
    }
    if (code === 'PHONE_NUMBER_BANNED') {
        return i18nT('acct.err.phone_banned', 'This number is banned from Telegram.');
    }
    if (code === 'PASSWORD_HASH_INVALID' || (step === 'password' && /PASSWORD/.test(code))) {
        return i18nT('acct.err.password_invalid', 'Wrong password.');
    }
    const msg = r?.error || r?.message || '';
    return i18nTf('acct.err.generic', { msg }, `Something went wrong: ${msg}`);
}

/** Open the wizard (no-op if it's already open). */
export function openAccountWizard() {
    if (open) return open;
    const w = {
        step: 'phone',
        sessionId: null,
        phone: '',
        label: '',
        accountId: null,
        busy: false,
        resendAt: 0,
        tick: null,
        done: false,
        noApi: getMonitorStatus()?.hint === 'configure-api',
        chats: [],
    };
    const box = document.createElement('div');
    box.className = 'aw-sheet';
    const handle = openSheet({
        title: i18nT('acct.title', 'Add Telegram account'),
        content: box,
        size: 'sm',
        onClose: () => {
            clearInterval(w.tick);
            window.removeEventListener('pagehide', onPageHide);
            if (!w.done) cancelSession(true);
            open = null;
        },
    });
    w.handle = handle;
    open = handle;

    function onPageHide() {
        if (w.sessionId && !w.done) {
            try {
                navigator.sendBeacon(
                    '/api/accounts/auth/cancel',
                    new Blob([JSON.stringify({ sessionId: w.sessionId })], {
                        type: 'application/json',
                    }),
                );
            } catch {
                /* best effort */
            }
        }
    }
    window.addEventListener('pagehide', onPageHide);

    async function cancelSession(fireAndForget = false) {
        const id = w.sessionId;
        w.sessionId = null;
        if (!id) return;
        const p = api.post('/api/accounts/auth/cancel', { sessionId: id }).catch(() => {});
        if (!fireAndForget) await p;
    }

    // ---- rendering -----------------------------------------------------

    function stepper() {
        const idx = STEPS.indexOf(w.step);
        return `<ol class="aw-steps" aria-label="${escapeHtml(i18nT('acct.progress', 'Progress'))}">
            ${STEPS.map((s, i) => {
                // The 2FA step only applies to accounts with a cloud password.
                const skipped = s === 'password' && i < idx && !w.passwordUsed;
                const cls = skipped
                    ? 'is-skipped'
                    : i < idx
                      ? 'is-done'
                      : i === idx
                        ? 'is-active'
                        : '';
                const dot = skipped ? '–' : i < idx ? '<i class="ri-check-line"></i>' : i + 1;
                return `<li class="aw-step ${cls}" ${i === idx ? 'aria-current="step"' : ''}>
                    <span class="aw-step-dot" aria-hidden="true">${dot}</span>
                    <span class="aw-step-label">${escapeHtml(stepLabel(s))}</span>
                </li>`;
            }).join('')}
        </ol>`;
    }

    function footer(label, { cancel = true } = {}) {
        return `<div class="aw-footer">
            ${cancel ? `<button type="button" class="aw-cancel" data-aw-cancel>${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>` : '<span></span>'}
            <button type="submit" class="tg-btn aw-primary" ${w.busy || w.noApi ? 'disabled' : ''}>${escapeHtml(label)}</button>
        </div>`;
    }

    function errorBox(msg, html = '') {
        return `<div class="aw-error ${msg ? '' : 'hidden'}" role="alert" data-aw-error>${escapeHtml(msg || '')}${html}</div>`;
    }

    function render(err = '', errHtml = '') {
        let body = '';
        if (w.step === 'phone') {
            const noApiHtml = w.noApi
                ? ` <button type="button" class="cr-link" data-aw-settings>${escapeHtml(i18nT('acct.err.no_api_link', 'Open Settings → Telegram API'))}</button>`
                : '';
            const e = w.noApi
                ? i18nT('acct.err.no_api', "Telegram API credentials aren't set yet.")
                : err;
            body = `
                <form class="aw-form" data-aw-form novalidate>
                    <label class="cd-label" for="aw-phone">${escapeHtml(i18nT('acct.phone.label', 'Phone number'))}</label>
                    <input id="aw-phone" type="tel" inputmode="tel" autocomplete="tel" required
                        class="tg-input aw-input" value="${escapeHtml(w.phone)}" placeholder="+66812345678"
                        aria-describedby="aw-phone-help" ${w.noApi ? 'disabled' : ''}>
                    <p id="aw-phone-help" class="cd-help">${escapeHtml(i18nT('acct.phone.help', 'With the country code, e.g. +66812345678. Telegram sends a login code to this number.'))}</p>
                    <details class="aw-optional">
                        <summary>${escapeHtml(i18nT('acct.label.label', 'Name this account (optional)'))}</summary>
                        <input id="aw-label" type="text" autocomplete="off" class="tg-input aw-input"
                            value="${escapeHtml(w.label)}" placeholder="${escapeHtml(i18nT('acct.label.placeholder', 'e.g. main'))}"
                            aria-label="${escapeHtml(i18nT('acct.label.label', 'Name this account (optional)'))}">
                    </details>
                    ${errorBox(e, w.noApi ? noApiHtml : errHtml)}
                    ${footer(primaryLabel())}
                </form>`;
        } else if (w.step === 'code') {
            body = `
                <form class="aw-form" data-aw-form novalidate>
                    <p class="aw-lead">${escapeHtml(i18nTf('acct.code.help', { phone: w.phone }, `Telegram sent a login code to the Telegram app (or by SMS) for ${w.phone}.`))}</p>
                    <label class="cd-label" for="aw-code">${escapeHtml(i18nT('acct.code.label', 'Login code'))}</label>
                    <input id="aw-code" type="text" inputmode="numeric" autocomplete="one-time-code" required
                        maxlength="12" class="tg-input aw-input aw-code" placeholder="12345">
                    ${errorBox(err, errHtml)}
                    <div class="aw-links">
                        <button type="button" class="cr-link" data-aw-resend disabled></button>
                        <button type="button" class="cr-link" data-aw-change>${escapeHtml(i18nT('acct.code.change_phone', 'Change number'))}</button>
                    </div>
                    ${footer(primaryLabel())}
                </form>`;
        } else if (w.step === 'password') {
            body = `
                <form class="aw-form" data-aw-form novalidate>
                    <p class="aw-lead">${escapeHtml(i18nT('acct.password.help', 'This account has two-step verification. Enter its cloud password to finish.'))}</p>
                    <label class="cd-label" for="aw-password">${escapeHtml(i18nT('acct.password.label', 'Cloud password'))}</label>
                    <input id="aw-password" type="password" autocomplete="current-password" required
                        class="tg-input aw-input" ${w.hint ? 'aria-describedby="aw-hint"' : ''}>
                    ${w.hint ? `<p id="aw-hint" class="cd-help">${escapeHtml(i18nTf('acct.password.hint', { hint: w.hint }, `Hint: ${w.hint}`))}</p>` : ''}
                    ${errorBox(err, errHtml)}
                    ${footer(primaryLabel())}
                </form>`;
        } else {
            body = `
                <div class="aw-done" role="status">
                    <i class="ri-checkbox-circle-fill" aria-hidden="true"></i>
                    <div>
                        <div class="aw-done-title">${escapeHtml(i18nT('acct.done.title', 'Account added'))}</div>
                        ${w.accountId ? `<div class="cd-help">${escapeHtml(i18nTf('acct.done.saved_as', { id: w.accountId }, `Saved as “${w.accountId}”.`))}</div>` : ''}
                    </div>
                </div>
                <h4 class="as-heading">${escapeHtml(i18nT('acct.chats.title', 'Pick chats to monitor'))}</h4>
                <p class="cd-help">${escapeHtml(i18nT('acct.chats.help', 'Turn on the chats you want to download from. You can change this any time.'))}</p>
                <input type="search" class="tg-input aw-input aw-filter hidden" data-aw-filter autocomplete="off"
                    placeholder="${escapeHtml(i18nT('acct.chats.filter', 'Filter chats'))}"
                    aria-label="${escapeHtml(i18nT('acct.chats.filter', 'Filter chats'))}">
                <div class="as-status" data-aw-chats-status role="status" aria-live="polite">${escapeHtml(i18nT('acct.chats.loading', 'Loading your chats…'))}</div>
                <div class="as-results aw-chats" data-aw-chats role="list"></div>
                <div class="aw-footer">
                    <span></span>
                    <button type="button" class="tg-btn aw-primary" data-aw-finish>${escapeHtml(i18nT('common.done', 'Done'))}</button>
                </div>`;
        }
        box.innerHTML = stepper() + body;
        if (w.step === 'code') updateResend();
        if (w.step === 'chats')
            wireChatResultRows(box.querySelector('[data-aw-chats]'), {
                getChat: (id) => w.chats.find((c) => String(c.id) === String(id)),
                beforeNavigate: () => handle.close(),
            });
        const first = box.querySelector('input:not([disabled]):not([type=hidden])');
        if (first && w.step !== 'chats') setTimeout(() => first.focus(), 30);
    }

    function showError(msg, html = '') {
        const el = box.querySelector('[data-aw-error]');
        if (!el) return render(msg, html);
        el.innerHTML = escapeHtml(msg) + html;
        el.classList.toggle('hidden', !msg);
        box.querySelector('.aw-input:not([disabled])')?.focus();
    }

    function primaryLabel() {
        if (w.step === 'phone') {
            return w.busy
                ? i18nT('acct.phone.sending', 'Sending…')
                : i18nT('acct.phone.send', 'Send code');
        }
        if (w.busy) return i18nT('acct.code.checking', 'Checking…');
        return w.step === 'password'
            ? i18nT('acct.password.submit', 'Sign in')
            : i18nT('acct.code.verify', 'Verify');
    }

    function setBusy(on) {
        w.busy = on;
        const btn = box.querySelector('.aw-primary');
        if (btn && !btn.hasAttribute('data-aw-finish')) {
            btn.disabled = on;
            btn.textContent = primaryLabel();
        }
    }

    function updateResend() {
        const btn = box.querySelector('[data-aw-resend]');
        if (!btn) return;
        const left = Math.max(0, Math.ceil((w.resendAt - Date.now()) / 1000));
        if (left > 0) {
            const mm = Math.floor(left / 60);
            const ss = String(left % 60).padStart(2, '0');
            btn.disabled = true;
            btn.textContent = i18nTf(
                'acct.code.resend_in',
                { time: `${mm}:${ss}` },
                `Resend code in ${mm}:${ss}`,
            );
        } else {
            btn.disabled = false;
            btn.textContent = i18nT('acct.code.resend', 'Resend code');
        }
    }

    function startResendTimer() {
        w.resendAt = Date.now() + RESEND_AFTER_S * 1000;
        clearInterval(w.tick);
        w.tick = setInterval(() => {
            if (w.step !== 'code') return;
            updateResend();
        }, 1000);
    }

    // ---- server steps ----------------------------------------------------

    function handleHttpError(e) {
        if (e?.data?.code === 'NO_API_CREDS') {
            w.noApi = true;
            w.step = 'phone';
            render();
            return;
        }
        // The server forgot the sign-in (expired / restarted): start over
        // on the next submit.
        if (/not found|Wrong state/i.test(e?.data?.error || e?.message || '')) {
            w.sessionId = null;
            w.step = 'phone';
            render(i18nT('acct.err.session', 'This sign-in expired. Please start again.'));
            return;
        }
        showError(errorText(e?.data || { error: e?.message }, w.step));
    }

    async function sendPhone() {
        if (!w.sessionId) {
            const r = await api.post(
                '/api/accounts/auth/begin',
                { label: w.label },
                { timeoutMs: 90_000 },
            );
            w.sessionId = r.sessionId;
        }
        return api.post(
            '/api/accounts/auth/phone',
            { sessionId: w.sessionId, phone: w.phone },
            { timeoutMs: 90_000 },
        );
    }

    async function submitPhone() {
        const phone = box.querySelector('#aw-phone')?.value.trim() || '';
        w.label = box.querySelector('#aw-label')?.value.trim() || '';
        if (!/^\+?[\d\s()-]{5,}$/.test(phone)) {
            showError(
                i18nT(
                    'acct.err.phone_format',
                    'Enter the number with its country code, e.g. +66812345678.',
                ),
            );
            return;
        }
        w.phone = phone.replace(/[\s()-]/g, '');
        setBusy(true);
        try {
            const r = await sendPhone();
            setBusy(false);
            if (r.state === 'code') {
                w.step = 'code';
                startResendTimer();
                render();
            } else if (r.state === 'password') {
                w.step = 'password';
                w.passwordUsed = true;
                w.hint = r.hint || null;
                render();
            } else if (r.state === 'error') {
                w.sessionId = null;
                render(errorText(r, 'phone'));
            } else {
                showError(errorText(r, 'phone'));
            }
        } catch (e) {
            setBusy(false);
            handleHttpError(e);
        }
    }

    async function submitCode() {
        const code = (box.querySelector('#aw-code')?.value || '').replace(/\D/g, '');
        if (!code) {
            showError(i18nT('acct.err.code_empty', 'Enter the code from Telegram.'));
            return;
        }
        setBusy(true);
        try {
            const r = await api.post(
                '/api/accounts/auth/code',
                { sessionId: w.sessionId, code },
                { timeoutMs: 90_000 },
            );
            setBusy(false);
            await afterAuthStep(r, 'code');
        } catch (e) {
            setBusy(false);
            handleHttpError(e);
        }
    }

    async function submitPassword() {
        const password = box.querySelector('#aw-password')?.value || '';
        if (!password) return showError(i18nT('acct.err.password_empty', 'Enter the password.'));
        setBusy(true);
        try {
            const r = await api.post(
                '/api/accounts/auth/2fa',
                { sessionId: w.sessionId, password },
                { timeoutMs: 90_000 },
            );
            setBusy(false);
            await afterAuthStep(r, 'password');
        } catch (e) {
            setBusy(false);
            handleHttpError(e);
        }
    }

    async function afterAuthStep(r, step) {
        if (r.state === 'done') return finish(r.accountId);
        if (r.state === 'password' && step !== 'password') {
            w.step = 'password';
            w.passwordUsed = true;
            w.hint = r.hint || null;
            render();
            return;
        }
        if (r.state === 'error') {
            // gramJS gave up on this sign-in — the next try starts fresh.
            w.sessionId = null;
            w.step = 'phone';
            render(errorText(r, step));
            return;
        }
        const input = box.querySelector('.aw-input');
        if (input) input.value = '';
        showError(errorText(r, step));
    }

    async function resend() {
        setBusy(true);
        const btn = box.querySelector('[data-aw-resend]');
        if (btn) btn.disabled = true;
        try {
            // There is no "resend" in the server flow: cancel this sign-in
            // and start another one for the same number — Telegram sends a
            // new code.
            await cancelSession();
            const r = await sendPhone();
            setBusy(false);
            if (r.state === 'code') {
                startResendTimer();
                render();
                showError('');
                const lead = box.querySelector('.aw-lead');
                if (lead) lead.textContent = i18nT('acct.code.resent', 'A new code is on its way.');
            } else {
                showError(errorText(r, 'phone'));
                updateResend();
            }
        } catch (e) {
            setBusy(false);
            handleHttpError(e);
            updateResend();
        }
    }

    async function finish(accountId) {
        w.done = true;
        w.accountId = accountId || null;
        const sid = w.sessionId;
        w.sessionId = null;
        clearInterval(w.tick);
        w.step = 'chats';
        render();
        // The first status poll after `done` loads the new account into
        // the running engine (see GET /api/accounts/auth/:sessionId).
        if (sid) await api.get(`/api/accounts/auth/${encodeURIComponent(sid)}`).catch(() => {});
        refreshMonitorStatus();
        if (state.currentPage === 'settings') {
            import('./settings.js').then((m) => m.loadAccounts?.()).catch(() => {});
        }
        loadChats();
    }

    async function loadChats() {
        const status = box.querySelector('[data-aw-chats-status]');
        const list = box.querySelector('[data-aw-chats]');
        const filter = box.querySelector('[data-aw-filter]');
        let dialogs = [];
        try {
            const r = await api.get('/api/dialogs?fresh=1', { timeoutMs: 120_000 });
            dialogs = r.dialogs || [];
            state.allDialogs = dialogs;
            state.dialogsAccounts = Array.isArray(r.accounts) ? r.accounts : [];
        } catch (e) {
            if (!status) return;
            const msg = e?.data?.message || e?.data?.error || e?.message || '';
            status.textContent = i18nTf(
                'acct.chats.failed',
                { msg },
                `Couldn't load chats: ${msg}`,
            );
            status.dataset.kind = 'error';
            return;
        }
        if (!list || !status) return;
        const mine = w.accountId
            ? dialogs.filter((d) => (d.accountIds || []).includes(w.accountId))
            : [];
        w.chats = mine.length ? mine : dialogs;
        const paint = () => {
            const q = (filter?.value || '').trim().toLowerCase();
            const rows = w.chats.filter(
                (d) =>
                    !q ||
                    String(d.name || '')
                        .toLowerCase()
                        .includes(q),
            );
            list.innerHTML = rows
                .slice(0, 60)
                .map((d) => renderChatResultRow(d))
                .join('');
            status.textContent = rows.length
                ? ''
                : i18nT('acct.chats.empty', 'No chats found on this account yet.');
        };
        if (filter && w.chats.length > 8) {
            filter.classList.remove('hidden');
            filter.addEventListener('input', paint);
        }
        paint();
    }

    // ---- events ---------------------------------------------------------

    box.addEventListener('submit', (e) => {
        e.preventDefault();
        if (w.busy) return;
        if (w.step === 'phone' && !w.noApi) submitPhone();
        else if (w.step === 'code') submitCode();
        else if (w.step === 'password') submitPassword();
    });
    box.addEventListener('click', async (e) => {
        if (e.target.closest('[data-aw-cancel]')) {
            await cancelSession();
            handle.close();
            return;
        }
        if (e.target.closest('[data-aw-settings]')) {
            handle.close();
            navigate('#/settings/card-tg-api');
            return;
        }
        if (e.target.closest('[data-aw-resend]')) {
            if (!w.busy) resend();
            return;
        }
        if (e.target.closest('[data-aw-change]')) {
            await cancelSession();
            clearInterval(w.tick);
            w.step = 'phone';
            render();
            return;
        }
        if (e.target.closest('[data-aw-finish]')) {
            handle.close();
        }
    });

    render();
    return handle;
}

/**
 * #/account/add (old links, bookmarks, a typed URL): show the Accounts
 * section underneath and open the wizard over it. The hash is replaced so
 * Back doesn't reopen the wizard — the same trick as #/stories.
 */
export function openAccountWizardFromRoute(renderBase) {
    renderBase?.();
    try {
        history.replaceState(null, '', '#/settings/accounts');
    } catch {
        /* ignore */
    }
    openAccountWizard();
}
