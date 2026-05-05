// Google Drive provider — wraps the optional `googleapis` dependency.
//
// Auth model: the operator generates an OAuth2 refresh token externally
// (we document the Google OAuth Playground flow in docs/BACKUP.md) and
// pastes clientId + clientSecret + refreshToken into the wizard. The
// SDK refreshes access tokens server-side as needed; access tokens
// never round-trip through the dashboard.
//
// Drive's folder model is graph-shaped (a file's path is `parents`,
// not a string), so we maintain a local `Map<posixPath, folderId>`
// cache. Each upload walks the path → ensureFolder() chain once,
// caches every intermediate folder id, and reuses the cache on the
// next upload. The cache resets on init() so a folder deletion in
// the Drive UI doesn't leave stale entries.
//
// Every uploaded file is stamped with `appProperties: { 'tgdl-backup': '1' }`
// so list() can scope to ours via a Drive query and we don't accidentally
// list / delete files the operator created by hand under the same
// folder.
//
// Quotas: Drive enforces 750 GB/day egress per account (and various
// burst-rate limits). On 403 the SDK throws — we let the manager's
// queue retry-with-backoff handle it, the same as transient network
// errors.

import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { BackupProvider, optionalDepError } from './base.js';
import { encryptStream } from '../encryption.js';

const APP_PROPERTY_KEY = 'tgdl-backup';
const APP_PROPERTY_VALUE = '1';
const DEFAULT_PAGE_SIZE = 200;

export class GoogleDriveProvider extends BackupProvider {
    static get name() { return 'gdrive'; }
    static get displayName() { return 'Google Drive'; }
    static get configSchema() {
        return [
            { name: 'clientId',     label: 'OAuth client ID',          type: 'text',     required: true,
                placeholder: '...apps.googleusercontent.com',
                help: 'From Google Cloud Console → Credentials → OAuth client ID (Desktop app).' },
            { name: 'clientSecret', label: 'OAuth client secret',      type: 'password', secret: true, required: true },
            { name: 'refreshToken', label: 'OAuth refresh token',      type: 'password', secret: true, required: true,
                help: 'Generate via the Google OAuth Playground — see the walkthrough below.' },
            { name: 'folderName',   label: 'Backup folder name',       type: 'text',
                placeholder: 'tgdl-backup',
                help: 'A folder with this name is auto-created at My Drive root if folderId is empty.' },
            { name: 'folderId',     label: 'Folder ID (optional)',     type: 'text',
                placeholder: 'leave blank to create one',
                help: 'Paste the destination folder ID from its Drive URL if you\'ve already made one.' },
        ];
    }

    constructor() {
        super();
        this._google = null;
        this._oauth2 = null;
        this._drive = null;
        this._rootFolderId = null;
        this._rootFolderName = 'tgdl-backup';
        this._folderCache = new Map();        // POSIX path under root → folderId
    }

    async init(cfg, _ctx) {
        try {
            const mod = await import('googleapis');
            this._google = mod.google;
        } catch {
            throw optionalDepError('gdrive', 'googleapis');
        }
        const clientId = String(cfg?.clientId || '').trim();
        const clientSecret = String(cfg?.clientSecret || '').trim();
        const refreshToken = String(cfg?.refreshToken || '').trim();
        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error(
                'Google Drive needs clientId + clientSecret + refreshToken. ' +
                'See docs/BACKUP.md → "Google Drive setup" for the OAuth walkthrough.',
            );
        }
        this._oauth2 = new this._google.auth.OAuth2(clientId, clientSecret);
        this._oauth2.setCredentials({ refresh_token: refreshToken });
        this._drive = this._google.drive({ version: 'v3', auth: this._oauth2 });

        this._rootFolderName = String(cfg?.folderName || 'tgdl-backup').trim() || 'tgdl-backup';
        this._rootFolderId = String(cfg?.folderId || '').trim() || null;
        this._folderCache = new Map();

        // Verify the OAuth refresh token actually works before we trust
        // it. about.get is cheap and well-defined.
        try {
            await this._drive.about.get({ fields: 'user(emailAddress)' });
        } catch (e) {
            const msg = e?.message || String(e);
            if (/invalid_grant/i.test(msg)) {
                throw new Error(
                    'Google Drive auth failed: refresh token rejected (invalid_grant). ' +
                    'It may be expired or revoked — re-generate via the OAuth Playground.',
                );
            }
            throw new Error(`Google Drive auth failed: ${msg}`);
        }

        // Resolve the root folder id (create if missing).
        if (!this._rootFolderId) {
            this._rootFolderId = await this._ensureFolder(this._rootFolderName, 'root');
        } else {
            // Sanity-check the supplied folderId.
            try {
                await this._drive.files.get({
                    fileId: this._rootFolderId,
                    fields: 'id, name, mimeType, trashed',
                });
            } catch (e) {
                throw new Error(
                    `Google Drive folder "${this._rootFolderId}" not found or not accessible: ${e.message}`,
                );
            }
        }
        this._folderCache.set('', this._rootFolderId);
    }

    /** Find OR create a folder with the given name under `parentId`. */
    async _ensureFolder(name, parentId) {
        const escaped = String(name).replace(/'/g, "\\'");
        // Search for an existing non-trashed folder with the exact name.
        const r = await this._drive.files.list({
            q: `name='${escaped}' and '${parentId}' in parents and ` +
               `mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
            pageSize: 10,
            spaces: 'drive',
        });
        const existing = (r.data?.files || [])[0];
        if (existing) return existing.id;
        const created = await this._drive.files.create({
            requestBody: {
                name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
                appProperties: { [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE },
            },
            fields: 'id',
        });
        return created.data.id;
    }

    /** Resolve a POSIX-relative dir path under the root, creating each
     *  segment as needed. Returns the leaf folder id and updates the
     *  cache for every intermediate path. */
    async _ensurePathFolders(dirPath) {
        const norm = String(dirPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!norm) return this._rootFolderId;
        if (this._folderCache.has(norm)) return this._folderCache.get(norm);

        const segments = norm.split('/').filter(Boolean);
        let parentId = this._rootFolderId;
        let acc = '';
        for (const seg of segments) {
            acc = acc ? `${acc}/${seg}` : seg;
            if (this._folderCache.has(acc)) {
                parentId = this._folderCache.get(acc);
                continue;
            }
            const folderId = await this._ensureFolder(seg, parentId);
            this._folderCache.set(acc, folderId);
            parentId = folderId;
        }
        return parentId;
    }

    /** Find a file by POSIX path under the root. Returns the Drive file
     *  metadata (`id`, `size`, `modifiedTime`, `md5Checksum`) or null. */
    async _findFile(remotePath) {
        const norm = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!norm) return null;
        const dir = path.posix.dirname(norm);
        const name = path.posix.basename(norm);
        const dirKey = dir === '.' ? '' : dir;
        let parentId;
        try {
            // Don't auto-create the parent folder when stat-ing.
            parentId = await this._lookupFolder(dirKey);
        } catch {
            return null;
        }
        if (!parentId) return null;
        const escapedName = name.replace(/'/g, "\\'");
        const r = await this._drive.files.list({
            q: `name='${escapedName}' and '${parentId}' in parents and trashed=false ` +
               `and mimeType!='application/vnd.google-apps.folder'`,
            fields: 'files(id, name, size, modifiedTime, md5Checksum, appProperties)',
            pageSize: 1,
            spaces: 'drive',
        });
        return (r.data?.files || [])[0] || null;
    }

    /** Read-only path → folderId resolver. Returns null when any
     *  intermediate segment is missing — never creates folders. */
    async _lookupFolder(dirPath) {
        const norm = String(dirPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!norm) return this._rootFolderId;
        if (this._folderCache.has(norm)) return this._folderCache.get(norm);
        let parentId = this._rootFolderId;
        let acc = '';
        for (const seg of norm.split('/').filter(Boolean)) {
            acc = acc ? `${acc}/${seg}` : seg;
            if (this._folderCache.has(acc)) {
                parentId = this._folderCache.get(acc);
                continue;
            }
            const escaped = seg.replace(/'/g, "\\'");
            const r = await this._drive.files.list({
                q: `name='${escaped}' and '${parentId}' in parents and ` +
                   `mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id, name)',
                pageSize: 1,
                spaces: 'drive',
            });
            const existing = (r.data?.files || [])[0];
            if (!existing) return null;
            this._folderCache.set(acc, existing.id);
            parentId = existing.id;
        }
        return parentId;
    }

    async upload(localPath, remotePath, opts, ctx) {
        const norm = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const dir = path.posix.dirname(norm);
        const name = path.posix.basename(norm);
        const parentId = await this._ensurePathFolders(dir === '.' ? '' : dir);

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

        // Idempotency: if a file with the same name already exists in
        // the parent folder, REPLACE it (update with new media) rather
        // than creating a duplicate. Drive happily allows two files
        // with the same name + parent — we don't want that.
        const existing = await this._findFile(norm);
        let result;
        if (existing) {
            result = await this._drive.files.update({
                fileId: existing.id,
                requestBody: {
                    appProperties: { [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE },
                },
                media: { body },
                fields: 'id, size, md5Checksum, modifiedTime',
            });
        } else {
            result = await this._drive.files.create({
                requestBody: {
                    name,
                    parents: [parentId],
                    appProperties: { [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE },
                },
                media: { body },
                fields: 'id, size, md5Checksum, modifiedTime',
            });
        }

        const data = result.data || {};
        return {
            remotePath,
            bytes: Number(data.size || 0),
            etag: data.md5Checksum || null,
            remoteId: data.id || undefined,
        };
    }

    async delete(remotePath, _ctx) {
        const found = await this._findFile(remotePath);
        if (!found) return; // idempotent
        try {
            await this._drive.files.delete({ fileId: found.id });
        } catch (e) {
            // 404 = already gone, fine.
            if (e?.code === 404) return;
            throw e;
        }
    }

    async stat(remotePath, _ctx) {
        const found = await this._findFile(remotePath);
        if (!found) return null;
        return {
            size: Number(found.size || 0),
            mtime: found.modifiedTime ? new Date(found.modifiedTime).getTime() : 0,
            etag: found.md5Checksum || undefined,
        };
    }

    async *list(prefix, ctx) {
        // Walk the folder tree under the resolved prefix, yielding files
        // (relative paths) along the way. We resolve the start folder
        // once, then BFS the children.
        const norm = String(prefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const startFolderId = norm ? await this._lookupFolder(norm) : this._rootFolderId;
        if (!startFolderId) return;
        const stack = [{ folderId: startFolderId, relPath: norm }];
        while (stack.length) {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            const { folderId, relPath } = stack.pop();
            let pageToken;
            do {
                if (ctx?.signal?.aborted) throw new Error('aborted');
                const r = await this._drive.files.list({
                    q: `'${folderId}' in parents and trashed=false`,
                    fields: 'nextPageToken, files(id, name, size, modifiedTime, mimeType, md5Checksum)',
                    pageSize: DEFAULT_PAGE_SIZE,
                    pageToken,
                    spaces: 'drive',
                });
                for (const f of (r.data?.files || [])) {
                    if (ctx?.signal?.aborted) throw new Error('aborted');
                    const childRel = relPath ? `${relPath}/${f.name}` : f.name;
                    if (f.mimeType === 'application/vnd.google-apps.folder') {
                        stack.push({ folderId: f.id, relPath: childRel });
                    } else {
                        yield {
                            name: childRel,
                            size: Number(f.size || 0),
                            mtime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0,
                        };
                    }
                }
                pageToken = r.data?.nextPageToken;
            } while (pageToken);
        }
    }

    async testConnection(_ctx) {
        try {
            const r = await this._drive.about.get({ fields: 'user(emailAddress, displayName), storageQuota' });
            const email = r.data?.user?.emailAddress || 'unknown';
            const folderHint = this._rootFolderId
                ? ` — backup folder id ${this._rootFolderId}`
                : '';
            return {
                ok: true,
                detail: `Authorised as ${email}${folderHint}`,
            };
        } catch (e) {
            const msg = e?.message || String(e);
            if (/invalid_grant/i.test(msg)) {
                return {
                    ok: false,
                    detail: 'Refresh token rejected (invalid_grant). Re-generate via the OAuth Playground.',
                };
            }
            return { ok: false, detail: msg };
        }
    }

    async close() {
        // No persistent socket to close — googleapis uses HTTP keep-alive
        // managed by the global Node agent. Drop refs so the next init
        // starts fresh.
        this._drive = null;
        this._oauth2 = null;
        this._google = null;
        this._folderCache.clear();
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
