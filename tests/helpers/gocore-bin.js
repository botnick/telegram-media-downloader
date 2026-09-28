// tgdl-core binary for the suites that run the real thing.
//
// Opt-in: those suites run only with TGDL_GO_CORE_TEST=1 (CI's
// "node + tgdl-core" jobs set it). Then the binary is TGDL_CORE_BIN, the
// dev build (core-service/bin, `npm run build:core`), or — with Go on
// PATH — a build into the OS temp dir, cached by a hash of the Go
// sources. Opted in but none of those works → the suite fails instead
// of skipping. Without the flag `findOrBuildGoCore()` returns null and
// the suites skip, so a plain `npm test` never builds or spawns it.

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SVC_DIR = path.join(REPO_ROOT, 'core-service');

export const GOCORE_TEST = process.env.TGDL_GO_CORE_TEST === '1';

function usable(p) {
    try {
        const st = fs.statSync(p);
        return st.isFile() && st.size > 0;
    } catch {
        return false;
    }
}

function sourceHash() {
    const h = crypto.createHash('sha256');
    const walk = (dir) => {
        for (const e of fs
            .readdirSync(dir, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name !== 'bin' && e.name !== 'dist') walk(p);
            } else if (e.name.endsWith('.go') || e.name === 'go.mod') {
                h.update(path.relative(SVC_DIR, p));
                h.update(fs.readFileSync(p));
            }
        }
    };
    walk(SVC_DIR);
    return h.digest('hex').slice(0, 16);
}

async function locate() {
    const explicit = process.env.TGDL_CORE_BIN;
    if (explicit && usable(explicit)) return path.resolve(explicit);

    const prev = process.env.TGDL_CORE_BIN;
    delete process.env.TGDL_CORE_BIN;
    try {
        const { resolveBinary } = await import('../../src/core/gocore/spawn.js');
        const found = resolveBinary();
        if (found && !found.missing && found.source !== 'download') return found.path;
    } finally {
        if (prev !== undefined) process.env.TGDL_CORE_BIN = prev;
    }

    const exe = process.platform === 'win32' ? 'tgdl-core.exe' : 'tgdl-core';
    const dir = path.join(os.tmpdir(), 'tgdl-core-test', sourceHash());
    const out = path.join(dir, exe);
    if (usable(out)) return out;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${exe}.${process.pid}.${Date.now()}.tmp`);
    const res = spawnSync('go', ['build', '-o', tmp, './cmd/tgdl-core'], {
        cwd: SVC_DIR,
        env: { ...process.env, CGO_ENABLED: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
    });
    if (res.error || res.status !== 0) {
        fs.rmSync(tmp, { force: true });
        return null;
    }
    try {
        fs.renameSync(tmp, out);
    } catch {
        // A parallel suite won the race; its binary is identical.
        fs.rmSync(tmp, { force: true });
    }
    return usable(out) ? out : null;
}

let _cached;

/** Path to a tgdl-core binary, or null when TGDL_GO_CORE_TEST isn't set. */
export async function findOrBuildGoCore() {
    if (!GOCORE_TEST) return null;
    if (_cached === undefined) _cached = await locate();
    if (!_cached) {
        throw new Error(
            'TGDL_GO_CORE_TEST=1 but no tgdl-core: set TGDL_CORE_BIN, run `npm run build:core`, or put Go on PATH',
        );
    }
    return _cached;
}
