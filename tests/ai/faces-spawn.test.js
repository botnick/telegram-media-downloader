// Track I — platform-parity tests for faces-spawn. Pin process.platform /
// process.arch via `_computeBinaryTarget` so each row of the support
// matrix is exercised deterministically. The full spawn flow needs the
// network + a real binary so it stays in the integration suite; here we
// only assert the binary target metadata.

import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';

import { _computeBinaryTarget, SIDECAR_VERSION } from '../../src/core/ai/faces-spawn.js';

const DATA_DIR = '/data';

afterEach(() => {
    // No env mutation in these tests, but the resolver consults
    // FACES_SIDECAR_BIN_URL through the spawn module. Keep this clear in
    // case a future test starts using it.
    delete process.env.TGDL_FACES_SIDECAR_BIN_URL;
    delete process.env.FACES_SIDECAR_BIN_URL;
});

const matrix = [
    {
        name: 'Windows x64',
        platform: 'win32',
        arch: 'x64',
        slug: 'tgdl-faces-win-x64',
        exe: '.exe',
    },
    {
        name: 'Windows ARM64',
        platform: 'win32',
        arch: 'arm64',
        slug: 'tgdl-faces-win-arm64',
        exe: '.exe',
    },
    {
        name: 'macOS Intel',
        platform: 'darwin',
        arch: 'x64',
        slug: 'tgdl-faces-mac-x64',
        exe: '',
    },
    {
        name: 'macOS Apple Silicon',
        platform: 'darwin',
        arch: 'arm64',
        slug: 'tgdl-faces-mac-arm64',
        exe: '',
    },
    {
        name: 'Linux x64',
        platform: 'linux',
        arch: 'x64',
        slug: 'tgdl-faces-linux-x64',
        exe: '',
    },
    {
        name: 'Linux ARM64 (Pi 4 / DSM)',
        platform: 'linux',
        arch: 'arm64',
        slug: 'tgdl-faces-linux-arm64',
        exe: '',
    },
];

describe('_computeBinaryTarget — supported matrix', () => {
    for (const row of matrix) {
        it(`${row.name} → slug ${row.slug}`, () => {
            const target = _computeBinaryTarget({
                platform: row.platform,
                arch: row.arch,
                dataDir: DATA_DIR,
                envBinUrl: null,
                cfgMirrors: [],
            });
            expect(target).toBeTruthy();
            expect(target.slug).toBe(row.slug);
            expect(target.exe).toBe(row.exe);
            expect(target.binPath).toBe(
                path.join(DATA_DIR, 'faces-service', 'bin', `${row.slug}${row.exe}`),
            );
            // Canonical GitHub URL is always in the list.
            expect(target.tarUrl).toBe(
                `https://github.com/botnick/telegram-media-downloader/releases/download/faces-v${SIDECAR_VERSION}/${row.slug}.tar.gz`,
            );
            expect(target.tarUrls).toContain(target.tarUrl);
        });
    }
});

describe('_computeBinaryTarget — unsupported combos', () => {
    it('returns null for FreeBSD', () => {
        expect(
            _computeBinaryTarget({
                platform: 'freebsd',
                arch: 'x64',
                dataDir: DATA_DIR,
                envBinUrl: null,
                cfgMirrors: [],
            }),
        ).toBeNull();
    });

    it('returns null for 32-bit ARM (Pi Zero / Pi 3)', () => {
        expect(
            _computeBinaryTarget({
                platform: 'linux',
                arch: 'arm',
                dataDir: DATA_DIR,
                envBinUrl: null,
                cfgMirrors: [],
            }),
        ).toBeNull();
    });

    it('returns null for s390x', () => {
        expect(
            _computeBinaryTarget({
                platform: 'linux',
                arch: 's390x',
                dataDir: DATA_DIR,
                envBinUrl: null,
                cfgMirrors: [],
            }),
        ).toBeNull();
    });
});

describe('_computeBinaryTarget — URL precedence', () => {
    it('env override sits first in the candidate list', () => {
        const target = _computeBinaryTarget({
            platform: 'linux',
            arch: 'x64',
            dataDir: DATA_DIR,
            envBinUrl: 'https://mirror.corp/tgdl-faces.tar.gz',
            cfgMirrors: [],
        });
        expect(target.tarUrls[0]).toBe('https://mirror.corp/tgdl-faces.tar.gz');
        // Canonical GitHub URL still present as fallback.
        expect(target.tarUrls[target.tarUrls.length - 1]).toContain('github.com');
    });

    it('downloadMirrors slot between env and GitHub', () => {
        const target = _computeBinaryTarget({
            platform: 'linux',
            arch: 'x64',
            dataDir: DATA_DIR,
            envBinUrl: 'https://env.example/file.tar.gz',
            cfgMirrors: ['https://mirror-a.example', 'https://mirror-b.example/full.tar.gz'],
        });
        expect(target.tarUrls).toEqual([
            'https://env.example/file.tar.gz',
            // Base URL — slug gets templated in.
            'https://mirror-a.example/tgdl-faces-linux-x64.tar.gz',
            // Full URL — taken verbatim.
            'https://mirror-b.example/full.tar.gz',
            `https://github.com/botnick/telegram-media-downloader/releases/download/faces-v${SIDECAR_VERSION}/tgdl-faces-linux-x64.tar.gz`,
        ]);
    });

    it('falls back to GitHub when no override is supplied', () => {
        const target = _computeBinaryTarget({
            platform: 'linux',
            arch: 'arm64',
            dataDir: DATA_DIR,
            envBinUrl: null,
            cfgMirrors: [],
        });
        expect(target.tarUrls).toHaveLength(1);
        expect(target.tarUrls[0]).toContain('github.com');
        expect(target.tarUrls[0]).toContain('linux-arm64.tar.gz');
    });

    it('ignores empty/garbage mirror entries', () => {
        const target = _computeBinaryTarget({
            platform: 'linux',
            arch: 'x64',
            dataDir: DATA_DIR,
            envBinUrl: null,
            cfgMirrors: ['', '   ', null, undefined, 'https://real.example'],
        });
        // Only the real mirror + the canonical github URL.
        expect(target.tarUrls).toHaveLength(2);
        expect(target.tarUrls[0]).toBe('https://real.example/tgdl-faces-linux-x64.tar.gz');
    });
});

describe('SIDECAR_VERSION', () => {
    it('is a non-empty semver-shaped string', () => {
        expect(typeof SIDECAR_VERSION).toBe('string');
        expect(SIDECAR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });
});
