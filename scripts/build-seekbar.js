#!/usr/bin/env node
/**
 * Cross-platform build wrapper for `seekbar-service/cmd/server` (the Go
 * sidecar). Same UX as `npm run build:faces`: invoke once after install,
 * the binary lands at `seekbar-service/bin/seekbar-server(.exe)` and the
 * Node side auto-spawns it on boot.
 *
 * Requires `go` (>= 1.21) on PATH. Honours `GOOS` / `GOARCH` / `GOARM`
 * env vars for cross-builds (e.g. building an arm64 binary on amd64 for
 * a Pi or NAS).
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SVC_DIR = path.join(REPO_ROOT, 'seekbar-service');
const BIN_DIR = path.join(SVC_DIR, 'bin');

if (!existsSync(SVC_DIR)) {
    console.error(
        `[build:seekbar] seekbar-service directory missing at ${SVC_DIR}.\n` +
            `Pull the sidecar source first.`,
    );
    process.exit(2);
}

mkdirSync(BIN_DIR, { recursive: true });

const isWin = process.platform === 'win32';
const binName = isWin ? 'seekbar-server.exe' : 'seekbar-server';
const outPath = path.join(BIN_DIR, binName);

const args = ['build', '-trimpath', '-ldflags', '-s -w', '-o', outPath, './cmd/server'];

console.log(`[build:seekbar] go ${args.join(' ')}`);
console.log(`[build:seekbar] target: ${outPath}`);
console.log(
    `[build:seekbar] GOOS=${process.env.GOOS || process.platform}` +
        ` GOARCH=${process.env.GOARCH || process.arch}`,
);

const proc = spawn('go', args, {
    cwd: SVC_DIR,
    stdio: 'inherit',
    env: process.env,
    shell: false,
});

proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
        console.error(
            `\n[build:seekbar] \`go\` not found on PATH.\n` +
                `Install Go >= 1.21 from https://go.dev/dl/ and retry.\n` +
                `Without the sidecar binary, the seekbar feature falls\n` +
                `back to the in-process ffmpeg path (slower but works).\n`,
        );
        process.exit(127);
    }
    console.error('[build:seekbar] spawn error:', err.message);
    process.exit(1);
});

proc.on('exit', (code) => {
    if (code === 0) {
        console.log(`\n[build:seekbar] ✓ built ${outPath}`);
    } else {
        console.error(`\n[build:seekbar] go build exited with code ${code}`);
    }
    process.exit(code ?? 1);
});
