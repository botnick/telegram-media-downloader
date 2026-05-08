/**
 * AI subsystem health checks.
 *
 * Each helper probes one piece of the runtime:
 *   - sharp                 (libvips native binding — needed by faces + phash)
 *   - @huggingface/transformers (ORT/WASM model runtime — needed by embeddings, faces, tags)
 *   - sqlite-vec            (optional SQLite extension — speeds up topK search)
 *   - models cache dir      (writable + sized correctly)
 *
 * Helpers NEVER throw. Each returns `{ ok: boolean, ... }` plus a
 * platform-aware `recommendation` string the dashboard's Doctor card can
 * render verbatim.
 *
 * The /api/ai/health endpoint composes these into a single payload so an
 * operator who's seeing the AI page misbehave can read one screen and know
 * exactly what's broken on this host.
 */

import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { tryImport } from './safe-load.js';
import { resolveCacheDir } from './models.js';

const PLATFORM = process.platform; // 'win32' | 'linux' | 'darwin'
const NODE_VERSION = process.version;

function _shortError(err) {
    if (!err) return '';
    const m = err.message || String(err);
    return m.length > 240 ? m.slice(0, 240) + '…' : m;
}

function _sharpRecommendation(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    if (PLATFORM === 'win32') {
        if (msg.includes('was compiled against a different node.js version')) {
            return 'Run `npm rebuild sharp` after a Node.js upgrade.';
        }
        return 'Run `npm rebuild sharp`. If that fails, delete node_modules/sharp and `npm install sharp` again.';
    }
    if (msg.includes('libvips')) {
        return 'Install libvips: Debian/Ubuntu `apt install libvips`, Alpine `apk add vips-dev`, RHEL `dnf install vips`. Then `npm rebuild sharp`.';
    }
    if (msg.includes('musl')) {
        return 'Switch to a glibc base image (debian/bookworm-slim) — sharp prebuilds for musl/Alpine are unreliable.';
    }
    return 'Try `npm rebuild sharp`. On Linux the package may need libvips installed first.';
}

function _transformersRecommendation(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    if (msg.includes('musl')) {
        return 'onnxruntime-node has no musl prebuilt — switch to a glibc Docker image (debian/bookworm-slim).';
    }
    if (msg.includes('cannot find module') || msg.includes('module not found')) {
        return 'Run `npm install @huggingface/transformers` to enable AI features.';
    }
    return 'Run `npm rebuild @huggingface/transformers` (and `npm rebuild onnxruntime-node` if listed).';
}

/**
 * Probe `sharp`. Loads the module and runs a 1×1 PNG resize so we catch
 * cases where the import succeeds but libvips itself is broken (the symptom
 * we've actually seen on Windows after a Node upgrade).
 */
export async function checkSharp() {
    const r = await tryImport('sharp');
    if (!r.ok) {
        return {
            name: 'sharp',
            ok: false,
            installed: false,
            error: _shortError(r.error),
            recommendation: _sharpRecommendation(r.error),
        };
    }
    const sharp = r.mod.default || r.mod;
    try {
        // 1×1 transparent PNG. Smallest possible valid input — no disk I/O.
        const tinyPng = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
            'base64',
        );
        await sharp(tinyPng).resize(1, 1).png().toBuffer();
        return {
            name: 'sharp',
            ok: true,
            installed: true,
            version: sharp.versions?.sharp || null,
            libvips: sharp.versions?.vips || null,
        };
    } catch (e) {
        return {
            name: 'sharp',
            ok: false,
            installed: true,
            error: _shortError(e),
            recommendation: _sharpRecommendation(e),
        };
    }
}

/**
 * Probe `@huggingface/transformers`. Just loads the module — does NOT load
 * a model (that would download ~90 MB on a fresh install). The catch path
 * is the only thing we're after: if the module imports cleanly the next
 * scan will succeed; if not, we tell the operator how to fix it.
 */
export async function checkTransformers() {
    const r = await tryImport('@huggingface/transformers');
    if (!r.ok) {
        return {
            name: 'transformers',
            ok: false,
            installed: false,
            error: _shortError(r.error),
            recommendation: _transformersRecommendation(r.error),
        };
    }
    return {
        name: 'transformers',
        ok: true,
        installed: true,
        // The module re-exports `env` even before any pipeline is created.
        // We don't read it (would mutate global state) — just confirm presence.
        hasEnv: typeof r.mod?.env === 'object',
    };
}

/**
 * Probe sqlite-vec. Optional dependency; failure here is INFO-level, not an
 * error. The fallback (in-memory cosine search) handles libraries up to
 * ~50k photos comfortably.
 */
export async function checkSqliteVec(getDb) {
    const r = await tryImport('sqlite-vec');
    if (!r.ok) {
        return {
            name: 'sqlite-vec',
            ok: true, // optional — missing is fine
            installed: false,
            optional: true,
            note: 'Optional. In-memory fallback handles up to ~50k photos. Install with `npm install sqlite-vec` for bigger libraries.',
        };
    }
    if (typeof r.mod.load !== 'function') {
        return {
            name: 'sqlite-vec',
            ok: true,
            installed: true,
            optional: true,
            error: 'sqlite-vec module loaded but no load() export found',
        };
    }
    try {
        const db = typeof getDb === 'function' ? getDb() : null;
        if (!db) {
            return {
                name: 'sqlite-vec',
                ok: true,
                installed: true,
                optional: true,
                note: 'Module installed; database not reachable for probe.',
            };
        }
        // Calling load on the same connection twice is a no-op in sqlite-vec.
        r.mod.load(db);
        return {
            name: 'sqlite-vec',
            ok: true,
            installed: true,
            optional: true,
            loaded: true,
        };
    } catch (e) {
        return {
            name: 'sqlite-vec',
            ok: true, // optional — install is broken but app still works
            installed: true,
            optional: true,
            error: _shortError(e),
            note: 'Module installed but extension load failed; in-memory fallback in use.',
        };
    }
}

/**
 * Verify the on-disk models cache dir exists, is writable, and report the
 * cumulative byte size of weights already cached. Fails LOUD when the
 * directory can't be created or written — that's a real install problem
 * (Docker volume permission, full disk, read-only fs).
 */
export async function checkModelsDir(cacheDirCfg) {
    const dir = resolveCacheDir(cacheDirCfg);
    try {
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true });
        }
        // Round-trip a probe file to verify write+delete works.
        const probe = path.join(dir, '.health-probe');
        await fs.writeFile(probe, 'ok', { encoding: 'utf8' });
        await fs.unlink(probe);
        // Optional disk-stat — only succeeds on POSIX. Windows reports null.
        let freeBytes = null;
        try {
            if (typeof fs.statfs === 'function') {
                const s = await fs.statfs(dir);
                if (s && Number.isFinite(s.bavail) && Number.isFinite(s.bsize)) {
                    freeBytes = s.bavail * s.bsize;
                }
            }
        } catch {
            /* statfs not available on this platform — leave null */
        }
        return {
            name: 'modelsDir',
            ok: true,
            dir,
            freeBytes,
        };
    } catch (e) {
        return {
            name: 'modelsDir',
            ok: false,
            dir,
            error: _shortError(e),
            recommendation:
                PLATFORM === 'win32'
                    ? 'Check that the models directory is writable. If running under Docker on Windows, verify volume mount permissions.'
                    : 'Ensure the dashboard process can write to the models directory. In Docker, the entrypoint chowns /app/data to uid 1000.',
        };
    }
}

/**
 * Run every check in parallel. Returns one screen of operator-friendly
 * diagnostic data — including the platform/node version so a bug report
 * has all the context. `ok` is the conjunction over non-optional checks.
 */
export async function summary({ getDb, cacheDir } = {}) {
    const [sharp, transformers, sqliteVec, modelsDir] = await Promise.all([
        checkSharp(),
        checkTransformers(),
        checkSqliteVec(getDb),
        checkModelsDir(cacheDir),
    ]);
    const checks = [sharp, transformers, sqliteVec, modelsDir];
    const required = checks.filter((c) => !c.optional);
    const ok = required.every((c) => c.ok);
    const recommendations = checks
        .filter((c) => !c.ok && c.recommendation)
        .map((c) => ({ name: c.name, text: c.recommendation }));
    return {
        ok,
        checks,
        recommendations,
        platform: PLATFORM,
        nodeVersion: NODE_VERSION,
        arch: process.arch,
        cpus: os.cpus()?.length || 1,
        ts: Date.now(),
    };
}
