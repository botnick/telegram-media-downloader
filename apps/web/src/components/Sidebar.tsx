/**
 * Left sidebar — direct port of the legacy.html sidebar block
 * (lines 155–290). Every class name + structure is preserved so the
 * shared CSS (legacy.css + Tailwind) renders pixel-identically.
 *
 * Behaviour wiring:
 *   - search input updates UI store's filter
 *   - nav items use TanStack Router Link with `data-page` for the
 *     legacy CSS active-state selector
 *   - "All Media" jumps to /viewer
 *   - downloaded groups list reads from /api/groups (TanStack Query)
 *   - footer disk + files chips read from /api/stats
 *   - sign-out posts to /api/logout then redirects
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useGroups, useStats } from "@/api/queries";
import { api } from "@/api/client";

const NAV_ITEMS = [
    { page: "groups", to: "/groups" as const, icon: "ri-group-line", label: "Groups", admin: true },
    { page: "backfill", to: "/backfill" as const, icon: "ri-history-line", label: "Backfill", admin: true },
    { page: "queue", to: "/queue" as const, icon: "ri-download-cloud-2-line", label: "Queue", admin: true },
    { page: "settings", to: "/settings" as const, icon: "ri-settings-3-line", label: "Settings", admin: false },
    { page: "maintenance", to: "/maintenance" as const, icon: "ri-tools-line", label: "Maintenance", admin: true },
];

export function Sidebar() {
    const navigate = useNavigate();
    const stats = useStats();
    const groups = useGroups();
    const [search, setSearch] = useState("");
    const [groupsFilter, setGroupsFilter] = useState("");
    const [groupsCollapsed, setGroupsCollapsed] = useState(false);

    const handleSignOut = async () => {
        try {
            await api.post("/api/logout");
        } catch {
            // ignore — drop the local session either way
        }
        window.location.href = "/login";
    };

    const downloaded = (groups.data?.downloaded ?? []).filter((g) =>
        groupsFilter ? g.name.toLowerCase().includes(groupsFilter.toLowerCase()) : true
    );

    return (
        <aside
            id="sidebar"
            className="fixed md:relative w-[min(85vw,18rem)] sm:w-80 bg-tg-sidebar border-r border-tg-border flex flex-col h-full z-50 sidebar-mobile md:transform-none"
        >
            {/* Header — back button + search */}
            <div className="p-3 flex items-center gap-3 border-b border-tg-border">
                <button
                    type="button"
                    id="sidebar-close"
                    className="md:hidden w-10 h-10 flex items-center justify-center rounded-full hover:bg-tg-hover"
                    aria-label="Close sidebar"
                >
                    <i className="ri-arrow-left-line text-xl text-tg-textSecondary" />
                </button>
                <div className="flex-1 relative">
                    <input
                        type="text"
                        id="search-input"
                        placeholder="Search"
                        className="tg-input pl-10 py-2 text-sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-tg-textSecondary" />
                </div>
            </div>

            {/* Navigation */}
            <nav className="border-b border-tg-border">
                {NAV_ITEMS.map((item) => (
                    <Link
                        key={item.page}
                        to={item.to}
                        className="nav-item flex items-center gap-3 p-3 cursor-pointer hover:bg-tg-hover"
                        data-page={item.page}
                        activeProps={{ className: "nav-item flex items-center gap-3 p-3 cursor-pointer hover:bg-tg-hover active" }}
                    >
                        <i className={`${item.icon} text-xl text-tg-textSecondary`} />
                        <span className="text-tg-text">{item.label}</span>
                    </Link>
                ))}
            </nav>

            {/* All Media button */}
            <div className="p-2 border-b border-tg-border">
                <button
                    type="button"
                    onClick={() => navigate({ to: "/viewer" })}
                    className="w-full flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-tg-hover transition-colors text-left"
                >
                    <div className="tg-avatar tg-avatar-4 w-12 h-12 text-xl flex-shrink-0">
                        <i className="ri-gallery-fill" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="font-medium text-tg-text text-[15px]">All Media</h3>
                        <p
                            id="all-media-count"
                            className="text-[13px] text-tg-textSecondary"
                        >
                            {stats.data
                                ? `${stats.data.totalFiles.toLocaleString()} files`
                                : "View all files"}
                        </p>
                    </div>
                </button>
            </div>

            {/* Downloaded Groups list */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
                <div className="sidebar-groups-header sticky top-0 z-20 bg-tg-sidebar border-b border-tg-border/40">
                    <button
                        id="downloaded-groups-toggle"
                        type="button"
                        onClick={() => setGroupsCollapsed((v) => !v)}
                        className="w-full px-3 pt-3 pb-1.5 text-xs text-tg-textSecondary uppercase tracking-wide flex items-center justify-between hover:bg-tg-hover transition-colors"
                        aria-expanded={!groupsCollapsed}
                    >
                        <span>Downloaded Groups</span>
                        <i
                            className={`ri-arrow-up-s-line text-base normal-case transition-transform ${
                                groupsCollapsed ? "rotate-180" : ""
                            }`}
                        />
                    </button>
                    {!groupsCollapsed && (
                        <div className="px-3 pt-1 pb-3">
                            <div className="relative">
                                <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-tg-textSecondary" />
                                <input
                                    type="text"
                                    id="sidebar-groups-search"
                                    placeholder="Filter groups…"
                                    className="tg-input pl-9 py-2 text-sm w-full"
                                    value={groupsFilter}
                                    onChange={(e) => setGroupsFilter(e.target.value)}
                                />
                            </div>
                        </div>
                    )}
                </div>
                {!groupsCollapsed && (
                    <div id="downloaded-groups-body">
                        <div id="groups-list">
                            {downloaded.map((g) => (
                                <Link
                                    key={g.id}
                                    to="/group/$groupId"
                                    params={{ groupId: g.id }}
                                    className="flex items-center gap-3 p-3 cursor-pointer hover:bg-tg-hover transition-colors"
                                >
                                    <div className="tg-avatar tg-avatar-4 w-10 h-10 text-base flex-shrink-0">
                                        {g.name.slice(0, 1).toUpperCase()}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h4 className="text-tg-text text-sm truncate">{g.name}</h4>
                                        <p className="text-xs text-tg-textSecondary truncate">
                                            {g.totalFiles} files · {g.sizeFormatted}
                                        </p>
                                    </div>
                                </Link>
                            ))}
                            {downloaded.length === 0 && (
                                <p className="px-3 py-4 text-xs text-tg-textSecondary text-center">
                                    {groupsFilter ? "No groups match" : "No groups yet"}
                                </p>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Footer — disk + files + sign-out */}
            <div className="border-t border-tg-border bg-tg-bg">
                <div className="px-3 pt-3 pb-2 flex items-center justify-between text-sm gap-3">
                    <span className="flex items-center gap-1.5 min-w-0">
                        <i className="ri-hard-drive-2-line text-tg-textSecondary" />
                        <span className="text-tg-textSecondary">Disk</span>
                        <span id="disk-usage" className="text-tg-text truncate">
                            {stats.data?.totalBytesFormatted ?? "—"}
                        </span>
                    </span>
                    <span className="flex items-center gap-1.5 min-w-0">
                        <i className="ri-file-list-2-line text-tg-textSecondary" />
                        <span className="text-tg-textSecondary">Files</span>
                        <span id="total-files" className="text-tg-text truncate">
                            {stats.data?.totalFiles ?? "—"}
                        </span>
                    </span>
                </div>
                <button
                    id="sidebar-logout-btn"
                    type="button"
                    onClick={handleSignOut}
                    className="w-full px-3 py-2.5 flex items-center justify-center gap-2 text-sm font-semibold text-white bg-tg-red/90 hover:bg-tg-red transition-colors border-t border-tg-red/30"
                    aria-label="Sign out"
                >
                    <i className="ri-logout-box-line text-base" />
                    <span>Sign out</span>
                </button>
            </div>
        </aside>
    );
}
