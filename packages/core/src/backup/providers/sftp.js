// SFTP backup provider. Wraps `ssh2-sftp-client` with the same surface
// the manager expects from every provider — streaming upload, idempotent
// delete, stat-or-null, async-iterable list, cheap testConnection.
//
// Auth: password OR private-key (PEM). Provide one. If both are set,
// the private key wins (less likely to be a stale leftover from a
// previous wizard run).
//
// `ssh2-sftp-client` is a required dep — SFTP is one of the three
// "first-class" providers and a NAS over SFTP is the second-most-common
// home setup after S3.

import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import SftpClient from 'ssh2-sftp-client';
import { BackupProvider } from './base.js';
import { encryptStream } from '../encryption.js';

export class SftpProvider extends BackupProvider {
    static get name() { return 'sftp'; }
    static get displayName() { return 'SFTP (SSH file transfer)'; }
    static get configSchema() {
        return [
            { name: 'host',         label: 'Host',          type: 'text',     required: true,  placeholder: 'nas.lan' },
            { name: 'port',         label: 'Port',          type: 'number',                    placeholder: '22' },
            { name: 'username',     label: 'Username',      type: 'text',     required: true },
            { name: 'password',     label: 'Password',      type: 'password', secret: true,
                help: 'Provide a password OR a private key, not both. If both, the key wins.' },
            { name: 'privateKey',   label: 'Private key (PEM)', type: 'textarea', secret: true,
                placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----' },
            { name: 'passphrase',   label: 'Key passphrase', type: 'password', secret: true,
                help: 'Only needed if the private key is encrypted.' },
            { name: 'remoteRoot',   label: 'Remote root',   type: 'text',     required: true,
                placeholder: '/home/user/tgdl-backup',
                help: 'Absolute path on the remote where uploads land. Will be auto-created.' },
        ];
    }

    constructor() {
        super();
        this.client = null;
        this.cfg = null;
        this.root = null;
    }

    async init(cfg, _ctx) {
        const host = String(cfg?.host || '').trim();
        const username = String(cfg?.username || '').trim();
        const remoteRoot = String(cfg?.remoteRoot || '').trim();
        if (!host) throw new Error('host required');
        if (!username) throw new Error('username required');
        if (!remoteRoot) throw new Error('remoteRoot required');
        if (!path.posix.isAbsolute(remoteRoot)) {
            throw new Error('remoteRoot must be an absolute path on the remote (start with /)');
        }
        this.cfg = {
            host,
            username,
            port: Number(cfg?.port) || 22,
            password: cfg?.password || undefined,
            privateKey: cfg?.privateKey || undefined,
            passphrase: cfg?.passphrase || undefined,
            // 30 s ssh2 ready-timeout — slow VPNs / power-saving NASes
            // sometimes take 5-10 s to negotiate.
            readyTimeout: 30_000,
        };
        if (!this.cfg.password && !this.cfg.privateKey) {
            throw new Error('password or privateKey required');
        }
        this.root = remoteRoot.replace(/\/+$/, '') || '/';
        this.client = new SftpClient(`tgdl-backup-${Date.now()}`);
        await this.client.connect(this.cfg);
        // Ensure the root exists. mkdir -p semantics.
        try { await this.client.mkdir(this.root, true); } catch { /* may already exist */ }
    }

    /** Resolve a remote (relative) path against the configured root. */
    _resolve(remotePath) {
        const norm = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (norm.includes('..')) throw new Error(`unsafe remote path: ${remotePath}`);
        return path.posix.join(this.root, norm);
    }

    async upload(localPath, remotePath, opts, ctx) {
        const dest = this._resolve(remotePath);
        const dir = path.posix.dirname(dest);
        try { await this.client.mkdir(dir, true); } catch { /* exists */ }

        let body = fs.createReadStream(localPath);
        if (opts?.encryptKey) {
            body = body.pipe(encryptStream(opts.encryptKey));
        }
        if (typeof opts?.onProgress === 'function' || opts?.throttleBps) {
            body = body.pipe(_makeProgressTransform({
                onProgress: opts?.onProgress,
                throttleBps: opts?.throttleBps,
                signal: ctx?.signal,
            }));
        }

        // ssh2-sftp-client's `put` accepts a Readable. Wrap so we can
        // honour AbortSignal — there's no native cancel on the library,
        // so we destroy the source stream and let the upstream error
        // surface as the abort.
        if (ctx?.signal) {
            ctx.signal.addEventListener('abort', () => {
                try { body.destroy(new Error('aborted')); } catch {}
            }, { once: true });
        }
        await this.client.put(body, dest);
        const st = await this.client.stat(dest);
        return {
            remotePath,
            bytes: Number(st?.size || 0),
            etag: undefined,
        };
    }

    async delete(remotePath, _ctx) {
        const target = this._resolve(remotePath);
        try {
            await this.client.delete(target);
        } catch (e) {
            // ssh2-sftp-client wraps errors; "No such file" needs to be
            // tolerated for the idempotent-delete contract.
            const msg = String(e?.message || '');
            if (/no such file/i.test(msg) || e?.code === 2) return;
            throw e;
        }
    }

    async stat(remotePath, _ctx) {
        const target = this._resolve(remotePath);
        try {
            const st = await this.client.stat(target);
            if (!st || st.isDirectory) return null;
            return {
                size: Number(st.size || 0),
                mtime: Number(st.modifyTime || st.mtime || 0) * (st.modifyTime > 1e12 ? 1 : 1000),
            };
        } catch (e) {
            const msg = String(e?.message || '');
            if (/no such file/i.test(msg) || e?.code === 2) return null;
            throw e;
        }
    }

    async *list(prefix, ctx) {
        const target = this._resolve(prefix || '');
        let entries;
        try {
            entries = await this.client.list(target);
        } catch (e) {
            const msg = String(e?.message || '');
            if (/no such file/i.test(msg)) return;
            throw e;
        }
        for (const e of entries) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            const rel = path.posix.join(String(prefix || '').replace(/\\/g, ''), e.name);
            if (e.type === '-') {
                yield {
                    name: rel,
                    size: Number(e.size || 0),
                    mtime: Number(e.modifyTime || 0),
                };
            } else if (e.type === 'd') {
                yield* this.list(rel, ctx);
            }
        }
    }

    async testConnection(_ctx) {
        try {
            const st = await this.client.stat(this.root);
            return {
                ok: true,
                detail: st?.isDirectory
                    ? `Connected to ${this.cfg.host}:${this.cfg.port} — root ${this.root} is a directory`
                    : `Connected to ${this.cfg.host}:${this.cfg.port} — but ${this.root} is not a directory`,
            };
        } catch (e) {
            return { ok: false, detail: e.message };
        }
    }

    async close() {
        try { await this.client?.end(); } catch {}
        this.client = null;
    }
}

function _makeProgressTransform({ onProgress, throttleBps, signal }) {
    let bytes = 0;
    const start = Date.now();
    return new Transform({
        async transform(chunk, _enc, cb) {
            try {
                if (signal?.aborted) return cb(new Error('aborted'));
                bytes += chunk.length;
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
