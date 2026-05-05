import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

import "./styles/main.css";

/**
 * Application entry. Wires:
 *   - TanStack Query: cache + retry + dedup for /api/* fetches
 *   - TanStack Router: type-safe client-side routing
 *
 * Both providers wrap the same component tree; Query lives outside
 * Router so route loaders can access the same cache.
 */

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // Default retries to one — backend errors surface fast in
            // development; production users can manually refresh.
            retry: 1,
            staleTime: 30_000,
            refetchOnWindowFocus: false,
        },
    },
});

const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");

ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
        </QueryClientProvider>
    </React.StrictMode>
);
