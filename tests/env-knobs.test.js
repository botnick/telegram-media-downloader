// Every TGDL_* variable the tests set must be one the app actually reads.
// A knob nothing reads (the "disable autostart" one was: set by the e2e
// suites and the contract harness, read nowhere) makes a test look like it
// pins a behaviour it doesn't — and the contract harness's environment is
// what a Go server is held to.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

// Read by the test runner itself, never by the app.
const TEST_ONLY = new Set(['TGDL_SKIP_E2E', 'TGDL_TEST_SECRET', 'TGDL_GO_CORE_TEST']);

function walk(dir, exts, out = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, exts, out);
        else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
    return out;
}

const namesIn = (files) => {
    const names = new Set();
    for (const f of files) {
        // Whole names only: a `TGDL_CORE_\w+` pattern isn't one.
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bTGDL_[A-Z0-9_]*[A-Z0-9]\b/g)) {
            names.add(m[0]);
        }
    }
    return names;
};

describe('TGDL_* environment knobs', () => {
    it('every one the tests set is read by the app', () => {
        const used = namesIn(walk(path.join(ROOT, 'tests'), ['.js', '.mjs']));
        const read = namesIn(
            [
                ...walk(path.join(ROOT, 'src'), ['.js', '.mjs']),
                ...walk(path.join(ROOT, 'scripts'), ['.js', '.mjs', '.sh']),
                ...walk(path.join(ROOT, 'core-service'), ['.go']),
            ].filter((f) => fs.existsSync(f)),
        );
        const dead = [...used].filter((n) => !TEST_ONLY.has(n) && !read.has(n)).sort();
        expect(dead).toEqual([]);
    });
});
