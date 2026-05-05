// Local provider — full upload + stat + list + delete cycle against a
// tmpdir destination, exercising the encryption pipeline too.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import { LocalProvider } from '@tgdl/core/backup/providers/local';
import { deriveKey, generateSalt, decryptBuffer } from '@tgdl/core/backup/encryption';

const SOURCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-src-'));
const DEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-bk-dst-'));

afterAll(() => {
    fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
});

let provider;
const ctx = { destinationId: 1, log: () => {}, signal: new AbortController().signal };

beforeAll(async () => {
    provider = new LocalProvider();
    await provider.init({ rootPath: DEST_DIR }, ctx);
});

describe('backup/providers/local', () => {
    it('round-trips a plaintext upload + stat + list + delete', async () => {
        const src = path.join(SOURCE_DIR, 'sample.txt');
        await fsp.writeFile(src, 'hello backup world');

        const r = await provider.upload(src, 'group/photos/sample.txt', {}, ctx);
        expect(r.bytes).toBe(18);
        expect(r.remotePath).toBe('group/photos/sample.txt');

        const st = await provider.stat('group/photos/sample.txt', ctx);
        expect(st).not.toBeNull();
        expect(st.size).toBe(18);

        // missing remote path → null, not throw
        expect(await provider.stat('group/photos/missing.txt', ctx)).toBeNull();

        const items = [];
        for await (const item of provider.list('group/photos', ctx)) items.push(item);
        expect(items.find((i) => i.name.endsWith('sample.txt'))).toBeTruthy();

        await provider.delete('group/photos/sample.txt', ctx);
        expect(await provider.stat('group/photos/sample.txt', ctx)).toBeNull();
        // Idempotent — second delete is a no-op
        await expect(provider.delete('group/photos/sample.txt', ctx)).resolves.toBeUndefined();
    });

    it('refuses unsafe remote paths (.. or absolute)', async () => {
        const src = path.join(SOURCE_DIR, 'evil.txt');
        await fsp.writeFile(src, 'bad');
        await expect(provider.upload(src, '../escape.txt', {}, ctx)).rejects.toThrow(/unsafe/);
        await expect(provider.upload(src, '/abs/path.txt', {}, ctx)).rejects.toThrow(/unsafe/);
    });

    it('encrypts on the wire when encryptKey is supplied', async () => {
        const src = path.join(SOURCE_DIR, 'plain.bin');
        const plaintext = crypto.randomBytes(64 * 1024);
        await fsp.writeFile(src, plaintext);
        const salt = generateSalt();
        const key = deriveKey('test-pass', salt);
        const r = await provider.upload(src, 'enc/plain.bin', { encryptKey: key }, ctx);
        expect(r.bytes).toBe(plaintext.length + 33);
        // Verify the on-disk file decrypts back to the original.
        const onDisk = await fsp.readFile(path.join(DEST_DIR, 'enc/plain.bin'));
        const recovered = decryptBuffer(onDisk, key);
        expect(recovered.equals(plaintext)).toBe(true);
    });

    it('reports test connection ok for a writable root', async () => {
        const r = await provider.testConnection(ctx);
        expect(r.ok).toBe(true);
    });
});
