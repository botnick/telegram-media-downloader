import crypto from 'crypto';
import { EventEmitter } from 'events';

/**
 * Rate Limiter - ป้องกัน Account Ban
 */
export class RateLimiter extends EventEmitter {
    constructor(config = {}) {
        super();
        this.maxPerMinute = config.requestsPerMinute || 15;
        this.delayMin = config.delayMs?.min || 500;
        this.delayMax = config.delayMs?.max || 2000;
        this.requests = [];
        this.paused = false;
    }

    async acquire() {
        while (this.paused) {
            await this.sleep(1000);
        }

        const now = Date.now();
        this.requests = this.requests.filter(t => now - t < 60000);

        if (this.requests.length >= this.maxPerMinute) {
            const waitTime = 60000 - (now - this.requests[0]) + 1000;
            // Emit event instead of printing directly
            this.emit('wait', Math.ceil(waitTime/1000));
            await this.sleep(1000); 
            return this.acquire();
        }

        const delay = this.delayMin + Math.random() * (this.delayMax - this.delayMin);
        await this.sleep(delay);
        
        this.requests.push(Date.now());
        return true;
    }

    async pauseForFloodWait(seconds) {
        this.paused = true;
        this.emit('flood', seconds); // Emit flood wait event
        await this.sleep((seconds + 5) * 1000);
        this.paused = false;
    }

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}

/**
 * Session Encryption — AES-256-GCM with per-blob random salt for the scrypt
 * key derivation.
 *
 * Wire format:
 *   v=2 (new):  { v: 2, salt, iv, data, tag }   ← random salt per blob
 *   v=1 (old):  { v: 1, iv, data, tag }          ← hardcoded salt 'tg-dl-salt-v1'
 *   undefined:  treated as v=1
 *
 * Decrypting still accepts v=1 so existing on-disk session files continue to
 * load. Anything we write goes out as v=2.
 */
const LEGACY_SALT = Buffer.from('tg-dl-salt-v1');
const KEY_LEN = 32; // AES-256

export class SecureSession {
    constructor(password) {
        this.password = String(password);
        // Cache derived keys so we don't pay scrypt cost on every encrypt.
        // Keyed by salt-hex; bounded to a few entries.
        this._keyCache = new Map();
    }

    _deriveKey(salt) {
        const k = salt.toString('hex');
        let key = this._keyCache.get(k);
        if (!key) {
            key = crypto.scryptSync(this.password, salt, KEY_LEN);
            // keep the cache small
            if (this._keyCache.size > 4) this._keyCache.clear();
            this._keyCache.set(k, key);
        }
        return key;
    }

    encrypt(data) {
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(16);
        const key = this._deriveKey(salt);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([
            cipher.update(data, 'utf8'),
            cipher.final(),
        ]);
        return {
            v: 2,
            salt: salt.toString('hex'),
            iv: iv.toString('hex'),
            data: encrypted.toString('hex'),
            tag: cipher.getAuthTag().toString('hex'),
        };
    }

    decrypt(obj) {
        const version = obj.v || 1;
        const salt = version >= 2 && obj.salt
            ? Buffer.from(obj.salt, 'hex')
            : LEGACY_SALT;
        const key = this._deriveKey(salt);
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(obj.iv, 'hex'),
        );
        decipher.setAuthTag(Buffer.from(obj.tag, 'hex'));
        return Buffer.concat([
            decipher.update(Buffer.from(obj.data, 'hex')),
            decipher.final(),
        ]).toString('utf8');
    }
}
