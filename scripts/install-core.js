#!/usr/bin/env node
/**
 * Make sure tgdl-core — the app's Go engine for file hashing, file checks,
 * directory walks and face clustering — is installed. Runs as the npm
 * `postinstall` step and as `npm run install:core`.
 *
 *   1. Already there and current (TGDL_CORE_BIN, the Docker image's
 *      /app/bin/tgdl-core, `npm run build:core` output, or an earlier
 *      download of this version)  → nothing to do.
 *   2. Download the pinned release `core-v<CORE_VERSION>` for this
 *      platform into data/core-service/bin, verified against the release's
 *      SHA256SUMS (TGDL_CORE_RELEASE_URL points at a mirror).
 *   3. No download (offline, no release for this platform yet) and Go on
 *      PATH → build it from core-service/ (`npm run build:core`).
 *   4. Otherwise print how to fix it. The app still starts: it tries the
 *      download once more on boot, and until tgdl-core runs the dashboard
 *      shows the fix.
 *
 * Never fails `npm install`. TGDL_CORE_SKIP_INSTALL=1 skips it (Docker
 * builds tgdl-core in its own stage).
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg) => console.log(`[install:core] ${msg}`);

function goAvailable() {
    const r = spawnSync('go', ['version'], { encoding: 'utf8', windowsHide: true });
    return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

async function main() {
    if (process.env.TGDL_CORE_SKIP_INSTALL === '1') {
        log('skipped (TGDL_CORE_SKIP_INSTALL=1)');
        return;
    }
    const {
        CORE_VERSION,
        downloadCore,
        installFix,
        platformSlug,
        resolveBinary,
        resolveCurrentBinary,
    } = await import('../src/core/gocore/spawn.js');
    // A stale `npm run build:core` binary is passed over (and rebuilt
    // below when Go is here).
    const staleDev = resolveBinary()?.source === 'dev';
    const found = await resolveCurrentBinary({ log: (_level, msg) => log(msg) });
    if (staleDev && found?.source !== 'dev' && goAvailable()) {
        log('rebuilding core-service/bin with Go');
        const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build-core.js')], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
            windowsHide: true,
        });
        if (r.status === 0) {
            log('tgdl-core rebuilt');
            return;
        }
    }
    if (found?.missing) {
        log(`TGDL_CORE_BIN points at ${found.path}, which is not an executable file.`);
        log('Fix: point it at a tgdl-core binary, or unset it.');
        return;
    }
    if (found && !found.stale) {
        log(`tgdl-core ready (${found.source}: ${found.path})`);
        return;
    }

    const slug = platformSlug();
    let downloadError = null;
    if (slug) {
        try {
            const p = await downloadCore(slug, {
                log: (_level, msg) => log(msg),
            });
            log(`tgdl-core ${CORE_VERSION} installed: ${p}`);
            return;
        } catch (e) {
            downloadError = String(e?.message || e);
            log(`download failed: ${downloadError}`);
        }
    } else {
        log(`no prebuilt tgdl-core for ${process.platform}/${process.arch}`);
    }

    const go = goAvailable();
    if (go) {
        log(`building from source with ${go}`);
        const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build-core.js')], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
            windowsHide: true,
        });
        if (r.status === 0) {
            const built = resolveBinary();
            if (built && !built.missing) {
                log(`tgdl-core built: ${built.path}`);
                return;
            }
            if (!slug) {
                log('Set TGDL_CORE_BIN to the binary above — this platform has no release slug.');
                return;
            }
        }
        log('the Go build failed (see above).');
    }

    if (found?.stale) {
        log(
            `keeping the installed tgdl-core (not ${CORE_VERSION}) for now; the app retries on start.`,
        );
        return;
    }
    const bar = '-'.repeat(72);
    console.warn(
        `\n${bar}\n[install:core] tgdl-core is not installed. The app will start, but file\n` +
            'hashing, Verify files, Re-index from disk, the disk-usage fallback and face\n' +
            'clustering stay off until it is. The app tries the download again when it starts.\n' +
            `Fix: ${installFix(slug)}\n${bar}\n`,
    );
}

main().catch((e) => {
    // Never fail npm install over this.
    console.warn(`[install:core] ${e?.message || e}`);
});
