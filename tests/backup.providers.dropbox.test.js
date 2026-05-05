// Dropbox provider — mock-only test against a stubbed `dropbox` SDK.
// Verifies the small-vs-chunked routing, idempotent delete, and the
// path normalisation around the configured remoteRoot.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const SOURCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-dx-src-'));
const smallFile = path.join(SOURCE_DIR, 'small.txt');
fs.writeFileSync(smallFile, 'hello dropbox');
const bigFile = path.join(SOURCE_DIR, 'big.bin');
// Just over 150 MB to force the chunked path. Use a sparse-ish buffer
// so the test stays fast — we don't actually upload, the mock drains
// the stream.
fs.writeFileSync(bigFile, Buffer.alloc(160 * 1024 * 1024));

const calls = [];
class MockDropbox {
    constructor(opts) {
        calls.push(['constructor', { hasKey: !!opts.clientId, hasSecret: !!opts.clientSecret, hasRefresh: !!opts.refreshToken }]);
    }
    async usersGetCurrentAccount() {
        calls.push(['usersGetCurrentAccount']);
        return { result: { email: 'tester@example.com' } };
    }
    async filesCreateFolderV2(args) {
        calls.push(['filesCreateFolderV2', args.path]);
        return { result: { metadata: { '.tag': 'folder', name: args.path } } };
    }
    async filesGetMetadata(args) {
        calls.push(['filesGetMetadata', args.path]);
        if (args.path.includes('missing')) {
            const e = new Error('not_found');
            e.error = { error_summary: 'path/not_found/' };
            throw e;
        }
        return { result: { '.tag': 'file', size: 13, server_modified: '2025-01-02T03:04:05Z', content_hash: 'hash' } };
    }
    async filesUpload(args) {
        calls.push(['filesUpload', { path: args.path, size: args.contents?.length }]);
        return { result: { id: 'id:upload', size: args.contents.length, content_hash: 'hash' } };
    }
    async filesUploadSessionStart(args) {
        calls.push(['filesUploadSessionStart', args.contents?.length]);
        return { result: { session_id: 'sid-1' } };
    }
    async filesUploadSessionAppendV2(args) {
        calls.push(['filesUploadSessionAppendV2', { offset: args.cursor.offset, len: args.contents?.length }]);
        return {};
    }
    async filesUploadSessionFinish(args) {
        calls.push(['filesUploadSessionFinish', { offset: args.cursor.offset, len: args.contents?.length, path: args.commit.path }]);
        return { result: { id: 'id:big', size: args.cursor.offset + (args.contents?.length || 0), content_hash: 'hash' } };
    }
    async filesDeleteV2(args) {
        calls.push(['filesDeleteV2', args.path]);
        if (args.path.includes('already-gone')) {
            const e = new Error('not_found');
            e.error = { error_summary: 'path_lookup/not_found/' };
            throw e;
        }
        return {};
    }
    async filesListFolder(args) {
        calls.push(['filesListFolder', args.path]);
        return {
            result: {
                entries: [
                    { '.tag': 'file', path_display: '/tgdl-backup/a.txt', name: 'a.txt', size: 5, server_modified: '2025-01-02T03:04:05Z' },
                    { '.tag': 'folder', path_display: '/tgdl-backup/photos', name: 'photos' },
                ],
                has_more: false,
            },
        };
    }
}

vi.mock('dropbox', () => ({ Dropbox: MockDropbox }));

let DropboxProvider;
const ctx = { destinationId: 1, log: () => {}, signal: new AbortController().signal };

beforeEach(async () => {
    calls.length = 0;
    const mod = await import('@tgdl/core/backup/providers/dropbox');
    DropboxProvider = mod.DropboxProvider;
});

describe('backup/providers/dropbox (mocked)', () => {
    it('rejects missing OAuth fields with an actionable hint', async () => {
        const p = new DropboxProvider();
        await expect(p.init({ appKey: 'x' }, ctx)).rejects.toThrow(/refreshToken/);
    });

    it('init verifies auth + ensures the remote root', async () => {
        const p = new DropboxProvider();
        await p.init({
            appKey: 'k', appSecret: 's', refreshToken: 't', remoteRoot: '/tgdl-backup',
        }, ctx);
        expect(calls.some((c) => c[0] === 'usersGetCurrentAccount')).toBe(true);
        expect(calls.some((c) => c[0] === 'filesCreateFolderV2' && c[1] === '/tgdl-backup')).toBe(true);
    });

    it('small upload uses filesUpload (not the chunked session API)', async () => {
        const p = new DropboxProvider();
        await p.init({
            appKey: 'k', appSecret: 's', refreshToken: 't', remoteRoot: '/tgdl-backup',
        }, ctx);
        const r = await p.upload(smallFile, 'small.txt', {}, ctx);
        expect(r.remotePath).toBe('small.txt');
        const single = calls.find((c) => c[0] === 'filesUpload');
        expect(single).toBeTruthy();
        expect(single[1].path).toBe('/tgdl-backup/small.txt');
        expect(calls.find((c) => c[0] === 'filesUploadSessionStart')).toBeFalsy();
    }, 20_000);

    it('big upload uses the chunked session API', async () => {
        const p = new DropboxProvider();
        await p.init({
            appKey: 'k', appSecret: 's', refreshToken: 't', remoteRoot: '/tgdl-backup',
        }, ctx);
        const r = await p.upload(bigFile, 'big.bin', {}, ctx);
        expect(r.remotePath).toBe('big.bin');
        expect(calls.find((c) => c[0] === 'filesUploadSessionStart')).toBeTruthy();
        expect(calls.find((c) => c[0] === 'filesUploadSessionFinish')).toBeTruthy();
    }, 60_000);

    it('delete is idempotent for a missing path', async () => {
        const p = new DropboxProvider();
        await p.init({
            appKey: 'k', appSecret: 's', refreshToken: 't', remoteRoot: '/tgdl-backup',
        }, ctx);
        await expect(p.delete('photos/already-gone.txt', ctx)).resolves.toBeUndefined();
    });

    it('stat returns null for a missing file (not throw)', async () => {
        const p = new DropboxProvider();
        await p.init({
            appKey: 'k', appSecret: 's', refreshToken: 't', remoteRoot: '/tgdl-backup',
        }, ctx);
        const st = await p.stat('photos/missing.txt', ctx);
        expect(st).toBeNull();
    });
});
