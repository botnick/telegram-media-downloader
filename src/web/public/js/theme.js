// Theme controller — light/dark/auto. Persists choice in localStorage and
// applies as a class on <html> so CSS overrides can target it.

const KEY = 'tgdl-theme';
const ROOT = document.documentElement;
const mql = window.matchMedia('(prefers-color-scheme: light)');

function effectiveScheme(setting) {
    if (setting === 'light' || setting === 'dark') return setting;
    return mql.matches ? 'light' : 'dark';
}

// Browser / OS status-bar colour — matches the #content-header background
// of each scheme. index.html ships one <meta name="theme-color"> per
// prefers-color-scheme; when the user forces a theme both carry that
// theme's colour so the bar doesn't follow the OS instead of the app.
const THEME_COLORS = { dark: '#17212B', light: '#FFFFFF' };

function syncThemeColor(setting, scheme) {
    const forced = setting === 'light' || setting === 'dark';
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
        const ownScheme = /light/.test(meta.getAttribute('media') || '') ? 'light' : 'dark';
        meta.setAttribute('content', THEME_COLORS[forced ? scheme : ownScheme]);
    }
}

function apply(setting) {
    const scheme = effectiveScheme(setting);
    ROOT.classList.toggle('theme-light', scheme === 'light');
    ROOT.classList.toggle('theme-dark', scheme === 'dark');
    ROOT.dataset.theme = setting;
    // Tell the browser so form controls and built-in scrollbars adapt too.
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', scheme);
    syncThemeColor(setting, scheme);
    document.dispatchEvent(new CustomEvent('themechange', { detail: { setting, scheme } }));
}

export function initTheme() {
    const stored = localStorage.getItem(KEY) || 'auto';
    apply(stored);
    mql.addEventListener?.('change', () => {
        if ((localStorage.getItem(KEY) || 'auto') === 'auto') apply('auto');
    });
}

export function getTheme() {
    return localStorage.getItem(KEY) || 'auto';
}

export function setTheme(setting) {
    if (!['light', 'dark', 'auto'].includes(setting)) return;
    localStorage.setItem(KEY, setting);
    apply(setting);
}

// Apply the persisted choice as early as possible to avoid the "dark flash"
// on light-theme reloads. The full module is loaded later by app.js.
initTheme();
