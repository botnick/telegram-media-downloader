/**
 * Dialog list — Telegram chats the logged-in account can see.
 * Backed by /api/dialogs.
 *
 * Schema lives in @tgdl/shared eventually; for now we type the
 * subset of fields the UI cares about.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export interface Dialog {
    id: string;
    name: string;
    type: "group" | "channel" | "user" | "supergroup";
    members?: number;
    photoUrl?: string | null;
    /** Already a configured group? */
    monitored?: boolean;
    /** Engine state for this group, if monitored. */
    state?: "active" | "paused";
}

interface DialogsResponse {
    dialogs: Dialog[];
}

export function useDialogs() {
    return useQuery({
        queryKey: ["dialogs"],
        queryFn: () => api.get<DialogsResponse>("/api/dialogs"),
        staleTime: 60_000,
    });
}
