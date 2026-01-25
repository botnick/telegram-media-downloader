import crypto from 'crypto';

/**
 * Rate Limiter - ป้องกัน Account Ban
 */
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
 * Session Encryption - AES-256-GCM
 */
export class SecureSession {
    constructor(password) {
        this.key = crypto.scryptSync(password, 'tg-dl-salt-v1', 32);
    }

    encrypt(data) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([
            cipher.update(data, 'utf8'),
            cipher.final()
        ]);
        return {
            v: 1,
            iv: iv.toString('hex'),
            data: encrypted.toString('hex'),
            tag: cipher.getAuthTag().toString('hex')
        };
    }

    decrypt(obj) {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            this.key,
            Buffer.from(obj.iv, 'hex')
        );
        decipher.setAuthTag(Buffer.from(obj.tag, 'hex'));
        return Buffer.concat([
            decipher.update(Buffer.from(obj.data, 'hex')),
            decipher.final()
        ]).toString('utf8');
    }
}
