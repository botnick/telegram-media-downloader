/**
 * TanStack Query hooks for every common GET endpoint. Mutation hooks
 * for POST/PUT/DELETE go in mutations.ts.
 *
 * All hooks share the same query-key conventions used by TanStack
 * Router's invalidator, so mutations can target their cache by key.
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type {
    DownloadsListQuery,
    DownloadsListResponse,
    GroupsListResponse,
    StatsResponse,
    VersionCheckResponse,
    VersionResponse,
} from "@tgdl/shared";

import { api } from "./client.js";

export function useVersion(): UseQueryResult<VersionResponse> {
    return useQuery({
        queryKey: ["version"],
        queryFn: () => api.get<VersionResponse>("/api/version"),
    });
}

export function useVersionCheck(): UseQueryResult<VersionCheckResponse> {
    return useQuery({
        queryKey: ["version", "check"],
        queryFn: () => api.get<VersionCheckResponse>("/api/version/check"),
        staleTime: 60 * 60_000,
    });
}

export function useStats(): UseQueryResult<StatsResponse> {
    return useQuery({
        queryKey: ["stats"],
        queryFn: () => api.get<StatsResponse>("/api/stats"),
        refetchInterval: 30_000,
    });
}

export function useGroups(): UseQueryResult<GroupsListResponse> {
    return useQuery({
        queryKey: ["groups"],
        queryFn: () => api.get<GroupsListResponse>("/api/groups"),
    });
}

export function useDownloadsAll(
    query: Partial<DownloadsListQuery> = {}
): UseQueryResult<DownloadsListResponse> {
    const params = new URLSearchParams();
    if (query.page) params.set("page", String(query.page));
    if (query.limit) params.set("limit", String(query.limit));
    if (query.type) params.set("type", query.type);
    return useQuery({
        queryKey: ["downloads", "all", query],
        queryFn: () => api.get<DownloadsListResponse>(`/api/downloads/all?${params.toString()}`),
        placeholderData: (prev) => prev,
    });
}

export function useDownloadsByGroup(
    groupId: string,
    query: Partial<DownloadsListQuery> = {}
): UseQueryResult<DownloadsListResponse> {
    const params = new URLSearchParams();
    if (query.page) params.set("page", String(query.page));
    if (query.limit) params.set("limit", String(query.limit));
    if (query.type) params.set("type", query.type);
    return useQuery({
        queryKey: ["downloads", "byGroup", groupId, query],
        queryFn: () =>
            api.get<DownloadsListResponse>(
                `/api/downloads/${encodeURIComponent(groupId)}?${params.toString()}`
            ),
        placeholderData: (prev) => prev,
    });
}
