// Onboarding banner — drives the user through the 3 steps a fresh install
// needs (API creds → add account → enable a group) by reading the `hint`
// field that /api/monitor/status now returns. Subscribes to the shared
// monitor-status poller (3 s cadence) instead of running its own timer —
// statusbar.js, engine.js and this module used to each poll independently
// (5 s + 3 s + 4 s = three separate fetches every few seconds), now they
// share one.

import { t as i18nT } from './i18n.js';
import { subscribe as subscribeMonitorStatus, refreshNow as refreshMonitorStatus } from './monitor-status.js';

const HINTS_DEF = {
    'configure-api': {
        step: 1,
        titleKey: 'onboard.configure_api.title',
        bodyKey: 'onboard.configure_api.body_html',
        actionKey: 'onboard.configure_api.action',
        defTitle: 'Step 1 of 3 — paste your Telegram API credentials',
        defBody: 'Get apiId + apiHash from <a href="https://my.telegram.org" target="_blank" rel="noopener" class="underline">my.telegram.org</a>, then save them under Settings → Telegram API.',
        defAction: 'Open Settings',
    },
    'add-account': {
        step: 2,
        titleKey: 'onboard.add_account.title',
        bodyKey: 'onboard.add_account.body_html',
        actionKey: 'onboard.add_account.action',
        defTitle: 'Step 2 of 3 — add a Telegram account',
        defBody: 'Sign in with your phone number (and 2FA if you have it). Sessions are stored encrypted under <code>data/sessions/</code>.',
        defAction: 'Add account',
    },
    'enable-group': {
        step: 3,
        titleKey: 'onboard.enable_group.title',
        bodyKey: 'onboard.enable_group.body_html',
        actionKey: 'onboard.enable_group.action',
        defTitle: 'Step 3 of 3 — pick a chat to monitor',
        defBody: 'Open the Groups page, click a chat to add it, or paste a <code>t.me/...</code> link from the top bar to download a single message right away.',
        defAction: 'Choose a group',
    },
};

function resolveHint(key) {
    const d = HINTS_DEF[key];
    if (!d) return null;
    return {
        step: d.step,
        title: i18nT(d.titleKey, d.defTitle),
        body: i18nT(d.bodyKey, d.defBody),
        action: i18nT(d.actionKey, d.defAction),
    };
}

let host = null;
let unsubscribe = null;

function ensureHost() {
    if (host) return host;
    host = document.createElement('div');
    host.id = 'onboarding-banner';
    host.className = 'hidden bg-tg-blue/10 border-b border-tg-blue/30 text-tg-text px-4 py-3 text-sm';
    host.style.position = 'sticky';
    host.style.top = '0';
    host.style.zIndex = '30';
    const main = document.querySelector('main');
    if (main && main.parentNode) main.parentNode.insertBefore(host, main);
    else document.body.insertBefore(host, document.body.firstChild);
    return host;
}

function openSettings(target) {
    if (typeof window.navigateTo === 'function') window.navigateTo('settings');
    if (target) {
        // Scroll the page to the right section after the page renders.
        setTimeout(() => {
            const el = document.querySelector(target);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
    }
}

function render(hint) {
    const el = ensureHost();
    const h = resolveHint(hint);
    if (!h) {
        el.classList.add('hidden');
        return;
    }
    const targetMap = {
        'configure-api': '#setting-api-id',
        'add-account': '#accounts-list',
        'enable-group': null, // we navigate to the Groups page below
    };
    el.classList.remove('hidden');
    el.innerHTML = `
        <div class="max-w-5xl mx-auto flex items-start gap-3">
            <div class="text-2xl">${'🪄'}</div>
            <div class="flex-1 min-w-0">
                <div class="font-semibold">${h.title}</div>
                <div class="text-tg-textSecondary text-xs mt-1">${h.body}</div>
            </div>
            <button id="onboarding-go" class="ml-auto self-center px-3 py-1.5 rounded bg-tg-blue text-white text-xs font-medium hover:bg-opacity-90">${h.action}</button>
        </div>`;
    el.querySelector('#onboarding-go').addEventListener('click', () => {
        if (hint === 'enable-group' && typeof window.navigateTo === 'function') {
            window.navigateTo('groups');
        } else {
            openSettings(targetMap[hint]);
        }
    });
}

function applyStatus(status) {
    render(status?.hint || null);
}

export function initOnboarding() {
    // Guests can't progress any of the onboarding steps (paste creds / add
    // account / enable group are all admin-only mutations), so showing the
    // banner just teases them with a button that 403s. Skip the subscription
    // entirely for the guest role — leaves the banner element absent.
    if (typeof document !== 'undefined' && document.body?.dataset?.role === 'guest') return;
    if (unsubscribe) unsubscribe();
    unsubscribe = subscribeMonitorStatus(applyStatus);
}

export function refreshOnboarding() { refreshMonitorStatus(); }
