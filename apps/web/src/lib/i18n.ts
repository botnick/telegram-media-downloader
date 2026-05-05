/**
 * Tiny i18n — fetches /locales/<lang>.json on first use, hands back
 * a `t(key, vars?)` function. Falls back to English when a key
 * misses; nested keys ("nav.viewer") resolved by dot-walk.
 *
 * Persists the preferred language in localStorage so the next page
 * load picks it up before the first render.
 */

import { create } from "zustand";

type Strings = Record<string, unknown>;

interface I18nState {
    lang: string;
    strings: Strings;
    setLang(lang: string): Promise<void>;
}

const STORAGE_KEY = "tgdl-lang";
const DEFAULT_LANG = (() => {
    if (typeof window === "undefined") return "en";
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
    const browser = navigator.language.toLowerCase();
    if (browser.startsWith("th")) return "th";
    return "en";
})();

async function loadLocale(lang: string): Promise<Strings> {
    try {
        const r = await fetch(`/locales/${lang}.json`);
        if (!r.ok) return {};
        return (await r.json()) as Strings;
    } catch {
        return {};
    }
}

export const useI18n = create<I18nState>((set) => ({
    lang: DEFAULT_LANG,
    strings: {},
    setLang: async (lang: string) => {
        const strings = await loadLocale(lang);
        try {
            window.localStorage.setItem(STORAGE_KEY, lang);
        } catch {
            // ignore storage errors (private mode, etc.)
        }
        set({ lang, strings });
    },
}));

// Boot — load the default locale on module evaluation so the first
// render has data ready (or at least a no-op fallback).
if (typeof window !== "undefined") {
    void useI18n.getState().setLang(DEFAULT_LANG);
}

function resolveKey(strings: Strings, key: string): string | null {
    const parts = key.split(".");
    let cur: unknown = strings;
    for (const p of parts) {
        if (cur && typeof cur === "object" && p in cur) {
            cur = (cur as Record<string, unknown>)[p];
        } else {
            return null;
        }
    }
    return typeof cur === "string" ? cur : null;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        name in vars ? String(vars[name]) : `{${name}}`
    );
}

export function useT(): (key: string, vars?: Record<string, string | number>, fallback?: string) => string {
    const strings = useI18n((s) => s.strings);
    return (key, vars, fallback) => {
        const found = resolveKey(strings, key);
        if (found) return interpolate(found, vars);
        if (fallback) return interpolate(fallback, vars);
        return key;
    };
}
