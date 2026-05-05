/**
 * Theme switcher — sets a `data-theme` attribute on <html> that the
 * Tailwind v4 @theme block keys off via [data-theme=...] selectors.
 *
 * Persists to localStorage so the next boot picks the same theme
 * before React hydrates (no flash of wrong theme).
 */

import { create } from "zustand";

type Theme = "dark" | "light" | "sunset" | "auto";

interface ThemeState {
    theme: Theme;
    setTheme(t: Theme): void;
}

const STORAGE_KEY = "tgdl-theme";

function resolveAuto(): Exclude<Theme, "auto"> {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
    if (typeof document === "undefined") return;
    const effective = theme === "auto" ? resolveAuto() : theme;
    document.documentElement.dataset["theme"] = effective;
}

const initial: Theme = (() => {
    if (typeof window === "undefined") return "dark";
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light" || saved === "sunset" || saved === "auto") return saved;
    return "dark";
})();

if (typeof window !== "undefined") applyTheme(initial);

export const useTheme = create<ThemeState>((set) => ({
    theme: initial,
    setTheme: (t) => {
        try {
            window.localStorage.setItem(STORAGE_KEY, t);
        } catch {
            // ignore
        }
        applyTheme(t);
        set({ theme: t });
    },
}));
