// Getting tgdl-core onto a machine: the release download (used by
// `npm install` → scripts/install-core.js and again on startup) must
// verify SHA256SUMS and install nothing on a mismatch; the platform →
// release-slug mapping must pick a binary that runs there.

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-core-install-'));
const RELEASE = path.join(TMP, 'release');
let server;
let base;
let spawnMod;
let slug;
let sums = '';

beforeAll(async () => {
    spawnMod = await import('../src/core/gocore/spawn.js');
    slug = spawnMod.platformSlug();
    if (!slug) return;
    const bin = requireCoreBin();
    const stage = path.join(TMP, 'stage');
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(RELEASE, { recursive: true });
    const inner = process.platform === 'win32' ? 'tgdl-core.exe' : 'tgdl-core';
    fs.copyFileSync(bin, path.join(stage, inner));
    const tarName = `tgdl-core-${slug}.tar.gz`;
    execFileSync('tar', ['-czf', path.join('..', 'release', tarName), inner], { cwd: stage });
    const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(RELEASE, tarName)))
        .digest('hex');
    sums = `${digest}  ${tarName}\n`;
    server = http.createServer((req, res) => {
        const name = decodeURIComponent(req.url.split('/').pop());
        if (name === 'SHA256SUMS') return res.end(sums);
        const p = path.join(RELEASE, name);
        if (!fs.existsSync(p)) {
            res.statusCode = 404;
            return res.end();
        }
        fs.createReadStream(p).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/core`;
    process.env.TGDL_CORE_RELEASE_URL = base;
}, 120_000);

afterAll(async () => {
    delete process.env.TGDL_CORE_RELEASE_URL;
    server?.closeAllConnections?.();
    await new Promise((r) => (server ? server.close(r) : r()));
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
});

describe('release download', () => {
    it('installs the verified binary with its version marker', async ({ skip }) => {
        if (!slug) skip();
        const dir = path.join(TMP, 'ok');
        const p = await spawnMod.downloadCore(slug, { dir, log: () => {} });
        expect(p).toBe(path.join(dir, spawnMod.binaryFileName(slug)));
        expect(fs.readFileSync(`${p}.version`, 'utf8').trim()).toBe(spawnMod.CORE_VERSION);
        expect(execFileSync(p, ['version'], { encoding: 'utf8' })).toMatch(
            new RegExp(`^tgdl-core ${spawnMod.CORE_VERSION.replace(/\./g, '\\.')} `),
        );
        // No staging leftovers.
        expect(fs.readdirSync(dir).filter((n) => n.startsWith('.staging-'))).toEqual([]);
    });

    it('a checksum mismatch installs nothing', async ({ skip }) => {
        if (!slug) skip();
        const good = sums;
        sums = `${'0'.repeat(64)}  tgdl-core-${slug}.tar.gz\n`;
        const dir = path.join(TMP, 'bad');
        try {
            await expect(spawnMod.downloadCore(slug, { dir, log: () => {} })).rejects.toThrow(
                /checksum mismatch/,
            );
        } finally {
            sums = good;
        }
        expect(fs.existsSync(path.join(dir, spawnMod.binaryFileName(slug)))).toBe(false);
    });

    it('a release without this platform installs nothing', async ({ skip }) => {
        if (!slug) skip();
        const good = sums;
        sums = `${'1'.repeat(64)}  tgdl-core-other.tar.gz\n`;
        try {
            await expect(
                spawnMod.downloadCore(slug, { dir: path.join(TMP, 'none'), log: () => {} }),
            ).rejects.toThrow(/no entry/);
        } finally {
            sums = good;
        }
    });
});

describe('platform slugs', () => {
    it('maps every release target and nothing else', () => {
        const s = (p, a, v) => spawnMod.platformSlug(p, a, v);
        expect(s('win32', 'x64')).toBe('win-x64');
        expect(s('win32', 'arm64')).toBe('win-arm64');
        expect(s('win32', 'ia32')).toBe(null);
        expect(s('linux', 'x64')).toBe('linux-x64');
        expect(s('linux', 'arm64')).toBe('linux-arm64');
        expect(s('linux', 'ia32')).toBe('linux-x86');
        expect(s('linux', 'arm', '7')).toBe('linux-arm');
        expect(s('linux', 'arm', undefined)).toBe('linux-arm');
        expect(s('linux', 'arm', '6')).toBe(null); // GOARM=7 build won't run on ARMv6
        expect(s('darwin', 'arm64')).toBe('mac-arm64');
        expect(s('darwin', 'x64')).toBe('mac-x64');
        expect(s('freebsd', 'x64')).toBe(null);
        expect([...spawnMod.SUPPORTED_SLUGS].sort()).toEqual(
            [
                'linux-arm',
                'linux-arm64',
                'linux-x64',
                'linux-x86',
                'mac-arm64',
                'mac-x64',
                'win-arm64',
                'win-x64',
            ].sort(),
        );
    });

    it('build-core, the release workflow and spawn.js agree on the version', () => {
        const repo = path.resolve(import.meta.dirname, '..');
        const versionGo = fs.readFileSync(
            path.join(repo, 'core-service', 'internal', 'version', 'version.go'),
            'utf8',
        );
        expect(versionGo).toContain(`var Version = "${spawnMod.CORE_VERSION}"`);
        const buildCore = fs.readFileSync(path.join(repo, 'scripts', 'build-core.js'), 'utf8');
        for (const slugName of spawnMod.SUPPORTED_SLUGS) {
            expect(buildCore, slugName).toContain(`'${slugName}':`);
        }
    });
});
