// Global keyboard shortcuts. Press `?` to open the cheatsheet, `Esc` closes
// any open sheet (sheet.js handles that for us). Listener is no-op while
// focus is in an input / textarea / contenteditable so search and form
// fields stay usable.
//
// User overrides: set `localStorage['tgdl-shortcut-overrides']` to a JSON
// object mapping `actionId` → key string. Empty object → defaults. Cross-
// session, no server round-trip. The Settings → Look & Feel panel can
// surface a UI for this; the wire format is documented + tested.

import { openSheet, sheetCount } from './sheet.js';
import { t as i18nT } from './i18n.js';

const OVERRIDE_KEY = 'tgdl-shortcut-overrides';

// Each shortcut has an `id` (stable forever — used as the override key),
// the default `keys` label (shown in the cheatsheet), an i18n key + EN
// fallback string, and a `match` predicate that takes a KeyboardEvent
// and returns true on hit. Overrides REPLACE the default keys label
// AND the predicate so the cheatsheet reflects the new binding.
const SHORTCUTS = [
    { id: 'cheatsheet',     keys: '?',          k: 'shortcuts.cheatsheet',     def: 'Open this shortcuts cheatsheet' },
    { id: 'close_modal',    keys: 'Esc',        k: 'shortcuts.close_modal',    def: 'Close any modal / sheet / drawer' },
    { id: 'go_library',     keys: 'g v',        k: 'shortcuts.go_library',     def: 'Go to Library' },
    { id: 'go_chats',       keys: 'g g',        k: 'shortcuts.go_chats',       def: 'Go to Chats' },
    { id: 'go_engine',      keys: 'g e',        k: 'shortcuts.go_engine',      def: 'Go to Engine' },
    { id: 'go_settings',    keys: 'g s',        k: 'shortcuts.go_settings',    def: 'Go to Settings' },
    { id: 'focus_search',   keys: '/',          k: 'shortcuts.focus_search',   def: 'Focus the gallery search box' },
    { id: 'open_paste',     keys: 'l',          k: 'shortcuts.open_paste',     def: 'Open the "paste t.me link" drawer' },
    { id: 'toggle_select',  keys: 's',          k: 'shortcuts.toggle_select',  def: 'Toggle gallery selection mode' },
    { id: 'play_pause',     keys: 'Enter',      k: 'shortcuts.play_pause',     def: '(in viewer) play / pause video' },
    { id: 'prev_next',      keys: '← / →',      k: 'shortcuts.prev_next',      def: '(in viewer) previous / next item' },
    { id: 'fullscreen',     keys: 'f',          k: 'shortcuts.fullscreen',     def: '(in viewer) toggle fullscreen' },
];

/**
 * Read the per-user override map from localStorage. Returns an empty
 * object if the key isn't set, the JSON is malformed, or `localStorage`
 * itself isn't available (e.g. SSR / sandboxed iframes).
 */
export function loadShortcutOverrides() {
    try {
        const raw = localStorage.getItem(OVERRIDE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        // Drop non-string values defensively — the override has to be a
        // displayable label, not a function or whatever else.
        const out = {};
        for (const k of Object.keys(parsed)) {
            if (typeof parsed[k] === 'string' && parsed[k]) out[k] = parsed[k];
        }
        return out;
    } catch { return {}; }
}

/**
 * Persist a single override. Pass `null`/`undefined` to clear it.
 */
export function setShortcutOverride(id, keys) {
    const cur = loadShortcutOverrides();
    if (!keys) delete cur[id];
    else cur[id] = String(keys);
    try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(cur)); } catch { /* quota / disabled */ }
    return cur;
}

/** Clear every user override and revert to the built-in defaults. */
export function resetShortcutOverrides() {
    try { localStorage.removeItem(OVERRIDE_KEY); } catch {}
}

/**
 * Compose the in-memory shortcut list with user overrides. Each entry's
 * `keys` is replaced when the user has set one — the rendering side
 * uses this for the cheatsheet AND the dispatcher uses it to match
 * KeyboardEvents (string compare against e.key by default; the chord
 * shortcuts ('g v' / 'g g' / etc.) keep their custom logic below).
 */
export function effectiveShortcuts() {
    const ov = loadShortcutOverrides();
    return SHORTCUTS.map(s => ov[s.id] ? { ...s, keys: ov[s.id] } : s);
}

let lastG = 0; // chord buffer

function buildContent() {
    const wrap = document.createElement('ul');
    wrap.className = 'space-y-1.5 text-sm';
    wrap.innerHTML = effectiveShortcuts().map(s => `
        <li class="flex items-center justify-between">
            <span class="text-tg-textSecondary">${i18nT(s.k, s.def)}</span>
            <kbd class="px-1.5 py-0.5 text-xs rounded bg-tg-bg/60 border border-tg-border font-mono">${s.keys}</kbd>
        </li>
    `).join('') +
    `<li class="text-[11px] text-tg-textSecondary pt-2 border-t border-tg-border mt-2">${i18nT('shortcuts.tip', "Tip — none of these fire while you're typing in a text field.")}</li>`;
    return wrap;
}

function show() {
    if (sheetCount() > 0 && document.querySelector('.sheet-root[data-shortcuts]')) return;
    const handle = openSheet({
        title: i18nT('shortcuts.title', 'Keyboard shortcuts'),
        content: buildContent(),
        size: 'sm',
    });
    handle.root.setAttribute('data-shortcuts', '1');
}

function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function dispatchG(letter) {
    const map = { v: 'viewer', g: 'groups', e: 'engine', s: 'settings' };
    const target = map[letter];
    if (target && typeof window.navigateTo === 'function') window.navigateTo(target);
}

/**
 * Match an effective shortcut against an event. Returns the matching
 * SHORTCUT entry (with the override keys substituted) or null.
 *
 * The match logic is intentionally simple — it compares e.key (case-
 * insensitive) against the user's override label, OR falls through to
 * the original built-in handler for chord shortcuts. The chord buffer
 * (`lastG`) handles the `g <letter>` family.
 */
function _matchOverride(e) {
    const ov = loadShortcutOverrides();
    if (!ov || !Object.keys(ov).length) return null;
    const k = (e.key || '').toLowerCase();
    for (const id of Object.keys(ov)) {
        const want = String(ov[id] || '').toLowerCase();
        if (!want) continue;
        if (want === k) return id;
    }
    return null;
}

function _runAction(id) {
    if (id === 'cheatsheet')   { show(); return; }
    if (id === 'open_paste')   { document.getElementById('paste-url-btn')?.click(); return; }
    if (id === 'toggle_select'){ document.getElementById('select-mode-btn')?.click(); return; }
    if (id === 'focus_search') { document.getElementById('search-input')?.focus(); return; }
    if (id === 'go_library')   { dispatchG('v'); return; }
    if (id === 'go_chats')     { dispatchG('g'); return; }
    if (id === 'go_engine')    { dispatchG('e'); return; }
    if (id === 'go_settings')  { dispatchG('s'); return; }
    // play_pause / prev_next / fullscreen are owned by viewer.js; the
    // override system here is the source of truth for the mapping but
    // the viewer wires its own keydown listener for in-modal keys.
}

export function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (isTyping(e)) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        // User-configured override beats every built-in mapping. We try
        // it first so a user who rebinds 's' to (say) 'p' gets the new
        // binding without the built-in fallback also firing on 's'.
        const overrideHit = _matchOverride(e);
        if (overrideHit) {
            e.preventDefault();
            _runAction(overrideHit);
            return;
        }

        if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
            e.preventDefault();
            show();
            return;
        }
        if (e.key === 'l' || e.key === 'L') {
            document.getElementById('paste-url-btn')?.click();
            return;
        }
        if (e.key === 's' || e.key === 'S') {
            document.getElementById('select-mode-btn')?.click();
            return;
        }
        if (e.key === 'g' || e.key === 'G') {
            lastG = Date.now();
            return;
        }
        if (Date.now() - lastG < 800 && /^[a-z]$/i.test(e.key)) {
            lastG = 0;
            dispatchG(e.key.toLowerCase());
        }
    });
}
