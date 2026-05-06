import { describe, it, expect } from 'vitest';
import { buildProxy, describeProxy } from '../src/core/proxy.js';

describe('buildProxy', () => {
    it('returns null when nothing is configured', () => {
        expect(buildProxy({})).toBe(null);
        expect(buildProxy({ proxy: { host: 'h' } })).toBe(null); // missing port
    });

    it('maps SOCKS5 with credentials', () => {
        const p = buildProxy({
            proxy: { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' },
        });
        expect(p).toEqual({
            ip: '1.2.3.4',
            port: 1080,
            socksType: 5,
            username: 'u',
            password: 'p',
        });
    });

    it('maps SOCKS4', () => {
        const p = buildProxy({ proxy: { type: 'socks4', host: 'h', port: 9050 } });
        expect(p).toEqual({ ip: 'h', port: 9050, socksType: 4 });
    });

    it('maps MTProxy + secret', () => {
        const p = buildProxy({ proxy: { type: 'mtproxy', host: 'h', port: 443, secret: 'abc' } });
        expect(p).toEqual({ ip: 'h', port: 443, MTProxy: true, secret: 'abc' });
    });

    it('throws on MTProxy without secret', () => {
        expect(() => buildProxy({ proxy: { type: 'mtproxy', host: 'h', port: 443 } })).toThrow();
    });

    it('rejects unsupported HTTP proxy explicitly', () => {
        expect(() => buildProxy({ proxy: { type: 'http', host: 'h', port: 8080 } })).toThrow(
            /HTTP proxy/,
        );
    });

    it('rejects out-of-range ports', () => {
        expect(buildProxy({ proxy: { type: 'socks5', host: 'h', port: 0 } })).toBe(null);
        expect(buildProxy({ proxy: { type: 'socks5', host: 'h', port: 99999 } })).toBe(null);
    });
});

describe('describeProxy', () => {
    it('renders a human-readable label', () => {
        expect(describeProxy({ proxy: { type: 'socks5', host: 'h', port: 1 } })).toBe('SOCKS5 h:1');
        expect(describeProxy({})).toBe('none');
    });
});
