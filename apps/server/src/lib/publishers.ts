/**
 * Wire @tgdl/core publishers (runtime EventEmitter, monitor, queue,
 * downloader) into the WebSocket broadcaster.
 *
 * The runtime instance exposes 'state' (engine on/off) and 'event'
 * (per-step events: download_start, download_complete, rate_wait,
 * flood_wait, forward_error). The legacy server.js subscribed to
 * those EventEmitter channels and re-broadcast each entry as a typed
 * WS message. Mirror that here so existing SPA subscribers keep
 * working unchanged.
 *
 * Best-effort: if @tgdl/core/runtime doesn't export a singleton (or
 * the host process never starts the engine), the wiring silently does
 * nothing — startup must not fail just because there's no monitor
 * running yet.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

// @ts-expect-error — js source
import * as runtimeMod from "@tgdl/core/runtime.js";
import { broadcast } from "./broadcast.js";

interface RuntimeLike {
    on?(channel: string, fn: (payload: unknown) => void): void;
}

export function wirePublishers(): void {
    try {
        const rt =
            (runtimeMod as { runtime?: RuntimeLike; default?: RuntimeLike }).runtime ??
            (runtimeMod as { default?: RuntimeLike }).default ??
            null;
        if (!rt || typeof rt.on !== "function") return;

        rt.on("state", (s) => {
            const payload = s as { state?: string; error?: string };
            // Cast through unknown — the runtime emits its own message
            // shape that the WS schema doesn't enumerate yet.
            broadcast({
                type: "monitor_state",
                state: payload.state,
                error: payload.error,
            } as unknown as Parameters<typeof broadcast>[0]);
        });

        rt.on("event", (e) => {
            const evt = e as { type?: string; payload?: unknown };
            broadcast({
                type: evt.type,
                payload: evt.payload,
            } as unknown as Parameters<typeof broadcast>[0]);
        });
    } catch {
        // Best-effort. The engine wires up later via /api/engine.
    }
}
