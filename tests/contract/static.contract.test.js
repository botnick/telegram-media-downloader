// The SPA shell and assets (src/web/public stays as it is; the Go server
// must serve the same bytes, including the ?v=<version> cache-bust
// rewriting), PWA files, CHANGELOG, group avatars, /metrics and the
// version endpoints.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, SEED, useContract } from './harness.js';
import { REPO_ROOT } from './lib/inventory.js';

const h = useContract(import.meta.url);
const alphaAvatar = `/photos/${encodeURIComponent(SEED.groups.alpha.id)}.jpg`;

// SPA assets evolve independently of the backend, so their goldens don't
// pin bytes: the recorded fact is "the response is this file (after the
// documented ?v= rewrite)". The rewrite below is written from the rule,
// not copied from server.js:
//   HTML: src/href="/js|/locales|/css/<file>.(js|json|css)" gains ?v=<version>
//   JS:   relative `from './x.js'`, `import './x.js'`, `import('./x.js')`
//         specifiers gain ?v=<version>
const REWRITES = {
    html: (s) =>
        s.replace(
            /\b(src|href)="(\/(?:js|locales|css)\/[^"?]+\.(?:js|json|css))"/g,
            (_m, attr, url) => `${attr}="${url}?v=${APP_VERSION}"`,
        ),
    js: (s) =>
        s.replace(
            /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?]+\.js)\2/g,
            (_m, lead, q, spec) => `${lead}${q}${spec}?v=${APP_VERSION}${q}`,
        ),
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const lf = (b) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));

function asFile(res, rel, rewrite = null, { text = true, range = null } = {}) {
    let expected = fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')));
    if (text) expected = lf(expected);
    if (rewrite) expected = Buffer.from(REWRITES[rewrite](expected.toString('utf8')));
    if (range) expected = expected.subarray(range[0], range[1] + 1);
    const got = text ? lf(res.body) : res.body;
    const identical = got.equals(expected);
    return {
        sameAsFile: rel,
        ...(rewrite ? { rewrite } : {}),
        ...(range ? { range } : {}),
        identical,
        ...(identical ? {} : { gotSha256: sha(got), expectedSha256: sha(expected) }),
    };
}

async function fileExchange(t, label, urlPath, rel, rewrite = null, o = {}) {
    const res = await t.request('GET', urlPath, o);
    const req = { method: 'GET', path: urlPath, as: o.as ?? 'admin', headers: o.headers };
    const ok = res.status === 200 || res.status === 206;
    await t.record(label, req, res, ok ? { bodyRecord: asFile(res, rel, rewrite, o) } : {});
    return res;
}

// Prometheus text: families, types and label sets are the contract; sample
// values are process state (memory, uptime, counters of this run) and are
// replaced by their kind.
function prometheus(text) {
    return text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            if (line.startsWith('#')) return line;
            const m = /^([^\s{]+(?:\{[^}]*\})?)\s+(\S+)$/.exec(line);
            if (!m) return line;
            return `${m[1]} <${Number.isInteger(Number(m[2])) ? 'int' : 'float'}>`;
        });
}

const pub = (f) => `src/web/public/${f}`;

describe('SPA shell (cache-busting rewriter)', () => {
    it('serves the HTML entry points with ?v= rewritten asset URLs', async () => {
        const t = h.t;
        await fileExchange(t, 'GET / (admin)', '/', pub('index.html'), 'html');
        await fileExchange(t, 'GET /index.html (admin)', '/index.html', pub('index.html'), 'html');
        await t.exchange('HEAD / (admin)', 'HEAD', '/');
        await fileExchange(t, 'GET /login.html (anon)', '/login.html', pub('login.html'), 'html', {
            as: 'anon',
        });
        await fileExchange(
            t,
            'GET /setup-needed.html (anon)',
            '/setup-needed.html',
            pub('setup-needed.html'),
            'html',
            { as: 'anon' },
        );
        await fileExchange(
            t,
            'GET /add-account.html (admin)',
            '/add-account.html',
            pub('add-account.html'),
            'html',
        );
        await t.exchange('GET /add-account.html (anon) → login', 'GET', '/add-account.html', {
            as: 'anon',
        });
        await fileExchange(
            t,
            'GET /share-error.html (admin)',
            '/share-error.html',
            pub('share-error.html'),
        );
        await fileExchange(t, 'GET / (guest)', '/', pub('index.html'), 'html', { as: 'guest' });
    });

    it('serves JS modules with rewritten relative imports', async () => {
        const t = h.t;
        const js = pub('js/app.js');
        await fileExchange(t, 'GET /js/app.js (anon, bare)', '/js/app.js', js, 'js', {
            as: 'anon',
        });
        await fileExchange(
            t,
            'GET /js/app.js?v=<version> (immutable)',
            `/js/app.js?v=${APP_VERSION}`,
            js,
            'js',
            { as: 'anon' },
        );
        await fileExchange(t, 'GET /js/ws.js', '/js/ws.js', pub('js/ws.js'), 'js', { as: 'anon' });
        await t.exchange('GET /js/missing.js → 404', 'GET', '/js/does-not-exist.js', {
            as: 'anon',
        });
        await t.exchange('GET /js/../server.js traversal', 'GET', '/js/..%2f..%2fserver.js', {
            as: 'anon',
        });
    });

    it('serves CSS, locales and icons from express.static', async () => {
        const t = h.t;
        const css = await fileExchange(
            t,
            'GET /css/main.css',
            '/css/main.css',
            pub('css/main.css'),
            null,
            {
                as: 'anon',
            },
        );
        await t.exchange('GET /css/main.css If-None-Match → 304', 'GET', '/css/main.css', {
            as: 'anon',
            headers: { 'if-none-match': css.headers.etag },
        });
        await fileExchange(
            t,
            'GET /css/tailwind.css?v=<version>',
            `/css/tailwind.css?v=${APP_VERSION}`,
            pub('css/tailwind.css'),
            null,
            { as: 'anon' },
        );
        await fileExchange(
            t,
            'GET /locales/en.json',
            '/locales/en.json',
            pub('locales/en.json'),
            null,
            {
                as: 'anon',
            },
        );
        await fileExchange(
            t,
            'GET /locales/th.json',
            '/locales/th.json',
            pub('locales/th.json'),
            null,
            {
                as: 'anon',
            },
        );
        await fileExchange(
            t,
            'GET /icons/icon-192.png',
            '/icons/icon-192.png',
            pub('icons/icon-192.png'),
            null,
            {
                as: 'anon',
                text: false,
            },
        );
        await fileExchange(
            t,
            'GET /icons/icon-512-maskable.png range 0-15',
            '/icons/icon-512-maskable.png',
            pub('icons/icon-512-maskable.png'),
            null,
            { as: 'anon', text: false, headers: { range: 'bytes=0-15' }, range: [0, 15] },
        );
        await t.exchange('GET /favicon.ico (public prefix, no file) → 404', 'GET', '/favicon.ico', {
            as: 'anon',
        });
        await t.exchange('GET /icons/nope.png → 404', 'GET', '/icons/nope.png', { as: 'anon' });
    });
});

describe('PWA, changelog, avatars', () => {
    it('service worker and manifest are public with explicit headers', async () => {
        const t = h.t;
        await fileExchange(t, 'GET /sw.js (anon)', '/sw.js', pub('sw.js'), null, { as: 'anon' });
        await fileExchange(
            t,
            'GET /manifest.webmanifest (anon)',
            '/manifest.webmanifest',
            pub('manifest.webmanifest'),
            null,
            { as: 'anon' },
        );
    });

    it('CHANGELOG.md needs a session', async () => {
        const t = h.t;
        await fileExchange(t, 'GET /CHANGELOG.md (admin)', '/CHANGELOG.md', 'CHANGELOG.md');
        await fileExchange(t, 'GET /CHANGELOG.md (guest)', '/CHANGELOG.md', 'CHANGELOG.md', null, {
            as: 'guest',
        });
        await t.exchange('GET /CHANGELOG.md (anon) → login', 'GET', '/CHANGELOG.md', {
            as: 'anon',
        });
    });

    it('group avatars under /photos', async () => {
        const t = h.t;
        const a = await t.exchange('GET /photos/<alpha>.jpg (admin)', 'GET', alphaAvatar);
        await t.exchange('GET /photos/<alpha>.jpg If-None-Match → 304', 'GET', alphaAvatar, {
            headers: { 'if-none-match': a.headers.etag },
        });
        await t.exchange('GET /photos/<alpha>.jpg (guest)', 'GET', alphaAvatar, { as: 'guest' });
        await t.exchange('GET /photos/<alpha>.jpg (anon) → login', 'GET', alphaAvatar, {
            as: 'anon',
        });
        await t.exchange('GET /photos/unknown.jpg → 404', 'GET', '/photos/-1009999999999.jpg');
    });
});

describe('version and metrics', () => {
    it('version endpoints are public; the update check is offline-safe', async () => {
        const t = h.t;
        const ver = await t.exchange('GET /api/version (admin)', 'GET', '/api/version');
        expect(ver.json.version).toBe(APP_VERSION);
        t.store.record('GET /api/version reports the package.json version', {
            route: 'GET /api/version',
            versionEqualsPackageJson: ver.json.version === APP_VERSION,
        });
        await t.exchange('GET /api/version/check (anon, no network)', 'GET', '/api/version/check', {
            as: 'anon',
        });
        await t.exchange(
            'GET /api/version/check?force=1 (guest)',
            'GET',
            '/api/version/check?force=1',
            {
                as: 'guest',
            },
        );
        const v = await t.request('GET', '/api/version', { as: 'anon' });
        await t.exchange('GET /api/version If-None-Match → 304', 'GET', '/api/version', {
            as: 'anon',
            headers: { 'if-none-match': v.headers.etag },
        });
    });

    it('/metrics is a public Prometheus scrape', async () => {
        const t = h.t;
        const res = await t.request('GET', '/metrics', { as: 'anon' });
        await t.record(
            'GET /metrics (anon)',
            { method: 'GET', path: '/metrics', as: 'anon' },
            res,
            {
                bodyRecord: { metrics: prometheus(res.text) },
                note: 'sample values replaced by <int>/<float>',
            },
        );
    });

    it('/metrics with TGDL_METRICS_TOKEN requires ?token=', async () => {
        const t = await h.extra({ env: { TGDL_METRICS_TOKEN: 'scrape-secret' } });
        await t.exchange('GET /metrics without token → 401', 'GET', '/metrics', { as: 'anon' });
        await t.exchange('GET /metrics wrong token → 401', 'GET', '/metrics?token=nope', {
            as: 'anon',
        });
        const res = await t.request('GET', '/metrics?token=scrape-secret', { as: 'anon' });
        await t.record(
            'GET /metrics with token',
            { method: 'GET', path: '/metrics?token=scrape-secret', as: 'anon' },
            res,
            { bodyRecord: { metrics: prometheus(res.text) }, note: 'sample values replaced' },
        );
    });
});
