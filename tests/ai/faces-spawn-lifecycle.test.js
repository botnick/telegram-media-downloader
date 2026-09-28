// faces-spawn lifecycle: no download / spawn before the operator switches
// AI on, the stock compose FACES_SERVICE_URL falling back to a local
// sidecar when the `faces` profile isn't running, and tarball extraction
// that survives Windows paths + a streaming parser that never interleaves
// chunks.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfig = vi.fn();
vi.mock('../../src/config/manager.js', () => ({ loadConfig: () => loadConfig() }));

// Sidecar HTTP probes (health / info / port discovery) fail fast instead of
// touching the network or resolving `tgdl-faces` for real.
vi.mock('http', async (importOriginal) => {
    const actual = await importOriginal();
    const { EventEmitter } = await import('events');
    const get = () => {
        const req = new EventEmitter();
        req.destroy = () => {};
        setImmediate(() =>
            req.emit(
                'error',
                Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
            ),
        );
        return req;
    };
    const base = actual.default ?? actual;
    return { ...actual, get, default: { ...base, get } };
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-faces-spawn-'));
// The spawn module resolves its binary dir from the data dir at import.
process.env.TGDL_DATA_DIR = TMP;
const spawnMod = await import('../../src/core/ai/faces-spawn.js');
const client = await import('../../src/core/ai/faces-client.js');
afterAll(() => {
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(TMP, { recursive: true, force: true });
});

const COMPOSE_URL = 'http://tgdl-faces:8011';
const notFound =
    (code = 'ENOTFOUND') =>
    async () => {
        throw Object.assign(new Error(`getaddrinfo ${code} tgdl-faces`), { code });
    };
const resolves = async () => ({ address: '172.18.0.5', family: 4 });

beforeEach(() => {
    spawnMod._resetForTests();
    client._resetForTests();
    delete process.env.FACES_SERVICE_URL;
    delete process.env.TGDL_FACES_SIDECAR_URL;
    delete process.env.TGDL_FACES_AUTO_DOWNLOAD;
});

describe('auto-spawn gate', () => {
    it.each([
        ['AI off (fresh install defaults)', { enabled: false, faceClustering: true }],
        ['face clustering off', { enabled: true, faceClustering: false }],
    ])('%s: no download, no spawn', async (_name, ai) => {
        loadConfig.mockReturnValue({ advanced: { ai } });
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const st = await spawnMod.startSidecar();
        expect(st.state).toBe('idle');
        expect(st.pid).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });
});

describe('compose default FACES_SERVICE_URL', () => {
    it('recognises only the stock compose URL', () => {
        expect(spawnMod._isComposeDefaultUrl(COMPOSE_URL)).toBe(true);
        expect(spawnMod._isComposeDefaultUrl('http://TGDL-FACES:8011/')).toBe(true);
        expect(spawnMod._isComposeDefaultUrl('http://tgdl-faces:9000')).toBe(false);
        expect(spawnMod._isComposeDefaultUrl('https://tgdl-faces:8011')).toBe(false);
        expect(spawnMod._isComposeDefaultUrl('http://tgdl-faces:8011/api')).toBe(false);
        expect(spawnMod._isComposeDefaultUrl('http://gpu-box:8011')).toBe(false);
        expect(spawnMod._isComposeDefaultUrl('')).toBe(false);
    });

    it('a custom URL is used as-is, without a DNS lookup', async () => {
        const lookup = vi.fn();
        expect(await spawnMod._decideEnvSidecar('http://gpu-box:8011', lookup)).toEqual({
            use: 'docker',
            reason: 'custom URL',
        });
        expect(lookup).not.toHaveBeenCalled();
    });

    it('the compose URL is used when tgdl-faces resolves (profile up)', async () => {
        expect(await spawnMod._decideEnvSidecar(COMPOSE_URL, resolves)).toMatchObject({
            use: 'docker',
        });
    });

    it.each(['ENOTFOUND', 'EAI_AGAIN'])(
        'the compose URL falls back to local when the lookup fails with %s',
        async (code) => {
            expect(await spawnMod._decideEnvSidecar(COMPOSE_URL, notFound(code))).toEqual({
                use: 'local',
                reason: code,
            });
        },
    );

    it('a lookup that hangs counts as not running', async () => {
        const hang = () => new Promise(() => {});
        expect(await spawnMod._decideEnvSidecar(COMPOSE_URL, hang, 30)).toEqual({
            use: 'local',
            reason: 'ETIMEOUT',
        });
    });

    it('boot, profile not up, AI off: nothing pointed at tgdl-faces, doctor explains', async () => {
        process.env.FACES_SERVICE_URL = COMPOSE_URL;
        spawnMod._setLookupForTests(notFound());
        loadConfig.mockReturnValue({ advanced: { ai: { enabled: false, faceClustering: true } } });
        const st = await spawnMod.startSidecar();
        expect(st.state).toBe('idle');
        expect(st.composeFallback).toBe(true);
        expect(st.mode).not.toBe('docker');
        expect(st.modeLabel).toMatch(/profile not running/);
        expect(client.getSidecarUrl()).toBeNull();
    });

    it('boot, profile not up, AI on: takes the local auto-spawn path', async () => {
        process.env.FACES_SERVICE_URL = COMPOSE_URL;
        // Nothing staged and downloads off, so the local path ends in
        // "failed" — what matters is that it was taken.
        process.env.TGDL_FACES_AUTO_DOWNLOAD = 'false';
        spawnMod._setLookupForTests(notFound());
        loadConfig.mockReturnValue({ advanced: { ai: { enabled: true, faceClustering: true } } });
        const st = await spawnMod.startSidecar();
        expect(st.composeFallback).toBe(true);
        expect(st.mode).not.toBe('docker');
        expect(st.state).toBe('failed');
        expect(st.error).toMatch(/autoDownload=false and binary missing/);
        expect(client.getSidecarUrl()).toBeNull();
    });

    it('boot, profile up: compose sidecar exactly as before', async () => {
        process.env.FACES_SERVICE_URL = COMPOSE_URL;
        spawnMod._setLookupForTests(resolves);
        loadConfig.mockReturnValue({ advanced: { ai: { enabled: true, faceClustering: true } } });
        const st = await spawnMod.startSidecar();
        expect(st.mode).toBe('docker');
        expect(st.modeLabel).toBe('compose sidecar');
        expect(st.composeFallback).toBe(false);
        expect(client.getSidecarUrl()).toBe(COMPOSE_URL);
        spawnMod.stopSidecar();
    });

    it('scan start re-checks: switches to the compose sidecar once the profile is up', async () => {
        process.env.FACES_SERVICE_URL = COMPOSE_URL;
        process.env.TGDL_FACES_AUTO_DOWNLOAD = 'false';
        loadConfig.mockReturnValue({ advanced: { ai: { enabled: true, faceClustering: true } } });
        spawnMod._setLookupForTests(notFound());
        await spawnMod.startSidecar();
        expect(spawnMod.getSidecarStatus().composeFallback).toBe(true);

        spawnMod._setLookupForTests(resolves);
        expect(await spawnMod.ensureSidecarForScan()).toBe(true);
        const st = await spawnMod.startSidecar(); // the restart it kicked off
        expect(st.mode).toBe('docker');
        expect(st.composeFallback).toBe(false);
        expect(client.getSidecarUrl()).toBe(COMPOSE_URL);
        spawnMod.stopSidecar();
    });

    it('scan start with a custom URL: no DNS re-check, no restart', async () => {
        process.env.FACES_SERVICE_URL = 'http://gpu-box:8011';
        const lookup = vi.fn(resolves);
        spawnMod._setLookupForTests(lookup);
        loadConfig.mockReturnValue({ advanced: { ai: { enabled: true, faceClustering: true } } });
        await spawnMod.startSidecar();
        expect(await spawnMod.ensureSidecarForScan()).toBe(false);
        expect(lookup).not.toHaveBeenCalled();
        expect(spawnMod.getSidecarStatus().modeLabel).toBe('FACES_SERVICE_URL');
        spawnMod.stopSidecar();
    });
});

// ---- tar fixtures -------------------------------------------------------------

// Modes matter off Windows: tar applies them (minus umask). A directory
// entry without the search bit (the 0644 this fixture used to give every
// entry) leaves its files unreadable and undeletable for the test user —
// EACCES on Linux CI. Directories get 0755, files 0644 unless given.
function tarHeader(name, size, type = '0', prefix = '', mode = type === '5' ? 0o755 : 0o644) {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 100, 'utf8');
    h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write('        ', 148, 'ascii'); // checksum placeholder
    h.write(type, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    if (prefix) h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return h;
}

function entry(name, data, type = '0', prefix = '', mode = undefined) {
    const body = Buffer.from(data);
    const pad = (512 - (body.length % 512)) % 512;
    return [tarHeader(name, body.length, type, prefix, mode), body, Buffer.alloc(pad)];
}

// A directory, a PAX header entry to skip, a ~300 KB file (many gunzip
// chunks — the old parser interleaved them), an empty file, and a path
// long enough to use the ustar prefix field.
const big = Buffer.alloc(300_000);
for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
function makeTarGz(file) {
    const parts = [
        ...entry('bin/', '', '5'),
        ...entry('PaxHeaders/tgdl-faces', '30 mtime=1700000000.000000000\n', 'x'),
        ...entry('bin/tgdl-faces', big, '0', '', 0o755), // executable, like the release binary
        ...entry('bin/empty.txt', ''),
        ...entry('deep.txt', 'deep', '0', 'a/very/long/prefix/dir'),
        Buffer.alloc(1024),
    ];
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
}

function checkTree(dir) {
    expect(Buffer.compare(fs.readFileSync(path.join(dir, 'bin', 'tgdl-faces')), big)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'bin', 'empty.txt'), 'utf8')).toBe('');
    expect(
        fs.readFileSync(path.join(dir, 'a', 'very', 'long', 'prefix', 'dir', 'deep.txt'), 'utf8'),
    ).toBe('deep');
}

describe('tarball extraction', () => {
    it('node fallback parses chunk by chunk (large file, PAX entry, ustar prefix)', async () => {
        const dir = path.join(TMP, 'fallback');
        fs.mkdirSync(dir, { recursive: true });
        const tgz = path.join(dir, 'pkg.tar.gz');
        makeTarGz(tgz);
        await spawnMod._extractTarballNodeFallback(tgz, dir);
        checkTree(dir);
    });

    it('node fallback rejects entries that escape the destination', async () => {
        const dir = path.join(TMP, 'escape');
        fs.mkdirSync(dir, { recursive: true });
        const tgz = path.join(dir, 'evil.tar.gz');
        fs.writeFileSync(
            tgz,
            zlib.gzipSync(Buffer.concat([...entry('../outside.txt', 'x'), Buffer.alloc(1024)])),
        );
        await expect(spawnMod._extractTarballNodeFallback(tgz, dir)).rejects.toThrow(/escapes/);
        expect(fs.existsSync(path.join(TMP, 'outside.txt'))).toBe(false);
    });

    const hasTar = !spawnSync('tar', ['--version'], { stdio: 'ignore' }).error;
    it.skipIf(!hasTar)(
        'system tar gets a path relative to the destination (GNU tar on Windows reads C:\\ as a host)',
        async () => {
            const dir = path.join(TMP, 'system tar dir'); // space on purpose
            fs.mkdirSync(dir, { recursive: true });
            const tgz = path.join(dir, 'pkg.tar.gz');
            makeTarGz(tgz);
            await spawnMod._extractTarball(tgz, dir);
            checkTree(dir);
        },
    );
});
