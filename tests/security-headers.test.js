import { describe, it, expect } from 'vitest';
import { buildSecurityHeaders, validateCsp } from '../src/web/lib/security-headers.js';
import { getDefaultCsp } from '../src/config/manager.js';

// Exact header helmet produced before CSP became configurable.
const LEGACY =
    "default-src 'self';base-uri 'self';font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net;form-action 'self';frame-ancestors 'self';img-src 'self' data: blob:;object-src 'none';script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;script-src-attr 'unsafe-inline';style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com;style-src-attr 'unsafe-inline';media-src 'self' blob:;connect-src 'self' ws: wss:;frame-src 'self'";

const env = {};

describe('buildSecurityHeaders', () => {
    it('default (no web.csp) is byte-identical to the legacy header', () => {
        const r = buildSecurityHeaders({}, { env });
        expect(r.csp).toEqual({ name: 'Content-Security-Policy', value: LEGACY });
        expect(r.xFrameOptions).toBe('SAMEORIGIN');
    });

    it('a partial directives object keeps the other defaults; [] removes one', () => {
        const partial = buildSecurityHeaders(
            { web: { csp: { directives: { 'img-src': ["'self'", 'https://i.example'] } } } },
            { env },
        );
        expect(partial.csp.value).toContain("object-src 'none'");
        expect(partial.csp.value).toContain("img-src 'self' https://i.example");
        expect(partial.xFrameOptions).toBe('SAMEORIGIN');
        const removed = buildSecurityHeaders(
            { web: { csp: { directives: { 'frame-src': [] } } } },
            { env },
        );
        expect(removed.csp.value).not.toContain('frame-src');
    });

    it('explicit defaults produce the same header', () => {
        const r = buildSecurityHeaders({ web: { csp: getDefaultCsp() } }, { env });
        expect(r.csp.value).toBe(LEGACY);
        expect(r.xFrameOptions).toBe('SAMEORIGIN');
    });

    it('disabled -> no CSP header', () => {
        const r = buildSecurityHeaders({ web: { csp: { enabled: false } } }, { env });
        expect(r.csp).toBeNull();
    });

    it('reportOnly switches the header name only', () => {
        const csp = { ...getDefaultCsp(), reportOnly: true };
        const r = buildSecurityHeaders({ web: { csp } }, { env });
        expect(r.csp.name).toBe('Content-Security-Policy-Report-Only');
        expect(r.csp.value).toBe(LEGACY);
    });

    it('edited directive appears; frame-ancestors change drops X-Frame-Options', () => {
        const csp = getDefaultCsp();
        csp.directives['img-src'].push('https://img.example.com');
        let r = buildSecurityHeaders({ web: { csp } }, { env });
        expect(r.csp.value).toContain("img-src 'self' data: blob: https://img.example.com;");
        expect(r.xFrameOptions).toBe('SAMEORIGIN');

        const csp2 = getDefaultCsp();
        csp2.directives['frame-ancestors'].push('https://portal.example.com');
        r = buildSecurityHeaders({ web: { csp: csp2 } }, { env });
        expect(r.csp.value).toContain("frame-ancestors 'self' https://portal.example.com;");
        expect(r.xFrameOptions).toBeNull();
    });

    it('forceHttps + secure appends upgrade-insecure-requests once', () => {
        const cfg = { web: { forceHttps: true } };
        expect(buildSecurityHeaders(cfg, { secure: true, env }).csp.value).toBe(
            `${LEGACY};upgrade-insecure-requests`,
        );
        expect(buildSecurityHeaders(cfg, { secure: false, env }).csp.value).toBe(LEGACY);
    });

    it('TGDL_CSP=off wins over config', () => {
        const r = buildSecurityHeaders({}, { env: { TGDL_CSP: 'off' } });
        expect(r.csp).toBeNull();
        expect(r.xFrameOptions).toBe('SAMEORIGIN');
    });
});

describe('validateCsp', () => {
    it('accepts keywords, trims, dedupes', () => {
        const v = validateCsp({
            directives: { 'script-src': ["'self'", ' https://a.example ', "'self'", ''] },
        });
        expect(v.ok).toBe(true);
        expect(v.value.directives['script-src']).toEqual(["'self'", 'https://a.example']);
        expect(v.value.enabled).toBe(true);
    });

    it.each([
        ['semicolon', 'https://a.example; script-src *'],
        ['comma', 'https://a.example,https://b.example'],
        ['newline', 'https://a.example\nscript-src *'],
        ['CR', 'https://a.example\rX'],
        ['NUL', 'a\u0000b'],
    ])('rejects %s in a source', (_n, src) => {
        const v = validateCsp({ directives: { 'img-src': [src] } });
        expect(v.ok).toBe(false);
    });

    it('rejects bad shapes and directive names', () => {
        expect(validateCsp(null).ok).toBe(false);
        expect(validateCsp({ directives: { 'img-src': 'x' } }).ok).toBe(false);
        expect(validateCsp({ directives: { 'Bad Name': [] } }).ok).toBe(false);
    });
});
