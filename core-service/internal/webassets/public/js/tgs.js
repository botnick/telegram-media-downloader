// Animated Telegram stickers (.tgs) — gzip-compressed Lottie JSON.
//
// The server has no Lottie renderer, so these never get a WebP thumbnail;
// the gallery tile and the viewer draw them in the browser instead. 2.x
// saved animated stickers under a `.webp` name, so callers probe by content
// (the gzip magic), never by extension.
//
// The player is loaded on first use from cdnjs, the same way the text
// viewer loads highlight.js. The "light" build has no expression support,
// so it never evaluates code from the sticker file.

const LOTTIE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie_light.min.js';
// Telegram caps .tgs at 64 KB; anything far beyond is not a sticker.
const MAX_TGS_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

let _lottieReady = null;

function ensureLottie() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (_lottieReady) return _lottieReady;
    _lottieReady = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LOTTIE_CDN;
        s.async = true;
        s.onload = () => (window.lottie ? resolve(window.lottie) : reject(new Error('no lottie')));
        s.onerror = () => reject(new Error(`Failed to load ${LOTTIE_CDN}`));
        document.head.appendChild(s);
    }).catch((e) => {
        _lottieReady = null;
        throw e;
    });
    return _lottieReady;
}

async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_JSON_BYTES) {
            await reader.cancel();
            throw new Error('sticker too large');
        }
        chunks.push(value);
    }
    return new Blob(chunks).text();
}

// Animation data per URL, so a tile re-rendered by the virtual grid and the
// viewer opening the same sticker do not download it again. null = not a
// sticker (remembered too, so a broken image is probed once).
const _cache = new Map();
const CACHE_MAX = 200;

async function loadTgs(url) {
    if (_cache.has(url)) return _cache.get(url);
    const pending = (async () => {
        if (typeof DecompressionStream !== 'function') return null;
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) return null;
        const length = Number(r.headers.get('Content-Length') || 0);
        if (length > MAX_TGS_BYTES) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length < 3 || bytes.length > MAX_TGS_BYTES) return null;
        if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
        const data = JSON.parse(await gunzip(bytes));
        if (!data || !Array.isArray(data.layers)) return null;
        return data;
    })().catch(() => null);
    if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
    _cache.set(url, pending);
    return pending;
}

/**
 * Draw the animated sticker at `url` into `container`.
 * Resolves to the Lottie animation (call `.destroy()` to remove it), or to
 * null when the file is not an animated sticker or the player is unavailable.
 * `stale()` lets the caller drop a result that arrived after the container
 * was reused for something else.
 */
export async function mountTgs(container, url, { autoplay = true, loop = true, stale } = {}) {
    try {
        const data = await loadTgs(url);
        if (!data) return null;
        const lottie = await ensureLottie();
        if (!container.isConnected || (stale && stale())) return null;
        return lottie.loadAnimation({
            container,
            renderer: 'svg',
            loop,
            autoplay,
            // The player mutates its input while preparing it.
            animationData: structuredClone(data),
            rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
        });
    } catch {
        return null;
    }
}
