/**
 * Domain types — canonical shape of business objects.
 *
 * Backend (DB rows, gramJS objects, in-memory state) and frontend
 * (gallery tiles, settings forms, queue rows) share these to keep
 * request/response shapes typed end-to-end.
 *
 * Use Zod schemas for anything that crosses the wire (HTTP request,
 * WS payload, DB → API mapping). Plain interfaces are fine for
 * purely-internal data structures that never leave their process.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Telegram chat / message ids overflow `Number.MAX_SAFE_INTEGER`, so the
 * project handles them as strings throughout. Keep them branded so a raw
 * `string` doesn't accidentally satisfy a parameter that expects an id.
 */
export const TelegramId = z.string().min(1).brand<"TelegramId">();
export type TelegramId = z.infer<typeof TelegramId>;

export const FileTypeSchema = z.enum([
    "photo",
    "video",
    "audio",
    "document",
    "sticker",
    "voice",
    "gif",
]);
export type FileType = z.infer<typeof FileTypeSchema>;

/**
 * `file.type` is the *frontend* category — the tab the gallery shows
 * the file under. Distinct from the DB's `file_type` column (mapped via
 * the typeFolder switch in the legacy server.js).
 */
export const ViewerFileTypeSchema = z.enum(["images", "videos", "audio", "documents", "stickers"]);
export type ViewerFileType = z.infer<typeof ViewerFileTypeSchema>;

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export const DownloadRowSchema = z.object({
    id: z.number().int().positive(),
    groupId: z.string(),
    groupName: z.string().nullable(),
    messageId: z.number().int(),
    fileName: z.string().nullable(),
    fileSize: z.number().int().nonnegative().nullable(),
    fileType: FileTypeSchema.nullable(),
    filePath: z.string().nullable(),
    status: z.string().default("completed"),
    createdAt: z.string(),
    ttlSeconds: z.number().int().nullable(),
    fileHash: z.string().nullable(),
    pinned: z.boolean().default(false),
    pendingUntil: z.number().int().nullable(),
    rescuedAt: z.number().int().nullable(),
    nsfwScore: z.number().nullable(),
    nsfwCheckedAt: z.number().int().nullable(),
    nsfwWhitelist: z.boolean().default(false),
});
export type DownloadRow = z.infer<typeof DownloadRowSchema>;

/** Gallery tile — flatter than the raw DB row, ready to render. */
export const ViewerFileSchema = z.object({
    id: z.number().int().positive(),
    name: z.string(),
    fullPath: z.string(),
    extension: z.string().nullable(),
    type: ViewerFileTypeSchema,
    size: z.number().int().nonnegative().nullable(),
    sizeFormatted: z.string().optional(),
    modified: z.string().nullable(),
    groupId: z.string(),
    groupName: z.string().nullable(),
    pinned: z.boolean().default(false),
    pendingUntil: z.number().int().nullable(),
    rescuedAt: z.number().int().nullable(),
    nsfwScore: z.number().nullable(),
});
export type ViewerFile = z.infer<typeof ViewerFileSchema>;

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const GroupSchema = z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean().default(true),
    monitorEnabled: z.boolean().default(true),
    forwardEnabled: z.boolean().default(false),
    forwardTo: z.string().nullable().optional(),
    backfillOnAdd: z.boolean().default(true),
    fileTypes: z.array(FileTypeSchema).optional(),
    accountOverride: z.string().nullable().optional(),
});
export type Group = z.infer<typeof GroupSchema>;

export const DownloadedGroupSchema = z.object({
    id: z.string(),
    downloadId: z.string(),
    name: z.string(),
    totalFiles: z.number().int().nonnegative(),
    sizeFormatted: z.string(),
    type: z.enum(["config", "folder"]),
});
export type DownloadedGroup = z.infer<typeof DownloadedGroupSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const UserRoleSchema = z.enum(["admin", "guest"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const AuthCheckResponseSchema = z.object({
    authenticated: z.boolean(),
    role: UserRoleSchema.nullable(),
    setupRequired: z.boolean().default(false),
});
export type AuthCheckResponse = z.infer<typeof AuthCheckResponseSchema>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PaginatedFilesSchema = z.object({
    files: z.array(ViewerFileSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    hasMore: z.boolean(),
});
export type PaginatedFiles = z.infer<typeof PaginatedFilesSchema>;

// ---------------------------------------------------------------------------
// Engine / queue / monitor
// ---------------------------------------------------------------------------

export const EngineStatusSchema = z.object({
    monitor: z.enum(["idle", "starting", "running", "stopping"]),
    queue: z.object({
        queued: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
    }),
    accounts: z.array(
        z.object({
            id: z.string(),
            phone: z.string().nullable(),
            connected: z.boolean(),
        })
    ),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

// ---------------------------------------------------------------------------
// Stats (footer chips)
// ---------------------------------------------------------------------------

export const StatsSchema = z.object({
    totalFiles: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    totalBytesFormatted: z.string(),
    diskBudgetBytes: z.number().int().nullable(),
    photoCount: z.number().int().nonnegative(),
    videoCount: z.number().int().nonnegative(),
    audioCount: z.number().int().nonnegative(),
    documentCount: z.number().int().nonnegative(),
});
export type Stats = z.infer<typeof StatsSchema>;
