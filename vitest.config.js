import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
        // tgdl-core (the Go engine) is required: build or find it once and
        // pass it to every worker as TGDL_CORE_BIN — see the setup file.
        globalSetup: ['./tests/setup/gocore.global.js'],
    },
});
