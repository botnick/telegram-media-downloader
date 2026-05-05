/**
 * WebSocket event contract.
 *
 * Backend broadcasts; frontend subscribes. Payload shapes match what
 * the legacy server.js / runtime.js / queue.js already emit so a tab
 * still running the old SPA bundle keeps working during the rolling
 * migration.
 */

import { z } from "zod";
import { ViewerFileSchema } from "./domain.js";

// ---------------------------------------------------------------------------
// Inbound (server → client)
// ---------------------------------------------------------------------------

export const WsDownloadStartedSchema = z.object({
    type: z.literal("download_start"),
    payload: z.object({
        groupId: z.string(),
        groupName: z.string().nullable(),
        messageId: z.number().int(),
        fileName: z.string().nullable(),
        fileSize: z.number().int().nullable(),
    }),
});

export const WsDownloadProgressSchema = z.object({
    type: z.literal("download_progress"),
    payload: z.object({
        messageId: z.number().int(),
        bytesReceived: z.number().int().nonnegative(),
        bytesTotal: z.number().int().nonnegative().nullable(),
    }),
});

export const WsDownloadCompleteSchema = z.object({
    type: z.literal("download_complete"),
    payload: z.object({
        file: ViewerFileSchema,
        deduped: z.boolean().default(false),
    }),
});

export const WsDownloadErrorSchema = z.object({
    type: z.literal("download_error"),
    payload: z.object({
        job: z.object({
            groupId: z.string(),
            messageId: z.number().int(),
        }),
        error: z.string(),
    }),
});

export const WsFileDeletedSchema = z.object({
    type: z.literal("file_deleted"),
    payload: z.object({
        path: z.string(),
        id: z.number().int().optional(),
    }),
});

export const WsPurgeAllSchema = z.object({
    type: z.literal("purge_all"),
});

export const WsThumbsRebuildDoneSchema = z.object({
    type: z.literal("thumbs_rebuild_done"),
    payload: z.object({
        removed: z.number().int().nonnegative(),
    }),
});

/**
 * Pseudo-events surfaced by the client wrapper itself; the server never
 * sends these. Listed here so subscribers can type them alongside real
 * events.
 */
export const WsClientOpenSchema = z.object({ type: z.literal("__ws_open") });
export const WsClientCloseSchema = z.object({ type: z.literal("__ws_close") });
export const WsClientGiveupSchema = z.object({
    type: z.literal("__ws_giveup"),
    attempts: z.number().int().nonnegative(),
});

export const WsServerMessageSchema = z.discriminatedUnion("type", [
    WsDownloadStartedSchema,
    WsDownloadProgressSchema,
    WsDownloadCompleteSchema,
    WsDownloadErrorSchema,
    WsFileDeletedSchema,
    WsPurgeAllSchema,
    WsThumbsRebuildDoneSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

export const WsClientPseudoSchema = z.discriminatedUnion("type", [
    WsClientOpenSchema,
    WsClientCloseSchema,
    WsClientGiveupSchema,
]);
export type WsClientPseudo = z.infer<typeof WsClientPseudoSchema>;

export type WsMessage = WsServerMessage | WsClientPseudo;
export type WsMessageType = WsMessage["type"];
