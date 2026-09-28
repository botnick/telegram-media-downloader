#!/usr/bin/env node
/**
 * Build tgdl-core (core-service/, Go).
 *
 *   npm run build:core
 *       Host build → core-service/bin/tgdl-core-<slug>(.exe), the path
 *       src/core/gocore/spawn.js looks at after TGDL_CORE_BIN and the
 *       Docker binary. GOOS / GOARCH in the environment cross-build.
 *
 *   npm run build:core -- --release
 *       Every release target → core-service/dist/tgdl-core-<slug>.tar.gz
 *       (each holding a single `tgdl-core` / `tgdl-core.exe`) plus
 *       SHA256SUMS. The release workflow runs exactly this.
 *
 * Requires Go on PATH; CGO is disabled, so no C toolchain is needed.
 */

import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CORE_VERSION, SUPPORTED_SLUGS } from '../src/core/gocore/spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SVC_DIR = path.join(REPO_ROOT, 'core-service');
const MODULE = 'github.com/botnick/telegram-media-downloader/core-service';

const TARGETS = {
    'win-x64': ['windows', 'amd64'],
    'win-arm64': ['windows', 'arm64'],
    'linux-x64': ['linux', 'amd64'],
    'linux-arm64': ['linux', 'arm64'],
    'linux-x86': ['linux', '386'],
    'mac-arm64': ['darwin', 'arm64'],
};

const args = process.argv.slice(2);
const release = args.includes('--release');
const versionArg = args.find((a) => a.startsWith('--version='));
const VERSION = versionArg ? versionArg.slice('--version='.length) : CORE_VERSION;

function goBuild(goos, goarch, outPath) {
    const ldflags = `-s -w -X ${MODULE}/internal/version.Version=${VERSION}`;
    const res = spawnSync(
        'go',
        ['build', '-trimpath', '-ldflags', ldflags, '-o', outPath, './cmd/tgdl-core'],
        {
            cwd: SVC_DIR,
            stdio: 'inherit',
            env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
        },
    );
    if (res.error?.code === 'ENOENT') {
        console.error(
            '[build:core] `go` not found on PATH. Install Go (https://go.dev/dl/) and retry.\n' +
                'Without tgdl-core the app hashes files with its Node worker pool as before.',
        );
        process.exit(127);
    }
    if (res.status !== 0) {
        console.error(`[build:core] go build failed for ${goos}/${goarch}`);
        process.exit(res.status || 1);
    }
}

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        createReadStream(p)
            .on('data', (c) => h.update(c))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
    });
}

function hostTarget() {
    const goos =
        process.env.GOOS || { win32: 'windows', darwin: 'darwin' }[process.platform] || 'linux';
    const goarch =
        process.env.GOARCH || { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch];
    const osPart = { windows: 'win', linux: 'linux', darwin: 'mac' }[goos] || goos;
    const archPart = { amd64: 'x64', arm64: 'arm64', 386: 'x86' }[goarch] || goarch;
    return { goos, goarch, slug: `${osPart}-${archPart}` };
}

async function main() {
    if (!existsSync(path.join(SVC_DIR, 'go.mod'))) {
        console.error(`[build:core] missing ${SVC_DIR}/go.mod`);
        process.exit(2);
    }

    if (!release) {
        const { goos, goarch, slug } = hostTarget();
        const binDir = path.join(SVC_DIR, 'bin');
        mkdirSync(binDir, { recursive: true });
        const out = path.join(binDir, `tgdl-core-${slug}${goos === 'windows' ? '.exe' : ''}`);
        console.log(`[build:core] ${goos}/${goarch} v${VERSION} → ${out}`);
        goBuild(goos, goarch, out);
        if (!SUPPORTED_SLUGS.includes(slug)) {
            console.warn(
                `[build:core] ${slug} is not a release target; point TGDL_CORE_BIN at the binary to use it.`,
            );
        }
        console.log('[build:core] done');
        return;
    }

    const distDir = path.join(SVC_DIR, 'dist');
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    const sums = [];
    for (const slug of SUPPORTED_SLUGS) {
        const [goos, goarch] = TARGETS[slug];
        const stage = mkdtempSync(path.join(distDir, `.stage-${slug}-`));
        try {
            const binName = goos === 'windows' ? 'tgdl-core.exe' : 'tgdl-core';
            console.log(`[build:core] ${slug} (${goos}/${goarch}) v${VERSION}`);
            goBuild(goos, goarch, path.join(stage, binName));
            const tarName = `tgdl-core-${slug}.tar.gz`;
            // Relative paths only: GNU tar on Windows reads `C:\…` as a
            // remote host.
            execFileSync('tar', ['-czf', tarName, '-C', path.basename(stage), binName], {
                cwd: distDir,
                stdio: 'inherit',
            });
            sums.push(`${await sha256File(path.join(distDir, tarName))}  ${tarName}`);
        } finally {
            rmSync(stage, { recursive: true, force: true });
        }
    }
    writeFileSync(path.join(distDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    console.log(`[build:core] wrote ${sums.length} tarballs + SHA256SUMS to ${distDir}`);
}

main().catch((e) => {
    console.error('[build:core]', e?.message || e);
    process.exit(1);
});
