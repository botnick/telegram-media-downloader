/**
 * API request/response contract.
 *
 * Frontend imports these to type its TanStack Query hooks; backend
 * imports them to validate request bodies via @hono/zod-validator and
 * to type its handlers' return values.
 *
 * One source of truth: change the schema, both ends pick up the new
 * shape at compile time. Endpoint URLs and methods stay byte-for-byte
 * identical to the legacy Express server so old browser tabs that
 * haven't picked up the new SPA bundle still work during a rolling
 * upgrade.
 */

import { z } from "zod";
import {
    AuthCheckResponseSchema,
    DownloadedGroupSchema,
    EngineStatusSchema,
    GroupSchema,
    PaginatedFilesSchema,
    StatsSchema,
    UserRoleSchema,
    ViewerFileTypeSchema,
} from "./domain.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
    error: z.string(),
    code: z.string().optional(),
    /**
     * Set on 401s when a guest pings an admin route — the SPA reads this
     * to show a single "admin only" toast instead of a generic error.
     */
    adminRequired: z.boolean().optional(),
    setupRequired: z.boolean().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const LoginRequestSchema = z.object({
    password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
    role: UserRoleSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const MeResponseSchema = z.object({
    role: UserRoleSchema,
    setupRequired: z.boolean().default(false),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------------------------------------------------------------------------
// Version chip
// ---------------------------------------------------------------------------

export const VersionResponseSchema = z.object({
    version: z.string(),
    commit: z.string(),
    builtAt: z.string().nullable(),
});
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

export const VersionCheckResponseSchema = z.object({
    current: z.string(),
    latest: z.string().nullable(),
    updateAvailable: z.boolean(),
    releaseUrl: z.string().nullable(),
    publishedAt: z.string().nullable(),
});
export type VersionCheckResponse = z.infer<typeof VersionCheckResponseSchema>;

// ---------------------------------------------------------------------------
// Downloads (gallery)
// ---------------------------------------------------------------------------

export const DownloadsListQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(50),
    type: ViewerFileTypeSchema.or(z.literal("all")).default("all"),
});
export type DownloadsListQuery = z.infer<typeof DownloadsListQuerySchema>;

/** Shared by /api/downloads/all + /api/downloads/:groupId. */
export const DownloadsListResponseSchema = PaginatedFilesSchema;
export type DownloadsListResponse = z.infer<typeof DownloadsListResponseSchema>;

export const PinRequestSchema = z.object({
    pinned: z.boolean(),
});
export type PinRequest = z.infer<typeof PinRequestSchema>;

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const GroupsListResponseSchema = z.object({
    config: z.array(GroupSchema),
    downloaded: z.array(DownloadedGroupSchema),
});
export type GroupsListResponse = z.infer<typeof GroupsListResponseSchema>;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export const StatsResponseSchema = StatsSchema;
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

// ---------------------------------------------------------------------------
// Auth check (public — re-exported from domain so callers grab it from
// the API module alongside the rest of the contract)
// ---------------------------------------------------------------------------

export { AuthCheckResponseSchema };
export type { AuthCheckResponse } from "./domain.js";

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export const EngineStatusResponseSchema = EngineStatusSchema;
export type EngineStatusResponse = z.infer<typeof EngineStatusResponseSchema>;

export const EngineActionRequestSchema = z.object({
    action: z.enum(["start", "stop", "restart"]),
});
export type EngineActionRequest = z.infer<typeof EngineActionRequestSchema>;

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

export const ThumbsQuerySchema = z.object({
    w: z.coerce.number().int().positive().optional(),
});
export type ThumbsQuery = z.infer<typeof ThumbsQuerySchema>;
