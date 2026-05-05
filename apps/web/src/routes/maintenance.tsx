import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api } from "@/api/client";

interface ThumbsCacheStats {
    count: number;
    bytes: number;
}

function Maintenance() {
    const queryClient = useQueryClient();
    const thumbsStats = useQuery({
        queryKey: ["maintenance", "thumbs", "stats"],
        queryFn: () => api.get<ThumbsCacheStats>("/api/maintenance/thumbs/stats"),
    });

    const buildThumbs = useMutation({
        mutationFn: () => api.post("/api/maintenance/thumbs/build"),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["maintenance"] }),
    });
    const wipeThumbs = useMutation({
        mutationFn: () => api.post("/api/maintenance/thumbs/rebuild"),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["maintenance"] }),
    });

    const integrity = useMutation({
        mutationFn: () => api.post("/api/maintenance/db/integrity"),
    });
    const vacuum = useMutation({
        mutationFn: () => api.post("/api/maintenance/db/vacuum"),
    });

    return (
        <div className="p-6 max-w-4xl mx-auto">
            <h1 className="text-2xl font-semibold mb-4">Maintenance</h1>

            <Section title="Thumbnails">
                <p className="text-sm text-tg-text-secondary mb-2">
                    Cache:{" "}
                    {thumbsStats.data
                        ? `${thumbsStats.data.count} files, ${(thumbsStats.data.bytes / 1024 / 1024).toFixed(1)} MB`
                        : "loading…"}
                </p>
                <div className="flex gap-2">
                    <Button onClick={() => buildThumbs.mutate()} loading={buildThumbs.isPending}>
                        Build missing
                    </Button>
                    <Button
                        onClick={() => wipeThumbs.mutate()}
                        loading={wipeThumbs.isPending}
                        variant="warn"
                    >
                        Wipe cache
                    </Button>
                </div>
            </Section>

            <Section title="Database">
                <div className="flex gap-2">
                    <Button onClick={() => integrity.mutate()} loading={integrity.isPending}>
                        Integrity check
                    </Button>
                    <Button onClick={() => vacuum.mutate()} loading={vacuum.isPending}>
                        VACUUM
                    </Button>
                </div>
            </Section>
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="bg-tg-panel rounded-lg p-4 mb-4">
            <h2 className="text-lg font-semibold mb-2">{title}</h2>
            {children}
        </section>
    );
}

function Button({
    children,
    onClick,
    loading,
    variant,
}: {
    children: React.ReactNode;
    onClick(): void;
    loading?: boolean;
    variant?: "warn";
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={loading}
            className={`px-3 py-1.5 rounded text-sm ${
                variant === "warn" ? "bg-red-700 hover:bg-red-600" : "bg-tg-blue hover:bg-tg-accent"
            } text-white disabled:opacity-50`}
        >
            {loading ? "…" : children}
        </button>
    );
}

export const Route = createFileRoute("/maintenance")({
    component: Maintenance,
});
