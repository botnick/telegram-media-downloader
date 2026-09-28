// Go-core flags (env / config precedence) and spawn helpers that don't
// need a binary: platform slugs, SHA256SUMS parsing, the child's minimal
// environment, and the Go / Node version pin staying in sync.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

import * as flags from '../src/core/gocore/flags.js';
import {
    allowRoots,
    CORE_VERSION,
    SUPPORTED_SLUGS,
    binaryFileName,
    childEnv,
    parseSha256Sums,
    platformSlug,
    resolveBinary,
} from '../src/core/gocore/spawn.js';

const KEYS = [
    'TGDL_GO_CORE',
    'TGDL_GO_FEATURES',
    'TGDL_CORE_BIN',
    'HASH_WORKER_POOL_SIZE',
    'TGDL_CORE_ALLOW_ROOTS',
    'TGDL_DATA_DIR',
    'TGDL_DOWNLOADS_DIR',
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    flags.setConfigReader(null);
});

afterAll(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    flags.setConfigReader(null);
});

describe('go-core flags', () => {
    it('defaults to shadow', () => {
        expect(flags.DEFAULT_MODE).toBe('shadow');
        expect(flags.resolveGlobalMode()).toEqual({ mode: 'shadow', source: 'default' });
        expect(flags.resolveFeatureMode('hash')).toEqual({ mode: 'shadow', source: 'default' });
        expect(flags.anyFeatureEnabled()).toBe(true);
    });

    it('config sets the mode; per-feature config beats the global one', () => {
        let cfg = { mode: 'on' };
        flags.setConfigReader(() => cfg);
        expect(flags.resolveFeatureMode('hash')).toEqual({ mode: 'on', source: 'config' });
        cfg = { mode: 'on', features: { hash: 'off' } };
        flags.invalidateConfig();
        expect(flags.resolveFeatureMode('hash')).toEqual({ mode: 'off', source: 'config' });
        expect(flags.anyFeatureEnabled()).toBe(false);
    });

    it('env wins over config, per-feature env over global env', () => {
        flags.setConfigReader(() => ({ mode: 'on', features: { hash: 'on' } }));
        process.env.TGDL_GO_CORE = 'off';
        expect(flags.resolveFeatureMode('hash')).toEqual({ mode: 'off', source: 'env' });
        process.env.TGDL_GO_FEATURES = 'hash=auto';
        expect(flags.resolveFeatureMode('hash')).toEqual({ mode: 'auto', source: 'env' });
        expect(flags.resolveGlobalMode()).toEqual({ mode: 'off', source: 'env' });
    });

    it('ignores invalid values instead of failing', () => {
        process.env.TGDL_GO_CORE = 'turbo';
        process.env.TGDL_GO_FEATURES = 'hash=fast,unknown=on,garbage';
        expect(flags.resolveFeatureMode('hash')).toEqual({ mode: 'shadow', source: 'default' });
        flags.setConfigReader(() => {
            throw new Error('db closed');
        });
        expect(flags.resolveFeatureMode('hash').mode).toBe('shadow');
    });

    it('parses feature lists in several spellings', () => {
        expect(flags.parseFeatureModes('hash=on')).toEqual({ hash: 'on' });
        expect(flags.parseFeatureModes('HASH:Shadow')).toEqual({ hash: 'shadow' });
        expect(flags.parseFeatureModes({ hash: 'OFF' })).toEqual({ hash: 'off' });
    });

    it('sanitizes the config block the dashboard API stores', () => {
        expect(
            flags.sanitizeConfigBlock({ mode: 'ON', features: { hash: 'auto', x: 'on' } }),
        ).toEqual({ mode: 'on', features: { hash: 'auto' } });
        expect(flags.sanitizeConfigBlock({ mode: 'bogus' })).toBeNull();
        expect(flags.sanitizeConfigBlock('on')).toBeNull();
    });
});

describe('go-core spawn helpers', () => {
    it('maps hosts to release slugs; unbuilt ones get null (Node only)', () => {
        expect(platformSlug('win32', 'x64')).toBe('win-x64');
        expect(platformSlug('win32', 'arm64')).toBe('win-arm64');
        expect(platformSlug('linux', 'x64')).toBe('linux-x64');
        expect(platformSlug('linux', 'arm64')).toBe('linux-arm64');
        expect(platformSlug('linux', 'ia32')).toBe('linux-x86');
        expect(platformSlug('darwin', 'arm64')).toBe('mac-arm64');
        expect(platformSlug('darwin', 'x64')).toBeNull();
        expect(platformSlug('win32', 'ia32')).toBeNull();
        expect(platformSlug('freebsd', 'x64')).toBeNull();
        expect(SUPPORTED_SLUGS).toHaveLength(6);
        expect(binaryFileName('win-x64', 'win32')).toBe('tgdl-core-win-x64.exe');
        expect(binaryFileName('linux-x64', 'linux')).toBe('tgdl-core-linux-x64');
    });

    it('parses SHA256SUMS', () => {
        const a = 'a'.repeat(64);
        const b = 'B'.repeat(64);
        const sums = parseSha256Sums(
            `${a}  tgdl-core-linux-x64.tar.gz\r\n${b} *tgdl-core-win-x64.tar.gz\nnot a line\n`,
        );
        expect(sums).toEqual({
            'tgdl-core-linux-x64.tar.gz': a,
            'tgdl-core-win-x64.tar.gz': 'b'.repeat(64),
        });
    });

    it('gives the child a minimal env: no app secrets', () => {
        process.env.HASH_WORKER_POOL_SIZE = '3';
        process.env.TGDL_TEST_SECRET = 'do-not-leak';
        try {
            const env = childEnv('tok');
            expect(env.TGDL_CORE_TOKEN).toBe('tok');
            expect(env.TGDL_CORE_PORT).toBe('0');
            expect(env.TGDL_CORE_WATCH_STDIN).toBe('1');
            expect(env.HASH_WORKER_POOL_SIZE).toBe('3');
            expect(env.TGDL_TEST_SECRET).toBeUndefined();
            for (const k of Object.keys(env)) {
                expect(k).toMatch(
                    /^(TGDL_CORE_\w+|HASH_WORKER_POOL_SIZE|PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL|TZ|GO\w+)$/,
                );
            }
        } finally {
            delete process.env.TGDL_TEST_SECRET;
        }
    });

    it('allow-roots: every place the app hashes from, and nothing else', () => {
        const data = path.resolve('some-data-dir');
        process.env.TGDL_DATA_DIR = data;
        const dataDownloads = path.join(data, 'downloads');
        // Default: the downloads dir only (data/downloads twice, de-duplicated).
        expect(allowRoots(null)).toEqual([dataDownloads]);
        // TGDL_DOWNLOADS_DIR moves the downloader's target; nsfw.js still
        // resolves relative rows under data/downloads, so both stay.
        process.env.TGDL_DOWNLOADS_DIR = path.resolve('hdd-downloads');
        expect(allowRoots(null)).toEqual([path.resolve('hdd-downloads'), dataDownloads]);
        // A custom config.download.path (relative = against the cwd, like
        // the downloader); the factory default adds nothing new.
        expect(allowRoots({ download: { path: './data/downloads' } })).toHaveLength(2);
        expect(allowRoots({ download: { path: 'media/tg' } })).toContain(path.resolve('media/tg'));
        // Extra roots from the app's own env, PATH-style.
        process.env.TGDL_CORE_ALLOW_ROOTS = [path.resolve('x1'), '', path.resolve('x2')].join(
            path.delimiter,
        );
        const roots = allowRoots(null);
        expect(roots).toContain(path.resolve('x1'));
        expect(roots).toContain(path.resolve('x2'));
        expect(roots.every((r) => path.isAbsolute(r))).toBe(true);
    });

    it('passes the roots to the child as TGDL_CORE_ALLOW_ROOTS', () => {
        const roots = [path.resolve('a'), path.resolve('b')];
        expect(childEnv('tok', roots).TGDL_CORE_ALLOW_ROOTS).toBe(roots.join(path.delimiter));
        // Never empty: the downloads dir is always there.
        expect(childEnv('tok').TGDL_CORE_ALLOW_ROOTS.length).toBeGreaterThan(0);
    });

    it('an explicit TGDL_CORE_BIN that does not exist is reported, not searched past', () => {
        process.env.TGDL_CORE_BIN = path.join('no', 'such', 'tgdl-core');
        const r = resolveBinary();
        expect(r.source).toBe('env');
        expect(r.missing).toBe(true);
    });

    it('keeps the Go default version in sync with CORE_VERSION', () => {
        const src = fs.readFileSync(
            path.join(
                import.meta.dirname,
                '..',
                'core-service',
                'internal',
                'version',
                'version.go',
            ),
            'utf8',
        );
        expect(/var Version = "([^"]+)"/.exec(src)?.[1]).toBe(CORE_VERSION);
    });
});
