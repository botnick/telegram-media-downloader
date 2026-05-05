/**
 * Single-source-of-truth for the lightbox overlay. Any gallery
 * component can call openLightbox(files, index) and the AppShell
 * will render the Lightbox over its main outlet.
 */

import { create } from "zustand";
import type { ViewerFile } from "@tgdl/shared";

interface LightboxState {
    open: boolean;
    files: ViewerFile[];
    index: number;
    openLightbox(files: ViewerFile[], index: number): void;
    close(): void;
}

export const useLightboxStore = create<LightboxState>((set) => ({
    open: false,
    files: [],
    index: 0,
    openLightbox: (files, index) => set({ open: true, files, index }),
    close: () => set({ open: false }),
}));
