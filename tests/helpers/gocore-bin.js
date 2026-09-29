// tgdl-core binary for the test run.
//
// tgdl-core is a required part of the app, so the suite needs one:
// TGDL_CORE_BIN when it points at a file, else the dev build
// (core-service/bin, `npm run build:core`), else — with Go on PATH — a
// build into the OS temp dir, cached by a hash of the Go sources (so an
// edited .go file is always rebuilt). The vitest global setup
// (tests/setup/gocore.global.js) resolves it once and exports it as
// TGDL_CORE_BIN to every test worker and every server they spawn.

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SVC_DIR = path.join(REPO_ROOT, 'core-service');
/** Where TGDL_CORE_BIN points when no binary could be found or built. */
export const MISSING_BIN = path.join(os.tmpdir(), 'tgdl-core-test', 'no-tgdl-core-available');

function usable(p) {
    try {
        const st = fs.statSync(p);
        return st.isFile() && st.size > 0;
    } catch {
        return false;
    }
}

export function sourceHash() {
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

function buildFromSource() {
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
        // A parallel run won the race; its binary is identical.
        fs.rmSync(tmp, { force: true });
    }
    return usable(out) ? out : null;
}

/**
 * Path to a tgdl-core built from this tree, or null. Prefers a fresh
 * build from source (Go on PATH) over a dev build that may be stale.
 */
export function locateGoCore() {
    const explicit = process.env.TGDL_CORE_BIN;
    if (explicit && usable(explicit) && explicit !== MISSING_BIN) return path.resolve(explicit);
    const built = buildFromSource();
    if (built) return built;
    const slug = { win32: 'win', linux: 'linux', darwin: 'mac' }[process.platform];
    const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
    if (slug && arch) {
        const dev = path.join(
            SVC_DIR,
            'bin',
            `tgdl-core-${slug}-${arch}${process.platform === 'win32' ? '.exe' : ''}`,
        );
        if (usable(dev)) return dev;
    }
    return null;
}

/** The binary the global setup picked (null when none is available). */
export function testCoreBin() {
    const p = process.env.TGDL_CORE_BIN;
    return p && p !== MISSING_BIN && usable(p) ? p : null;
}
