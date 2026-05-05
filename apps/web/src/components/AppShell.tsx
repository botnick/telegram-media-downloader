/**
 * App shell — three-pane Telegram-style layout.
 *
 * <Sidebar>           pinned left, scrolls inside its own column
 * <main><Outlet /></main>   content area, route-driven
 * <StatusBar />       full-width footer
 *
 * The lightbox renders as a portal-style overlay when the store flips
 * its `open` flag; AppShell mounts it conditionally so the keyboard +
 * scroll handlers attach only while it's visible.
 */

import { Outlet } from "@tanstack/react-router";

import { Lightbox } from "@/components/Lightbox";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { useLightboxStore } from "@/store/lightbox";

export function AppShell() {
    const lightbox = useLightboxStore();

    return (
        <div className="flex h-full bg-tg-bg text-tg-text">
            <Sidebar />

            <div className="flex-1 flex flex-col overflow-hidden">
                <main className="flex-1 overflow-hidden">
                    <Outlet />
                </main>
                <StatusBar />
            </div>

            {lightbox.open ? (
                <Lightbox
                    files={lightbox.files}
                    initialIndex={lightbox.index}
                    onClose={lightbox.close}
                />
            ) : null}
        </div>
    );
}
