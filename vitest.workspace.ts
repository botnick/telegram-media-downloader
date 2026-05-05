import { defineWorkspace } from "vitest/config";

/**
 * Vitest workspace — runs the legacy tests/ suite at the repo root
 * (still .js, imports @tgdl/core via the package symlink) plus any
 * per-workspace vitest config that lands later (apps/web, apps/server).
 *
 * The root project sets TGDL_DATA_DIR to a tmpdir so tests don't
 * scribble on the real data/ directory.
 */
export default defineWorkspace([
    {
        test: {
            name: "core",
            root: "./",
            include: ["tests/**/*.test.{js,ts}"],
            globals: true,
            environment: "node",
            // Long-running native deps (better-sqlite3, sharp) need a
            // moment to spin up on cold runs.
            testTimeout: 20_000,
            hookTimeout: 20_000,
        },
    },
]);
