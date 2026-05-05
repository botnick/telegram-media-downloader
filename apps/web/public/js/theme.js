// Theme controller — light/dark/auto. Persists choice in localStorage and
// applies as a class on <html> so CSS overrides can target it.

const KEY = 'tgdl-theme';
const ROOT = document.documentElement;
const mql = window.matchMedia('(prefers-color-scheme: light)');

function effectiveScheme(setting) {
    if (setting === 'light' || setting === 'dark') return setting;
    return mql.matches ? 'light' : 'dark';
}

function apply(setting) {
    const scheme = effectiveScheme(setting);
    ROOT.classList.toggle('theme-light', scheme === 'light');
    ROOT.classList.toggle('theme-dark', scheme === 'dark');
    ROOT.dataset.theme = setting;
    // Tell the browser so form controls and built-in scrollbars adapt too.
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', scheme);
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
