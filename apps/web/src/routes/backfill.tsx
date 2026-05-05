import { createFileRoute } from "@tanstack/react-router";
import { useGroups } from "@/api/queries";

function Backfill() {
    const groups = useGroups();
    return (
        <div className="p-6">
            <h1 className="text-2xl font-semibold mb-4">Backfill</h1>
            <p className="text-tg-text-secondary mb-4">
                Pull historical messages from a configured group. Pick a chat from the list below to
                start a backfill job.
            </p>
            {groups.isLoading && <p>Loading…</p>}
            <ul className="space-y-2 max-w-2xl">
                {(groups.data?.config ?? []).map((g) => (
                    <li
                        key={g.id}
                        className="bg-tg-panel rounded p-3 flex items-center justify-between"
                    >
                        <span>{g.name}</span>
                        <button
                            type="button"
                            className="px-3 py-1 bg-tg-blue text-white rounded text-sm"
                            disabled
                            title="Backfill kickoff lands in a follow-up"
                        >
                            Start
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export const Route = createFileRoute("/backfill")({
    component: Backfill,
});
