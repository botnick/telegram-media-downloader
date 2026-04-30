/* Telegram Media Downloader — Service Worker
 *
 * Strategy:
 *   - Pre-cache the static app shell on install so the dashboard opens
 *     instantly (and offline) once installed.
 *   - Network-first for navigation / HTML so deploys reflect on next load.
 *   - Cache-first for hashed/static assets (icons, locales, /js, /css) with
 *     a background revalidation.
 *   - Bypass everything dynamic / authenticated: /api, /files, /photos,
 *     /metrics, /ws and any non-GET request. We never want a stale auth
 *     check answer or stale media bytes served from cache.
 *   - skipWaiting + clients.claim so a new SW takes over immediately
 *     after a deploy without waiting for every tab to close.
 */

// Bump on every meaningful release. The activate handler clears any cache
// whose key doesn't match the current pair, so old shell + asset caches
// get evicted automatically when this string changes.
const VERSION = 'v39';
const SHELL_CACHE = `tgdl-shell-${VERSION}`;
const ASSET_CACHE = `tgdl-assets-${VERSION}`;

// Files that make up the "app shell" — small, stable, version-independent.
// Cached on install so the dashboard frame paints from cache.
const SHELL_URLS = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/icon-192-maskable.png',
    '/icons/icon-512-maskable.png',
    '/locales/en.json',
    '/locales/th.json',
];

// Paths that must NEVER be intercepted by the SW. These either need fresh
// auth state, return user media bytes, or are upgrade endpoints that
// shouldn't be cached or replayed.
const BYPASS_PREFIXES = [
    '/api/',
    '/files/',
    '/photos/',
    '/metrics',
    '/ws',
    '/login',
    '/setup-needed',
    '/add-account',
    // Share links carry HMAC-signed tokens that must hit the network on
    // every request — caching them would let revoked links keep serving
    // bytes from the SW, defeating the revoke flow.
    '/share/',
    // Thumbnails are content-addressed by (id, width); the browser HTTP
    // cache + Cache-Control: max-age=86400, immutable on the server is
    // enough. Caching them in the SW too would balloon the SW cache for
    // libraries with thousands of tiles for no real win.
    '/api/thumbs/',
];

function isBypass(url) {
    const p = url.pathname;
    return BYPASS_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

function isStaticAsset(url) {
    const p = url.pathname;
    return (
        p.startsWith('/js/') ||
        p.startsWith('/css/') ||
        p.startsWith('/locales/') ||
        p.startsWith('/icons/') ||
        p === '/manifest.webmanifest' ||
        p === '/favicon.ico'
    );
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then((cache) =>
            // addAll is atomic — if any fetch fails we leave the old SW in
            // place. Use individual `add` so a single 404 (e.g. th.json
            // missing on a stripped install) doesn't void the whole shell.
            Promise.all(
                SHELL_URLS.map((u) =>
                    cache.add(u).catch(() => {
                        /* swallow — best-effort precache */
                    })
                )
            )
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys
                    .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
                    .map((k) => caches.delete(k))
            );
            await self.clients.claim();
        })()
    );
});

// Allow the page to ping the SW to take over immediately after an update.
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Only handle GETs from same-origin. Everything else passes through to
    // the network unmodified (POST /api/login, WebSocket upgrade, CDN
    // requests for Tailwind/Remixicon, etc.).
    if (req.method !== 'GET') return;
    let url;
    try { url = new URL(req.url); } catch { return; }
    if (url.origin !== self.location.origin) return;

    if (isBypass(url)) return;

    // Navigation requests — network-first so a deploy reflects on next
    // navigation. Falls back to cached index.html when offline.
    if (req.mode === 'navigate' || req.destination === 'document') {
        event.respondWith(
            (async () => {
                try {
                    const fresh = await fetch(req);
                    // Stash a copy of the entry HTML so we can serve it
                    // offline next time.
                    if (fresh && fresh.ok) {
                        const cache = await caches.open(SHELL_CACHE);
                        cache.put('/index.html', fresh.clone()).catch(() => {});
                    }
                    return fresh;
                } catch {
                    const cache = await caches.open(SHELL_CACHE);
                    const cached = (await cache.match(req)) || (await cache.match('/index.html'));
                    return cached || Response.error();
                }
            })()
        );
        return;
    }

    // Hashed/static assets — cache-first with background revalidation.
    if (isStaticAsset(url)) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(ASSET_CACHE);
                const cached = await cache.match(req);
                const networkPromise = fetch(req)
                    .then((res) => {
                        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
                        return res;
                    })
                    .catch(() => cached || Response.error());
                return cached || networkPromise;
            })()
        );
    }
    // Anything else — let the network handle it.
});
