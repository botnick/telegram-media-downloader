import { createFileRoute, Link } from "@tanstack/react-router";
import { useGroups } from "@/api/queries";

function Groups() {
    const groups = useGroups();

    return (
        <main className="p-6 max-w-4xl mx-auto">
            <h1 className="text-2xl font-semibold mb-4">Groups</h1>
            {groups.isLoading && <p>Loading…</p>}
            {groups.error && <p className="text-red-400">Error: {(groups.error as Error).message}</p>}

            {groups.data && (
                <>
                    <section className="mb-6">
                        <h2 className="text-lg mb-2 text-tg-text-secondary">Configured ({groups.data.config.length})</h2>
                        <ul className="space-y-1">
                            {groups.data.config.map((g) => (
                                <li key={g.id} className="flex items-center justify-between bg-tg-panel rounded px-3 py-2">
                                    <span>{g.name}</span>
                                    <span className="text-xs text-tg-text-secondary font-mono">{g.id}</span>
                                </li>
                            ))}
                        </ul>
                    </section>

                    <section>
                        <h2 className="text-lg mb-2 text-tg-text-secondary">Downloaded ({groups.data.downloaded.length})</h2>
                        <ul className="space-y-1">
                            {groups.data.downloaded.map((g) => (
                                <li key={g.id} className="flex items-center justify-between bg-tg-panel rounded px-3 py-2">
                                    <Link
                                        to="/group/$groupId"
                                        params={{ groupId: g.id }}
                                        className="text-tg-accent hover:underline"
                                    >
                                        {g.name}
                                    </Link>
                                    <span className="text-xs text-tg-text-secondary">
                                        {g.totalFiles} · {g.sizeFormatted}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
                </>
            )}
        </main>
    );
}

export const Route = createFileRoute("/groups")({
    component: Groups,
});
