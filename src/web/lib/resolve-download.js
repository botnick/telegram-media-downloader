import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOADS_DIR = path.join(__dirname, '../../../data/downloads');

export async function safeResolveDownload(userPath) {
    if (typeof userPath !== 'string' || userPath.length === 0)
        return { ok: false, reason: 'forbidden' };
    if (userPath.includes('\0')) return { ok: false, reason: 'forbidden' };
    let normalized = path.normalize(userPath);
    // Tolerate the legacy `data/downloads/` prefix that was sneaking
    // into queue-history entries + some DB rows because downloader's
    // `buildPath()` defaulted to `'./data/downloads'` (relative form
    // was being stored verbatim instead of always-stripped). Without
    // this fix, the second `path.join(DOWNLOADS_DIR, …)` below would
    // double the prefix → `<root>/data/downloads/data/downloads/<…>`
    // → 404 for every cached preview link the SPA rendered.
    const dataDownloadsPrefix = 'data' + path.sep + 'downloads' + path.sep;
    while (normalized.startsWith(dataDownloadsPrefix)) {
        normalized = normalized.slice(dataDownloadsPrefix.length);
    }
    // Defensive: also strip the POSIX form when running on Windows
    // (path.normalize keeps forward slashes if they're already there
    // because that's what came over the URL).
    while (normalized.startsWith('data/downloads/')) {
        normalized = normalized.slice('data/downloads/'.length);
    }
    if (path.isAbsolute(normalized)) return { ok: false, reason: 'forbidden' };
    if (normalized.split(path.sep).includes('..')) return { ok: false, reason: 'forbidden' };
    const candidate = path.join(DOWNLOADS_DIR, normalized);
    const rootReal = await fs.realpath(DOWNLOADS_DIR).catch(() => path.resolve(DOWNLOADS_DIR));
    let real;
    try {
        real = await fs.realpath(candidate);
    } catch (e) {
        // ENOENT → genuinely missing (deleted / never written / DB drift).
        // Tell the caller so the route can return 404 instead of a
        // misleading 403 that makes users think it's a permission bug.
        return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : 'forbidden' };
    }
    if (!real.startsWith(rootReal + path.sep) && real !== rootReal) {
        return { ok: false, reason: 'forbidden' };
    }
    return { ok: true, real };
}
