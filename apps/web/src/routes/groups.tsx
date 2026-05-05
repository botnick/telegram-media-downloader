/**
 * /groups — Manage Groups page. Mirrors the legacy `#page-groups`
 * surface: tab row (All Dialogs / Monitored Only / Unmonitored),
 * search box, vertical list of <DialogRow>s.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useDialogs, type Dialog } from "@/api/dialogs";
import { DialogRow } from "@/components/DialogRow";
import { TopBar } from "@/components/TopBar";

type Tab = "all" | "monitored" | "unmonitored";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: "all", label: "All Dialogs" },
    { id: "monitored", label: "Monitored Only" },
    { id: "unmonitored", label: "Unmonitored" },
];

function GroupsPage() {
    const [tab, setTab] = useState<Tab>("all");
    const [search, setSearch] = useState("");
    const dialogs = useDialogs();

    const filtered = useMemo<Dialog[]>(() => {
        const list = dialogs.data?.dialogs ?? [];
        const byTab = list.filter((d) =>
            tab === "all" ? true : tab === "monitored" ? d.monitored : !d.monitored
        );
        if (!search.trim()) return byTab;
        const q = search.toLowerCase();
        return byTab.filter((d) => d.name.toLowerCase().includes(q));
    }, [dialogs.data, tab, search]);

    return (
        <div className="flex flex-col h-full">
            <TopBar
                title="Manage Groups"
                subtitle="Configure monitoring and filters"
                avatarColor={1}
                avatarIcon="ri-group-line"
            />

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-5xl mx-auto px-3 sm:px-4 pt-4">
                    {/* Tabs */}
                    <div className="flex border-b border-tg-border mb-4">
                        {TABS.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setTab(t.id)}
                                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                    tab === t.id
                                        ? "border-tg-blue text-tg-blue"
                                        : "border-transparent text-tg-textSecondary hover:text-white"
                                }`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>

                    {/* Search box */}
                    <div className="mb-4">
                        <div className="relative">
                            <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-tg-textSecondary" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search groups/channels…"
                                className="w-full bg-tg-panel border border-tg-border rounded-lg pl-10 pr-4 py-2 text-tg-text outline-none focus:border-tg-blue"
                            />
                        </div>
                    </div>

                    {/* Dialog list */}
                    {dialogs.isLoading ? (
                        <div className="flex items-center justify-center py-10 text-tg-textSecondary">
                            <span className="w-6 h-6 border-2 border-tg-blue border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : null}

                    {dialogs.error ? (
                        <p className="text-red-400 text-sm py-6">
                            Failed to load: {(dialogs.error as Error).message}
                        </p>
                    ) : null}

                    <div className="space-y-3 pb-6">
                        {filtered.map((d) => (
                            <DialogRow key={d.id} dialog={d} />
                        ))}
                        {!dialogs.isLoading && filtered.length === 0 ? (
                            <p className="text-center text-tg-textSecondary text-sm py-10">
                                {search.trim()
                                    ? `No dialogs match "${search}"`
                                    : "No dialogs"}
                            </p>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

export const Route = createFileRoute("/groups")({
    component: GroupsPage,
});
