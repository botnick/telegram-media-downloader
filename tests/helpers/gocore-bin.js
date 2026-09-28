// Locate a tgdl-core binary for tests: TGDL_CORE_BIN, then the regular
// lookup (Docker / core-service/bin / data download), then — when a Go
// toolchain is on PATH — a build into the OS temp dir, cached by a hash
// of the Go sources so repeated runs reuse it.
//
// Returns null when there is no binary and no Go; suites then skip,
// unless TGDL_GOCORE_REQUIRE=1 (CI) turns that into a failure.

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SVC_DIR = path.join(REPO_ROOT, 'core-service');

export const REQUIRE_GOCORE = process.env.TGDL_GOCORE_REQUIRE === '1';

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

let _cached;

export async function findOrBuildGoCore() {
    if (_cached !== undefined) return _cached;
    const explicit = process.env.TGDL_CORE_BIN;
    if (explicit && usable(explicit)) return (_cached = path.resolve(explicit));

    const prev = process.env.TGDL_CORE_BIN;
    delete process.env.TGDL_CORE_BIN;
    try {
        const { resolveBinary } = await import('../../src/core/gocore/spawn.js');
        const found = resolveBinary();
        if (found && !found.missing && found.source !== 'download') return (_cached = found.path);
    } finally {
        if (prev !== undefined) process.env.TGDL_CORE_BIN = prev;
    }

    const exe = process.platform === 'win32' ? 'tgdl-core.exe' : 'tgdl-core';
    let dir;
    try {
        dir = path.join(os.tmpdir(), 'tgdl-core-test', sourceHash());
    } catch {
        return (_cached = null);
    }
    const out = path.join(dir, exe);
    if (usable(out)) return (_cached = out);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${exe}.${process.pid}.${Date.now()}.tmp`);
    const res = spawnSync('go', ['build', '-o', tmp, './cmd/tgdl-core'], {
        cwd: SVC_DIR,
        env: { ...process.env, CGO_ENABLED: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
    });
    if (res.error || res.status !== 0) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {}
        return (_cached = null);
    }
    try {
        fs.renameSync(tmp, out);
    } catch {
        // A parallel suite won the race; its binary is identical.
        fs.rmSync(tmp, { force: true });
    }
    return (_cached = usable(out) ? out : null);
}
