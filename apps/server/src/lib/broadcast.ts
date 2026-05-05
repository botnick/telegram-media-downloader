/**
 * In-process WebSocket broadcaster.
 *
 * Mirrors the Set<WebSocket> the legacy server kept in server.js. The
 * runtime / queue / monitor modules call broadcast() with a typed
 * message; every live client receives the JSON-serialised payload.
 *
 * The Set lives at module scope so importing this from a route or
 * background job hits the same instance.
 */

import type { WsServerMessage } from "@tgdl/shared";

type Sock = {
    readonly readyState: number;
    send(data: string): void;
};

const clients = new Set<Sock>();

export function register(sock: Sock): () => void {
    clients.add(sock);
    return () => {
        clients.delete(sock);
    };
}

export function broadcast(message: WsServerMessage): void {
    const payload = JSON.stringify(message);
    for (const sock of clients) {
        if (sock.readyState !== 1) continue; // 1 = OPEN
        try {
            sock.send(payload);
        } catch {
            // Best effort — a drop will be cleaned up by onClose.
        }
    }
}

export function clientCount(): number {
    return clients.size;
}
