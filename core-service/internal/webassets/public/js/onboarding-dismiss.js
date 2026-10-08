// Adds a "Hide for now" ✕ button to the onboarding banner without
// touching onboarding.js. The trick: subscribe to the same
// /api/monitor/status push that onboarding.js subscribes to. Because
// subscribers fire in insertion order and this module is initialised
// AFTER initOnboarding(), our callback always runs immediately after
// onboarding has (re-)rendered the banner — at which point we re-inject
// the ✕ that the innerHTML rewrite just wiped.
//
// localStorage persists dismissal across refreshes. The key is the
// banner's TITLE TEXT itself (i18n-localised) rather than the hint key
// (which onboarding.js does not expose externally), so when the server
// moves the operator to the next step the new title doesn't match the
// stored dismissal → banner re-appears for that step automatically.

import { t as i18nT } from './i18n.js';
import { subscribe as subscribeMonitorStatus } from './monitor-status.js';

const DISMISS_KEY = 'onboarding-dismissed';

function getDismissed() {
    try {
        return localStorage.getItem(DISMISS_KEY);
    } catch {
        return null;
    }
}
function setDismissed(value) {
    try {
        localStorage.setItem(DISMISS_KEY, value);
    } catch {
        /* private mode / sandbox — degrade silently to in-memory only */
    }
}

function ensureRoom(banner) {
    // onboarding.js's template wraps content in a `max-w-5xl mx-auto flex`
    // div. Adding `pr-9` reserves space for the absolute-positioned ✕
    // so the title/body never slip under it.
    const wrapper = banner.firstElementChild;
    if (wrapper && wrapper.classList && !wrapper.classList.contains('pr-9')) {
        wrapper.classList.add('pr-9');
    }
}

function injectInto(banner) {
    if (banner.classList.contains('hidden')) return;

    const titleEl = banner.querySelector('.font-semibold');
    const titleText = titleEl?.textContent?.trim() || '';

    // Already dismissed for this exact title → hide and bail.
    if (titleText && getDismissed() === titleText) {
        banner.classList.add('hidden');
        return;
    }

    // Banner is visible and not dismissed. If the ✕ button is already
    // there (rare — onboarding.js wipes innerHTML on every render so it
    // normally isn't) skip; otherwise build a fresh one.
    if (banner.querySelector('#onboarding-dismiss')) return;

    ensureRoom(banner);

    const dismissLabel = i18nT('onboard.dismiss', 'Hide for now');
    const btn = document.createElement('button');
    btn.id = 'onboarding-dismiss';
    btn.type = 'button';
    btn.setAttribute('aria-label', dismissLabel);
    btn.setAttribute('title', dismissLabel);
    btn.className =
        'absolute top-1.5 right-1.5 w-7 h-7 rounded-full text-tg-textSecondary hover:text-tg-text hover:bg-tg-text/10 flex items-center justify-center transition-colors';
    btn.innerHTML = '<i class="ri-close-line text-base" aria-hidden="true"></i>';
    btn.addEventListener('click', () => {
        if (titleText) setDismissed(titleText);
        banner.classList.add('hidden');
    });

    banner.appendChild(btn);
}

export function initOnboardingDismiss() {
    subscribeMonitorStatus(() => {
        const banner = document.getElementById('onboarding-banner');
        if (banner) injectInto(banner);
    });
}
