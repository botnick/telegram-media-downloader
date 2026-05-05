/**
 * WebSocket — `/ws` upgrade handler.
 *
 * Client connects with the same session cookie used for REST. The
 * legacy implementation kept a Set<WebSocket> of live clients in
 * server.js and broadcast events from runtime.js / queue.js. Hono +
 * @hono/node-ws keep the same model: we register handlers per
 * connection lifecycle event and keep the broadcaster in lib/.
 */

import type { Hono } from "hono";

// `@hono/node-ws` does not yet export the upgradeWebSocket factory's
// type, so we rely on the inferred type from createNodeWebSocket.
type UpgradeWebSocketFn = ReturnType<
    // Avoid importing the actual function just to extract the type;
    // describe the shape we use instead.
    () => (cb: () => Record<string, unknown>) => unknown
>;

export function mountWebSocket(app: Hono, upgradeWebSocket: UpgradeWebSocketFn) {
    app.get(
        "/ws",
        upgradeWebSocket(() => ({
            onOpen: () => {
                // TODO(server): register client into broadcaster set,
                // attach session cookie validation, send any
                // queued-on-reconnect events.
            },
            onMessage: () => {
                // Currently the SPA only listens; the server is the
                // sole publisher. Reserve hook for future ping/pong.
            },
            onClose: () => {
                // TODO(server): drop from broadcaster set
            },
        })) as never
    );
}
