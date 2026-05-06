// Verifies that user-configured shortcut overrides in localStorage
// REPLACE the built-in defaults — the shortcuts.js module surfaces this
// via `loadShortcutOverrides`, `setShortcutOverride`, `effectiveShortcuts`.

import { describe, it, expect, beforeEach } from 'vitest';

// Vitest in node mode doesn't have window/localStorage by default. We
// install a minimal in-memory polyfill so the module-under-test can read
// + write without hitting the real browser store. We always-assign (not
// "if undefined") because some Vitest environment plugins or earlier
// test files in the suite leave a stub Storage object on globalThis
// that lacks `setItem`, which made these tests pass in isolation but
// fail in `vitest run` ordering.
class MemStore {
    constructor() { this.m = new Map(); }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
    clear() { this.m.clear(); }
}

function installPolyfills() {
    globalThis.localStorage = new MemStore();
    if (typeof globalThis.window === 'undefined') {
        globalThis.window = {
            localStorage: globalThis.localStorage,
            matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        };
    } else {
        globalThis.window.localStorage = globalThis.localStorage;
        if (typeof globalThis.window.matchMedia !== 'function') {
            globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        }
    }
    if (typeof globalThis.document === 'undefined') {
        globalThis.document = {
            addEventListener() {},
            querySelector() { return null; },
            getElementById() { return null; },
        };
    }
}
installPolyfills();

beforeEach(() => {
    // Re-install before every test so each one sees a fresh writable
    // store, regardless of what test ordering / environment plugin did
    // to globalThis.localStorage in between.
    installPolyfills();
});

describe('shortcut overrides', () => {
    it('loadShortcutOverrides returns {} on a fresh install', async () => {
        const { loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        expect(loadShortcutOverrides()).toEqual({});
    });

    it('setShortcutOverride persists the new binding across reads', async () => {
        const { setShortcutOverride, loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        setShortcutOverride('toggle_select', 'p');
        const map = loadShortcutOverrides();
        expect(map.toggle_select).toBe('p');
    });

    it('effectiveShortcuts replaces the built-in default with the user override', async () => {
        const { setShortcutOverride, effectiveShortcuts } = await import('../src/web/public/js/shortcuts.js');
        const before = effectiveShortcuts().find(s => s.id === 'toggle_select');
        expect(before.keys).toBe('s');

        setShortcutOverride('toggle_select', 'P');
        const after = effectiveShortcuts().find(s => s.id === 'toggle_select');
        expect(after.keys).toBe('P');
    });

    it('resetShortcutOverrides reverts to defaults', async () => {
        const { setShortcutOverride, resetShortcutOverrides, loadShortcutOverrides } =
            await import('../src/web/public/js/shortcuts.js');
        setShortcutOverride('focus_search', 'k');
        expect(loadShortcutOverrides().focus_search).toBe('k');
        resetShortcutOverrides();
        expect(loadShortcutOverrides()).toEqual({});
    });

    it('discards malformed JSON without throwing', async () => {
        globalThis.localStorage.setItem('tgdl-shortcut-overrides', '{not json');
        const { loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        expect(loadShortcutOverrides()).toEqual({});
    });

    it('drops non-string override values defensively', async () => {
        globalThis.localStorage.setItem('tgdl-shortcut-overrides', JSON.stringify({
            toggle_select: 'p',
            invalid: { evil: 'object' },
            other: 42,
        }));
        const { loadShortcutOverrides } = await import('../src/web/public/js/shortcuts.js');
        const m = loadShortcutOverrides();
        expect(m.toggle_select).toBe('p');
        expect(m.invalid).toBeUndefined();
        expect(m.other).toBeUndefined();
    });
});
