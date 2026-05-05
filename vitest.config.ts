import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Root vitest config — used by `pnpm test` from the repo root.
 *
 * The legacy tests/ directory still imports modules via
 * `@tgdl/core/...`; the workspace symlink under node_modules makes
 * that resolve to packages/core/src/*.js. Set TGDL_DATA_DIR to
 * vitest's per-process tmpdir so tests don't smash the live data/.
 */
export default defineConfig({
    test: {
        include: ["tests/**/*.test.{js,ts}"],
        globals: true,
        environment: "node",
        testTimeout: 20_000,
        hookTimeout: 20_000,
        env: {
            TGDL_DATA_DIR: resolve(process.cwd(), "tests/.tmp-data"),
        },
        setupFiles: [],
        passWithNoTests: false,
    },
});
