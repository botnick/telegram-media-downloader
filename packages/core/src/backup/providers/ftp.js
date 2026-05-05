// FTP / FTPS provider — wraps the optional `basic-ftp` dependency.
//
// `basic-ftp` is listed in optionalDependencies (not regular deps) so a
// minimal install doesn't pull it in. The first time an FTP destination
// is used the provider tries a dynamic import and surfaces a clear
// `npm install basic-ftp` hint when missing.
//
// Wire layout mirrors the SFTP provider: paths are relative under a
// configured `remoteRoot`, forward-slash only on the wire, mkdir-p
// before every upload, idempotent delete (tolerates "no such file"),
// and an async-iterable list() that walks the remote tree recursively.
//
// FTP doesn't expose etags. We return `null` for that field and let
// the manager fall back to the size-based dedup check.
//
// Cancellation: every long-running call is wrapped so the
// AbortController on `ctx.signal` aborts the underlying socket via
// `client.close()` — `basic-ftp` doesn't have a native cancel token,
// so closing the control connection is the cleanest interrupt.

import fs from 'fs';
import { Transform } from 'stream';
import { BackupProvider, optionalDepError } from './base.js';
import { encryptStream } from '../encryption.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.BACKUP_FTP_TIMEOUT_MS) > 0
    ? Number(process.env.BACKUP_FTP_TIMEOUT_MS) : 30_000;

export class FtpProvider extends BackupProvider {
    static get name() { return 'ftp'; }
    static get displayName() { return 'FTP / FTPS'; }
    static get configSchema() {
        return [
            { name: 'host',       label: 'Host',       type: 'text',     required: true,
                placeholder: 'ftp.example.com' },
            { name: 'port',       label: 'Port',       type: 'number',                    placeholder: '21' },
            { name: 'username',   label: 'Username',   type: 'text',     required: true },
            { name: 'password',   label: 'Password',   type: 'password', secret: true,
                help: 'Empty for anonymous FTP.' },
            { name: 'secure',     label: 'TLS mode',   type: 'select',
                options: [
                    { value: 'false',   label: 'Plain FTP (no TLS)' },
                    { value: 'control', label: 'Explicit FTPS — AUTH TLS on port 21' },
                    { value: 'true',    label: 'Implicit FTPS — TLS from connect on port 990' },
                ],
                help: 'Most modern hosts use Explicit FTPS. Plain FTP transmits credentials in cleartext.' },
            { name: 'remoteRoot', label: 'Remote root', type: 'text',    required: true,
                placeholder: '/tgdl-backup',
                help: 'Absolute path on the remote where uploads land. Auto-created.' },
        ];
    }

    constructor() {
        super();
        this._ftp = null;
        this._cfg = null;
        this._root = '/';
    }

    async init(cfg, _ctx) {
        try {
            const mod = await import('basic-ftp');
            this._ftp = mod;
        } catch {
            throw optionalDepError('ftp', 'basic-ftp');
        }
        const host = String(cfg?.host || '').trim();
        const username = String(cfg?.username || cfg?.user || '').trim() || 'anonymous';
        const remoteRoot = this._normRemote(cfg?.remoteRoot || '/');
        if (!host) throw new Error('host required');

        const secure = cfg?.secure === 'true' || cfg?.secure === true
            ? true
            : (cfg?.secure === 'control' ? 'control' : false);

        // basic-ftp picks a sane default port from `secure` when omitted
        // (21 / 990) — but if the operator typed a custom port we honour it.
        const port = Number(cfg?.port) > 0 ? Number(cfg.port) : (secure === true ? 990 : 21);

        this._cfg = {
            host,
            port,
            user: username,
            password: cfg?.password != null ? String(cfg.password) : '',
            secure,
        };
        this._root = remoteRoot;

        // Probe the connection at init() time so create-destination
        // surfaces auth/TLS errors immediately rather than at first
        // upload. The probe also creates the remote root if missing.
        await this._withClient(async (client) => {
            await client.ensureDir(this._root);
        });
    }

    /** Normalise a remote path: backslashes → forward, collapse `//`,
     *  ensure leading `/`. Drops trailing `/` except for the literal root. */
    _normRemote(p) {
        let s = String(p == null ? '/' : p).replace(/\\/g, '/').replace(/\/+/g, '/');
        if (!s.startsWith('/')) s = '/' + s;
        if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }

    /** Resolve a relative remote path under the configured root. Refuses
     *  `..` escapes — symmetric with LocalProvider's _resolveSafe. */
    _resolve(remotePath) {
        const norm = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (norm.split('/').some((seg) => seg === '..')) {
            throw new Error(`unsafe remote path: ${remotePath}`);
        }
        return this._normRemote(`${this._root}/${norm}`);
    }

    /** Open a fresh control connection, run the callback, always close.
     *  basic-ftp's Client is single-use per logical operation — sharing
     *  one across overlapping ops is not safe. */
    async _withClient(fn, ctx) {
        const client = new this._ftp.Client(DEFAULT_TIMEOUT_MS);
        client.ftp.verbose = false;
        let aborted = false;
        const onAbort = () => { aborted = true; try { client.close(); } catch {} };
        if (ctx?.signal) {
            if (ctx.signal.aborted) onAbort();
            else ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            await client.access({
                host: this._cfg.host,
                port: this._cfg.port,
                user: this._cfg.user,
                password: this._cfg.password,
                secure: this._cfg.secure,
                // `secureOptions` defaults to Node's TLS defaults; no
                // hard-coded cert pinning here. Operators on self-signed
                // certificates can set NODE_TLS_REJECT_UNAUTHORIZED=0
                // at the process level if needed.
            });
            const r = await fn(client);
            if (aborted) throw new Error('aborted');
            return r;
        } finally {
            try { client.close(); } catch {}
            if (ctx?.signal) {
                try { ctx.signal.removeEventListener('abort', onAbort); } catch {}
            }
        }
    }

    async upload(localPath, remotePath, opts, ctx) {
        return this._withClient(async (client) => {
            const target = this._resolve(remotePath);
            const dir = target.substring(0, target.lastIndexOf('/')) || '/';
            await client.ensureDir(dir);
            // ensureDir() leaves the working directory IN the dir; reset
            // so subsequent absolute paths resolve from the root.
            await client.cd('/');

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
            if (ctx?.signal) {
                ctx.signal.addEventListener('abort', () => {
                    try { body.destroy(new Error('aborted')); } catch {}
                }, { once: true });
            }

            await client.uploadFrom(body, target);

            // Read back the size for telemetry. We can't always rely on
            // `size` (some servers strip it from the LIST output for
            // FTPS) — fall back to the local file size.
            let bytes = 0;
            try { bytes = Number(await client.size(target)) || 0; } catch {}
            if (!bytes) {
                try { bytes = (await fs.promises.stat(localPath)).size; } catch {}
            }
            return {
                remotePath,
                bytes,
                etag: null,
            };
        }, ctx);
    }

    async delete(remotePath, ctx) {
        const target = this._resolve(remotePath);
        try {
            await this._withClient(async (client) => {
                await client.remove(target);
            }, ctx);
        } catch (e) {
            const msg = String(e?.message || '');
            // Idempotent: 550 / "No such file" must be tolerated.
            if (e?.code === 550 || /no such|not found|does not exist/i.test(msg)) return;
            throw e;
        }
    }

    async stat(remotePath, ctx) {
        const target = this._resolve(remotePath);
        try {
            return await this._withClient(async (client) => {
                let size = 0;
                try { size = Number(await client.size(target)) || 0; } catch (e) {
                    const msg = String(e?.message || '');
                    if (e?.code === 550 || /no such|not found|does not exist/i.test(msg)) return null;
                    throw e;
                }
                let mtime = 0;
                try {
                    const d = await client.lastMod(target);
                    if (d instanceof Date) mtime = d.getTime();
                } catch { /* MDTM not supported on every server */ }
                return { size, mtime, etag: null };
            }, ctx);
        } catch (e) {
            const msg = String(e?.message || '');
            if (e?.code === 550 || /no such|not found|does not exist/i.test(msg)) return null;
            throw e;
        }
    }

    async *list(prefix, ctx) {
        const start = this._resolve(prefix || '');
        // Walk recursively. We use a stack instead of recursion so a
        // deep tree doesn't blow the call stack on large mirrors.
        const stack = [start];
        while (stack.length) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            const dir = stack.pop();
            let entries;
            try {
                entries = await this._withClient((client) => client.list(dir), ctx);
            } catch (e) {
                const msg = String(e?.message || '');
                if (e?.code === 550 || /no such|not found|does not exist/i.test(msg)) continue;
                throw e;
            }
            for (const e of entries) {
                if (ctx?.signal?.aborted) throw new Error('aborted');
                if (!e?.name || e.name === '.' || e.name === '..') continue;
                const abs = this._normRemote(`${dir}/${e.name}`);
                // Trim our configured root so callers see paths relative
                // to it, matching the shape they pass to upload/delete.
                const rel = abs.startsWith(this._root + '/')
                    ? abs.slice(this._root.length + 1)
                    : abs.replace(/^\//, '');
                if (e.type === 1 || e.isFile) {
                    const size = Number(e.size || 0);
                    const mtime = e.modifiedAt instanceof Date ? e.modifiedAt.getTime() : 0;
                    yield { name: rel, size, mtime };
                } else if (e.type === 2 || e.isDirectory) {
                    stack.push(abs);
                }
            }
        }
    }

    async testConnection(ctx) {
        try {
            return await this._withClient(async (client) => {
                await client.ensureDir(this._root);
                return {
                    ok: true,
                    detail: `Connected to ${this._cfg.host}:${this._cfg.port} — root ${this._root} is writable`,
                };
            }, ctx);
        } catch (e) {
            const msg = e?.message || String(e);
            // basic-ftp surfaces auth failures as code 530.
            if (e?.code === 530 || /530/.test(msg)) {
                return { ok: false, detail: `Auth failed (530) — check username + password. ${msg}` };
            }
            if (e?.code === 'ENOTFOUND' || /ENOTFOUND/.test(msg)) {
                return { ok: false, detail: `Host not found — check spelling of "${this._cfg.host}"` };
            }
            if (e?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
                return { ok: false, detail: `Connection refused on port ${this._cfg.port} — wrong port or firewall blocked` };
            }
            return { ok: false, detail: msg };
        }
    }

    async close() {
        // We don't keep a long-lived client — every op opens + closes
        // its own. Nothing to release here.
        this._ftp = null;
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

