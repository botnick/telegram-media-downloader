// Backup credentials — round-trip a config blob + verify rotation
// invalidates old blobs.

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
    encryptConfig,
    decryptConfig,
    looksLikeCredentialsBlob,
    deriveKek,
} from '../src/core/backup/credentials.js';

function hexSecret() {
    return crypto.randomBytes(32).toString('hex');
}

describe('backup/credentials', () => {
    it('round-trips a JSON config under a known shareSecret', () => {
        const secret = hexSecret();
        const config = {
            endpoint: 'https://s3.example.com',
            region: 'us-east-1',
            accessKeyId: 'AKIAEXAMPLE',
            secretAccessKey: 'super-secret-' + crypto.randomBytes(16).toString('hex'),
            bucket: 'tgdl-backup',
            prefix: 'tgdl/',
        };
        const blob = encryptConfig(config, secret);
        expect(Buffer.isBuffer(blob)).toBe(true);
        expect(looksLikeCredentialsBlob(blob)).toBe(true);
        const decoded = decryptConfig(blob, secret);
        expect(decoded).toEqual(config);
    });

    it('different shareSecret = decrypt fails (rotation invalidates old blobs)', () => {
        const s1 = hexSecret();
        const s2 = hexSecret();
        const blob = encryptConfig({ token: 'abc' }, s1);
        expect(() => decryptConfig(blob, s2)).toThrow();
    });

    it('rejects non-hex shareSecret', () => {
        expect(() => deriveKek('not hex')).toThrow(/hex/);
        expect(() => encryptConfig({}, 'too-short')).toThrow();
    });

    it('detects a wrong-magic blob immediately', () => {
        const secret = hexSecret();
        const noise = Buffer.from('GIBBERISHGIBBERISHGIBBERISHGIBBERISH');
        expect(looksLikeCredentialsBlob(noise)).toBe(false);
        expect(() => decryptConfig(noise, secret)).toThrow(/magic|too short/i);
    });
});
