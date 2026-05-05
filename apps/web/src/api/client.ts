/**
 * Thin fetch wrapper for the SPA — same shape as the legacy
 * apps/web/legacy.html / public/js/api.js wrapper:
 *
 *   - Accepts a path + optional body, returns parsed JSON.
 *   - Redirects to /login.html on 401.
 *   - Treats 503 with setupRequired as a redirect to /setup-needed.html.
 *   - Tightens response-type to the shape supplied by the caller.
 */

export class ApiError extends Error {
    readonly status: number;
    readonly data: unknown;
    constructor(message: string, status: number, data: unknown) {
        super(message);
        this.status = status;
        this.data = data;
    }
}

async function parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

async function request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown
): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);

    if (res.status === 401) {
        if (!url.startsWith("/api/auth_check") && !url.startsWith("/api/login")) {
            window.location.href = "/login.html";
        }
        const data = await parseJson(res);
        throw new ApiError(
            (data as { error?: string }).error ?? "Unauthorized",
            401,
            data
        );
    }

    const data = await parseJson(res);

    if (
        res.status === 503 &&
        (data as { setupRequired?: boolean }).setupRequired &&
        !window.location.pathname.startsWith("/setup-needed")
    ) {
        window.location.href = "/setup-needed.html";
        throw new ApiError(
            (data as { error?: string }).error ?? "Setup required",
            503,
            data
        );
    }

    if (!res.ok) {
        throw new ApiError(
            (data as { error?: string }).error ?? `HTTP ${res.status}`,
            res.status,
            data
        );
    }

    return data as T;
}

export const api = {
    get<T>(url: string): Promise<T> {
        return request<T>("GET", url);
    },
    post<T>(url: string, body?: unknown): Promise<T> {
        return request<T>("POST", url, body);
    },
    put<T>(url: string, body?: unknown): Promise<T> {
        return request<T>("PUT", url, body);
    },
    delete<T>(url: string, body?: unknown): Promise<T> {
        return request<T>("DELETE", url, body);
    },
};
