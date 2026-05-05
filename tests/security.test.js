import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import { SecureSession, RateLimiter } from '@tgdl/core/security';

describe('SecureSession', () => {
    const password = 'a-secret-with-decent-entropy-aaaaa';

    it('round-trips v=2 blobs', () => {
        const s = new SecureSession(password);
        const enc = s.encrypt('hello');
        expect(enc.v).toBe(2);
        expect(enc.salt).toBeTruthy();
        expect(s.decrypt(enc)).toBe('hello');
    });

    it('decrypts legacy v=1 blobs', () => {
        const legacyKey = crypto.scryptSync(password, 'tg-dl-salt-v1', 32);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
        const data = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const blob = { v: 1, iv: iv.toString('hex'), data: data.toString('hex'), tag: tag.toString('hex') };

        const s = new SecureSession(password);
        expect(s.decrypt(blob)).toBe('legacy');
    });

    it('throws on a tampered tag', () => {
        const s = new SecureSession(password);
        const enc = s.encrypt('hello');
        expect(() => s.decrypt({ ...enc, tag: '00'.repeat(16) })).toThrow();
    });

    it('throws on a swapped salt', () => {
        const s = new SecureSession(password);
        const enc = s.encrypt('hello');
        expect(() => s.decrypt({ ...enc, salt: '00'.repeat(16) })).toThrow();
    });
});

describe('RateLimiter', () => {
    it('allows requests under the limit', async () => {
        // The constructor falls back to 500-2000ms human-like jitter when the
        // explicit delay is 0 (treated as falsy), so 5 acquires take a few
        // seconds. Bump the timeout to comfortably exceed the upper bound.
        const rl = new RateLimiter({ requestsPerMinute: 60, delayMs: { min: 1, max: 1 } });
        for (let i = 0; i < 5; i++) {
            await rl.acquire();
        }
        expect(rl.requests.length).toBe(5);
    }, 15000);

    it('emits a flood event with the requested seconds', async () => {
        const rl = new RateLimiter({ requestsPerMinute: 60 });
        const onFlood = vi.fn();
        rl.on('flood', onFlood);
        // Don't actually wait the (3+5)*1000 ms here; just verify the event.
        const p = rl.pauseForFloodWait(3);
        // Give the synchronous part a tick to emit before we resolve the promise.
        await new Promise((r) => setImmediate(r));
        expect(onFlood).toHaveBeenCalledWith(3);
        // Force-unblock by short-circuiting the timer (rl.paused=false manually).
        rl.paused = false;
        await p;
    }, 30000);
});
