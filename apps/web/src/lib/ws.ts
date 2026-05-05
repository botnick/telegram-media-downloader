/**
 * Minimal WebSocket client wrapper — auto-reconnect, type-safe handler
 * registry. Mirrors the legacy public/js/ws.js so the SPA's existing
 * subscription patterns translate directly.
 */

import type { WsMessage, WsMessageType } from "@tgdl/shared";

type Handler = (m: WsMessage) => void;
const handlers = new Map<WsMessageType | "*", Set<Handler>>();

let socket: WebSocket | null = null;
let backoff = 1000;
let alive = false;
let attemptCount = 0;
const MAX_ATTEMPTS_BEFORE_PAUSE = 12;

function dispatch(msg: WsMessage) {
    const set = handlers.get(msg.type);
    if (set)
        for (const fn of set)
            try {
                fn(msg);
            } catch (e) {
                console.error("ws handler", e);
            }
    const all = handlers.get("*");
    if (all)
        for (const fn of all)
            try {
                fn(msg);
            } catch {
                /* swallow */
            }
}

function open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    try {
        socket = new WebSocket(url);
    } catch {
        scheduleReconnect();
        return;
    }
    socket.addEventListener("open", () => {
        alive = true;
        backoff = 1000;
        attemptCount = 0;
        dispatch({ type: "__ws_open" });
    });
    socket.addEventListener("message", (ev) => {
        let msg;
        try {
            msg = JSON.parse(ev.data as string) as WsMessage;
        } catch {
            return;
        }
        if (msg && typeof msg === "object" && msg.type) dispatch(msg);
    });
    socket.addEventListener("close", () => {
        alive = false;
        dispatch({ type: "__ws_close" });
        scheduleReconnect();
    });
    socket.addEventListener("error", () => {
        try {
            socket?.close();
        } catch {
            // ignore
        }
    });
}

function scheduleReconnect() {
    if (document.hidden) {
        document.addEventListener("visibilitychange", oneShot, { once: true });
        return;
    }
    attemptCount++;
    if (attemptCount >= MAX_ATTEMPTS_BEFORE_PAUSE) {
        dispatch({ type: "__ws_giveup", attempts: attemptCount });
        return;
    }
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 30_000);
}
function oneShot() {
    open();
}

export const ws = {
    connect() {
        if (!socket || socket.readyState >= 2) open();
    },
    retry() {
        attemptCount = 0;
        backoff = 1000;
        open();
    },
    on(type: WsMessageType | "*", fn: Handler): () => void {
        let set = handlers.get(type);
        if (!set) {
            set = new Set();
            handlers.set(type, set);
        }
        set.add(fn);
        return () => {
            handlers.get(type)?.delete(fn);
        };
    },
    isConnected() {
        return alive;
    },
};
