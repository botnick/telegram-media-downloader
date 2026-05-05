// Backup payload encryption.
//
// File format on the wire:
//
//   magic(4)='TGDB' | version(1)=1 | iv(12) | ciphertext | tag(16)
//
// magic + version make corrupt or unexpected blobs identifiable on
// inspection — a future restore tool that reads `head -c5` against an
// uploaded file knows immediately whether it's a TGDB-encrypted blob or
// a plaintext / partial / wrong-bucket object before trying to decrypt.
//
// The ciphertext is streamed: encryptStream / decryptStream wrap a
// Node Readable so a 10 GB tar.gz never has to fit in RAM.
//
// Key derivation lives separately (manager.js owns the per-destination
// passphrase + salt → 32-byte AES key). This module is purely the
// cryptographic primitive.

import crypto from 'crypto';
import { Transform } from 'stream';

export const MAGIC = Buffer.from('TGDB', 'utf8');
export const VERSION = 1;
export const IV_LEN = 12;       // 96 bits — GCM standard
export const TAG_LEN = 16;      // 128 bits — GCM standard
export const HEADER_LEN = MAGIC.length + 1 + IV_LEN; // 17 bytes
export const KEY_LEN = 32;      // 256 bits

// PBKDF2 cost. 200k iterations of SHA-256 takes ~150 ms on a modern
// laptop — slow enough to deter brute force, fast enough that an
// operator entering a passphrase doesn't notice a spinner.
export const PBKDF2_ITER = 200_000;
export const SALT_LEN = 16;

/**
 * Derive a 32-byte AES key from a passphrase + salt via PBKDF2-SHA256.
 *
 * @param {string} passphrase
 * @param {Buffer} salt   per-destination salt, generated at create time
 * @returns {Buffer} 32-byte key
 */
export function deriveKey(passphrase, salt) {
    if (!passphrase || typeof passphrase !== 'string') {
        throw new Error('passphrase required');
    }
    if (!Buffer.isBuffer(salt) || salt.length < 8) {
        throw new Error('salt must be a Buffer of at least 8 bytes');
    }
    return crypto.pbkdf2Sync(
        Buffer.from(passphrase, 'utf8'),
        salt,
        PBKDF2_ITER,
        KEY_LEN,
        'sha256',
    );
}

/** Generate a fresh random salt suitable for `deriveKey`. */
export function generateSalt() {
    return crypto.randomBytes(SALT_LEN);
}

/**
 * Encrypt a single Buffer payload. Used by tests + small-blob paths.
 * Streams should use `encryptStream`.
 *
 * @param {Buffer} plaintext
 * @param {Buffer} key      32 bytes
 * @returns {Buffer} magic|version|iv|ciphertext|tag
 */
export function encryptBuffer(plaintext, key) {
    if (!Buffer.isBuffer(plaintext)) plaintext = Buffer.from(plaintext);
    if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
        throw new Error(`key must be ${KEY_LEN} bytes`);
    }
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, ct, tag]);
}

/**
 * Decrypt a `encryptBuffer` payload. Throws on magic / version / tag
 * mismatch — caller is responsible for surfacing that as a recoverable
 * error in the UI ("wrong passphrase or corrupt file").
 *
 * @param {Buffer} blob
 * @param {Buffer} key
 * @returns {Buffer} plaintext
 */
export function decryptBuffer(blob, key) {
    if (!Buffer.isBuffer(blob) || blob.length < HEADER_LEN + TAG_LEN) {
        throw new Error('payload too short to be a TGDB blob');
    }
    if (!blob.slice(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('not a TGDB blob (magic mismatch)');
    }
    const ver = blob[MAGIC.length];
    if (ver !== VERSION) {
        throw new Error(`unsupported TGDB version ${ver} (expected ${VERSION})`);
    }
    if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
        throw new Error(`key must be ${KEY_LEN} bytes`);
    }
    const iv = blob.slice(MAGIC.length + 1, HEADER_LEN);
    const tag = blob.slice(blob.length - TAG_LEN);
    const ct = blob.slice(HEADER_LEN, blob.length - TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Build a streaming encryptor for piping a file/tar archive into a
 * provider's upload(). Emits `magic|version|iv` as the very first chunk
 * (so a partial upload can be inspected and identified), then the
 * streaming ciphertext, then the GCM auth tag at the end.
 *
 * Usage:
 *   const enc = encryptStream(key);
 *   readable.pipe(enc).pipe(remoteWriter);
 *
 * @param {Buffer} key
 * @returns {Transform}
 */
export function encryptStream(key) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
        throw new Error(`key must be ${KEY_LEN} bytes`);
    }
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let headerSent = false;
    return new Transform({
        transform(chunk, _enc, cb) {
            try {
                if (!headerSent) {
                    headerSent = true;
                    this.push(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
                }
                this.push(cipher.update(chunk));
                cb();
            } catch (e) { cb(e); }
        },
        flush(cb) {
            try {
                if (!headerSent) {
                    headerSent = true;
                    this.push(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
                }
                this.push(cipher.final());
                this.push(cipher.getAuthTag());
                cb();
            } catch (e) { cb(e); }
        },
    });
}

/**
 * Streaming decryptor — counterpart to `encryptStream`. Reads + verifies
 * the header, emits plaintext, and validates the auth tag at end-of-stream.
 *
 * The implementation buffers the *last* TAG_LEN bytes of every flush so
 * the final 16 bytes of the source stream can be split off as the auth
 * tag without the caller having to know the source length up front.
 *
 * @param {Buffer} key
 * @returns {Transform}
 */
export function decryptStream(key) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
        throw new Error(`key must be ${KEY_LEN} bytes`);
    }
    let headerBuf = Buffer.alloc(0);
    let decipher = null;
    let trailing = Buffer.alloc(0);
    return new Transform({
        transform(chunk, _enc, cb) {
            try {
                if (!decipher) {
                    headerBuf = Buffer.concat([headerBuf, chunk]);
                    if (headerBuf.length < HEADER_LEN) return cb();
                    if (!headerBuf.slice(0, MAGIC.length).equals(MAGIC)) {
                        return cb(new Error('not a TGDB blob (magic mismatch)'));
                    }
                    if (headerBuf[MAGIC.length] !== VERSION) {
                        return cb(new Error(`unsupported TGDB version ${headerBuf[MAGIC.length]}`));
                    }
                    const iv = headerBuf.slice(MAGIC.length + 1, HEADER_LEN);
                    decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
                    chunk = headerBuf.slice(HEADER_LEN);
                    headerBuf = null;
                    if (chunk.length === 0) return cb();
                }
                // Keep TAG_LEN bytes back so we can pull the auth tag out
                // when the source stream ends.
                const combined = Buffer.concat([trailing, chunk]);
                if (combined.length <= TAG_LEN) {
                    trailing = combined;
                    return cb();
                }
                const usable = combined.slice(0, combined.length - TAG_LEN);
                trailing = combined.slice(combined.length - TAG_LEN);
                this.push(decipher.update(usable));
                cb();
            } catch (e) { cb(e); }
        },
        flush(cb) {
            try {
                if (!decipher) return cb(new Error('TGDB header missing — stream too short'));
                if (trailing.length !== TAG_LEN) {
                    return cb(new Error('TGDB tag missing — truncated stream'));
                }
                decipher.setAuthTag(trailing);
                this.push(decipher.final());
                cb();
            } catch (e) { cb(e); }
        },
    });
}
