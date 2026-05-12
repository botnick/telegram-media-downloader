import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
    computeBinaryTarget,
    isBinaryUsable,
    normaliseUrl,
} from '../../src/core/ai/faces-download.js';

// The checksum tests that previously lived in faces-spawn-checksum.test.js
// now import from faces-download directly — kept in their own file.

// ---------------------------------------------------------------------------
// normaliseUrl
// ---------------------------------------------------------------------------

describe('normaliseUrl', () => {
    it('trims whitespace and trailing slashes', () => {
        expect(normaliseUrl('  https://example.com/path/  ')).toBe('https://example.com/path');
    });
    it('returns null for empty input', () => {
        expect(normaliseUrl('')).toBeNull();
        expect(normaliseUrl(null)).toBeNull();
        expect(normaliseUrl(undefined)).toBeNull();
    });
    it('preserves a clean URL unchanged', () => {
        expect(normaliseUrl('https://example.com')).toBe('https://example.com');
    });
});

// ---------------------------------------------------------------------------
// computeBinaryTarget
// ---------------------------------------------------------------------------

describe('computeBinaryTarget', () => {
    const baseOpts = { dataDir: '/data', envBinUrl: null, cfgMirrors: [] };

    it('returns null for unsupported platform', () => {
        expect(computeBinaryTarget({ ...baseOpts, platform: 'freebsd', arch: 'x64' })).toBeNull();
    });
    it('returns null for unsupported arch', () => {
        expect(computeBinaryTarget({ ...baseOpts, platform: 'linux', arch: 'mips' })).toBeNull();
    });

    it('maps linux+x64 to correct slug', () => {
        const t = computeBinaryTarget({ ...baseOpts, platform: 'linux', arch: 'x64' });
        expect(t.slug).toBe('tgdl-faces-linux-x64');
        expect(t.exe).toBe('');
        expect(t.binPath).toContain('tgdl-faces-linux-x64');
    });

    it('maps darwin+arm64 to correct slug', () => {
        const t = computeBinaryTarget({ ...baseOpts, platform: 'darwin', arch: 'arm64' });
        expect(t.slug).toBe('tgdl-faces-mac-arm64');
    });

    it('adds .exe extension on win32', () => {
        const t = computeBinaryTarget({ ...baseOpts, platform: 'win32', arch: 'x64' });
        expect(t.exe).toBe('.exe');
        expect(t.binPath).toContain('.exe');
    });

    it('envBinUrl is first in tarUrls', () => {
        const t = computeBinaryTarget({
            ...baseOpts,
            platform: 'linux',
            arch: 'x64',
            envBinUrl: 'https://mirror.example.com/binary.tar.gz',
        });
        expect(t.tarUrls[0]).toBe('https://mirror.example.com/binary.tar.gz');
    });

    it('cfgMirrors appear before the canonical GitHub URL', () => {
        const t = computeBinaryTarget({
            ...baseOpts,
            platform: 'linux',
            arch: 'x64',
            cfgMirrors: ['https://cdn.example.com'],
        });
        // Last URL is always the canonical GH release.
        const last = t.tarUrls[t.tarUrls.length - 1];
        expect(last).toContain('github.com');
        expect(t.tarUrls[0]).toContain('cdn.example.com');
    });

    it('appends slug.tar.gz to a mirror base URL without extension', () => {
        const t = computeBinaryTarget({
            ...baseOpts,
            platform: 'linux',
            arch: 'x64',
            cfgMirrors: ['https://cdn.example.com/releases'],
        });
        expect(t.tarUrls[0]).toBe('https://cdn.example.com/releases/tgdl-faces-linux-x64.tar.gz');
    });
});

// ---------------------------------------------------------------------------
// isBinaryUsable
// ---------------------------------------------------------------------------

describe('isBinaryUsable', () => {
    it('returns false for a non-existent path', () => {
        expect(isBinaryUsable('/does/not/exist/binary')).toBe(false);
    });

    it('returns true for a regular file with exec bit (non-Windows)', async () => {
        if (process.platform === 'win32') return; // exec bit not relevant
        const tmp = path.join(os.tmpdir(), `tgdl-test-binary-${Date.now()}`);
        await fs.writeFile(tmp, '#!/bin/sh\necho hello\n');
        await fs.chmod(tmp, 0o755);
        try {
            expect(isBinaryUsable(tmp)).toBe(true);
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });

    it('returns false for a zero-byte file', async () => {
        const tmp = path.join(os.tmpdir(), `tgdl-test-empty-${Date.now()}`);
        await fs.writeFile(tmp, '');
        await fs.chmod(tmp, 0o755);
        try {
            expect(isBinaryUsable(tmp)).toBe(false);
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });

    it('returns false for a file without exec bit (non-Windows)', async () => {
        if (process.platform === 'win32') return;
        const tmp = path.join(os.tmpdir(), `tgdl-test-noexec-${Date.now()}`);
        await fs.writeFile(tmp, 'not empty');
        await fs.chmod(tmp, 0o644);
        try {
            expect(isBinaryUsable(tmp)).toBe(false);
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    });
});
