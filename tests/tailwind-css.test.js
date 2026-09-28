// Guard: the committed src/web/public/css/tailwind.css must match what
// `npm run build:css` produces from the current HTML / JS / locale sources.
//
// The stylesheet is generated (Tailwind v3 CLI, config in
// scripts/tailwind.config.cjs) and committed so Docker images and bare-metal
// installs need no build step. If someone adds a utility class to a
// template string and forgets to rebuild, the class silently has no CSS in
// production — this test turns that into a CI failure with a clear fix.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);

describe('prebuilt Tailwind stylesheet', () => {
    it('is up to date with the sources (run `npm run build:css` if this fails)', () => {
        const cli = join(dirname(require.resolve('tailwindcss/package.json')), 'lib', 'cli.js');
        const res = spawnSync(
            process.execPath,
            [
                cli,
                '-c',
                join(ROOT, 'scripts', 'tailwind.config.cjs'),
                '-i',
                join(ROOT, 'scripts', 'tailwind.input.css'),
                '--minify',
            ],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        );
        expect(res.status, res.stderr).toBe(0);
        // Normalise line endings — Windows checkouts may carry CRLF.
        const norm = (s) => s.replace(/\r\n/g, '\n').trim();
        const committed = readFileSync(join(ROOT, 'src/web/public/css/tailwind.css'), 'utf8');
        const fresh = norm(res.stdout);
        expect(fresh.length).toBeGreaterThan(1000);
        expect(norm(committed) === fresh).toBe(true);
    }, 60_000);
});
