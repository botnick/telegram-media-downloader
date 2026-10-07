// tgdl-core is the only implementation now, so what matters is how every
// failure surfaces:
//
//   - a file that can't be read fails exactly like fs (err.code, message);
//   - a path outside the allowed roots is answered in-process, same result;
//   - tgdl-core unavailable (missing binary, too old, not started) is a
//     GoCoreError with status 503 and a message that says how to fix it —
//     and the integrity sweep prunes nothing in that case;
//   - a malformed / truncated answer is an error, never a wrong result;
//   - a crash mid-request fails the requests in flight, calls made while
//     it restarts wait for it, and it never outlives its parent.
//
// Most cases use a fake tgdl-core (a local HTTP server); the last group
// runs the real binary.

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { PassThrough } from 'stream';
import { gzipSync } from 'zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { requireCoreBin } from './helpers/gocore-raw.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-gocore-client-'));
const DOWNLOADS = path.join(TMP, 'data', 'downloads');
const FILE = path.join(DOWNLOADS, 'sample ไทย 🎬.bin');
const PAYLOAD = crypto.randomBytes(3 * 1024 * 1024 + 11);
const EXPECTED = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const savedBin = process.env.TGDL_CORE_BIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client;
let checksum;
let gofs;
let spawnMod;
let faces;
const servers = [];

/** A fake tgdl-core. `routes[path](req, raw, res)`; /health is built in. */
async function fakeCore(routes, { features = ['hash', 'stat', 'walk', 'dbscan'] } = {}) {
    // A Map, so a request path can only ever pick one of the given routes.
    const routeMap = new Map(Object.entries(routes));
    const srv = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, service: 'tgdl-core', version: '9.9.9', features }));
            return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const route = routeMap.get(req.url.split('?')[0]);
            if (typeof route !== 'function') {
                return json(res, 404, { error: { code: 'ENOTFOUND' } });
            }
            route(req, Buffer.concat(chunks), res);
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    client.setEndpoint(`http://127.0.0.1:${srv.address().port}`, 'tok', features, '9.9.9');
    client.markHealthy({ features, version: '9.9.9' });
    return srv;
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

beforeAll(async () => {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    fs.writeFileSync(FILE, PAYLOAD);
    process.env.TGDL_DATA_DIR = path.join(TMP, 'data');
    delete process.env.TGDL_DOWNLOADS_DIR;
    delete process.env.TGDL_CORE_ALLOW_ROOTS;
    client = await import('../src/core/gocore/client.js');
    spawnMod = await import('../src/core/gocore/spawn.js');
    checksum = await import('../src/core/checksum.js');
    gofs = await import('../src/core/gocore/fs.js');
    faces = await import('../src/core/ai/faces.js');
});

afterEach(async () => {
    spawnMod.stopGoCore();
    spawnMod._resetForTests();
    client._resetForTests();
    process.env.TGDL_CORE_BIN = savedBin;
    while (servers.length) {
        const s = servers.pop();
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
    }
});

afterAll(async () => {
    try {
        (await import('../src/core/db.js')).getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    await sleep(200);
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
});

describe('answers from a (fake) tgdl-core', () => {
    it('passes only the Go worker tuning variables to the child', () => {
        const previous = {
            dbscan: process.env.TGDL_DBSCAN_WORKERS,
            faststart: process.env.FASTSTART_CONCURRENCY,
            thumbsImg: process.env.THUMBS_IMG_CONCURRENCY,
            thumbs: process.env.THUMBS_VID_CONCURRENCY,
            ffmpeg: process.env.FFMPEG_PATH,
            secret: process.env.TGDL_FACES_API_TOKEN,
        };
        process.env.TGDL_DBSCAN_WORKERS = '3';
        process.env.FASTSTART_CONCURRENCY = '1';
        process.env.THUMBS_IMG_CONCURRENCY = '5';
        process.env.THUMBS_VID_CONCURRENCY = '2';
        process.env.FFMPEG_PATH = '/tmp/ffmpeg';
        process.env.TGDL_FACES_API_TOKEN = 'must-not-leak';
        try {
            const env = spawnMod.childEnv('token', [DOWNLOADS]);
            expect(env).toMatchObject({
                TGDL_DBSCAN_WORKERS: '3',
                FASTSTART_CONCURRENCY: '1',
                THUMBS_IMG_CONCURRENCY: '5',
                THUMBS_VID_CONCURRENCY: '2',
                FFMPEG_PATH: '/tmp/ffmpeg',
                TGDL_CORE_DB: path.join(process.env.TGDL_DATA_DIR, 'db.sqlite'),
            });
            expect(env.TGDL_FACES_API_TOKEN).toBeUndefined();
        } finally {
            for (const [key, value] of Object.entries({
                TGDL_DBSCAN_WORKERS: previous.dbscan,
                FASTSTART_CONCURRENCY: previous.faststart,
                THUMBS_IMG_CONCURRENCY: previous.thumbsImg,
                THUMBS_VID_CONCURRENCY: previous.thumbs,
                FFMPEG_PATH: previous.ffmpeg,
            })) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            if (previous.secret === undefined) delete process.env.TGDL_FACES_API_TOKEN;
            else process.env.TGDL_FACES_API_TOKEN = previous.secret;
        }
    });

    it('pipes a ZIP response without buffering it in the client', async () => {
        const wire = Buffer.from('fake-zip-wire');
        await fakeCore(
            {
                '/v1/zip': (req, raw, res) => {
                    res.writeHead(200, { 'content-type': 'application/zip' });
                    res.end(wire);
                },
            },
            { features: ['zip'] },
        );
        const out = new PassThrough();
        out.setHeader = () => {};
        out.headersSent = false;
        const chunks = [];
        out.on('data', (chunk) => chunks.push(chunk));
        await client.pipeZip(out, [{ path: FILE, name: 'sample.bin' }]);
        expect(Buffer.concat(chunks)).toEqual(wire);
    });

    it('pipes a tar.gz response into a plain writable stream', async () => {
        const wire = gzipSync(Buffer.from('fake-tar-gz-wire'));
        let request;
        await fakeCore(
            {
                '/v1/tar-gz': (req, raw, res) => {
                    request = JSON.parse(raw);
                    res.writeHead(200, { 'content-type': 'application/gzip' });
                    res.end(wire);
                },
            },
            { features: ['tar-gz'] },
        );
        const out = new PassThrough();
        const chunks = [];
        out.on('data', (chunk) => chunks.push(chunk));
        await client.pipeTarGz(out, DOWNLOADS);
        expect(Buffer.concat(chunks)).toEqual(wire);
        expect(request).toEqual({ root: DOWNLOADS });
    });

    it('removes a tree while preserving the Go keep allowlist', async () => {
        let request;
        await fakeCore(
            {
                '/v1/fs/remove-tree': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, { kept: 2, removed: 3 });
                },
            },
            { features: ['remove-tree'] },
        );
        await expect(
            client.removeTree(DOWNLOADS, [FILE, path.join(DOWNLOADS, 'shared.jpg')]),
        ).resolves.toEqual({ kept: 2, removed: 3 });
        expect(request).toEqual({
            root: DOWNLOADS,
            keep: [FILE, path.join(DOWNLOADS, 'shared.jpg')],
        });
    });

    it('accepts the Go faststart result and rejects malformed status', async () => {
        let malformed = false;
        await fakeCore(
            {
                '/v1/faststart': (req, raw, res) =>
                    json(
                        res,
                        200,
                        malformed ? { status: 'wat' } : { status: 'optimized', newSize: 1234 },
                    ),
            },
            { features: ['faststart'] },
        );
        await expect(client.optimizeFaststart(FILE)).resolves.toEqual({
            status: 'optimized',
            newSize: 1234,
        });

        malformed = true;
        await expect(client.optimizeFaststart(FILE)).rejects.toMatchObject({ kind: 'protocol' });
    });

    it('writes a video thumbnail through the Go core client', async () => {
        await fakeCore(
            {
                '/v1/thumb/video': (req, raw, res) => json(res, 200, { status: 'ok', size: 456 }),
            },
            { features: ['thumb'] },
        );
        await expect(
            client.generateVideoThumb(FILE, path.join(DOWNLOADS, 'thumb.webp.tmp'), 320),
        ).resolves.toEqual({ status: 'ok', size: 456 });
    });

    it('writes image and audio thumbnails through the Go core client', async () => {
        await fakeCore(
            {
                '/v1/thumb/image': (req, raw, res) => json(res, 200, { status: 'ok', size: 123 }),
                '/v1/thumb/audio': (req, raw, res) => json(res, 200, { status: 'ok', size: 234 }),
            },
            { features: ['thumb'] },
        );
        await expect(
            client.generateImageThumb(FILE, path.join(DOWNLOADS, 'image.webp.tmp'), 320),
        ).resolves.toEqual({ status: 'ok', size: 123 });
        await expect(
            client.generateAudioThumb(FILE, path.join(DOWNLOADS, 'audio.webp.tmp'), 320),
        ).resolves.toEqual({ status: 'ok', size: 234 });
    });

    it('writes a seekbar sprite through the Go core client', async () => {
        await fakeCore(
            {
                '/v1/seekbar': (req, raw, res) => json(res, 200, { status: 'ok', size: 789 }),
            },
            { features: ['seekbar'] },
        );
        await expect(
            client.generateSeekbarSprite(FILE, path.join(DOWNLOADS, 'sprite.webp.tmp'), {
                frames: 12,
                intervalSec: 1.5,
                cols: 4,
                rows: 3,
                tileWidth: 160,
                format: 'webp',
                quality: 75,
            }),
        ).resolves.toEqual({ status: 'ok', size: 789 });
    });

    it('reads group aggregates through the Go DB projection', async () => {
        await fakeCore(
            {
                '/v1/db/group-aggregates': (req, raw, res) =>
                    json(res, 200, {
                        rows: [
                            {
                                group_id: '-1001',
                                best_name: 'Photos',
                                any_name: 'Unknown',
                                count: 4,
                                size: 1234,
                            },
                        ],
                    }),
            },
            { features: ['db'] },
        );
        await expect(client.groupAggregates()).resolves.toEqual([
            {
                group_id: '-1001',
                best_name: 'Photos',
                any_name: 'Unknown',
                count: 4,
                size: 1234,
            },
        ]);
    });

    it('reads database totals through the Go DB projection', async () => {
        await fakeCore(
            {
                '/v1/db/stats': (req, raw, res) =>
                    json(res, 200, { totalFiles: 12, totalSize: 3456 }),
            },
            { features: ['db'] },
        );
        await expect(client.databaseStats()).resolves.toEqual({ totalFiles: 12, totalSize: 3456 });
    });

    it('reads group stats and paginated files through the Go DB projection', async () => {
        await fakeCore(
            {
                '/v1/db/group-stats': (req, raw, res) =>
                    json(res, 200, {
                        totalFiles: 2,
                        totalBytes: 30,
                        byType: { photo: 1, video: 1 },
                        firstMessageId: 10,
                        lastMessageId: 11,
                        lastDownloadAt: '2026-01-02T00:00:00Z',
                    }),
                '/v1/db/group-files': (req, raw, res) =>
                    json(res, 200, {
                        rows: [{ id: 2, message_id: 11, file_name: 'b.mp4' }],
                        total: 1,
                        limit: 50,
                        offset: 0,
                        hasMore: false,
                    }),
            },
            { features: ['db'] },
        );
        await expect(client.groupStats('-1')).resolves.toMatchObject({ totalFiles: 2 });
        await expect(client.groupFiles({ groupId: '-1' })).resolves.toMatchObject({ total: 1 });
    });

    it('reads the local all-media page through the Go DB projection', async () => {
        await fakeCore(
            {
                '/v1/db/downloads/all': (req, raw, res) =>
                    json(res, 200, {
                        files: [{ id: 2, group_id: '-1', file_name: 'b.mp4' }],
                        total: 1,
                    }),
            },
            { features: ['db'] },
        );
        await expect(client.allDownloads({ type: 'videos' })).resolves.toMatchObject({ total: 1 });
    });

    it('reads a local per-group gallery page through the Go DB projection', async () => {
        await fakeCore(
            {
                '/v1/db/downloads/group': (req, raw, res) =>
                    json(res, 200, {
                        files: [{ id: 2, group_id: '-1', file_name: 'b.mp4', pinned: 0 }],
                        total: 1,
                    }),
            },
            { features: ['db'] },
        );
        await expect(
            client.downloadsGroup({ groupId: '-1', type: 'videos' }),
        ).resolves.toMatchObject({ total: 1 });
    });

    it('reads a local search page through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/downloads/search': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        files: [{ id: 2, group_id: '-1', file_name: 'b.mp4' }],
                        total: 1,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.searchDownloads({
                query: 'cool',
                groupId: '-1',
                type: 'videos',
                limit: 3,
                offset: 6,
                pinnedOnly: true,
                pinnedFirst: true,
                order: 'newest',
            }),
        ).resolves.toMatchObject({ total: 1 });
        expect(request).toMatchObject({
            query: 'cool',
            groupId: '-1',
            type: 'videos',
            limit: 3,
            offset: 6,
            pinnedOnly: true,
            pinnedFirst: true,
            order: 'newest',
        });
    });

    it('reads the joined share-link page through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/share-links': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [{ id: 1, download_id: 2, file_name: 'b.mp4' }],
                        total: 1,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.shareLinks({
                downloadId: 2,
                includeRevoked: false,
                limit: 10,
                offset: 20,
                search: 'b.mp4',
            }),
        ).resolves.toMatchObject({ total: 1 });
        expect(request).toMatchObject({
            downloadId: 2,
            includeRevoked: false,
            limit: 10,
            offset: 20,
            search: 'b.mp4',
        });
    });

    it('reads update history through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/update-history': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, { history: [{ id: 4, status: 'failed' }] });
                },
            },
            { features: ['db'] },
        );
        await expect(client.updateHistory({ limit: 3 })).resolves.toEqual({
            history: [{ id: 4, status: 'failed' }],
        });
        expect(request).toEqual({ limit: 3 });
    });

    it('reads NSFW tier counters through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/nsfw-tiers': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        tiers: { def_not: 1, maybe_not: 2 },
                        scanned: 3,
                        unscanned: 4,
                        whitelisted: 1,
                        totalEligible: 7,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(client.nsfwTiers({ fileTypes: ['photo', 'video'] })).resolves.toMatchObject({
            scanned: 3,
            totalEligible: 7,
        });
        expect(request).toEqual({ fileTypes: ['photo', 'video'] });
    });

    it('reads an NSFW histogram through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/nsfw-histogram': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, { bins: 4, counts: [1, 0, 2, 0] });
                },
            },
            { features: ['db'] },
        );
        await expect(client.nsfwHistogram({ fileTypes: ['photo'], bins: 4 })).resolves.toEqual({
            bins: 4,
            counts: [1, 0, 2, 0],
        });
        expect(request).toEqual({ fileTypes: ['photo'], bins: 4 });
    });

    it('reads the paginated NSFW review list through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/nsfw-list': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [{ id: 1, file_name: 'a.jpg', nsfw_score: 0.2 }],
                        total: 1,
                        page: 2,
                        totalPages: 2,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.nsfwList({
                tier: 'def_not',
                fileTypes: ['photo'],
                groupId: '-1',
                includeWhitelisted: true,
                page: 2,
                limit: 1,
                fileKind: 'photo',
            }),
        ).resolves.toMatchObject({ total: 1, page: 2 });
        expect(request).toMatchObject({
            tier: 'def_not',
            fileTypes: ['photo'],
            groupId: '-1',
            includeWhitelisted: true,
            page: 2,
            limit: 1,
            fileKind: 'photo',
        });
    });

    it('reads the bounded unscanned NSFW queue through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/nsfw-candidates': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [
                            {
                                id: 3,
                                group_id: '-2',
                                group_name: 'Group 2',
                                file_name: 'c.pdf',
                                file_path: 'G/documents/c.pdf',
                                file_type: 'document',
                                file_size: 20,
                                created_at: '2026-01-03T00:00:00Z',
                            },
                        ],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.nsfwCandidates({ fileTypes: ['photo', 'video'], limit: 12 }),
        ).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 3, file_type: 'document' })],
        });
        expect(request).toEqual({ fileTypes: ['photo', 'video'], limit: 12 });
    });

    it('reads the local people page through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/people': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, { people: [{ id: 1, label: 'Alice' }], total: 1 });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.peopleList({ limit: 2, offset: 4, sort: 'name', dir: 'asc' }),
        ).resolves.toMatchObject({ total: 1 });
        expect(request).toEqual({ limit: 2, offset: 4, sort: 'name', dir: 'asc' });
    });

    it('reads the thumbnail maintenance catalog through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/thumbs-list': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [{ id: 1, file_name: 'a.jpg', file_type: 'photo', cached: true }],
                        nextCursor: 1,
                        hasMore: true,
                        total: 3,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.thumbsList({
                limit: 2,
                cursor: 4,
                kind: 'image',
                cachedOnly: true,
                cacheRoot: '/tmp/thumbs',
            }),
        ).resolves.toMatchObject({ total: 3, hasMore: true });
        expect(request).toEqual({
            limit: 2,
            cursor: 4,
            kind: 'image',
            cachedOnly: true,
            cacheRoot: '/tmp/thumbs',
        });
    });

    it('reads the seekbar catalog through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/seekbar-list': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [{ id: 2, duration_sec: 12.5, file_name: 'b.mp4' }],
                        total: 1,
                        limit: 1,
                        offset: 3,
                        hasMore: false,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(client.seekbarList({ limit: 1, offset: 3 })).resolves.toMatchObject({
            total: 1,
            offset: 3,
        });
        expect(request).toEqual({ limit: 1, offset: 3 });
    });

    it('reads seekbar cache counters through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/seekbar-stats': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, { count: 4, bytes: 4096, totalVideos: 12 });
                },
            },
            { features: ['db'] },
        );
        await expect(client.seekbarStats()).resolves.toEqual({
            count: 4,
            bytes: 4096,
            totalVideos: 12,
        });
        expect(request).toEqual({});
    });

    it('reads the keyset seekbar backlog through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/seekbar-candidates': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [
                            {
                                id: 2,
                                file_path: 'G/videos/b.mp4',
                                file_type: 'video',
                                file_size: 20,
                                file_name: 'b.mp4',
                            },
                        ],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(client.seekbarCandidates({ beforeId: 99, limit: 10 })).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 2, file_type: 'video' })],
        });
        expect(request).toEqual({ beforeId: 99, limit: 10 });
    });

    it('reads face boxes through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/faces-by-download': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        success: true,
                        downloadId: 2,
                        faces: [
                            {
                                id: 9,
                                x: 0.1,
                                y: 0.2,
                                w: 0.3,
                                h: 0.4,
                                person_id: null,
                                quality_score: 0.8,
                                person_label: null,
                            },
                        ],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(client.facesByDownload(2)).resolves.toMatchObject({
            success: true,
            downloadId: 2,
            faces: [expect.objectContaining({ id: 9, x: 0.1 })],
        });
        expect(request).toEqual({ downloadId: 2 });
    });

    it('reads compact person groups through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/person-groups': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        success: true,
                        groups: [{ id: 1, label: 'Alice', face_count: 2, cover_download_id: 2 }],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(client.personGroups({ limit: 1 })).resolves.toMatchObject({
            success: true,
            groups: [expect.objectContaining({ id: 1, face_count: 2 })],
        });
        expect(request).toEqual({ limit: 1 });
    });

    it('reads a person gallery through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/person-photos': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        success: true,
                        personId: 1,
                        files: [
                            {
                                id: 2,
                                file_name: 'b.mp4',
                                file_path: 'G/videos/b.mp4',
                                file_type: 'video',
                                file_size: 20,
                                created_at: '2026-01-02T00:00:00Z',
                                group_id: '-1',
                                group_name: 'Cool Channel',
                                message_id: 11,
                                face_id: 2,
                                face_x: 0.1,
                                face_y: 0.2,
                                face_w: 0.3,
                                face_h: 0.4,
                            },
                        ],
                        total: 1,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.personPhotos({ personId: 1, limit: 1, offset: 2 }),
        ).resolves.toMatchObject({
            success: true,
            personId: 1,
            files: [expect.objectContaining({ id: 2, face_id: 2 })],
        });
        expect(request).toEqual({ personId: 1, limit: 1, offset: 2 });
    });

    it('reads AI maintenance counters through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/ai-counts': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        totalEligible: 2,
                        indexed: 1,
                        unindexed: 1,
                        withEmbedding: 1,
                        withFaces: 1,
                        withTags: 1,
                        peopleCount: 1,
                        totalFaces: 1,
                        noiseFaces: 0,
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(client.aiCounts({ fileTypes: ['photo', 'video'] })).resolves.toMatchObject({
            totalEligible: 2,
            indexed: 1,
        });
        expect(request).toEqual({ fileTypes: ['photo', 'video'] });
    });

    it('reads bounded unindexed AI candidates through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/ai-candidates': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [
                            {
                                id: 7,
                                group_id: '-1',
                                group_name: 'Cool Channel',
                                file_name: 'a.jpg',
                                file_path: 'G/images/a.jpg',
                                file_type: 'photo',
                                file_size: 20,
                                created_at: '2026-01-01T00:00:00Z',
                            },
                        ],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.aiCandidates({ fileTypes: ['photo', 'video'], limit: 12 }),
        ).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 7, file_path: 'G/images/a.jpg' })],
        });
        expect(request).toEqual({ fileTypes: ['photo', 'video'], limit: 12 });
    });

    it('reads grouped recovery counters through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/recovery-stats': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [{ group_id: '-1', files: 2, lastSeen: '2026-01-02T00:00:00Z' }],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(client.recoveryStats()).resolves.toMatchObject({
            rows: [expect.objectContaining({ group_id: '-1', files: 2 })],
        });
        expect(request).toEqual({});
    });

    it('reads cluster catalog deltas and searches through the Go DB projection', async () => {
        const requests = [];
        await fakeCore(
            {
                '/v1/db/cluster-downloads': (req, raw, res) => {
                    requests.push([req, JSON.parse(raw)]);
                    json(res, 200, { rows: [{ id: 4, group_id: '-2', file_name: 'c.pdf' }] });
                },
                '/v1/db/cluster-downloads-since': (req, raw, res) => {
                    requests.push([req, JSON.parse(raw)]);
                    json(res, 200, {
                        rows: [
                            {
                                id: 2,
                                group_id: '-1',
                                group_name: 'Cool Channel',
                                message_id: 11,
                                file_name: 'b.mp4',
                                file_size: 20,
                                file_type: 'video',
                                file_path: 'G/videos/b.mp4',
                                file_hash: null,
                                status: 'completed',
                                created_at: '2026-01-02T00:00:00Z',
                                nsfw_score: 0.25,
                            },
                        ],
                    });
                },
                '/v1/db/cluster-search': (req, raw, res) => {
                    requests.push([req, JSON.parse(raw)]);
                    json(res, 200, { rows: [{ id: 2, group_id: '-1', file_name: 'b.mp4' }] });
                },
            },
            { features: ['db'] },
        );
        await expect(client.clusterDownloads({ limit: 2, offset: 1 })).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 4, file_name: 'c.pdf' })],
        });
        await expect(client.clusterDownloadsSince({ sinceId: 1, limit: 2 })).resolves.toMatchObject(
            {
                rows: [expect.objectContaining({ id: 2, file_name: 'b.mp4' })],
            },
        );
        await expect(client.clusterSearch({ query: 'Cool', limit: 10 })).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 2, group_id: '-1' })],
        });
        expect(requests.map(([req, body]) => [req.method, body])).toEqual([
            ['POST', { limit: 2, offset: 1 }],
            ['POST', { sinceId: 1, limit: 2 }],
            ['POST', { query: 'Cool', limit: 10 }],
        ]);
    });

    it('reads Telegram media dedup candidates through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/telegram-media-candidates': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [
                            {
                                id: 2,
                                group_id: '-1',
                                group_name: 'Cool Channel',
                                message_id: 11,
                                file_name: 'b.mp4',
                                file_size: 20,
                                file_type: 'video',
                                file_path: 'G/videos/b.mp4',
                                file_hash: null,
                                telegram_media_kind: 'document',
                                telegram_media_id: 'doc-2',
                                telegram_media_size: 20,
                            },
                        ],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.telegramMediaCandidates({ kind: 'document', id: 'doc-2', size: 20 }),
        ).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 2, telegram_media_id: 'doc-2' })],
        });
        expect(request).toEqual({ kind: 'document', id: 'doc-2', size: 20 });
    });

    it('reads content-hash dedup candidates through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/file-hash-candidates': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [{ id: 7, file_path: 'G/videos/duplicate.mp4', file_size: 20 }],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.fileHashCandidates({ hash: 'a'.repeat(64), size: 20 }),
        ).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 7, file_size: 20 })],
        });
        expect(request).toEqual({ hash: 'a'.repeat(64), size: 20 });
    });

    it('reads filename/size dedup candidates through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/file-name-candidates': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        rows: [{ id: 8, file_path: 'G/images/same.jpg', file_size: 12 }],
                    });
                },
            },
            { features: ['db'] },
        );
        await expect(
            client.fileNameCandidates({ groupId: '-3', fileName: 'same.jpg', size: 12 }),
        ).resolves.toMatchObject({
            rows: [expect.objectContaining({ id: 8, file_path: 'G/images/same.jpg' })],
        });
        expect(request).toEqual({ groupId: '-3', fileName: 'same.jpg', size: 12 });
    });

    it('reads dedup coverage counters through the Go DB projection', async () => {
        let request;
        await fakeCore(
            {
                '/v1/db/dedup-stats': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, { totalFiles: 12, hashed: 9, missing: 2 });
                },
            },
            { features: ['db'] },
        );
        await expect(client.dedupStats()).resolves.toEqual({
            totalFiles: 12,
            hashed: 9,
            missing: 2,
        });
        expect(request).toEqual({});
    });

    it('hashes a bounded batch and preserves per-file errors', async () => {
        let request;
        await fakeCore(
            {
                '/v1/hash-batch': (req, raw, res) => {
                    request = JSON.parse(raw);
                    json(res, 200, {
                        results: [
                            { sha256: EXPECTED, size: PAYLOAD.length, mtimeMs: 12 },
                            { code: 'ENOENT', message: 'missing' },
                        ],
                    });
                },
            },
            { features: ['hash-batch'] },
        );
        await expect(
            client.hashBatch([FILE, path.join(DOWNLOADS, 'missing.bin')]),
        ).resolves.toEqual([
            { sha256: EXPECTED, size: PAYLOAD.length, mtimeMs: 12 },
            { code: 'ENOENT', message: 'missing' },
        ]);
        expect(request).toEqual({ paths: [FILE, path.join(DOWNLOADS, 'missing.bin')] });
    });

    it('falls back to single-file hashing when hash-batch is unavailable', async () => {
        const requests = [];
        await fakeCore(
            {
                '/v1/hash': (req, raw, res) => {
                    requests.push(JSON.parse(raw).path);
                    json(res, 200, { sha256: EXPECTED, size: PAYLOAD.length, mtimeMs: 1 });
                },
            },
            { features: ['hash'] },
        );
        const { hashFilesViaCore } = await import('../src/core/gocore/hash.js');
        await expect(
            hashFilesViaCore([FILE, FILE], { sizes: [PAYLOAD.length, PAYLOAD.length] }),
        ).resolves.toEqual([{ sha256: EXPECTED }, { sha256: EXPECTED }]);
        expect(requests).toEqual([FILE, FILE]);
    });

    it('a file error (422) becomes the error fs would throw', async () => {
        const missing = path.join(DOWNLOADS, 'nope.bin');
        await fakeCore({
            '/v1/hash': (req, raw, res) =>
                json(res, 422, { error: { code: 'ENOENT', message: 'ENOENT: gone' } }),
        });
        const err = await checksum.sha256OfFile(missing).catch((e) => e);
        const want = await fs.promises.open(missing).catch((e) => e);
        expect({ code: err.code, syscall: err.syscall, message: err.message }).toEqual({
            code: want.code,
            syscall: want.syscall,
            message: want.message,
        });
    });

    it('EOUTSIDE (403) is answered in-process with the same digest', async () => {
        let calls = 0;
        await fakeCore({
            '/v1/hash': (req, raw, res) => {
                calls++;
                json(res, 403, { error: { code: 'EOUTSIDE', message: 'outside' } });
            },
        });
        expect(await checksum.sha256OfFile(FILE)).toBe(EXPECTED);
        expect(calls).toBe(1);
    });

    it('stat-batch: EOUTSIDE entries are answered by fs.stat, the rest as sent', async () => {
        await fakeCore({
            '/v1/fs/stat-batch': (req, raw, res) => {
                const { paths } = JSON.parse(raw);
                json(res, 200, {
                    results: paths.map((p, i) =>
                        i === 0 ? { code: 'EOUTSIDE' } : { code: 'ENOENT' },
                    ),
                });
            },
        });
        const st = fs.statSync(FILE);
        const res = await gofs.statMany([FILE, path.join(DOWNLOADS, 'x')]);
        expect(res).toEqual([
            { ok: true, size: st.size, mtimeMs: st.mtimeMs, isFile: true, isDir: false },
            { code: 'ENOENT' },
        ]);
    });

    it('malformed or truncated answers are errors, never results', async () => {
        await fakeCore({
            '/v1/hash': (req, raw, res) => json(res, 200, { sha256: 'nothex', size: 1 }),
            '/v1/fs/stat-batch': (req, raw, res) => json(res, 200, { results: [] }),
            '/v1/fs/walk': (req, raw, res) => {
                res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                res.end('{"t":"d","p":"a"}\n'); // no "end" line
            },
            '/v1/dbscan': (req, raw, res) => {
                res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                res.end(
                    '{"t":"result","count":2,"noiseCount":0,"starts":"","members":"","centroids":""}\n',
                );
            },
        });
        await expect(checksum.sha256OfFile(FILE)).rejects.toMatchObject({ kind: 'protocol' });
        await expect(gofs.statMany([FILE])).rejects.toMatchObject({ kind: 'protocol' });
        await expect(gofs.walkTree(DOWNLOADS)).rejects.toMatchObject({ kind: 'protocol' });
        const data = new Float32Array(4);
        await expect(
            faces.clusterFacesOffThread({ data, n: 2, dim: 2 }, { eps: 1, minPts: 2 }),
        ).rejects.toMatchObject({ kind: 'protocol' });
    });

    it('server errors keep their kind; nothing is retried into a wrong answer', async () => {
        await fakeCore({
            '/v1/hash': (req, raw, res) => json(res, 500, { error: { code: 'EINTERNAL' } }),
            '/v1/fs/stat-batch': (req, raw, res) => json(res, 401, { error: { code: 'EAUTH' } }),
            '/v1/fs/walk': (req, raw, res) => json(res, 503, { error: { code: 'EQUEUEFULL' } }),
        });
        await expect(checksum.sha256OfFile(FILE)).rejects.toMatchObject({ kind: 'server' });
        await expect(gofs.statMany([FILE])).rejects.toMatchObject({ kind: 'auth', status: 401 });
        await expect(gofs.walkTree(DOWNLOADS)).rejects.toMatchObject({ kind: 'busy' });
    });

    it('a dropped connection or a timeout is an error', async () => {
        await fakeCore({
            '/v1/hash': (req) => req.socket.destroy(),
            '/v1/fs/stat-batch': () => {
                /* never answers */
            },
        });
        await expect(checksum.sha256OfFile(FILE)).rejects.toMatchObject({ kind: 'transport' });
        await expect(client.statBatch([FILE], { timeoutMs: 300 })).rejects.toMatchObject({
            kind: 'timeout',
        });
    });

    it('a dbscan error line is an error', async () => {
        await fakeCore({
            '/v1/dbscan': (req, raw, res) => {
                res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                res.end(
                    '{"t":"progress","done":1,"n":2}\n{"t":"error","code":"EINTERNAL","message":"boom"}\n',
                );
            },
        });
        await expect(
            faces.clusterFacesOffThread(
                { data: new Float32Array(4), n: 2, dim: 2 },
                { eps: 1, minPts: 2 },
            ),
        ).rejects.toMatchObject({ kind: 'server', message: 'boom' });
    });

    it('an older tgdl-core without a feature: 503 that says to update', async () => {
        await fakeCore({}, { features: ['hash'] });
        const err = await gofs.statMany([FILE]).catch((e) => e);
        expect(err).toMatchObject({ kind: 'unavailable', status: 503 });
        expect(err.message).toMatch(/does not support "stat"/);
    });
});

describe('tgdl-core missing', () => {
    it('every feature rejects with 503 and the fix; the sweep prunes nothing', async () => {
        process.env.TGDL_CORE_BIN = path.join(TMP, 'no-such-dir', 'tgdl-core');
        const t0 = Date.now();
        const errs = await Promise.all([
            checksum.sha256OfFile(FILE).catch((e) => e),
            gofs.statMany([FILE]).catch((e) => e),
            gofs.walkTree(DOWNLOADS).catch((e) => e),
            faces
                .clusterFacesOffThread(
                    { data: new Float32Array(4), n: 2, dim: 2 },
                    { eps: 1, minPts: 2 },
                )
                .catch((e) => e),
        ]);
        expect(Date.now() - t0).toBeLessThan(5_000); // no long wait: it is not starting
        for (const e of errs) {
            expect(e).toMatchObject({
                kind: 'unavailable',
                status: 503,
                code: 'TGDL_CORE_UNAVAILABLE',
            });
            expect(e.message).toMatch(/Fix:.*TGDL_CORE_BIN/);
        }
        expect(spawnMod.getGoCoreStatus().state).toBe('binary_missing');
        expect(spawnMod.getCoreBanner()).toMatchObject({ state: 'binary_missing' });

        // Integrity: a row whose file is gone must NOT be pruned when the
        // stat can't be answered at all.
        const dbApi = await import('../src/core/db.js');
        const db = dbApi.getDb();
        expect(
            path.resolve(db.name).startsWith(path.resolve(TMP)),
            `db.name ${db.name} escaped the temp dir`,
        ).toBe(true);
        db.exec('DELETE FROM downloads');
        db.prepare(
            `INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type, file_path)
             VALUES ('g', 'g', 1, 'gone.jpg', 5, 'photo', 'g/gone.jpg')`,
        ).run();
        const integrity = await import('../src/core/integrity.js');
        const res = await integrity.sweep();
        expect(res).toMatchObject({ skipped: true, reason: 'core_unavailable', pruned: 0 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM downloads').get().n).toBe(1);
    });
});

describe('real tgdl-core', () => {
    it('crash mid-request: in-flight calls fail, calls during the restart wait, then all is well', {
        timeout: 60_000,
    }, async () => {
        process.env.TGDL_CORE_BIN = requireCoreBin();
        const big = path.join(DOWNLOADS, 'big.bin');
        const buf = crypto.randomBytes(96 * 1024 * 1024);
        fs.writeFileSync(big, buf);
        const bigHex = crypto.createHash('sha256').update(buf).digest('hex');
        expect(await spawnMod.startGoCore()).toBe(true);
        const { pid, restarts } = spawnMod.getGoCoreStatus();

        const inflight = [];
        for (let i = 0; i < 4; i++) inflight.push(checksum.sha256OfFile(big).catch((e) => e));
        await sleep(15);
        process.kill(pid, 'SIGKILL');
        const out = await Promise.all(inflight);
        for (const r of out) {
            // Either it finished before the kill (then it is right) or it failed.
            if (typeof r === 'string') expect(r).toBe(bigHex);
            else expect(r).toMatchObject({ name: 'GoCoreError' });
        }
        // Called while tgdl-core is down and restarting: waits, then answers.
        await sleep(100);
        expect(await checksum.sha256OfFile(FILE)).toBe(EXPECTED);
        const st = spawnMod.getGoCoreStatus();
        expect(st.state).toBe('running');
        expect(st.pid).not.toBe(pid);
        expect(st.restarts).toBe(restarts + 1);
    });

    it('wrong token: an auth error, not a result', { timeout: 30_000 }, async () => {
        process.env.TGDL_CORE_BIN = requireCoreBin();
        expect(await spawnMod.startGoCore()).toBe(true);
        const ep = client.getEndpoint();
        client.setEndpoint(ep.url, 'definitely-not-the-token', ep.features, ep.version);
        client.markHealthy({ features: ep.features });
        await expect(client.hashFile(FILE)).rejects.toMatchObject({ kind: 'auth', status: 401 });
    });

    it('exits when its parent dies (no orphan)', { timeout: 30_000 }, async () => {
        const bin = requireCoreBin();
        const script = `
            const { spawn } = require('child_process');
            const c = spawn(process.argv[1], ['serve'], {
                env: { ...process.env, TGDL_CORE_TOKEN: 't', TGDL_CORE_WATCH_STDIN: '1' },
                stdio: ['pipe', 'pipe', 'inherit'],
                windowsHide: true,
            });
            c.stdout.once('data', () => console.log('PID ' + c.pid));
            setInterval(() => {}, 1000);
        `;
        const parent = spawn(process.execPath, ['-e', script, bin], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const line = await new Promise((resolve, reject) => {
            const rl = readline.createInterface({ input: parent.stdout });
            rl.on('line', (l) => l.startsWith('PID ') && resolve(l));
            setTimeout(() => reject(new Error('no PID line')), 15_000);
        });
        const goPid = Number(line.slice(4));
        const alive = (p) => {
            try {
                process.kill(p, 0);
            } catch {
                return false;
            }
            try {
                return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${p}/stat`, 'utf8'));
            } catch {
                return true;
            }
        };
        expect(alive(goPid)).toBe(true);
        parent.kill('SIGKILL');
        const t0 = Date.now();
        while (alive(goPid) && Date.now() - t0 < 10_000) await sleep(50);
        expect(alive(goPid)).toBe(false);
    });
});
