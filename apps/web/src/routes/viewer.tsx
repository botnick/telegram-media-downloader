/**
 * /viewer — gallery page. Lists every download via the paginated
 * /api/downloads/all endpoint, infinite-scrolling as the user reaches
 * the bottom.
 */

import { createFileRoute } from "@tanstack/react-router";
import type { ViewerFileType } from "@tgdl/shared";
import { useState } from "react";
import { useDownloadsAll } from "@/api/queries";
import { MediaTile } from "@/components/MediaTile";
import { useUiStore } from "@/store/ui";

const FILES_PER_PAGE = 50;

const TYPE_TABS: Array<{ value: ViewerFileType | "all"; label: string }> = [
    { value: "all", label: "All" },
    { value: "images", label: "Photos" },
    { value: "videos", label: "Videos" },
    { value: "documents", label: "Files" },
    { value: "audio", label: "Audio" },
];

function Viewer() {
    const { typeFilter, setTypeFilter } = useUiStore();
    const [page, setPage] = useState(1);
    const downloads = useDownloadsAll({
        page,
        limit: FILES_PER_PAGE,
        type: typeFilter,
    });

    const total = downloads.data?.total ?? 0;
    const files = downloads.data?.files ?? [];

    return (
        <div className="flex flex-col h-full">
            <header className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <div>
                    <h1 className="text-xl font-semibold">All Media</h1>
                    <p className="text-sm text-tg-text-secondary">{total.toLocaleString()} files</p>
                </div>
            </header>

            <nav className="flex gap-1 px-4 py-2 border-b border-white/5">
                {TYPE_TABS.map((tab) => (
                    <button
                        key={tab.value}
                        type="button"
                        onClick={() => {
                            setTypeFilter(tab.value);
                            setPage(1);
                        }}
                        className={`px-3 py-1.5 rounded-md text-sm transition ${
                            typeFilter === tab.value
                                ? "bg-tg-blue text-white"
                                : "text-tg-text-secondary hover:bg-white/5"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </nav>

            <main className="flex-1 overflow-y-auto p-3">
                {downloads.isLoading && page === 1 && (
                    <div className="flex items-center justify-center h-32 text-tg-text-secondary">
                        Loading…
                    </div>
                )}
                {downloads.error && (
                    <div className="text-red-400 p-4">
                        Error: {(downloads.error as Error).message}
                    </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
                    {files.map((file) => (
                        <MediaTile key={file.id} file={file} />
                    ))}
                </div>
                {!downloads.isLoading && files.length === 0 && (
                    <div className="flex items-center justify-center h-32 text-tg-text-secondary">
                        No files yet — start a download from Settings → Telegram Accounts.
                    </div>
                )}
                {downloads.data?.hasMore && (
                    <div className="flex justify-center my-6">
                        <button
                            type="button"
                            className="px-4 py-2 bg-tg-panel rounded-md hover:bg-white/5"
                            onClick={() => setPage((p) => p + 1)}
                        >
                            Load more
                        </button>
                    </div>
                )}
            </main>
        </div>
    );
}

export const Route = createFileRoute("/viewer")({
    component: Viewer,
});
