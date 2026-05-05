/**
 * Top-level layout — sidebar + main content. Mirrors the legacy SPA's
 * structure (left rail with primary navigation, main area renders the
 * active route's outlet).
 */

import { Link, Outlet } from "@tanstack/react-router";
import { useStats, useVersion } from "@/api/queries";

const NAV = [
    { to: "/" as const, label: "Home", icon: "🏠" },
    { to: "/viewer" as const, label: "All Media", icon: "🖼️" },
    { to: "/groups" as const, label: "Groups", icon: "📁" },
    { to: "/queue" as const, label: "Queue", icon: "⏳" },
    { to: "/backfill" as const, label: "Backfill", icon: "📥" },
    { to: "/settings" as const, label: "Settings", icon: "⚙️" },
    { to: "/maintenance" as const, label: "Maintenance", icon: "🛠️" },
];

export function AppShell() {
    const stats = useStats();
    const version = useVersion();

    return (
        <div className="flex h-full">
            <aside className="w-64 bg-tg-panel border-r border-white/5 flex flex-col">
                <div className="p-4 border-b border-white/5">
                    <h1 className="text-lg font-semibold">Telegram Downloader</h1>
                    <p className="text-xs text-tg-text-secondary">
                        v{version.data?.version ?? "?"}
                    </p>
                </div>

                <nav className="flex-1 p-2 space-y-1">
                    {NAV.map((item) => (
                        <Link
                            key={item.to}
                            to={item.to}
                            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 text-sm"
                            activeProps={{ className: "bg-tg-blue/30" }}
                        >
                            <span>{item.icon}</span>
                            <span>{item.label}</span>
                        </Link>
                    ))}
                </nav>

                <footer className="p-3 border-t border-white/5 text-xs text-tg-text-secondary">
                    <div className="flex justify-between">
                        <span>Files</span>
                        <span>{stats.data?.totalFiles ?? "—"}</span>
                    </div>
                    <div className="flex justify-between">
                        <span>Disk</span>
                        <span>{stats.data?.totalBytesFormatted ?? "—"}</span>
                    </div>
                </footer>
            </aside>

            <main className="flex-1 overflow-hidden">
                <Outlet />
            </main>
        </div>
    );
}
