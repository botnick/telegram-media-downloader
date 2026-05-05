// Backup encryption — buffer + stream round-trip + format checks.

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { Readable } from 'stream';
import {
    deriveKey, generateSalt,
    encryptBuffer, decryptBuffer,
    encryptStream, decryptStream,
    MAGIC, VERSION, KEY_LEN,
} from '@tgdl/core/backup/encryption';

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

describe('backup/encryption', () => {
    it('derives a 32-byte key from a passphrase + salt', () => {
        const salt = generateSalt();
        const k = deriveKey('correct horse battery staple', salt);
        expect(Buffer.isBuffer(k)).toBe(true);
        expect(k.length).toBe(KEY_LEN);
    });

    it('rejects bogus key / salt input', () => {
        expect(() => deriveKey('', generateSalt())).toThrow();
        expect(() => deriveKey('hi', Buffer.alloc(2))).toThrow();
    });

    it('round-trips a 5 MB random buffer', () => {
        const key = deriveKey('test-pass', generateSalt());
        const plaintext = crypto.randomBytes(5 * 1024 * 1024);
        const blob = encryptBuffer(plaintext, key);

        // Header looks right.
        expect(blob.slice(0, 4).equals(MAGIC)).toBe(true);
        expect(blob[4]).toBe(VERSION);
        // Encrypted blob is plaintext + 4 magic + 1 ver + 12 iv + 16 tag = 33 byte overhead.
        expect(blob.length).toBe(plaintext.length + 33);

        const decrypted = decryptBuffer(blob, key);
        expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('refuses to decrypt with the wrong key', () => {
        const k1 = deriveKey('a', generateSalt());
        const k2 = deriveKey('b', generateSalt());
        const blob = encryptBuffer(Buffer.from('hello world'), k1);
        expect(() => decryptBuffer(blob, k2)).toThrow();
    });

    it('refuses non-TGDB blobs', () => {
        const key = deriveKey('x', generateSalt());
        const noise = Buffer.from('NOPE\x01nopenopenopenopenopenopenope');
        expect(() => decryptBuffer(noise, key)).toThrow(/magic mismatch|too short/i);
    });

    it('streams a 5 MB buffer through encrypt → decrypt and gets the original back', async () => {
        const key = deriveKey('streams', generateSalt());
        const plaintext = crypto.randomBytes(5 * 1024 * 1024);
        const enc = encryptStream(key);
        const dec = decryptStream(key);
        const piped = Readable.from([plaintext]).pipe(enc).pipe(dec);
        const out = await streamToBuffer(piped);
        expect(out.equals(plaintext)).toBe(true);
    });

    it('streamed output starts with MAGIC + VERSION + IV (header on the wire)', async () => {
        const key = deriveKey('hdr', generateSalt());
        const enc = encryptStream(key);
        const out = await streamToBuffer(Readable.from([Buffer.from('hi')]).pipe(enc));
        expect(out.slice(0, 4).equals(MAGIC)).toBe(true);
        expect(out[4]).toBe(VERSION);
        expect(out.length).toBe(2 + 33);
    });
});
