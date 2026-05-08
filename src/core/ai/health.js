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
 *
 * Hardening (v2.12.1):
 *   - Every probe is wrapped in `withTimeout()` so a hung native call can no
 *     longer block the request; the worst case is a structured `ok: false`
 *     with `error: "<name> probe timed out after 6000ms"`.
 *   - `checkSharp()` no longer invokes libvips (`.toBuffer()`) — the version
 *     surface alone tells us the binding loaded; running an actual resize on
 *     a broken libvips would SIGSEGV the whole process with no JS log.
 *   - `checkSqliteVec()` only calls `mod.load(db)` ONCE per process; the
 *     extension is process-wide and re-loading every health hit was wasted
 *     work that could segfault on a corrupt build.
 *   - Every step emits a structured log line via the optional `log` callback
 *     so when something does crash the docker logs show exactly which probe
 *     was running last.
 */

import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { tryImport } from './safe-load.js';
import { resolveCacheDir } from './models.js';

const PLATFORM = process.platform; // 'win32' | 'linux' | 'darwin'
const NODE_VERSION = process.version;

// Per-check timeout. 6 s is well below the dashboard's 15 s client-side
// timeout, leaving headroom for the route-level wrapper to assemble the
// summary payload + JSON-encode it.
export const PROBE_TIMEOUT_MS = 6_000;

// Cached sqlite-vec.load() result — process-wide, since the extension is
// loaded into every connection that shares the same SQLite library handle.
// Re-loading on every health hit was the original implementation; on a
// corrupt build it could SIGSEGV the process.
let _sqliteVecCache = null;

function _shortError(err) {
    if (!err) return '';
    const m = err.message || String(err);
    return m.length > 240 ? m.slice(0, 240) + '…' : m;
}

function _logSafe(log, entry) {
    if (typeof log !== 'function') return;
    try {
        log(entry);
    } catch {
        /* never throw from a log call */
    }
}

/**
 * Race a probe against a timeout. The probe still runs in the background if
 * the timeout wins, but the caller (and the HTTP request) gets a structured
 * answer immediately. Returns the probe's value on success, or a fallback
 * `{ ok: false, error, recommendation }` payload on timeout.
 */
async function withTimeout(name, ms, fn, log) {
    const t0 = Date.now();
    _logSafe(log, { source: 'ai-health', level: 'info', msg: `probe ${name}: start` });
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            _logSafe(log, {
                source: 'ai-health',
                level: 'warn',
                msg: `probe ${name}: TIMEOUT after ${ms}ms — returning structured fallback (probe still running in background)`,
            });
            resolve({
                name,
                ok: false,
                installed: null,
                error: `${name} probe timed out after ${ms}ms`,
                recommendation:
                    `The "${name}" probe hung for more than ${ms}ms. ` +
                    'This usually points at a broken native binding (libvips, onnxruntime-node, sqlite-vec). ' +
                    'Check container memory limits and run `npm rebuild` for the affected module.',
                timedOut: true,
            });
        }, ms);
        // Don't keep the event loop alive on shutdown.
        if (typeof timer.unref === 'function') timer.unref();
    });
    try {
        const result = await Promise.race([
            Promise.resolve()
                .then(fn)
                .catch((err) => ({
                    name,
                    ok: false,
                    installed: null,
                    error: _shortError(err),
                    recommendation: `The "${name}" probe threw: ${_shortError(err)}`,
                    threw: true,
                })),
            timeout,
        ]);
        clearTimeout(timer);
        const ms_ = Date.now() - t0;
        _logSafe(log, {
            source: 'ai-health',
            level: result.ok ? 'info' : 'warn',
            msg: `probe ${name}: done in ${ms_}ms (ok=${!!result.ok}${result.timedOut ? ' timedOut' : ''}${result.threw ? ' threw' : ''}${result.error ? ` error="${String(result.error).slice(0, 200)}"` : ''})`,
        });
        return result;
    } catch (err) {
        // Defensive — withTimeout itself should never throw, but if it does
        // we still owe the caller a structured payload.
        clearTimeout(timer);
        _logSafe(log, {
            source: 'ai-health',
            level: 'error',
            msg: `probe ${name}: harness crashed — ${_shortError(err)}`,
        });
        return {
            name,
            ok: false,
            error: _shortError(err),
            recommendation: `Health probe harness crashed for "${name}". Check server logs.`,
        };
    }
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
 * Probe `sharp`. Loads the module and reads its `versions` surface — that
 * alone tells us whether libvips bound successfully (sharp throws at
 * import-time when libvips can't be found). We deliberately do NOT invoke a
 * round-trip resize like earlier versions did: a broken libvips would
 * SIGSEGV the entire process from native code, bypassing every JS catch.
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
    const versions = sharp?.versions || {};
    if (!versions.vips) {
        // Module imported but libvips didn't bind — same fix as a missing
        // module, but the error surface is different.
        return {
            name: 'sharp',
            ok: false,
            installed: true,
            error: 'sharp loaded without libvips version metadata — native binding likely broken',
            recommendation: _sharpRecommendation(new Error('libvips not bound')),
        };
    }
    return {
        name: 'sharp',
        ok: true,
        installed: true,
        version: versions.sharp || null,
        libvips: versions.vips || null,
    };
}

/**
 * Probe `@huggingface/transformers`. Just loads the module — does NOT load
 * a model (that would download ~90 MB on a fresh install). The catch path
 * is the only thing we're after: if the module imports cleanly the next
 * scan will succeed; if not, we tell the operator how to fix it.
 *
 * Note: dynamic `import()` of this package transitively loads
 * onnxruntime-node, which can be heavy. The probe is timeout-bounded by
 * `withTimeout()` above, so a hang here can't take the request down.
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
 *
 * The expensive part — actually loading the .so via `mod.load(db)` — is
 * cached per process. Re-loading on every health hit is wasted work and on
 * a corrupt build was a route to SIGSEGV.
 */
export async function checkSqliteVec(getDb) {
    if (_sqliteVecCache) return _sqliteVecCache;

    const r = await tryImport('sqlite-vec');
    if (!r.ok) {
        _sqliteVecCache = {
            name: 'sqlite-vec',
            ok: true, // optional — missing is fine
            installed: false,
            optional: true,
            note: 'Optional. In-memory fallback handles up to ~50k photos. Install with `npm install sqlite-vec` for bigger libraries.',
        };
        return _sqliteVecCache;
    }
    if (typeof r.mod.load !== 'function') {
        _sqliteVecCache = {
            name: 'sqlite-vec',
            ok: true,
            installed: true,
            optional: true,
            error: 'sqlite-vec module loaded but no load() export found',
        };
        return _sqliteVecCache;
    }
    try {
        const db = typeof getDb === 'function' ? getDb() : null;
        if (!db) {
            // Don't cache — a later request might pass a real DB.
            return {
                name: 'sqlite-vec',
                ok: true,
                installed: true,
                optional: true,
                note: 'Module installed; database not reachable for probe.',
            };
        }
        // Calling load on the same connection twice is a no-op in sqlite-vec,
        // but we cache the result anyway so we skip the dlopen path entirely.
        r.mod.load(db);
        _sqliteVecCache = {
            name: 'sqlite-vec',
            ok: true,
            installed: true,
            optional: true,
            loaded: true,
        };
        return _sqliteVecCache;
    } catch (e) {
        _sqliteVecCache = {
            name: 'sqlite-vec',
            ok: true, // optional — install is broken but app still works
            installed: true,
            optional: true,
            error: _shortError(e),
            note: 'Module installed but extension load failed; in-memory fallback in use.',
        };
        return _sqliteVecCache;
    }
}

/**
 * Test-only: reset the sqlite-vec cache so unit tests can exercise both
 * paths without spawning a fresh Node process. Not exported anywhere a
 * production code path can reach.
 */
export function _resetSqliteVecCacheForTests() {
    _sqliteVecCache = null;
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
 * Run every check in parallel, each behind its own timeout. Returns one
 * screen of operator-friendly diagnostic data — including the platform/node
 * version so a bug report has all the context. `ok` is the conjunction over
 * non-optional checks.
 *
 * @param {object} [opts]
 * @param {Function} [opts.getDb]   live SQLite handle factory
 * @param {string}   [opts.cacheDir]
 * @param {Function} [opts.log]     structured logger (server.js's `log()`)
 * @param {number}   [opts.timeoutMs=PROBE_TIMEOUT_MS]   per-check timeout
 */
export async function summary({ getDb, cacheDir, log, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const t0 = Date.now();
    _logSafe(log, {
        source: 'ai-health',
        level: 'info',
        msg: `summary: begin (timeoutMs=${timeoutMs}, platform=${PLATFORM}, node=${NODE_VERSION})`,
    });

    const [sharp, transformers, sqliteVec, modelsDir] = await Promise.all([
        withTimeout('sharp', timeoutMs, () => checkSharp(), log),
        withTimeout('transformers', timeoutMs, () => checkTransformers(), log),
        withTimeout('sqlite-vec', timeoutMs, () => checkSqliteVec(getDb), log),
        withTimeout('modelsDir', timeoutMs, () => checkModelsDir(cacheDir), log),
    ]);

    const checks = [sharp, transformers, sqliteVec, modelsDir];
    const required = checks.filter((c) => !c.optional);
    const ok = required.every((c) => c.ok);
    const recommendations = checks
        .filter((c) => !c.ok && c.recommendation)
        .map((c) => ({ name: c.name, text: c.recommendation }));

    const totalMs = Date.now() - t0;
    _logSafe(log, {
        source: 'ai-health',
        level: ok ? 'info' : 'warn',
        msg: `summary: done in ${totalMs}ms (ok=${ok}, failed=[${checks
            .filter((c) => !c.ok)
            .map((c) => c.name)
            .join(',')}])`,
    });

    return {
        ok,
        checks,
        recommendations,
        platform: PLATFORM,
        nodeVersion: NODE_VERSION,
        arch: process.arch,
        cpus: os.cpus()?.length || 1,
        ts: Date.now(),
        elapsedMs: totalMs,
    };
}
