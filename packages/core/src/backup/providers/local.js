// Local-filesystem backup provider.
//
// Targets a directory on a mounted volume — the typical NAS use case is
// `/mnt/nas/tgdl-backup`, but anything writable works (USB external HDD,
// a sibling Docker volume, an SMB mount on Windows). The provider is
// also the simplest reference implementation, so the encryption +
// throttle + abort-signal plumbing in the queue can be exercised
// end-to-end without a network round-trip.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { BackupProvider } from './base.js';
import { encryptStream } from '../encryption.js';

export class LocalProvider extends BackupProvider {
    static get name() { return 'local'; }
    static get displayName() { return 'Local filesystem / NAS mount'; }
    static get configSchema() {
        return [
            {
                name: 'rootPath',
                label: 'Root path',
                type: 'text',
                required: true,
                placeholder: '/mnt/nas/tgdl-backup',
                help: 'Absolute path to the destination directory. The dashboard process must have read+write permissions there.',
            },
        ];
    }

    constructor() {
        super();
        this.root = null;
    }

    async init(cfg, _ctx) {
        const root = String(cfg?.rootPath || '').trim();
        if (!root) throw new Error('rootPath required');
        if (!path.isAbsolute(root)) {
            throw new Error('rootPath must be an absolute path');
        }
        await fsp.mkdir(root, { recursive: true });
        // Probe write access — surfaces EACCES at create-time instead of
        // at first upload.
        const probe = path.join(root, '.tgdl-write-probe');
        try {
            await fsp.writeFile(probe, '');
            await fsp.unlink(probe);
        } catch (e) {
            throw new Error(`Cannot write to ${root}: ${e.message}`);
        }
        this.root = root;
    }

    /** Resolve a remote (POSIX) path to an absolute on-disk path,
     *  refusing anything that escapes the configured root via `..`. */
    _resolveSafe(remotePath) {
        const norm = String(remotePath || '').replace(/\\/g, '/');
        if (norm.includes('..') || path.posix.isAbsolute(norm)) {
            throw new Error(`unsafe remote path: ${remotePath}`);
        }
        return path.resolve(this.root, ...norm.split('/').filter(Boolean));
    }

    async upload(localPath, remotePath, opts, ctx) {
        const dest = this._resolveSafe(remotePath);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const tmp = dest + '.part';
        const src = fs.createReadStream(localPath);
        const dst = fs.createWriteStream(tmp);
        const transforms = [];
        if (opts?.encryptKey) {
            transforms.push(encryptStream(opts.encryptKey));
        }
        let bytesIn = 0;
        const onProgress = opts?.onProgress;
        if (typeof onProgress === 'function' || opts?.throttleBps) {
            transforms.push(_makeProgressTransform({
                onProgress,
                throttleBps: opts?.throttleBps,
                signal: ctx?.signal,
                onBytes: (n) => { bytesIn = n; },
            }));
        }
        const stages = [src, ...transforms, dst];
        try {
            await pipeline(stages, { signal: ctx?.signal });
        } catch (e) {
            try { await fsp.unlink(tmp); } catch {}
            throw e;
        }
        await fsp.rename(tmp, dest);
        const st = await fsp.stat(dest);
        return {
            remotePath,
            bytes: st.size,
            // Keep both stat-derived size and the streamed-from-source
            // count for telemetry. They match in plaintext mode and
            // deliberately differ when encryption adds the 33-byte
            // overhead (4-magic + 1-version + 12-iv + 16-tag).
            sourceBytes: bytesIn || undefined,
        };
    }

    async delete(remotePath, _ctx) {
        const target = this._resolveSafe(remotePath);
        try {
            await fsp.unlink(target);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
    }

    async stat(remotePath, _ctx) {
        const target = this._resolveSafe(remotePath);
        try {
            const st = await fsp.stat(target);
            if (!st.isFile()) return null;
            return { size: st.size, mtime: st.mtimeMs };
        } catch (e) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
    }

    async *list(prefix, ctx) {
        const root = prefix ? this._resolveSafe(prefix) : this.root;
        let entries;
        try {
            entries = await fsp.readdir(root, { withFileTypes: true });
        } catch (e) {
            if (e.code === 'ENOENT') return;
            throw e;
        }
        for (const e of entries) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            const abs = path.join(root, e.name);
            if (e.isFile()) {
                try {
                    const st = await fsp.stat(abs);
                    const rel = path.posix.join(
                        String(prefix || '').replace(/\\/g, '/'),
                        e.name,
                    );
                    yield { name: rel, size: st.size, mtime: st.mtimeMs };
                } catch { /* file disappeared mid-list */ }
            } else if (e.isDirectory()) {
                // Recurse — snapshot retention only walks shallow prefixes
                // so depth is bounded in practice.
                yield* this.list(
                    path.posix.join(String(prefix || '').replace(/\\/g, '/'), e.name),
                    ctx,
                );
            }
        }
    }

    async testConnection(_ctx) {
        const probe = path.join(this.root, '.tgdl-test-probe');
        try {
            await fsp.writeFile(probe, 'ok');
            await fsp.unlink(probe);
            return { ok: true, detail: `Wrote + removed probe at ${probe}` };
        } catch (e) {
            return { ok: false, detail: e.message };
        }
    }
}

/**
 * Internal helper — a Transform that:
 *   - tallies byte counts (for `onBytes` + `onProgress`)
 *   - throttles to `throttleBps` bytes/sec when set (sleep-based —
 *     simple and predictable; bandwidth shapers usually do not need
 *     sub-second granularity for a 100-file backup queue)
 *   - bails out fast on signal.aborted
 */
function _makeProgressTransform({ onProgress, throttleBps, signal, onBytes }) {
    let bytes = 0;
    const start = Date.now();
    return new Transform({
        async transform(chunk, _enc, cb) {
            try {
                if (signal?.aborted) return cb(new Error('aborted'));
                bytes += chunk.length;
                if (typeof onBytes === 'function') onBytes(bytes);
                if (typeof onProgress === 'function') {
                    try { onProgress({ bytesUploaded: bytes }); } catch {}
                }
                if (throttleBps && throttleBps > 0) {
                    const elapsedMs = Date.now() - start;
                    const expectedMs = (bytes / throttleBps) * 1000;
                    const lagMs = expectedMs - elapsedMs;
                    if (lagMs > 5) {
                        await new Promise((r) => setTimeout(r, Math.min(1000, lagMs)));
                    }
                }
                cb(null, chunk);
            } catch (e) { cb(e); }
        },
    });
}
