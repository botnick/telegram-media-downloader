// Dropbox provider — wraps the optional `dropbox` SDK.
//
// Auth model: appKey + appSecret + refreshToken. The dashboard does
// NOT host an embedded OAuth callback listener (that would mean opening
// an extra port, dealing with browser pop-ups, etc.) — the operator
// generates a long-lived refresh token externally via the Dropbox
// developer console and pastes it into the wizard. The SDK refreshes
// access tokens server-side as needed.
//
// Upload sizes:
//   - <= 150 MB → single-shot `filesUpload`
//   - >  150 MB → chunked session API (`filesUploadSessionStartFinish`
//     for files that fit in one session, multi-call for larger).
//
// Dropbox's chunked-session protocol requires:
//   - filesUploadSessionStart   (returns sessionId, no offset)
//   - filesUploadSessionAppendV2 (append more chunks at offset)
//   - filesUploadSessionFinish  (commit at final offset)
//
// We chunk at 8 MB by default (overridable via env). 8 MB strikes a
// balance between API call count + memory. Dropbox accepts up to 150 MB
// per session-API chunk.

import fs from 'fs';
import { Transform } from 'stream';
import { BackupProvider, optionalDepError } from './base.js';
import { encryptStream } from '../encryption.js';

const SINGLE_SHOT_LIMIT = 150 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = Number(process.env.BACKUP_DROPBOX_CHUNK_BYTES) > 0
    ? Math.max(4 * 1024 * 1024, Math.min(150 * 1024 * 1024, Number(process.env.BACKUP_DROPBOX_CHUNK_BYTES)))
    : 8 * 1024 * 1024;

export class DropboxProvider extends BackupProvider {
    static get name() { return 'dropbox'; }
    static get displayName() { return 'Dropbox'; }
    static get configSchema() {
        return [
            { name: 'appKey',       label: 'App key',          type: 'text',     required: true,
                help: 'Found in Dropbox developer console → Apps → Settings tab.' },
            { name: 'appSecret',    label: 'App secret',       type: 'password', secret: true, required: true },
            { name: 'refreshToken', label: 'Refresh token',    type: 'password', secret: true, required: true,
                help: 'Long-lived token from the OAuth flow. See the walkthrough below.' },
            { name: 'remoteRoot',   label: 'Remote root path', type: 'text',     required: true,
                placeholder: '/tgdl-backup',
                help: 'Absolute path inside the app folder (or full Dropbox if your app has full-access scope).' },
        ];
    }

    constructor() {
        super();
        this._Dropbox = null;
        this._dbx = null;
        this._cfg = null;
        this._remoteRoot = '/';
    }

    async init(cfg, _ctx) {
        let mod;
        try {
            mod = await import('dropbox');
        } catch {
            throw optionalDepError('dropbox', 'dropbox');
        }
        // The Dropbox SDK is published as both CJS and ESM; the named
        // export shape works on both via the dynamic import wrapper.
        this._Dropbox = mod.Dropbox || mod.default?.Dropbox;
        if (!this._Dropbox) throw new Error('dropbox SDK loaded but Dropbox class is missing');

        const appKey = String(cfg?.appKey || '').trim();
        const appSecret = String(cfg?.appSecret || '').trim();
        const refreshToken = String(cfg?.refreshToken || '').trim();
        if (!appKey || !appSecret || !refreshToken) {
            throw new Error(
                'Dropbox needs appKey + appSecret + refreshToken. ' +
                'See docs/BACKUP.md → "Dropbox setup" for the OAuth walkthrough.',
            );
        }
        this._cfg = { appKey, appSecret, refreshToken };
        this._remoteRoot = this._normRemote(cfg?.remoteRoot || '/tgdl-backup');

        // The SDK ships with `node-fetch` baked in but lets us pass a
        // custom fetch (Node 18+ has globalThis.fetch). Either works;
        // we rely on the default to keep the surface small.
        this._dbx = new this._Dropbox({
            clientId: appKey,
            clientSecret: appSecret,
            refreshToken,
        });

        // Probe the credentials. Dropbox returns a 401 "invalid_grant"
        // if the refresh token is dead.
        try {
            await this._dbx.usersGetCurrentAccount();
        } catch (e) {
            const msg = this._errMsg(e);
            if (/invalid_grant/i.test(msg) || /expired/i.test(msg)) {
                throw new Error(
                    'Dropbox auth failed: refresh token rejected. ' +
                    'Re-generate via the developer console — see docs/BACKUP.md.',
                );
            }
            throw new Error(`Dropbox auth failed: ${msg}`);
        }

        // Ensure the remote root exists.
        if (this._remoteRoot && this._remoteRoot !== '/') {
            await this._ensureFolder(this._remoteRoot);
        }
    }

    /** Normalise a Dropbox path: forward-slash only, leading `/`, no
     *  trailing slash (except for the literal root). Dropbox itself is
     *  picky — `/foo/` returns `path/malformed_path`. */
    _normRemote(p) {
        let s = String(p == null ? '/' : p).replace(/\\/g, '/').replace(/\/+/g, '/');
        if (!s.startsWith('/')) s = '/' + s;
        if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
        return s;
    }

    /** Resolve a relative path under the configured root. */
    _resolve(remotePath) {
        const norm = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (norm.split('/').some((seg) => seg === '..')) {
            throw new Error(`unsafe remote path: ${remotePath}`);
        }
        if (this._remoteRoot === '/' || this._remoteRoot === '') {
            return this._normRemote('/' + norm);
        }
        return this._normRemote(`${this._remoteRoot}/${norm}`);
    }

    async _ensureFolder(absPath) {
        try {
            await this._dbx.filesCreateFolderV2({ path: absPath, autorename: false });
        } catch (e) {
            const tag = e?.error?.error?.['.tag'] || e?.error?.error_summary || '';
            // 409 / path/conflict/folder = already exists, fine.
            if (/path\/conflict/i.test(String(tag)) || /already_exists/i.test(String(tag)) || e?.status === 409) {
                return;
            }
            // Some hosts return tag = "path" with sub-tag "conflict". The
            // error_summary string is the most reliable check.
            const summary = e?.error?.error_summary || '';
            if (/conflict/i.test(summary)) return;
            throw e;
        }
    }

    /** Walk a path's parent dirs and ensure each exists. Lets uploads
     *  to nested paths (e.g. group/photos/x.jpg) succeed first time. */
    async _ensureParents(absFilePath) {
        const segs = absFilePath.split('/').filter(Boolean);
        if (segs.length <= 1) return;
        // Build cumulative paths: /a, /a/b, /a/b/c (skip the file itself).
        let acc = '';
        for (let i = 0; i < segs.length - 1; i++) {
            acc += '/' + segs[i];
            await this._ensureFolder(acc);
        }
    }

    async upload(localPath, remotePath, opts, ctx) {
        const target = this._resolve(remotePath);
        await this._ensureParents(target);

        // Determine the on-the-wire size. We can't always know up-front
        // when encryption / throttling transforms are in the pipeline,
        // so we read the local file size and add the encryption header
        // overhead (33 bytes) when a key is provided. That's enough to
        // route to the right upload path.
        let localSize = 0;
        try { localSize = (await fs.promises.stat(localPath)).size; } catch {}
        const wireSize = opts?.encryptKey ? localSize + 33 : localSize;

        if (wireSize <= SINGLE_SHOT_LIMIT) {
            return await this._uploadSmall(localPath, target, remotePath, opts, ctx);
        }
        return await this._uploadChunked(localPath, target, remotePath, opts, ctx);
    }

    async _uploadSmall(localPath, target, remotePath, opts, ctx) {
        // For files <= 150 MB, buffer the (possibly transformed) stream
        // into a Buffer and call filesUpload once. Buffering is
        // necessary because the SDK's `contents` field expects a
        // Buffer / string / Blob — it doesn't accept a stream.
        const buf = await this._streamToBuffer(localPath, opts, ctx);
        const r = await this._dbx.filesUpload({
            path: target,
            contents: buf,
            mode: { '.tag': 'overwrite' },
            mute: true,
            strict_conflict: false,
        });
        const data = r?.result || r || {};
        return {
            remotePath,
            bytes: Number(data.size || buf.length || 0),
            etag: data.content_hash || null,
            remoteId: data.id || undefined,
        };
    }

    async _uploadChunked(localPath, target, remotePath, opts, ctx) {
        // Build a transformed stream and pump it in DEFAULT_CHUNK_BYTES
        // slices. We start a session on the first chunk, append on the
        // middle ones, finish on the last — matching Dropbox's protocol.
        const stream = this._buildTransformedStream(localPath, opts, ctx);
        let sessionId = null;
        let offset = 0;
        let lastChunk = null;

        const flush = async (buf, isLast) => {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            if (sessionId == null) {
                const r = await this._dbx.filesUploadSessionStart({
                    close: false,
                    contents: buf,
                });
                sessionId = (r?.result || r)?.session_id;
                if (!sessionId) throw new Error('Dropbox: filesUploadSessionStart returned no session_id');
                offset += buf.length;
                return;
            }
            if (!isLast) {
                await this._dbx.filesUploadSessionAppendV2({
                    cursor: { session_id: sessionId, offset },
                    close: false,
                    contents: buf,
                });
                offset += buf.length;
            }
        };

        // Iterate the stream in fixed-size slices. We accumulate small
        // chunks until we hit the chunk size, then flush.
        let acc = Buffer.alloc(0);
        for await (const chunk of stream) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            acc = Buffer.concat([acc, chunk]);
            while (acc.length >= DEFAULT_CHUNK_BYTES) {
                const slice = acc.subarray(0, DEFAULT_CHUNK_BYTES);
                acc = acc.subarray(DEFAULT_CHUNK_BYTES);
                if (lastChunk) await flush(lastChunk, false);
                lastChunk = Buffer.from(slice);
            }
        }
        if (acc.length) {
            if (lastChunk) await flush(lastChunk, false);
            lastChunk = Buffer.concat([Buffer.alloc(0), acc]);
        }
        // Final commit. If we never started a session (edge case: empty
        // stream), fall through to filesUpload with an empty buffer.
        if (sessionId == null) {
            const r = await this._dbx.filesUpload({
                path: target,
                contents: lastChunk || Buffer.alloc(0),
                mode: { '.tag': 'overwrite' },
                mute: true,
            });
            const data = r?.result || r || {};
            return {
                remotePath,
                bytes: Number(data.size || (lastChunk?.length || 0)),
                etag: data.content_hash || null,
                remoteId: data.id || undefined,
            };
        }
        const finishR = await this._dbx.filesUploadSessionFinish({
            cursor: { session_id: sessionId, offset },
            commit: {
                path: target,
                mode: { '.tag': 'overwrite' },
                mute: true,
                strict_conflict: false,
            },
            contents: lastChunk || Buffer.alloc(0),
        });
        const data = finishR?.result || finishR || {};
        return {
            remotePath,
            bytes: Number(data.size || (offset + (lastChunk?.length || 0))),
            etag: data.content_hash || null,
            remoteId: data.id || undefined,
        };
    }

    /** Build the read stream + apply encryption / progress transforms. */
    _buildTransformedStream(localPath, opts, ctx) {
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
        return body;
    }

    async _streamToBuffer(localPath, opts, ctx) {
        const stream = this._buildTransformedStream(localPath, opts, ctx);
        const chunks = [];
        for await (const c of stream) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            chunks.push(c);
        }
        return Buffer.concat(chunks);
    }

    async delete(remotePath, _ctx) {
        const target = this._resolve(remotePath);
        try {
            await this._dbx.filesDeleteV2({ path: target });
        } catch (e) {
            const summary = e?.error?.error_summary || this._errMsg(e);
            if (/path_lookup\/not_found/i.test(summary) || /not_found/i.test(summary)) return;
            throw e;
        }
    }

    async stat(remotePath, _ctx) {
        const target = this._resolve(remotePath);
        try {
            const r = await this._dbx.filesGetMetadata({ path: target });
            const data = r?.result || r || {};
            if (data['.tag'] === 'folder' || data.is_folder) return null;
            return {
                size: Number(data.size || 0),
                mtime: data.server_modified
                    ? new Date(data.server_modified).getTime()
                    : (data.client_modified ? new Date(data.client_modified).getTime() : 0),
                etag: data.content_hash || undefined,
            };
        } catch (e) {
            const summary = e?.error?.error_summary || this._errMsg(e);
            if (/path\/not_found/i.test(summary) || /not_found/i.test(summary)) return null;
            throw e;
        }
    }

    async *list(prefix, ctx) {
        const target = this._resolve(prefix || '');
        let cursor = null;
        try {
            const first = await this._dbx.filesListFolder({
                path: target,
                recursive: true,
                include_deleted: false,
                include_has_explicit_shared_members: false,
            });
            const r1 = first?.result || first || {};
            yield* this._yieldEntries(r1.entries || [], ctx);
            if (r1.has_more) cursor = r1.cursor;
        } catch (e) {
            const summary = e?.error?.error_summary || this._errMsg(e);
            // 409 path/not_found just means the prefix doesn't exist —
            // list() must return empty in that case to match the contract.
            if (/path\/not_found/i.test(summary) || /not_found/i.test(summary)) return;
            throw e;
        }

        while (cursor) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            const r = await this._dbx.filesListFolderContinue({ cursor });
            const data = r?.result || r || {};
            yield* this._yieldEntries(data.entries || [], ctx);
            cursor = data.has_more ? data.cursor : null;
        }
    }

    *_yieldEntries(entries, ctx) {
        for (const entry of entries) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            if (entry['.tag'] !== 'file') continue;
            const absPath = entry.path_display || entry.path_lower || entry.name;
            // Trim our configured root to keep names symmetric with
            // upload/delete inputs.
            let rel = absPath;
            if (this._remoteRoot && this._remoteRoot !== '/' &&
                rel.toLowerCase().startsWith(this._remoteRoot.toLowerCase() + '/')) {
                rel = rel.slice(this._remoteRoot.length + 1);
            } else if (rel.startsWith('/')) {
                rel = rel.slice(1);
            }
            yield {
                name: rel,
                size: Number(entry.size || 0),
                mtime: entry.server_modified
                    ? new Date(entry.server_modified).getTime()
                    : (entry.client_modified ? new Date(entry.client_modified).getTime() : 0),
            };
        }
    }

    async testConnection(_ctx) {
        try {
            const acct = await this._dbx.usersGetCurrentAccount();
            const data = acct?.result || acct || {};
            const email = data.email || 'unknown';
            // Probe the remote root too — surfaces "folder doesn't exist"
            // before the first upload.
            try {
                await this._dbx.filesGetMetadata({ path: this._remoteRoot });
            } catch (e) {
                const summary = e?.error?.error_summary || this._errMsg(e);
                if (/not_found/i.test(summary)) {
                    await this._ensureFolder(this._remoteRoot);
                }
            }
            return {
                ok: true,
                detail: `Authorised as ${email} — root ${this._remoteRoot} ready`,
            };
        } catch (e) {
            const msg = this._errMsg(e);
            if (/invalid_grant/i.test(msg)) {
                return { ok: false, detail: 'Refresh token rejected. Re-generate via the developer console.' };
            }
            return { ok: false, detail: msg };
        }
    }

    /** Best-effort error → string. Dropbox SDK errors carry an
     *  error_summary on the deeply nested `error.error_summary` path. */
    _errMsg(e) {
        if (!e) return 'unknown error';
        if (typeof e === 'string') return e;
        if (e.error?.error_summary) return e.error.error_summary;
        if (e.error?.error?.['.tag']) return String(e.error.error['.tag']);
        return e.message || String(e);
    }

    async close() {
        // SDK uses HTTP keep-alive; nothing to close. Drop refs so a
        // re-init starts clean.
        this._dbx = null;
        this._Dropbox = null;
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

