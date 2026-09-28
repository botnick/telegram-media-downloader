// Seekbar generator ↔ a sidecar on ANOTHER host. The fake sidecar only
// "sees" files under its own mount (/mnt/media), writes sprites to its own
// output dir (never the app's data dir), requires a token, and speaks
// either the 0.3.3 API (path only) or 0.4.0 (features + chunked uploads).
// ffprobe and local ffmpeg are stubbed, as in seekbar.generator.test.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

const mock = vi.hoisted(() => ({ duration: 120, localRuns: [] }));

vi.mock('child_process', async (importOriginal) => {
    const { EventEmitter } = await import('events');
    return {
        ...(await importOriginal()),
        spawn: () => {
            const p = new EventEmitter();
            p.stdout = new EventEmitter();
            p.stderr = new EventEmitter();
            setImmediate(() => {
                p.stdout.emit('data', Buffer.from(`${mock.duration}\n`));
                p.emit('close', 0);
            });
            return p;
        },
    };
});

vi.mock('../src/core/thumbs.js', async () => {
    const nodeFs = await import('fs');
    return {
        hasFfmpeg: () => true,
        ffmpegHasLibwebp: () => true,
        hwaccelUploadPipeline: () => ({ inputArgs: [], scaleVf: null }),
        resolveFfprobeBin: () => 'ffprobe',
        resolveFfmpegBin: () => 'ffmpeg',
        runFfmpegArgs: async (args, opts) => {
            mock.localRuns.push({ args, opts });
            nodeFs.writeFileSync(args.at(-1), Buffer.alloc(64, 1));
        },
    };
});

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-seekbar-ext-'));
const REMOTE_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-seekbar-remote-'));
const CFG = {
    enabled: true,
    intervalSec: 4,
    tileWidth: 160,
    columns: 10,
    maxTiles: 240,
    format: 'webp',
    quality: 75,
    concurrency: 2,
    maxRetries: 1,
};
const TOKEN = 'sb-secret';
const SPRITE = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200, 7)]);

// Fake sidecar state.
const S = {
    version: '0.4.0',
    chunkBytes: 300,
    requests: [],
    uploads: new Map(), // id -> Buffer
    dropFirstChunkResponse: false,
    spriteMissing: false,
    deleted: [],
    jobs: new Map(),
};

let dbApi;
let client;
let generator;
let spawnMod;
let server;
let base;
let _msg = 0;

function addVideo(bytes = 1000) {
    _msg += 1;
    const name = `v${_msg}.mp4`;
    const rel = `g/videos/${name}`;
    const abs = path.join(DATA_DIR, 'downloads', 'g', 'videos', name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes, _msg % 250));
    const r = dbApi.insertDownload({
        groupId: '-100999',
        groupName: 'g',
        messageId: _msg,
        fileName: name,
        fileSize: bytes,
        fileType: 'video',
        filePath: rel,
    });
    return { id: Number(r.lastInsertRowid), file_path: rel, file_type: 'video', abs };
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    dbApi.getDb();
    client = await import('../src/core/seekbar/client.js');
    generator = await import('../src/core/seekbar/generator.js');
    spawnMod = await import('../src/core/seekbar/spawn.js');

    server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        const url = new URL(req.url, 'http://x');
        // Reverse-proxy prefix.
        if (!url.pathname.startsWith('/seekbar/')) return send(404, { error: 'no route' });
        const route = url.pathname.slice('/seekbar'.length);
        S.requests.push({ method: req.method, route, token: req.headers['x-api-token'] || null });
        const v4 = S.version === '0.4.0';

        if (route === '/health') {
            return send(200, {
                ok: true,
                version: S.version,
                platform: 'linux',
                ...(v4 ? { features: ['path', 'upload', 'job_params', 'sprite_download'] } : {}),
                ...(v4 ? { upload_chunk_bytes: S.chunkBytes, auth_required: true } : {}),
            });
        }
        const spriteRoute = /^\/sprite\/([^/]+)$/.exec(route);
        const gated = route.startsWith('/v1/') || (v4 && spriteRoute);
        if (gated && req.headers['x-api-token'] !== TOKEN) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            return res.end('{"error":"unauthorized"}\n');
        }
        if (spriteRoute && req.method === 'GET') {
            const f = path.join(REMOTE_OUT, `${spriteRoute[1]}.webp`);
            if (S.spriteMissing || !fs.existsSync(f)) return send(404, { error: 'not found' });
            res.writeHead(200, { 'Content-Type': 'image/webp' });
            return res.end(fs.readFileSync(f));
        }
        if (route === '/v1/stats') return send(200, { queued: 0 });
        const up = /^\/v1\/uploads\/([^/]+)$/.exec(route);
        if (up && req.method === 'PUT' && v4) {
            const cur = S.uploads.get(up[1]) || Buffer.alloc(0);
            const off = Number(req.headers['x-upload-offset']);
            if (off !== cur.length)
                return send(409, { error: 'offset mismatch', size: cur.length });
            const next = Buffer.concat([cur, body]);
            S.uploads.set(up[1], next);
            if (S.dropFirstChunkResponse) {
                S.dropFirstChunkResponse = false;
                return req.socket.destroy(); // chunk stored, response lost
            }
            return send(200, { upload_id: up[1], size: next.length });
        }
        const del = /^\/v1\/sprite\/([^/]+)$/.exec(route);
        if (del && req.method === 'DELETE') {
            S.deleted.push(del[1]);
            return send(200, { removed: 1 });
        }
        if (route === '/v1/sprite' && req.method === 'POST') {
            const b = JSON.parse(body.toString('utf8'));
            let src;
            if (b.upload_id) {
                if (!v4 || !S.uploads.has(b.upload_id)) {
                    return send(400, { error: 'upload not found' });
                }
                src = { upload: S.uploads.get(b.upload_id) };
            } else if (!String(b.path).startsWith('/mnt/media/')) {
                return send(400, { error: 'source not found', path: b.path });
            } else {
                src = { path: b.path };
            }
            const job = {
                id: `job-${S.jobs.size + 1}`,
                video_id: b.video_id,
                status: 'pending',
                submitted: b,
                src,
            };
            S.jobs.set(job.id, job);
            return send(202, { id: job.id, video_id: b.video_id, status: 'pending' });
        }
        const jm = /^\/v1\/jobs\/([^/]+)$/.exec(route);
        if (jm && req.method === 'GET') {
            const job = S.jobs.get(jm[1]);
            if (!job) return send(404, { error: 'gone' });
            // Finishes on the first poll: sprite lands in the REMOTE dir.
            const sp = path.join(REMOTE_OUT, `${job.video_id}.webp`);
            fs.writeFileSync(sp, SPRITE);
            return send(200, {
                id: job.id,
                video_id: job.video_id,
                status: 'done',
                sprite_path: `/data/output/${job.video_id}.webp`,
                frames: 30,
                cols: 10,
                rows: 3,
                tile_w: 160,
                tile_h: 90,
                bytes: SPRITE.length,
                ...(v4 ? { format: 'webp', source: job.src.upload ? 'upload' : 'path' } : {}),
            });
        }
        send(404, { error: 'no route' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/seekbar/`;
});

beforeEach(async () => {
    mock.localRuns.length = 0;
    mock.duration = 120;
    S.version = '0.4.0';
    S.requests.length = 0;
    S.uploads.clear();
    S.jobs.clear();
    S.deleted.length = 0;
    S.dropFirstChunkResponse = false;
    S.spriteMissing = false;
    client._resetForTests();
    client.setSidecarUrl(base, TOKEN);
    client.setCapabilities(await client.health());
});

afterAll(async () => {
    await new Promise((r) => server.close(r));
    client._resetForTests();
    spawnMod.stopSidecar();
    try {
        dbApi.getDb().close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(REMOTE_OUT, { recursive: true, force: true });
});

const localSprite = (id) => path.join(DATA_DIR, 'seekbar', `${id}.webp`);

describe('seekbar with a sidecar on another host', () => {
    it('0.4.0 + no shared storage: uploads the video in chunks, downloads the sprite back', async () => {
        const row = addVideo(1000);
        const meta = await generator.generateForDownload(row, CFG, { overwrite: 'always' });
        expect(meta.frames).toBe(30);
        expect(mock.localRuns).toHaveLength(0);

        const puts = S.requests.filter((r) => r.method === 'PUT');
        expect(puts).toHaveLength(Math.ceil(1000 / S.chunkBytes));
        const job = [...S.jobs.values()][0];
        expect(job.src.upload.equals(fs.readFileSync(row.abs))).toBe(true);
        // App settings travel with the job.
        expect(job.submitted).toMatchObject({
            tile_w: 160,
            cols: 10,
            format: 'webp',
            overwrite: 'always',
        });

        expect(fs.readFileSync(localSprite(row.id)).equals(SPRITE)).toBe(true);
        expect(dbApi.getSeekbarSprite(row.id).sprite_path).toBe(localSprite(row.id));
        // The sidecar's staging copy is removed; every request carried the token.
        expect(S.deleted).toEqual([String(row.id)]);
        expect(
            S.requests.filter((r) => r.route !== '/health').every((r) => r.token === TOKEN),
        ).toBe(true);
    });

    it('resumes an upload whose chunk response was lost', async () => {
        S.dropFirstChunkResponse = true;
        const row = addVideo(700);
        await generator.generateForDownload(row, CFG, { overwrite: 'always' });
        const job = [...S.jobs.values()][0];
        expect(job.src.upload.equals(fs.readFileSync(row.abs))).toBe(true);
    });

    it('shared mount at a different path: path map keeps path mode (no upload)', async () => {
        client.setPathMap(`${path.join(DATA_DIR, 'downloads')}=/mnt/media`);
        const row = addVideo();
        await generator.generateForDownload(row, CFG, { overwrite: 'always' });
        const job = [...S.jobs.values()][0];
        expect(job.submitted.path).toBe(`/mnt/media/${row.file_path}`);
        expect(S.requests.some((r) => r.method === 'PUT')).toBe(false);
        expect(fs.existsSync(localSprite(row.id))).toBe(true);
    });

    it('0.3.3 sidecar that cannot see the video: keeps today’s local-ffmpeg fallback', async () => {
        S.version = '0.3.3';
        client.setCapabilities(await client.health());
        const row = addVideo();
        const meta = await generator.generateForDownload(row, CFG, { overwrite: 'always' });
        expect(meta.frames).toBeGreaterThan(0);
        expect(mock.localRuns).toHaveLength(1);
        expect(S.requests.some((r) => r.method === 'PUT')).toBe(false);
    });

    it('0.3.3 sidecar with a mapped mount but its own output dir: sprite is downloaded', async () => {
        S.version = '0.3.3';
        client.setCapabilities(await client.health());
        client.setPathMap(`${path.join(DATA_DIR, 'downloads')}=/mnt/media`);
        const row = addVideo();
        await generator.generateForDownload(row, CFG, { overwrite: 'always' });
        expect(mock.localRuns).toHaveLength(0);
        expect(fs.readFileSync(localSprite(row.id)).equals(SPRITE)).toBe(true);
        // Before: the DB recorded the sidecar-only path (/data/output/…).
        expect(dbApi.getSeekbarSprite(row.id).sprite_path).toBe(localSprite(row.id));
    });

    it('a sprite the app cannot fetch fails retryably instead of recording a dead path', async () => {
        S.spriteMissing = true;
        const row = addVideo();
        const err = await generator
            .generateForDownload(row, CFG, { overwrite: 'always' })
            .catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/sprite not reachable from the app.*retry/);
        expect(generator.isPermanentSeekbarError(err.message)).toBe(false);
        expect(dbApi.getSeekbarSprite(row.id)).toBeFalsy();
    });

    it('a wrong token never uploads and falls back to local ffmpeg', async () => {
        client.setSidecarUrl(base, 'wrong');
        const row = addVideo();
        await generator.generateForDownload(row, CFG, { overwrite: 'always' });
        expect(mock.localRuns).toHaveLength(1);
        expect(S.requests.some((r) => r.method === 'PUT')).toBe(false);
    });
});

describe('seekbar spawn in remote mode', () => {
    afterAll(() => {
        delete process.env.SEEKBAR_SIDECAR_URL;
        delete process.env.SEEKBAR_API_TOKEN;
    });

    it('env wins over dashboard config for URL, token and path map', () => {
        process.env.SEEKBAR_SIDECAR_URL = 'http://env-host:8089';
        delete process.env.SEEKBAR_API_TOKEN;
        const r = spawnMod.resolveRemoteSettings({
            sidecarUrl: 'http://cfg-host:8089',
            apiToken: 'cfg-token',
            pathMap: '/a=/b',
        });
        expect(r).toMatchObject({
            url: 'http://env-host:8089',
            token: 'cfg-token',
            pathMap: '/a=/b',
            sources: { url: 'env', token: 'config', pathMap: 'config' },
        });
        delete process.env.SEEKBAR_SIDECAR_URL;
        expect(spawnMod.resolveRemoteSettings({}).url).toBe('');
    });

    it('connects to a remote sidecar, records its capabilities, flags a bad token', async () => {
        process.env.SEEKBAR_SIDECAR_URL = base;
        process.env.SEEKBAR_API_TOKEN = TOKEN;
        await spawnMod.refreshSidecar();
        expect(spawnMod.getSidecarStatus()).toMatchObject({
            ok: true,
            mode: 'remote',
            version: '0.4.0',
            sources: { url: 'env', token: 'env' },
        });
        expect(client.hasFeature('upload')).toBe(true);

        process.env.SEEKBAR_API_TOKEN = 'nope';
        await spawnMod.refreshSidecar();
        const st = spawnMod.getSidecarStatus();
        expect(st.ok).toBe(false);
        expect(st.error).toMatch(/rejected the API token/);
        spawnMod.stopSidecar();
    });
});
