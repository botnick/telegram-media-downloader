// S3 provider — only runs if MINIO_TEST_ENDPOINT is set in the
// environment. The test is otherwise auto-skipped so CI keeps passing
// without network access.
//
// Local repro:
//
//   docker run -d --rm --name tgdl-test-minio \
//      -p 9000:9000 -e MINIO_ROOT_USER=test -e MINIO_ROOT_PASSWORD=test12345 \
//      minio/minio server /data
//   MINIO_TEST_ENDPOINT=http://127.0.0.1:9000 \
//   MINIO_TEST_ACCESS_KEY=test \
//   MINIO_TEST_SECRET=test12345 \
//   MINIO_TEST_BUCKET=tgdl-test \
//      npm test backup.providers.s3
//
// The bucket is auto-created on first run.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import crypto from 'crypto';

const ENDPOINT = process.env.MINIO_TEST_ENDPOINT;
const ACCESS = process.env.MINIO_TEST_ACCESS_KEY || 'minioadmin';
const SECRET = process.env.MINIO_TEST_SECRET || 'minioadmin';
const BUCKET = process.env.MINIO_TEST_BUCKET || 'tgdl-test';
const REGION = process.env.MINIO_TEST_REGION || 'us-east-1';

const RUN = !!ENDPOINT;
const describeS3 = RUN ? describe : describe.skip;

let SOURCE_DIR;
let provider;
const ctx = { destinationId: 1, log: () => {}, signal: new AbortController().signal };

if (RUN) {
    SOURCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-s3-src-'));
}

beforeAll(async () => {
    if (!RUN) return;
    const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
    const setupClient = new S3Client({
        endpoint: ENDPOINT, region: REGION, forcePathStyle: true,
        credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    });
    try {
        await setupClient.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch { /* already exists */ }

    const { S3Provider } = await import('@tgdl/core/backup/providers/s3');
    provider = new S3Provider();
    await provider.init({
        endpoint: ENDPOINT, region: REGION, bucket: BUCKET,
        accessKeyId: ACCESS, secretAccessKey: SECRET,
        prefix: 'tests/', forcePathStyle: 'true',
    }, ctx);
});

afterAll(async () => {
    if (!RUN) return;
    try { await provider?.close(); } catch {}
    if (SOURCE_DIR) fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
});

describeS3('backup/providers/s3 (requires MINIO_TEST_ENDPOINT)', () => {
    it('round-trips upload + stat + list + delete', async () => {
        const src = path.join(SOURCE_DIR, 'data.bin');
        const payload = crypto.randomBytes(64 * 1024);
        await fsp.writeFile(src, payload);

        const r = await provider.upload(src, 'group/photos/data.bin', {}, ctx);
        expect(r.bytes).toBe(payload.length);

        const st = await provider.stat('group/photos/data.bin', ctx);
        expect(st).not.toBeNull();
        expect(st.size).toBe(payload.length);

        const items = [];
        for await (const item of provider.list('group/photos', ctx)) items.push(item);
        expect(items.length).toBeGreaterThan(0);

        await provider.delete('group/photos/data.bin', ctx);
        expect(await provider.stat('group/photos/data.bin', ctx)).toBeNull();
    });

    it('reports testConnection ok', async () => {
        const r = await provider.testConnection(ctx);
        expect(r.ok).toBe(true);
    });
});
