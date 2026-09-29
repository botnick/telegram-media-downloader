import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // tests/contract is its own suite (`npm run test:contract`).
        exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'tests/contract/**'],
        // tgdl-core (the Go engine) is required: build or find it once and
        // pass it to every worker, and every server a suite spawns, as
        // TGDL_CORE_BIN — so none of them tries to download a release. See
        // the setup file.
        globalSetup: ['./tests/setup/gocore.global.js'],
    },
});
