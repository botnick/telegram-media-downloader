import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useDownloadsByGroup } from "@/api/queries";
import { MediaTile } from "@/components/MediaTile";

function GroupPage() {
    const { groupId } = useParams({ from: "/group/$groupId" });
    const [page, setPage] = useState(1);
    const downloads = useDownloadsByGroup(groupId, { page, limit: 50 });

    const files = downloads.data?.files ?? [];

    return (
        <main className="p-3 h-full flex flex-col">
            <header className="px-1 pb-3">
                <h1 className="text-xl font-semibold">{groupId}</h1>
                <p className="text-sm text-tg-text-secondary">{downloads.data?.total ?? 0} files</p>
            </header>
            <div className="flex-1 overflow-y-auto">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
                    {files.map((f) => (
                        <MediaTile key={f.id} file={f} />
                    ))}
                </div>
                {downloads.data?.hasMore && (
                    <div className="flex justify-center my-6">
                        <button
                            type="button"
                            className="px-4 py-2 bg-tg-panel rounded-md"
                            onClick={() => setPage((p) => p + 1)}
                        >
                            Load more
                        </button>
                    </div>
                )}
            </div>
        </main>
    );
}

export const Route = createFileRoute("/group/$groupId")({
    component: GroupPage,
});
