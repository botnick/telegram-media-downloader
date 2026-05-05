import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { StatsResponse, VersionResponse } from "@tgdl/shared";

async function fetchVersion(): Promise<VersionResponse> {
    const r = await fetch("/api/version");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as VersionResponse;
}

async function fetchStats(): Promise<StatsResponse> {
    const r = await fetch("/api/stats");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as StatsResponse;
}

function Home() {
    const version = useQuery({ queryKey: ["version"], queryFn: fetchVersion });
    const stats = useQuery({ queryKey: ["stats"], queryFn: fetchStats });

    return (
        <main className="p-8 max-w-3xl mx-auto">
            <h1 className="text-3xl font-bold mb-4">Telegram Media Downloader</h1>
            <p className="text-tg-text-secondary mb-6">
                React + Hono dashboard. UI port from the legacy SPA is in progress; this page is a
                smoke screen confirming the new stack reaches the backend correctly.
            </p>

            <section className="bg-tg-panel rounded-lg p-4 mb-4">
                <h2 className="text-lg font-semibold mb-2">Version</h2>
                {version.isLoading && <p>Loading…</p>}
                {version.error && (
                    <p className="text-red-400">Error: {(version.error as Error).message}</p>
                )}
                {version.data && (
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                        <dt className="text-tg-text-secondary">Version</dt>
                        <dd>{version.data.version}</dd>
                        <dt className="text-tg-text-secondary">Commit</dt>
                        <dd className="font-mono">{version.data.commit}</dd>
                        <dt className="text-tg-text-secondary">Built</dt>
                        <dd>{version.data.builtAt ?? "—"}</dd>
                    </dl>
                )}
            </section>

            <section className="bg-tg-panel rounded-lg p-4">
                <h2 className="text-lg font-semibold mb-2">Library stats</h2>
                {stats.isLoading && <p>Loading…</p>}
                {stats.error && (
                    <p className="text-red-400">Error: {(stats.error as Error).message}</p>
                )}
                {stats.data && (
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                        <dt className="text-tg-text-secondary">Total files</dt>
                        <dd>{stats.data.totalFiles}</dd>
                        <dt className="text-tg-text-secondary">Disk used</dt>
                        <dd>{stats.data.totalBytesFormatted}</dd>
                    </dl>
                )}
            </section>
        </main>
    );
}

export const Route = createFileRoute("/")({
    component: Home,
});
