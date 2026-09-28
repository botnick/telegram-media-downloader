// Golden snapshot store — one JSON file per scenario file under
// tests/contract/__snapshots__/<name>.snap.json.
//
//   CONTRACT_UPDATE=1  → record: overwrite the file with this run's entries
//   (default)          → compare: every entry must equal the golden one, and
//                        every golden entry must be produced again (a stale
//                        entry means a scenario silently stopped running)
//
// Plain JSON (not vitest's .snap modules) so the goldens are target-neutral:
// the same files are compared against CONTRACT_TARGET=node|go|url, and
// non-JS tooling can read them.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

export const SNAP_DIR = path.resolve(import.meta.dirname, '..', '__snapshots__');
export const UPDATE = process.env.CONTRACT_UPDATE === '1';

function stableStringify(obj) {
    return `${JSON.stringify(obj, null, 2)}\n`;
}

export function snapshotStore(testFileUrl) {
    const base = path.basename(fileURLToPath(testFileUrl)).replace(/\.contract\.test\.js$/, '');
    const file = path.join(SNAP_DIR, `${base}.snap.json`);
    const golden = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const out = { entries: {}, securityProfiles: {} };

    function addProfile(id, headers) {
        out.securityProfiles[id] = headers;
    }

    function record(label, entry, { profiles = {} } = {}) {
        if (Object.hasOwn(out.entries, label)) {
            throw new Error(`duplicate snapshot label "${label}" in ${base}`);
        }
        out.entries[label] = entry;
        for (const [id, h] of Object.entries(profiles)) addProfile(id, h);
        if (UPDATE) return;
        if (!golden) {
            throw new Error(
                `no golden snapshot ${path.relative(process.cwd(), file)} — record it with CONTRACT_UPDATE=1 against the Node target`,
            );
        }
        const want = golden.entries?.[label];
        if (want === undefined) {
            throw new Error(
                `no golden entry "${label}" in ${base}.snap.json — record with CONTRACT_UPDATE=1`,
            );
        }
        // Security headers: compare the profile contents first so a diff
        // shows the header that changed, not two opaque profile ids.
        if (entry && want && entry.security !== want.security) {
            const cur = profiles[entry.security] ?? out.securityProfiles[entry.security];
            const old = golden.securityProfiles?.[want.security];
            expect(cur, `[${label}] security headers`).toEqual(old);
        }
        expect(entry, `[${label}]`).toEqual(want);
    }

    function finish() {
        if (UPDATE) {
            fs.mkdirSync(SNAP_DIR, { recursive: true });
            fs.writeFileSync(file, stableStringify(out));
            return;
        }
        if (!golden) return;
        const missing = Object.keys(golden.entries || {}).filter(
            (k) => !Object.hasOwn(out.entries, k),
        );
        expect(missing, `golden entries of ${base} that this run did not produce`).toEqual([]);
    }

    return {
        record,
        finish,
        file,
        name: base,
        get entries() {
            return out.entries;
        },
    };
}

/** All committed snapshot files, parsed. */
export function loadAllSnapshots() {
    if (!fs.existsSync(SNAP_DIR)) return [];
    return fs
        .readdirSync(SNAP_DIR)
        .filter((f) => f.endsWith('.snap.json'))
        .sort()
        .map((f) => ({
            file: f,
            data: JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8')),
        }));
}
