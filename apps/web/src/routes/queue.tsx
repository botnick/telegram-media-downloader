import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api } from "@/api/client";

interface QueueSnapshot {
    queued: number;
    active: number;
    completed: number;
    downloads: Array<{
        groupId?: string;
        messageId?: number;
        fileName?: string;
        bytesReceived?: number;
        bytesTotal?: number | null;
    }>;
}

function Queue() {
    const snap = useQuery({
        queryKey: ["queue"],
        queryFn: () => api.get<QueueSnapshot>("/api/queue/snapshot"),
        refetchInterval: 1000,
    });

    return (
        <div className="p-6">
            <h1 className="text-2xl font-semibold mb-4">Queue</h1>
            <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-tg-panel rounded-lg p-4">
                    <p className="text-tg-text-secondary text-sm">Queued</p>
                    <p className="text-3xl font-semibold">{snap.data?.queued ?? "—"}</p>
                </div>
                <div className="bg-tg-panel rounded-lg p-4">
                    <p className="text-tg-text-secondary text-sm">Active</p>
                    <p className="text-3xl font-semibold">{snap.data?.active ?? "—"}</p>
                </div>
                <div className="bg-tg-panel rounded-lg p-4">
                    <p className="text-tg-text-secondary text-sm">Completed</p>
                    <p className="text-3xl font-semibold">{snap.data?.completed ?? "—"}</p>
                </div>
            </div>

            <h2 className="text-lg font-semibold mb-2">In flight</h2>
            <div className="space-y-2">
                {(snap.data?.downloads ?? []).map((d, i) => (
                    <div
                        key={`${d.groupId}-${d.messageId}-${i}`}
                        className="bg-tg-panel rounded p-3 flex justify-between"
                    >
                        <span className="truncate">{d.fileName ?? "—"}</span>
                        <span className="text-tg-text-secondary text-sm">
                            {d.bytesReceived != null && d.bytesTotal != null
                                ? `${Math.round((d.bytesReceived / d.bytesTotal) * 100)}%`
                                : "…"}
                        </span>
                    </div>
                ))}
                {(snap.data?.downloads ?? []).length === 0 && (
                    <p className="text-tg-text-secondary text-sm">Nothing in flight.</p>
                )}
            </div>
        </div>
    );
}

export const Route = createFileRoute("/queue")({
    component: Queue,
});
