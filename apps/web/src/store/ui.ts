/**
 * UI state — view mode, current group filter, selection, etc.
 *
 * Server state lives in TanStack Query (api/queries). Anything that
 * isn't fetched from the backend goes here so components can read +
 * write it without prop drilling.
 */

import type { ViewerFileType } from "@tgdl/shared";
import { create } from "zustand";

interface UiState {
    viewMode: "grid" | "compact" | "list";
    typeFilter: ViewerFileType | "all";
    selectedPaths: Set<string>;
    selectMode: boolean;
    setViewMode(mode: UiState["viewMode"]): void;
    setTypeFilter(filter: UiState["typeFilter"]): void;
    toggleSelected(path: string): void;
    clearSelected(): void;
    setSelectMode(on: boolean): void;
}

export const useUiStore = create<UiState>((set) => ({
    viewMode: "grid",
    typeFilter: "all",
    selectedPaths: new Set(),
    selectMode: false,
    setViewMode: (mode) => set({ viewMode: mode }),
    setTypeFilter: (filter) => set({ typeFilter: filter }),
    toggleSelected: (path) =>
        set((s) => {
            const next = new Set(s.selectedPaths);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return { selectedPaths: next };
        }),
    clearSelected: () => set({ selectedPaths: new Set() }),
    setSelectMode: (on) => set({ selectMode: on, selectedPaths: on ? new Set() : new Set() }),
}));
