// tgdl-core banner — shown to admins while the app's Go file engine can't
// run (binary missing / not downloadable / unsupported platform / keeps
// crashing). Reads `core` from the shared monitor-status poller, the same
// source the onboarding banner uses; hidden again as soon as it's fixed.

import { t as i18nT } from './i18n.js';
import { subscribe as subscribeMonitorStatus } from './monitor-status.js';

let host = null;
let unsubscribe = null;
let lastKey = '';

function ensureHost() {
    if (host) return host;
    host = document.createElement('div');
    host.id = 'core-banner';
    host.setAttribute('role', 'alert');
    host.className =
        'hidden bg-red-500/10 border-b border-red-500/40 text-tg-text px-4 py-3 text-sm';
    const main = document.querySelector('main');
    if (main?.parentNode) main.parentNode.insertBefore(host, main);
    else document.body.insertBefore(host, document.body.firstChild);
    return host;
}

function render(core) {
    const el = ensureHost();
    const key = core ? `${core.state}|${core.fix}` : '';
    if (key === lastKey) return;
    lastKey = key;
    if (!core) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'max-w-5xl mx-auto';
    const title = document.createElement('div');
    title.className = 'font-semibold';
    title.textContent = i18nT(
        'core.banner.title',
        "tgdl-core, the app's file engine, isn't running",
    );
    const body = document.createElement('div');
    body.className = 'text-tg-textSecondary text-xs mt-1';
    body.textContent = i18nT(
        'core.banner.body',
        'File hashing and duplicate checks, Verify files, Re-index from disk and face grouping are paused until it runs. Everything else works.',
    );
    const fix = document.createElement('div');
    fix.className = 'text-xs mt-1 font-mono break-words';
    fix.textContent = core.fix;
    wrap.append(title, body, fix);
    el.replaceChildren(wrap);
    el.classList.remove('hidden');
}

export function initCoreBanner() {
    if (typeof document !== 'undefined' && document.body?.dataset?.role === 'guest') return;
    if (unsubscribe) unsubscribe();
    unsubscribe = subscribeMonitorStatus((status) => render(status?.core || null));
}
