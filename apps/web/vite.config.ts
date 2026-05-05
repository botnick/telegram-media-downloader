import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";

/**
 * Vite config — dashboard SPA.
 *
 * Dev: `pnpm -F @tgdl/web dev` boots Vite on :5173 with HMR + proxies
 * /api, /ws, /files, /photos back to the Hono server on :3000.
 *
 * Build: `pnpm -F @tgdl/web build` writes hashed bundles into
 * apps/web/dist which the Hono server's serveStatic middleware picks
 * up at runtime.
 */
export default defineConfig({
    plugins: [
        TanStackRouterVite({
            target: "react",
            autoCodeSplitting: true,
            routesDirectory: "./src/routes",
            generatedRouteTree: "./src/routeTree.gen.ts",
        }),
        react(),
    ],
    resolve: {
        alias: {
            "@": resolve(__dirname, "src"),
        },
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            "/api": "http://localhost:3000",
            "/ws": { target: "ws://localhost:3000", ws: true },
            "/files": "http://localhost:3000",
            "/photos": "http://localhost:3000",
            "/share": "http://localhost:3000",
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: true,
        manifest: true,
        target: "es2022",
    },
});
