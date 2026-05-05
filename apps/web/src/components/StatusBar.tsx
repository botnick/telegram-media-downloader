/**
 * Footer status bar — version + WS connection state + queue + disk.
 * Subscribes to WS pseudo-events to flip the connection chip without
 * polling.
 */

import { useState } from "react";
import { useWs } from "@/lib/wsHooks";
import { useStats, useVersion } from "@/api/queries";

export function StatusBar() {
    const stats = useStats();
    const version = useVersion();
    const [wsState, setWsState] = useState<"idle" | "open" | "closed" | "giveup">(
        "idle"
    );

    useWs("__ws_open", () => setWsState("open"));
    useWs("__ws_close", () => setWsState("closed"));
    useWs("__ws_giveup", () => setWsState("giveup"));

    const wsLabel =
        wsState === "open"
            ? "WS connected"
            : wsState === "giveup"
              ? "WS gave up — click to retry"
              : wsState === "closed"
                ? "WS reconnecting…"
                : "WS idle";

    return (
        <footer className="flex items-center gap-4 px-4 py-1.5 border-t border-white/5 bg-tg-panel text-xs text-tg-text-secondary">
            <span>v{version.data?.version ?? "?"}</span>
            <span
                className={`px-2 py-0.5 rounded ${
                    wsState === "open" ? "bg-green-700/30 text-green-300" : "bg-yellow-700/30"
                }`}
            >
                {wsLabel}
            </span>
            <span className="ml-auto">
                {stats.data?.totalFiles ?? "—"} files · {stats.data?.totalBytesFormatted ?? "—"}
            </span>
        </footer>
    );
}
