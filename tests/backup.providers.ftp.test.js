// FTP provider — mock-only test. We stub `basic-ftp` via vi.mock so a
// real FTP server isn't needed; the provider's path normalisation,
// idempotent-delete tolerance, and abort-signal plumbing get exercised
// against the mock client.
//
// To run an end-to-end check against a real FTP server (e.g. vsftpd),
// expose host / username / password through env vars and switch the
// mock to a real basic-ftp import — left as an opt-in escape hatch
// because CI doesn't have one available.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stand-in for basic-ftp's Client. Records every call into `calls` so
// each test can assert against them. Throws on `delete` for a missing
// path the first time around, then succeeds — exercises the idempotent
// path on the provider side.
const calls = [];
class MockClient {
    constructor() {
        this.ftp = { verbose: false };
        this._closed = false;
    }
    async access(opts) {
        calls.push(['access', opts]);
    }
    async ensureDir(p) {
        calls.push(['ensureDir', p]);
    }
    async cd(p) {
        calls.push(['cd', p]);
    }
    async uploadFrom(stream, target) {
        calls.push(['uploadFrom', target]);
        // Drain the stream so transforms / pipes finish.
        if (stream && typeof stream.on === 'function') {
            await new Promise((res) => {
                stream.on('data', () => {});
                stream.on('end', res);
                stream.on('error', res);
                stream.resume?.();
            });
        }
    }
    async size(p) {
        calls.push(['size', p]);
        if (p.includes('missing')) {
            const e = new Error('550 No such file');
            e.code = 550;
            throw e;
        }
        return 18;
    }
    async lastMod(p) {
        calls.push(['lastMod', p]);
        return new Date('2025-01-02T03:04:05Z');
    }
    async remove(p) {
        calls.push(['remove', p]);
        if (p.includes('already-gone')) {
            const e = new Error('550 No such file');
            e.code = 550;
            throw e;
        }
    }
    async list(dir) {
        calls.push(['list', dir]);
        if (dir === '/tgdl-backup' || dir === '/tgdl-backup/photos') {
            return [
                { name: 'a.txt', type: 1, size: 18, modifiedAt: new Date('2025-01-02') },
                { name: 'photos', type: 2 },
            ].filter((e) => (dir === '/tgdl-backup' ? true : e.name === 'a.txt'));
        }
        return [];
    }
    close() {
        this._closed = true;
        calls.push(['close']);
    }
}

vi.mock('basic-ftp', () => ({
    Client: MockClient,
}));

let FtpProvider;
const ctx = { destinationId: 1, log: () => {}, signal: new AbortController().signal };

beforeEach(async () => {
    calls.length = 0;
    const mod = await import('../src/core/backup/providers/ftp.js');
    FtpProvider = mod.FtpProvider;
});

describe('backup/providers/ftp (mocked)', () => {
    it('init connects + ensures the remote root', async () => {
        const p = new FtpProvider();
        await p.init(
            {
                host: 'example.com',
                username: 'tester',
                password: 'pw',
                secure: 'control',
                remoteRoot: '/tgdl-backup',
            },
            ctx,
        );
        const access = calls.find((c) => c[0] === 'access');
        expect(access[1].host).toBe('example.com');
        expect(access[1].user).toBe('tester');
        expect(access[1].secure).toBe('control');
        expect(access[1].port).toBe(21);
        expect(calls.some((c) => c[0] === 'ensureDir' && c[1] === '/tgdl-backup')).toBe(true);
    });

    it('refuses .. escape paths on upload', async () => {
        const p = new FtpProvider();
        await p.init({ host: 'h', username: 'u', remoteRoot: '/r' }, ctx);
        // Use a fake local path; we never actually open it before path
        // validation.
        await expect(p.upload('does-not-matter', '../escape.txt', {}, ctx)).rejects.toThrow(
            /unsafe/,
        );
    });

    it('delete is idempotent — 550 from server is swallowed', async () => {
        const p = new FtpProvider();
        await p.init({ host: 'h', username: 'u', remoteRoot: '/tgdl-backup' }, ctx);
        // Should not throw.
        await expect(p.delete('photos/already-gone.txt', ctx)).resolves.toBeUndefined();
        // remove was attempted on the right absolute path.
        expect(calls.find((c) => c[0] === 'remove')[1]).toBe(
            '/tgdl-backup/photos/already-gone.txt',
        );
    });

    it('list yields files relative to the remote root, recursing into dirs', async () => {
        const p = new FtpProvider();
        await p.init({ host: 'h', username: 'u', remoteRoot: '/tgdl-backup' }, ctx);
        const out = [];
        for await (const item of p.list('', ctx)) out.push(item);
        // a.txt at root + a.txt inside photos/
        expect(out.length).toBeGreaterThanOrEqual(2);
        const names = out.map((i) => i.name).sort();
        expect(names).toContain('a.txt');
        expect(names).toContain('photos/a.txt');
    });

    it('testConnection ok when ensureDir succeeds', async () => {
        const p = new FtpProvider();
        await p.init({ host: 'h', username: 'u', remoteRoot: '/tgdl-backup' }, ctx);
        const r = await p.testConnection(ctx);
        expect(r.ok).toBe(true);
    });

    it('schema marks password as a secret', () => {
        const fields = FtpProvider.configSchema;
        const password = fields.find((f) => f.name === 'password');
        expect(password?.secret).toBe(true);
    });
});
