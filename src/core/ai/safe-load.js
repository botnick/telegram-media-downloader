/**
 * Tiny dynamic-import helper. Wraps `import()` so a missing or broken native
 * dependency surfaces as a structured `{ ok: false, error }` instead of a
 * thrown rejection that might escape into `process.on('uncaughtException')`.
 *
 * The whole point: `import sharp from 'sharp'` at module top-level used to
 * crash the entire web process when libvips was missing. Replacing those
 * with `await tryImport('sharp')` keeps every other AI capability working
 * even when one native dep is broken on the host.
 */

export async function tryImport(specifier) {
    try {
        return { ok: true, mod: await import(specifier) };
    } catch (error) {
        return { ok: false, error };
    }
}

/**
 * Cached lazy loader factory. Each call to `lazy('sharp', mapFn)` returns
 * a function that resolves the module once per process. `mapFn` extracts
 * the value the caller actually wants (typically `m => m.default`).
 *
 * On failure the returned promise REJECTS with an Error tagged
 * `code: 'NATIVE_LOAD_FAIL'` so call sites can convert it into a
 * structured route-level error rather than a process crash.
 */
export function lazy(specifier, mapFn = (m) => m.default ?? m, code = 'NATIVE_LOAD_FAIL') {
    let promise = null;
    return function load() {
        if (promise) return promise;
        promise = tryImport(specifier).then((r) => {
            if (!r.ok) {
                const err = new Error(
                    `Failed to load '${specifier}': ${r.error?.message || r.error}`,
                );
                err.code = code;
                err.cause = r.error;
                // Reset so the next caller can retry (e.g. after an operator
                // runs `npm rebuild` without restarting the process).
                promise = null;
                throw err;
            }
            return mapFn(r.mod);
        });
        return promise;
    };
}
