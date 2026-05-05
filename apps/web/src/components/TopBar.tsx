/**
 * Top header bar — replicates the legacy SPA's content header
 * (legacy.html:496–712).
 *
 * Layout:
 *   - hamburger (mobile) | avatar | title/subtitle | role pill
 *   - engine status pill | notify bell | select-mode toggle
 *   - desktop-only: paste-link | stories | view-mode | refresh
 *   - overflow ⋮ on mobile
 *
 * Title + avatar + actions are page-driven; route components pass
 * the props that change (title, subtitle, avatarColor, avatarIcon,
 * onAddDialog, etc.).
 */

import { type ReactNode } from "react";
import { useUiStore } from "@/store/ui";

export interface TopBarProps {
    /** Page title (e.g. "All Media", "Manage Groups"). */
    title: string;
    /** Optional subtitle below the title (mobile-hidden). */
    subtitle?: string;
    /** Avatar variant 1–5 — same scheme as legacy `.tg-avatar-{n}`. */
    avatarColor?: 1 | 2 | 3 | 4 | 5;
    /** Avatar icon class (e.g. `ri-gallery-line`). */
    avatarIcon?: string;
    /** Slot for page-specific action buttons (Add, etc.). */
    pageActions?: ReactNode;
}

export function TopBar({
    title,
    subtitle,
    avatarColor = 1,
    avatarIcon = "ri-gallery-line",
    pageActions,
}: TopBarProps) {
    const { selectMode, setSelectMode } = useUiStore();

    return (
        <header className="h-14 bg-tg-bg border-b border-tg-border flex items-center px-2 sm:px-4 gap-1 sm:gap-2 shrink-0">
            <button
                type="button"
                className="md:hidden w-10 h-10 flex items-center justify-center rounded-full hover:bg-tg-hover shrink-0"
                aria-label="Open menu"
            >
                <i className="ri-menu-line text-xl text-tg-textSecondary" />
            </button>

            <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
                <div
                    className={`tg-avatar tg-avatar-${avatarColor} w-9 h-9 sm:w-10 sm:h-10 text-base sm:text-lg shrink-0`}
                >
                    <i className={avatarIcon} />
                </div>
                <div className="min-w-0 flex-1">
                    <h1 className="font-medium text-tg-text truncate text-sm sm:text-base">
                        {title}
                    </h1>
                    {subtitle ? (
                        <p className="text-xs text-tg-textSecondary truncate hidden sm:block">
                            {subtitle}
                        </p>
                    ) : null}
                </div>
            </div>

            <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
                {pageActions}

                {/* Engine status pill */}
                <a
                    href="#/settings/engine"
                    className="engine-status-pill flex items-center gap-1.5 px-3 h-8 rounded-full bg-tg-panel hover:bg-tg-hover text-xs"
                    aria-label="Engine status"
                >
                    <span className="w-2 h-2 rounded-full bg-tg-textSecondary" />
                    <span className="text-tg-text">Idle</span>
                </a>

                <button
                    type="button"
                    className="w-10 h-10 rounded-full hover:bg-tg-hover flex items-center justify-center relative"
                    aria-label="Notifications"
                >
                    <i className="ri-notification-3-line text-xl text-tg-textSecondary" />
                </button>

                <button
                    type="button"
                    onClick={() => setSelectMode(!selectMode)}
                    className={`w-10 h-10 rounded-full hover:bg-tg-hover items-center justify-center hidden md:flex ${
                        selectMode ? "bg-tg-hover" : ""
                    }`}
                    aria-label="Toggle selection mode"
                >
                    <i className="ri-checkbox-multiple-line text-xl text-tg-textSecondary" />
                </button>

                <button
                    type="button"
                    className="hidden sm:flex w-10 h-10 rounded-full hover:bg-tg-hover items-center justify-center"
                    aria-label="Download from Telegram link"
                    title="Download from a Telegram link"
                >
                    <i className="ri-link-m text-xl text-tg-textSecondary" />
                </button>

                <button
                    type="button"
                    className="hidden sm:flex w-10 h-10 rounded-full hover:bg-tg-hover items-center justify-center"
                    aria-label="Stories"
                    title="Download Telegram Stories"
                >
                    <i className="ri-camera-line text-xl text-tg-textSecondary" />
                </button>

                <button
                    type="button"
                    className="hidden sm:flex w-10 h-10 rounded-full hover:bg-tg-hover items-center justify-center"
                    aria-label="View mode"
                >
                    <i className="ri-layout-grid-line text-xl text-tg-textSecondary" />
                </button>

                <button
                    type="button"
                    className="w-10 h-10 rounded-full hover:bg-tg-hover flex items-center justify-center"
                    aria-label="Refresh"
                >
                    <i className="ri-refresh-line text-xl text-tg-textSecondary" />
                </button>
            </div>
        </header>
    );
}
