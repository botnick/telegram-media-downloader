// Contract suite config — `npm run test:contract`. Kept apart from the
// default `npm test` (which excludes tests/contract) because every file
// boots its own server on a fresh seed.
import path from 'path';
import { BaseSequencer } from 'vitest/node';
import { defineConfig } from 'vitest/config';

const root = path.resolve(import.meta.dirname, '..', '..');

// Files that wait on server-side timers (the 30 s stats push, the account
// wizard's connect retries, the 2 s gap of the bulk chat re-check) start
// first so they overlap the short ones instead of trailing the run.
const SLOW_FIRST = ['ws-ambient', 'accounts', 'chats', 'cluster-ws'];

class SlowFirstSequencer extends BaseSequencer {
    async sort(files) {
        const weight = (f) => {
            const name = path.basename(f.moduleId ?? f[1] ?? String(f));
            const i = SLOW_FIRST.findIndex((s) => name.startsWith(`${s}.`));
            return i < 0 ? SLOW_FIRST.length : i;
        };
        return [...files].sort((a, b) => weight(a) - weight(b));
    }
}

export default defineConfig({
    root,
    test: {
        include: ['tests/contract/**/*.contract.test.js'],
        exclude: ['**/node_modules/**'],
        testTimeout: 60_000,
        hookTimeout: 120_000,
        pool: 'forks',
        poolOptions: {
            forks: {
                // Each file runs one server; cap concurrency so slow CI
                // runners don't time out on boot.
                maxForks: Number(process.env.CONTRACT_WORKERS) || 4,
                minForks: 1,
            },
        },
        // One target per file, scenarios inside a file run in order.
        sequence: { concurrent: false, shuffle: false, sequencer: SlowFirstSequencer },
    },
});
