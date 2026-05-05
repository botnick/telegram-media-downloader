// S3-compatible provider — covers AWS S3, Cloudflare R2, Backblaze B2,
// MinIO, Wasabi, DigitalOcean Spaces and the rest of the S3-API ecosystem
// in one driver. Provider-specific quirks (R2's missing CRC, B2's
// `endpoint_url` shape) are fronted by the generic
// `endpoint + region + bucket` config.
//
// The `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` packages are listed
// as required (NOT optional) dependencies in package.json — installing
// at least one S3-shaped destination is the single most common backup
// setup, so we don't gate it behind an extra `npm install`.
//
// All paths inside `bucket` use `prefix/...` as a POSIX-style key
// — never a leading `/` (which AWS treats as a separate empty top-level
// folder).

import fs from 'fs';
import { Transform } from 'stream';
import path from 'path';
import {
    S3Client,
    DeleteObjectCommand,
    HeadObjectCommand,
    HeadBucketCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { BackupProvider } from './base.js';
import { encryptStream } from '../encryption.js';

export class S3Provider extends BackupProvider {
    static get name() { return 's3'; }
    static get displayName() { return 'S3-compatible (AWS / R2 / B2 / MinIO / Wasabi)'; }
    static get configSchema() {
        return [
            {
                name: 'endpoint',
                label: 'Endpoint URL',
                type: 'text',
                placeholder: 'https://s3.us-east-1.amazonaws.com',
                help: 'Full URL. AWS users can leave blank to use the default. R2: https://<acct>.r2.cloudflarestorage.com. B2: https://s3.<region>.backblazeb2.com.',
            },
            {
                name: 'region',
                label: 'Region',
                type: 'text',
                required: true,
                placeholder: 'us-east-1',
                help: 'R2: "auto". B2: matches the endpoint.',
            },
            {
                name: 'bucket',
                label: 'Bucket',
                type: 'text',
                required: true,
                placeholder: 'tgdl-backup',
            },
            {
                name: 'accessKeyId',
                label: 'Access key ID',
                type: 'text',
                required: true,
                secret: true,
            },
            {
                name: 'secretAccessKey',
                label: 'Secret access key',
                type: 'password',
                required: true,
                secret: true,
            },
            {
                name: 'prefix',
                label: 'Prefix (optional)',
                type: 'text',
                placeholder: 'tgdl/',
                help: 'Object keys will be stored under this prefix. Trailing slash optional.',
            },
            {
                name: 'forcePathStyle',
                label: 'Force path-style addressing',
                type: 'select',
                options: [
                    { value: 'auto',  label: 'Auto (off for AWS, on for MinIO)' },
                    { value: 'true',  label: 'On' },
                    { value: 'false', label: 'Off' },
                ],
                help: 'MinIO and some self-hosted gateways require path-style. Cloud S3 / R2 / B2 don\'t.',
            },
        ];
    }

    constructor() {
        super();
        this.client = null;
        this.bucket = null;
        this.prefix = '';
    }

    async init(cfg, _ctx) {
        const region = String(cfg?.region || '').trim();
        const bucket = String(cfg?.bucket || '').trim();
        const accessKeyId = String(cfg?.accessKeyId || '').trim();
        const secretAccessKey = String(cfg?.secretAccessKey || '').trim();
        if (!region) throw new Error('region required');
        if (!bucket) throw new Error('bucket required');
        if (!accessKeyId || !secretAccessKey) {
            throw new Error('accessKeyId + secretAccessKey required');
        }
        const endpoint = (cfg?.endpoint || '').trim() || undefined;
        let forcePathStyle;
        const fps = String(cfg?.forcePathStyle ?? 'auto').toLowerCase();
        if (fps === 'true') forcePathStyle = true;
        else if (fps === 'false') forcePathStyle = false;
        else if (endpoint && /(localhost|127\.0\.0\.1|minio)/i.test(endpoint)) {
            forcePathStyle = true;
        }

        this.client = new S3Client({
            region,
            endpoint,
            forcePathStyle,
            credentials: { accessKeyId, secretAccessKey },
        });
        this.bucket = bucket;
        this.prefix = String(cfg?.prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
    }

    /** Build a full S3 key from a remote path. */
    _key(remotePath) {
        const norm = String(remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        return this.prefix ? `${this.prefix}/${norm}` : norm;
    }

    async upload(localPath, remotePath, opts, ctx) {
        const Key = this._key(remotePath);
        const ContentType = _guessContentType(remotePath);
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
        const uploader = new Upload({
            client: this.client,
            params: { Bucket: this.bucket, Key, Body: body, ContentType },
            // 8 MB parts × 4 in flight is a safe default — keeps memory
            // under 32 MB on a single upload, fits inside R2's 5 MB-min /
            // 5 GB-max part rules, and gives B2 / Wasabi enough parallelism
            // to saturate a 1 Gbps line.
            queueSize: 4,
            partSize: 8 * 1024 * 1024,
            leavePartsOnError: false,
        });
        if (ctx?.signal) {
            const onAbort = () => uploader.abort().catch(() => {});
            ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        const result = await uploader.done();
        // ETag from S3 has wrapping quotes — strip them for cleanliness.
        const etag = (result?.ETag || '').replace(/^"|"$/g, '') || undefined;
        const head = await this.stat(remotePath, ctx).catch(() => null);
        return {
            remotePath,
            bytes: head?.size || 0,
            etag,
            remoteId: result?.VersionId || undefined,
        };
    }

    async delete(remotePath, _ctx) {
        try {
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: this._key(remotePath),
            }));
        } catch (e) {
            // S3 returns 204 for both "deleted" and "didn't exist" — only
            // genuine network/auth errors land here.
            if (e?.$metadata?.httpStatusCode && e.$metadata.httpStatusCode >= 400
                && e.$metadata.httpStatusCode !== 404) {
                throw e;
            }
        }
    }

    async stat(remotePath, _ctx) {
        try {
            const r = await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: this._key(remotePath),
            }));
            return {
                size: Number(r?.ContentLength || 0),
                mtime: r?.LastModified ? new Date(r.LastModified).getTime() : 0,
                etag: (r?.ETag || '').replace(/^"|"$/g, '') || undefined,
            };
        } catch (e) {
            const code = e?.$metadata?.httpStatusCode;
            if (code === 404 || e?.name === 'NotFound' || e?.Code === 'NoSuchKey') return null;
            throw e;
        }
    }

    async *list(prefix, ctx) {
        let ContinuationToken;
        const Prefix = this._key(prefix || '');
        do {
            if (ctx?.signal?.aborted) throw new Error('aborted');
            const r = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix,
                ContinuationToken,
                MaxKeys: 1000,
            }));
            for (const obj of (r.Contents || [])) {
                // Trim our configured prefix back off so the caller sees
                // remote-paths in the same shape it passes in.
                let name = obj.Key || '';
                if (this.prefix && name.startsWith(this.prefix + '/')) {
                    name = name.slice(this.prefix.length + 1);
                }
                yield {
                    name,
                    size: Number(obj.Size || 0),
                    mtime: obj.LastModified ? new Date(obj.LastModified).getTime() : 0,
                };
            }
            ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (ContinuationToken);
    }

    async testConnection(_ctx) {
        try {
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
            return { ok: true, detail: `HeadBucket ${this.bucket} → 200` };
        } catch (e) {
            const code = e?.$metadata?.httpStatusCode;
            return { ok: false, detail: `${e.name || 'Error'}${code ? ' (' + code + ')' : ''}: ${e.message}` };
        }
    }

    async close() {
        try { this.client?.destroy?.(); } catch {}
        this.client = null;
    }
}

const _CT = {
    '.gz':   'application/gzip',
    '.tar':  'application/x-tar',
    '.tgz':  'application/gzip',
    '.zip':  'application/zip',
    '.json': 'application/json',
    '.txt':  'text/plain',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.mp4':  'video/mp4',
    '.mov':  'video/quicktime',
    '.mp3':  'audio/mpeg',
};
function _guessContentType(p) {
    const ext = path.posix.extname(String(p || '')).toLowerCase();
    return _CT[ext] || 'application/octet-stream';
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
