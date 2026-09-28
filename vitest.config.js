import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // tests/contract is its own suite (`npm run test:contract`).
        exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'tests/contract/**'],
        // Servers spawned by the e2e suites inherit this: without it they'd
        // try to download the tgdl-core release on every run. Suites that
        // test tgdl-core set TGDL_GO_CORE themselves (CI's Go job passes it).
        env: { TGDL_GO_CORE: process.env.TGDL_GO_CORE ?? 'off' },
    },
});
