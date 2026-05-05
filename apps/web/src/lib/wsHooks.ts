/**
 * React glue around lib/ws.ts — components subscribe declaratively
 * with `useWs("download_complete", handler)` and the connection /
 * unsubscribe cleanup happens for them.
 */

import { useEffect } from "react";
import { ws } from "./ws";
import type { WsMessage, WsMessageType } from "@tgdl/shared";

let connected = false;
function ensureConnected() {
    if (connected) return;
    connected = true;
    ws.connect();
}

export function useWs(
    type: WsMessageType | "*",
    handler: (m: WsMessage) => void
): void {
    useEffect(() => {
        ensureConnected();
        const unsub = ws.on(type, handler);
        return unsub;
    }, [type, handler]);
}
