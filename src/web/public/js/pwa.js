// PWA wiring — registers the service worker, captures the
// `beforeinstallprompt` event, and exposes a small `installPwa()` API plus
// an `installable` CustomEvent so the UI can show / hide an install button.
//
// Usage in markup:
//   <button id="pwa-install-btn" hidden onclick="installPwa()">…</button>
//
// We surface the button by toggling the `hidden` attribute on any element
// with `[data-pwa-install]`. The button is invisible until the browser
// confirms the app is installable (and never reappears after install).

let deferredPrompt = null;

function setInstallVisible(visible) {
    document.querySelectorAll('[data-pwa-install]').forEach((el) => {
        if (visible) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
    });
}

// Already-installed (display-mode standalone or iOS standalone) → never
// show the install affordance.
function isStandalone() {
    return (
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        // iOS Safari (no beforeinstallprompt at all — manual Add to Home Screen)
        window.navigator.standalone === true
    );
}

window.addEventListener('beforeinstallprompt', (e) => {
    // Stash for later; Chrome only fires this once per page load.
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone()) setInstallVisible(true);
    window.dispatchEvent(new CustomEvent('pwa:installable'));
});

window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setInstallVisible(false);
    window.dispatchEvent(new CustomEvent('pwa:installed'));
});

/**
 * Trigger the native install prompt. No-op if the browser hasn't fired
 * `beforeinstallprompt` yet (Safari, Firefox desktop, already-installed).
 * Returns the user's choice ('accepted' / 'dismissed' / 'unavailable').
 */
export async function installPwa() {
    if (!deferredPrompt) return 'unavailable';
    const evt = deferredPrompt;
    deferredPrompt = null;
    setInstallVisible(false);
    try {
        evt.prompt();
        const choice = await evt.userChoice;
        return choice && choice.outcome ? choice.outcome : 'dismissed';
    } catch {
        return 'dismissed';
    }
}

// Expose globally so inline `onclick="installPwa()"` works without an
// import in the markup.
window.installPwa = installPwa;

// Hide the button up-front if we're already running standalone.
if (isStandalone()) setInstallVisible(false);

// ---- Service worker registration -----------------------------------------
// Register on page load so it doesn't compete with the SPA boot for
// bandwidth. Auto-update: when a new SW takes control we reload once so
// the user sees the new shell immediately.
if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        // Soft reload — the new SW has already claimed clients via
        // clients.claim(), so the next request gets the fresh shell.
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('/sw.js', { scope: '/' })
            .then((reg) => {
                // If a new worker is found, tell it to take over right
                // away (matches the SW's skipWaiting handler).
                reg.addEventListener('updatefound', () => {
                    const sw = reg.installing;
                    if (!sw) return;
                    sw.addEventListener('statechange', () => {
                        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                            sw.postMessage('SKIP_WAITING');
                            window.dispatchEvent(new CustomEvent('pwa:update-available'));
                        }
                    });
                });
            })
            .catch(() => {
                /* SW registration is best-effort; dashboard still works */
            });
    });
}
