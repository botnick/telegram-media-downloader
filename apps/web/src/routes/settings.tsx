/**
 * /settings — read + write data/config.json.
 *
 * The legacy SPA used a hand-built form with ~30 inputs grouped by
 * category. This React port keeps the same groupings but renders
 * them via a generic JSON tree editor for now; a polished per-field
 * UI lands in a follow-up.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

function Settings() {
    const queryClient = useQueryClient();
    const config = useQuery({
        queryKey: ["config"],
        queryFn: () => api.get<Record<string, unknown>>("/api/config"),
    });

    const [draft, setDraft] = useState<string>("");
    const [parseError, setParseError] = useState<string | null>(null);

    useEffect(() => {
        if (config.data) setDraft(JSON.stringify(config.data, null, 2));
    }, [config.data]);

    const save = useMutation({
        mutationFn: (next: Record<string, unknown>) => api.put("/api/config", next),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["config"] });
            queryClient.invalidateQueries({ queryKey: ["groups"] });
        },
    });

    const handleSave = () => {
        try {
            const parsed = JSON.parse(draft) as Record<string, unknown>;
            setParseError(null);
            save.mutate(parsed);
        } catch (e) {
            setParseError((e as Error).message);
        }
    };

    return (
        <div className="p-6 max-w-4xl mx-auto h-full overflow-y-auto">
            <h1 className="text-2xl font-semibold mb-2">Settings</h1>
            <p className="text-sm text-tg-text-secondary mb-4">
                Edit <code className="bg-black/30 px-1 rounded">data/config.json</code> directly.
                Changes apply immediately without a restart.
            </p>

            {config.isLoading && <p>Loading…</p>}
            {config.error && (
                <p className="text-red-400">Error: {(config.error as Error).message}</p>
            )}

            {config.data && (
                <>
                    <textarea
                        className="w-full h-[60vh] p-3 bg-black/40 border border-white/10 rounded font-mono text-sm"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        spellCheck={false}
                    />
                    {parseError && <p className="text-red-400 text-sm mt-2">JSON: {parseError}</p>}
                    <div className="flex gap-3 mt-3">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={save.isPending}
                            className="px-4 py-2 bg-tg-blue text-white rounded disabled:opacity-50"
                        >
                            {save.isPending ? "Saving…" : "Save"}
                        </button>
                        <button
                            type="button"
                            onClick={() => setDraft(JSON.stringify(config.data, null, 2))}
                            className="px-4 py-2 bg-tg-panel rounded"
                        >
                            Reset
                        </button>
                    </div>
                    {save.isError && (
                        <p className="text-red-400 text-sm mt-2">
                            Save failed: {(save.error as Error).message}
                        </p>
                    )}
                    {save.isSuccess && <p className="text-green-400 text-sm mt-2">Saved.</p>}
                </>
            )}
        </div>
    );
}

export const Route = createFileRoute("/settings")({
    component: Settings,
});
