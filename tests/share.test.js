import { describe, it, expect, beforeEach } from 'vitest';
import {
    ensureShareSecret, _resetShareSecretCache,
    signShareToken, verifyShareToken, buildShareUrlPath,
    clampTtlSeconds, maskSigInLog,
    TTL_MIN_SEC, TTL_MAX_SEC, TTL_DEFAULT_SEC, TTL_NEVER,
    getShareSecretFingerprint,
} from '../src/core/share.js';

function freshSecretConfig() {
    const cfg = { web: {} };
    ensureShareSecret(cfg);
    return cfg;
}

describe('ensureShareSecret', () => {
    beforeEach(() => _resetShareSecretCache());

    it('generates and persists a 64-char hex secret on first call', () => {
        const cfg = { web: {} };
        const { secret, generated } = ensureShareSecret(cfg);
        expect(generated).toBe(true);
        expect(secret).toMatch(/^[0-9a-f]{64}$/);
        expect(cfg.web.shareSecret).toBe(secret);
    });

    it('keeps an existing valid secret untouched', () => {
        const seed = 'a'.repeat(64);
        const cfg = { web: { shareSecret: seed } };
        const { secret, generated } = ensureShareSecret(cfg);
        expect(generated).toBe(false);
        expect(secret).toBe(seed);
    });

    it('regenerates when stored value is malformed', () => {
        const cfg = { web: { shareSecret: 'not-hex' } };
        const { generated, secret } = ensureShareSecret(cfg);
        expect(generated).toBe(true);
        expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('exposes a short fingerprint for log lines, never the full secret', () => {
        const cfg = { web: { shareSecret: '0123456789abcdef'.repeat(4) } };
        ensureShareSecret(cfg);
        expect(getShareSecretFingerprint()).toBe('01234567');
    });
});

describe('signShareToken / verifyShareToken', () => {
    beforeEach(() => { _resetShareSecretCache(); freshSecretConfig(); });

    it('round-trips a freshly signed token', () => {
        const sig = signShareToken(42, 1750000000);
        expect(verifyShareToken(42, 1750000000, sig)).toBe(true);
    });

    it('produces a base64url SHA-256 digest (43 chars, no padding)', () => {
        const sig = signShareToken(1, 1234567890);
        expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('rejects a tampered linkId', () => {
        const sig = signShareToken(42, 1750000000);
        expect(verifyShareToken(43, 1750000000, sig)).toBe(false);
    });

    it('rejects a tampered exp', () => {
        const sig = signShareToken(42, 1750000000);
        expect(verifyShareToken(42, 1750000001, sig)).toBe(false);
    });

    it('rejects a tampered sig', () => {
        const sig = signShareToken(42, 1750000000);
        const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
        expect(verifyShareToken(42, 1750000000, flipped)).toBe(false);
    });

    it('rejects empty / short / non-base64url sigs without throwing', () => {
        expect(verifyShareToken(42, 1750000000, '')).toBe(false);
        expect(verifyShareToken(42, 1750000000, 'short')).toBe(false);
        expect(verifyShareToken(42, 1750000000, 'A B C !!')).toBe(false);
        expect(verifyShareToken(42, 1750000000, null)).toBe(false);
        expect(verifyShareToken(42, 1750000000, undefined)).toBe(false);
    });

    it('signature changes when the secret rotates', () => {
        const sigA = signShareToken(42, 1750000000);
        // Force a fresh secret.
        _resetShareSecretCache();
        ensureShareSecret({ web: { shareSecret: 'b'.repeat(64) } });
        const sigB = signShareToken(42, 1750000000);
        expect(sigA).not.toBe(sigB);
        // And the OLD sig no longer verifies under the new secret.
        expect(verifyShareToken(42, 1750000000, sigA)).toBe(false);
    });
});

describe('buildShareUrlPath', () => {
    beforeEach(() => { _resetShareSecretCache(); freshSecretConfig(); });

    it('formats /share/<id>?exp=<n>&sig=<…>', () => {
        const url = buildShareUrlPath(42, 1750000000);
        expect(url).toMatch(/^\/share\/42\?exp=1750000000&sig=[A-Za-z0-9_\-%]+$/);
    });

    it('embeds exp=0 verbatim for never-expires links', () => {
        const url = buildShareUrlPath(7, 0);
        expect(url.startsWith('/share/7?exp=0&sig=')).toBe(true);
    });
});

describe('clampTtlSeconds', () => {
    it('returns the default for missing / non-numeric input', () => {
        expect(clampTtlSeconds(undefined)).toBe(TTL_DEFAULT_SEC);
        expect(clampTtlSeconds(null)).toBe(TTL_DEFAULT_SEC);
        expect(clampTtlSeconds(NaN)).toBe(TTL_DEFAULT_SEC);
        expect(clampTtlSeconds('abc')).toBe(TTL_DEFAULT_SEC);
    });

    it('clamps below the floor', () => {
        expect(clampTtlSeconds(1)).toBe(TTL_MIN_SEC);
        expect(clampTtlSeconds(59)).toBe(TTL_MIN_SEC);
        expect(clampTtlSeconds(60)).toBe(60);
    });

    it('clamps above the ceiling', () => {
        expect(clampTtlSeconds(TTL_MAX_SEC + 1)).toBe(TTL_MAX_SEC);
        expect(clampTtlSeconds(10 * 365 * 86400)).toBe(TTL_MAX_SEC);
    });

    it('passes valid values through (floored)', () => {
        expect(clampTtlSeconds(3600)).toBe(3600);
        expect(clampTtlSeconds(3600.9)).toBe(3600);
    });

    it('preserves the explicit "never expires" sentinel (0)', () => {
        expect(clampTtlSeconds(0)).toBe(TTL_NEVER);
        expect(clampTtlSeconds('0')).toBe(TTL_NEVER);
        expect(TTL_NEVER).toBe(0);
    });
});

describe('maskSigInLog', () => {
    it('truncates sig= to first 8 chars + ellipsis', () => {
        const url = '/share/1?exp=2&sig=ABCDEFGHabcdefghIJKLMNOPijklmnop';
        expect(maskSigInLog(url)).toBe('/share/1?exp=2&sig=ABCDEFGH…');
    });

    it('handles multiple sig= occurrences', () => {
        const s = 'GET /share/1?exp=2&sig=AAAAAAAAxxxx ; ref /share/2?exp=3&sig=BBBBBBBByyy';
        const masked = maskSigInLog(s);
        expect(masked).toContain('sig=AAAAAAAA…');
        expect(masked).toContain('sig=BBBBBBBB…');
        expect(masked).not.toContain('xxxx');
        expect(masked).not.toContain('yyy');
    });

    it('passes non-string input through', () => {
        expect(maskSigInLog(null)).toBe(null);
        expect(maskSigInLog(123)).toBe(123);
    });
});
