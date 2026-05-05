// Provider credential storage.
//
// Provider configs (S3 keys, SFTP private keys, FTP passwords, etc.)
// must NOT live as plaintext on disk — anyone with `data/db.sqlite` in
// hand could otherwise lift every credential. We derive an AES-256 KEK
// from `config.web.shareSecret` (already used by the share-link HMAC
// path) via PBKDF2-SHA256 and encrypt each provider config blob with
// AES-256-GCM before writing it to `backup_destinations.config_blob`.
//
// Rotation caveat: rotating shareSecret invalidates every existing
// destination blob — manager.js surfaces "credentials no longer
// decryptable, please re-enter" instead of crashing.
//
// File-format-on-DB:
//   magic(4)='TGDC' | version(1)=1 | iv(12) | ciphertext | tag(16)
//
// Different magic from the upload payload (`TGDB`) so the two formats
// can never be confused on inspection — a credentials blob accidentally
// shipped to the remote (or vice-versa) fails the magic check up front
// instead of producing garbled bytes.

import crypto from 'crypto';

const MAGIC = Buffer.from('TGDC', 'utf8');
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + IV_LEN; // 17 bytes
const KEY_LEN = 32;
const PBKDF2_ITER = 200_000;

// The KEK derivation salt is fixed (not random per blob) so the same
// shareSecret always yields the same KEK — required so a server restart
// can read back its own credential blobs without a prompt. The salt is
// a constant byte string ("tgdl-cred-v1") padded out to 16 bytes; this
// is fine because the *secret* is the random shareSecret, not the salt.
const KEK_SALT = Buffer.concat([
    Buffer.from('tgdl-cred-v1', 'utf8'),
    Buffer.alloc(16 - Buffer.from('tgdl-cred-v1', 'utf8').length),
]);

/**
 * Derive the AES-256 KEK from `config.web.shareSecret` (a hex string).
 *
 * @param {string} shareSecret  config.web.shareSecret — the same hex
 *                              value that signs share-link URLs
 * @returns {Buffer} 32-byte key
 */
export function deriveKek(shareSecret) {
    if (typeof shareSecret !== 'string' || !/^[0-9a-f]{64}$/i.test(shareSecret)) {
        throw new Error('shareSecret must be a 64-char hex string (config.web.shareSecret)');
    }
    return crypto.pbkdf2Sync(
        Buffer.from(shareSecret, 'hex'),
        KEK_SALT,
        PBKDF2_ITER,
        KEY_LEN,
        'sha256',
    );
}

/**
 * Encrypt a JSON-serialisable provider config object for storage in
 * `backup_destinations.config_blob`. Returns a Buffer suitable for
 * binding to a SQLite BLOB column.
 *
 * @param {object} config       arbitrary provider config
 * @param {string} shareSecret  hex shareSecret from config.web
 * @returns {Buffer}
 */
export function encryptConfig(config, shareSecret) {
    const json = JSON.stringify(config ?? {});
    const key = deriveKek(shareSecret);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, ct, tag]);
}

/**
 * Decrypt a `encryptConfig` blob and parse it back to an object.
 * Throws on magic / version / tag mismatch — callers should treat that
 * as "shareSecret rotated or credentials blob corrupted, please re-enter".
 *
 * @param {Buffer} blob
 * @param {string} shareSecret
 * @returns {object}
 */
export function decryptConfig(blob, shareSecret) {
    if (!Buffer.isBuffer(blob) || blob.length < HEADER_LEN + TAG_LEN) {
        throw new Error('credentials blob too short');
    }
    if (!blob.slice(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('not a TGDC blob (magic mismatch — credentials format changed?)');
    }
    const ver = blob[MAGIC.length];
    if (ver !== VERSION) {
        throw new Error(`unsupported TGDC version ${ver}`);
    }
    const key = deriveKek(shareSecret);
    const iv = blob.slice(MAGIC.length + 1, HEADER_LEN);
    const tag = blob.slice(blob.length - TAG_LEN);
    const ct = blob.slice(HEADER_LEN, blob.length - TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const buf = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(buf.toString('utf8'));
}

/**
 * Heuristic: returns true iff `blob` has the TGDC magic. Useful when
 * upgrading existing rows whose config_blob was written in a different
 * format — falls through to "needs re-entry" instead of crashing.
 */
export function looksLikeCredentialsBlob(blob) {
    return Buffer.isBuffer(blob)
        && blob.length >= MAGIC.length
        && blob.slice(0, MAGIC.length).equals(MAGIC);
}
