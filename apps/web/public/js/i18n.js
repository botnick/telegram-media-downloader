// Tiny i18n. Loads `/locales/<lang>.json` lazily, exposes `t(key)`, and
// updates every element marked `data-i18n="key"` (or attribute-shaped:
// `data-i18n-aria-label="key"` etc.) so the SPA can flip language without
// reloading.

const LS_KEY = 'tgdl-lang';
const SUPPORTED = ['auto', 'en', 'th'];
const FALLBACK = 'en';

let dict = {};
let active = 'en';
let listeners = new Set();

function detect() {
    const stored = localStorage.getItem(LS_KEY);
    if (stored && SUPPORTED.includes(stored) && stored !== 'auto') return stored;
    const guess = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED.includes(guess) && guess !== 'auto' ? guess : FALLBACK;
}

async function load(lang) {
    if (lang === FALLBACK) {
        // English ships inline so the dashboard never flashes empty strings
        // before the network round-trip resolves.
        dict = {};
        return;
    }
    try {
        const res = await fetch(`/locales/${encodeURIComponent(lang)}.json`);
        if (!res.ok) throw new Error('not found');
        dict = await res.json();
    } catch {
        dict = {};
    }
}

export function t(key, fallback) {
    return (dict && dict[key]) || fallback || key;
}

/**
 * Translate + interpolate `{name}` placeholders against `vars`.
 *   tf('viewer.bulk.confirm', { count: 3 }, 'Delete 3 file(s)?')
 * The fallback string is used (and interpolated) when the key is missing,
 * so callers can keep an English string inline as a safety net during a
 * translation roll-out.
 */
export function tf(key, vars, fallback) {
    const tpl = (dict && dict[key]) || fallback || key;
    if (!vars) return tpl;
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

export function getLang() {
    return localStorage.getItem(LS_KEY) || 'auto';
}

export async function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    localStorage.setItem(LS_KEY, lang);
    active = lang === 'auto' ? detect() : lang;
    document.documentElement.lang = active;
    await load(active);
    applyToDOM();
    for (const fn of listeners) try { fn(active); } catch {}
}

export function onLanguageChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Re-translate every element under `root` that has a data-i18n* attribute.
 * Keys ending with `_html` are rendered as innerHTML so embedded `<code>`
 * / `<b>` / `<a>` markup in the translation actually formats — using
 * textContent would surface literal angle brackets in the UI.
 */
export function applyToDOM(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.dataset.i18n;
        const isHtml = key && key.endsWith('_html');
        const fallback = el.dataset.i18nFallback || (isHtml ? el.innerHTML : el.textContent.trim());
        const value = t(key, fallback);
        if (isHtml) el.innerHTML = value;
        else el.textContent = value;
    });
    // Attribute-shaped translations: data-i18n-aria-label, data-i18n-placeholder, data-i18n-title
    for (const attr of ['aria-label', 'placeholder', 'title']) {
        const dataAttr = `i18n${attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())}`;
        // dataset key is camelCased: aria-label → i18nAriaLabel
        root.querySelectorAll(`[data-${attr === 'aria-label' ? 'i18n-aria-label' : `i18n-${attr}`}]`).forEach((el) => {
            const key = el.dataset[dataAttr] || el.getAttribute(`data-i18n-${attr}`);
            if (!key) return;
            el.setAttribute(attr, t(key, el.getAttribute(attr) || ''));
        });
    }
}

// Module-level promise so consumers that translate during early bootstrap
// (before initI18n() has resolved) can `await ready` to avoid getting an
// empty dict. `initI18n()` assigns this on first call.
let _readyResolve;
export const ready = new Promise((resolve) => { _readyResolve = resolve; });

export async function initI18n() {
    const stored = localStorage.getItem(LS_KEY) || 'auto';
    active = stored === 'auto' ? detect() : stored;
    document.documentElement.lang = active;
    await load(active);
    applyToDOM();
    try { _readyResolve?.(active); } catch {}
}
