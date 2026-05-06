// Cache-Control assertions for the SPA's hot-path static assets.
//
// We don't boot the full server.js (it has a lot of side effects we'd
// have to stub: WS upgrade handler, monitor watchdog, etc.). Instead we
// re-create the *isolated* asset cache-policy middleware here using the
// same path-prefix logic that lives in server.js, then drive it with a
// stub req/res pair. If the production server.js drifts, this test
// drifts with it — keep both blocks aligned.

import { describe, it, expect } from 'vitest';

function applyCachePolicy(reqPath, query = {}) {
    // 1:1 copy of the live middleware in server.js — see line ~324.
    let cc = null;
    const setHeader = (k, v) => {
        if (k.toLowerCase() === 'cache-control') cc = v;
    };
    const res = { setHeader };
    const req = { path: reqPath, query };

    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
    } else if (req.path.startsWith('/photos/')) {
        res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
    } else if (req.path.startsWith('/files/')) {
        res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
    } else if (req.path === '/sw.js') {
        res.setHeader('Cache-Control', 'no-cache, max-age=0');
    } else if (
        req.path.startsWith('/js/') ||
        req.path.startsWith('/css/') ||
        req.path.startsWith('/icons/')
    ) {
        if (req.query && req.query.v) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    } else if (req.path.startsWith('/locales/')) {
        res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    }
    return cc;
}

describe('cache-control headers', () => {
    it('serves /css/main.css with 1y immutable when ?v= is present', () => {
        const cc = applyCachePolicy('/css/main.css', { v: '2.6.0' });
        expect(cc).toMatch(/immutable/);
        expect(cc).toMatch(/max-age=31536000/);
    });

    it('serves /js/app.js with 1y immutable when ?v= is present', () => {
        const cc = applyCachePolicy('/js/app.js', { v: '2.6.0' });
        expect(cc).toMatch(/immutable/);
        expect(cc).toMatch(/max-age=31536000/);
    });

    it('serves /icons/icon-192.png with 1y immutable when ?v= is present', () => {
        const cc = applyCachePolicy('/icons/icon-192.png', { v: '2.6.0' });
        expect(cc).toMatch(/immutable/);
        expect(cc).toMatch(/max-age=31536000/);
    });

    it('serves /api/* with no-store', () => {
        const cc = applyCachePolicy('/api/downloads/all', {});
        expect(cc).toMatch(/no-store/);
    });

    it('serves /sw.js with no-cache', () => {
        const cc = applyCachePolicy('/sw.js', {});
        expect(cc).toMatch(/no-cache/);
    });

    it('serves /locales/* with must-revalidate (translations evolve more often)', () => {
        const cc = applyCachePolicy('/locales/en.json', {});
        expect(cc).toMatch(/must-revalidate/);
    });

    it('serves /js/app.js with conservative 1h fallback when ?v= is missing', () => {
        const cc = applyCachePolicy('/js/app.js', {});
        expect(cc).not.toMatch(/immutable/);
        expect(cc).toMatch(/max-age=3600/);
    });

    it('serves /files/* with 30d immutable (downloads are content-addressed by name)', () => {
        const cc = applyCachePolicy('/files/group/images/foo.jpg', {});
        expect(cc).toMatch(/immutable/);
        expect(cc).toMatch(/max-age=2592000/);
    });
});
