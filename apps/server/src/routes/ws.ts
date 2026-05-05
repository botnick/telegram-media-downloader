/**
 * WebSocket — `/ws` upgrade handler.
 *
 * Each connection is registered into the broadcaster set. Server-side
 * publishers (runtime.js, queue.js, monitor.js — all in @tgdl/core)
 * call `broadcast(message)` to fan out events; we don't need a per-
 * connection state machine here.
 *
 * Auth: the upgrade request carries the same session cookie used for
 * REST. Validation is best-effort — if the cookie is missing the
 * client still connects but the SPA won't receive admin-only events
 * because the publishers gate those at emit time.
 */

import type { Hono } from "hono";

import { clientCount, register } from "../lib/broadcast.js";

interface WsLike {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
}

type UpgradeWebSocketFn = (cb: (c: unknown) => Record<string, unknown>) => unknown;

export function mountWebSocket(app: Hono, upgradeWebSocket: UpgradeWebSocketFn) {
    app.get(
        "/ws",
        upgradeWebSocket(() => {
            let unregister: (() => void) | null = null;
            return {
                onOpen: (_event: unknown, ws: WsLike) => {
                    unregister = register(ws);
                    // eslint-disable-next-line no-console
                    console.log(`[ws] client connected (total=${clientCount()})`);
                },
                onMessage: () => {
                    // SPA does not currently send messages — server is the
                    // sole publisher. Hook reserved for future ping/pong.
                },
                onClose: () => {
                    if (unregister) unregister();
                    unregister = null;
                    // eslint-disable-next-line no-console
                    console.log(`[ws] client disconnected (total=${clientCount()})`);
                },
                onError: () => {
                    if (unregister) unregister();
                    unregister = null;
                },
            };
        }) as never
    );
}
