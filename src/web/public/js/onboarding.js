// Onboarding banner — drives the user through the 3 steps a fresh install
// needs (API creds → add account → enable a group) by reading the `hint`
// field that /api/monitor/status now returns. Polls every 4s; sticky at the
// top of the dashboard until the hint becomes null.

import { api } from './api.js';

const HINTS = {
    'configure-api': {
        step: 1,
        title: 'Step 1 of 3 — paste your Telegram API credentials',
        body: 'Get apiId + apiHash from <a href="https://my.telegram.org" target="_blank" rel="noopener" class="underline">my.telegram.org</a>, then save them under Settings → Telegram API.',
        action: 'Open Settings',
    },
    'add-account': {
        step: 2,
        title: 'Step 2 of 3 — add a Telegram account',
        body: 'Sign in with your phone number (and 2FA if you have it). Sessions are stored encrypted under <code>data/sessions/</code>.',
        action: 'Add account',
    },
    'enable-group': {
        step: 3,
        title: 'Step 3 of 3 — pick a chat to monitor',
        body: 'Open the Groups page, click a chat to add it, or paste a <code>t.me/...</code> link from the top bar to download a single message right away.',
        action: 'Choose a group',
    },
};

let host = null;
let pollHandle = null;

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
    if (!hint || !HINTS[hint]) {
        el.classList.add('hidden');
        return;
    }
    const h = HINTS[hint];
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

async function refresh() {
    try {
        const status = await api.get('/api/monitor/status');
        render(status?.hint || null);
    } catch { /* ignore — keep last state */ }
}

export function initOnboarding() {
    refresh();
    if (pollHandle) clearInterval(pollHandle);
    // Poll every 4 s — cheap and responsive enough for a fresh-install flow.
    pollHandle = setInterval(refresh, 4000);
}

export function refreshOnboarding() { refresh(); }
