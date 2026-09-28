// nsfw-client ↔ an external sidecar on "another host". A fake HTTP server
// speaks the nsfw-service API behind a reverse-proxy style path prefix
// (/nsfw) and only "sees" files under its own mount (/mnt/media).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

import * as client from '../src/core/nsfw-client.js';

const APP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-nsfw-client-'));
const photo = path.join(APP_ROOT, 'g', 'photos', 'a.jpg');
const S = {
    features: ['path', 'b64', 'upload', 'auth'],
    token: '',
    // sidecar-side paths it can read → score
    visible: new Set(),
    allowRoot: '/mnt/media',
    requests: [],
    dropNextClassify: false,
};

let server;
let base;

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

beforeAll(async () => {
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c86' } })
        .jpeg()
        .toFile(photo);

    server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const json = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        if (!req.url.startsWith('/nsfw/')) return json(404, { error: 'no route' });
        const route = req.url.slice('/nsfw'.length);
        const entry = {
            route,
            token: req.headers['x-api-token'] || null,
            type: req.headers['content-type'] || null,
            bytes: body.length,
        };
        S.requests.push(entry);
        if (route === '/health') {
            return json(200, {
                ok: true,
                version: S.features.length ? '1.2.0' : '1.1.0',
                ...(S.features.length ? { features: S.features, auth_required: !!S.token } : {}),
            });
        }
        if (S.token && req.headers['x-api-token'] !== S.token) {
            return json(401, { error: 'unauthorized', code: 'unauthorized' });
        }
        if (route === '/classify' && S.dropNextClassify) {
            S.dropNextClassify = false;
            req.socket.destroy();
            return;
        }
        if (route === '/classify/upload') {
            if (!S.features.includes('upload')) return json(404, { detail: 'Not Found' });
            entry.raw = body;
            return json(200, { score: 0.8, label: 'nsfw' });
        }
        if (route === '/classify') {
            const b = JSON.parse(body.toString('utf8') || '{}');
            entry.json = b;
            if (b.path) {
                if (!b.path.startsWith(S.allowRoot)) {
                    return json(403, { error: 'path_not_allowed', code: 'path_not_allowed' });
                }
                if (!S.visible.has(b.path)) {
                    return json(200, { error: 'file_not_found', score: null, label: null });
                }
                return json(200, { score: 0.9, label: 'nsfw' });
            }
            if (b.image_b64) return json(200, { score: 0.7, label: 'nsfw' });
            return json(400, { error: 'provide path or image_b64', code: 'missing_input' });
        }
        if (route === '/classify/batch') {
            const b = JSON.parse(body.toString('utf8'));
            entry.json = b;
            return json(200, {
                results: b.files.map((f) =>
                    !f.startsWith(S.allowRoot)
                        ? { file: f, error: 'path_not_allowed' }
                        : S.visible.has(f)
                          ? { file: f, score: 0.9, label: 'nsfw' }
                          : { file: f, error: 'file_not_found', score: null, label: null },
                ),
            });
        }
        json(404, { error: 'no route' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

const logs = [];
const onLog = (e) => logs.push(e);

beforeEach(() => {
    client._resetForTests();
    client.setSidecarUrl(`${base}/nsfw/`);
    client.applyNsfwSidecarCfg({ retryBackoffMs: [5] });
    S.features = ['path', 'b64', 'upload', 'auth'];
    S.token = '';
    S.visible = new Set(['/mnt/media/g/photos/a.jpg']);
    S.requests = [];
    S.dropNextClassify = false;
    logs.length = 0;
});

const routes = () => S.requests.filter((r) => r.route !== '/health').map((r) => r.route);

describe('nsfw-client external mode', () => {
    it('maps app paths to the sidecar mount and stays in path mode', async () => {
        client.setPathMap(`${APP_ROOT}=/mnt/media`);
        const r = await client.classifyFile(photo, {}, onLog);
        expect(r).toEqual({ score: 0.9, label: 'nsfw' });
        expect(S.requests.at(-1).json.path).toBe('/mnt/media/g/photos/a.jpg');
        expect(routes()).toEqual(['/classify']);
    });

    it('uploads raw bytes once the sidecar rejects path mode, for the rest of the session', async () => {
        const r1 = await client.classifyFile(photo, {}, onLog);
        expect(r1).toEqual({ score: 0.8, label: 'nsfw' });
        const r2 = await client.classifyFile(photo, {}, onLog);
        expect(r2).toEqual({ score: 0.8, label: 'nsfw' });
        expect(routes()).toEqual(['/classify', '/classify/upload', '/classify/upload']);
        const up = S.requests.find((x) => x.route === '/classify/upload');
        expect(up.type).toBe('application/octet-stream');
        expect(up.raw.equals(fs.readFileSync(photo))).toBe(true);
    });

    it('falls back to base64 JSON against a sidecar without the upload feature (≤1.1)', async () => {
        S.features = [];
        const r = await client.classifyFile(photo, {}, onLog);
        expect(r).toEqual({ score: 0.7, label: 'nsfw' });
        expect(routes()).toEqual(['/classify', '/classify']);
        expect(S.requests.at(-1).json.image_b64).toBe(fs.readFileSync(photo).toString('base64'));
    });

    it('uploads a file the sidecar accepts but cannot find, without leaving path mode', async () => {
        S.allowRoot = APP_ROOT; // same path string on both hosts, not mounted there
        S.visible = new Set();
        try {
            expect(await client.classifyFile(photo, {}, onLog)).toEqual({
                score: 0.8,
                label: 'nsfw',
            });
            expect(routes()).toEqual(['/classify', '/classify/upload']);
            S.visible.add(photo);
            expect(await client.classifyFile(photo, {}, onLog)).toEqual({
                score: 0.9,
                label: 'nsfw',
            });
            expect(routes().at(-1)).toBe('/classify');
        } finally {
            S.allowRoot = '/mnt/media';
        }
        expect(logs.some((l) => /can't find/.test(l.msg))).toBe(true);
    });

    it('sends the shared token on every request and reports a rejected one once', async () => {
        S.token = 'good';
        client.setSidecarAuth('good');
        client.setPathMap(`${APP_ROOT}=/mnt/media`);
        expect(await client.classifyFile(photo, {}, onLog)).toEqual({ score: 0.9, label: 'nsfw' });
        expect(S.requests.every((r) => r.token === 'good')).toBe(true);

        client.setSidecarAuth('bad');
        expect(await client.classifyFile(photo, {}, onLog)).toBeNull();
        expect(await client.classifyFile(photo, {}, onLog)).toBeNull();
        const authLogs = logs.filter((l) => /rejected the API token/.test(l.msg));
        expect(authLogs).toHaveLength(1);
    });

    it('classifies in-memory tiles without ever sending a path', async () => {
        client.setPathMap(`${APP_ROOT}=/mnt/media`);
        const tile = await sharp({
            create: { width: 16, height: 16, channels: 3, background: '#000' },
        })
            .jpeg()
            .toBuffer();
        expect(await client.classifyBuffer(tile, {}, onLog)).toEqual({ score: 0.8, label: 'nsfw' });
        expect(routes()).toEqual(['/classify/upload']);
        // Path mode is still on for library files afterwards.
        expect(await client.classifyFile(photo, {}, onLog)).toEqual({ score: 0.9, label: 'nsfw' });
        expect(routes().at(-1)).toBe('/classify');
    });

    it('downscales large images before uploading them', async () => {
        const big = path.join(APP_ROOT, 'big.png');
        const w = 1400;
        await sharp(crypto.randomBytes(w * w * 3), { raw: { width: w, height: w, channels: 3 } })
            .png({ compressionLevel: 0 })
            .toFile(big);
        expect(fs.statSync(big).size).toBeGreaterThan(1.5 * 1024 * 1024);
        await client.classifyFile(big, {}, onLog);
        const up = S.requests.find((x) => x.route === '/classify/upload');
        expect(up.bytes).toBeLessThan(fs.statSync(big).size);
        const meta = await sharp(up.raw).metadata();
        expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1024);
    });

    it('retries through a path-prefixed URL after a dropped connection', async () => {
        client.setPathMap(`${APP_ROOT}=/mnt/media`);
        S.dropNextClassify = true;
        const r = await client.classifyFile(photo, {}, onLog);
        expect(r).toEqual({ score: 0.9, label: 'nsfw' });
        // The liveness probe between attempts went to /nsfw/health, not /health.
        expect(S.requests.map((x) => x.route)).toEqual(['/classify', '/health', '/classify']);
    });

    it('batch: maps paths, keeps results in order, uploads what the sidecar cannot see', async () => {
        client.setPathMap(`${APP_ROOT}=/mnt/media`);
        const missing = path.join(APP_ROOT, 'g', 'photos', 'b.jpg');
        fs.copyFileSync(photo, missing);
        const out = await client.classifyBatch([photo, missing], {}, onLog);
        expect(out).toEqual([
            { score: 0.9, label: 'nsfw' },
            { score: 0.8, label: 'nsfw' },
        ]);
        const batch = S.requests.find((x) => x.route === '/classify/batch');
        expect(batch.json.files).toEqual([
            '/mnt/media/g/photos/a.jpg',
            '/mnt/media/g/photos/b.jpg',
        ]);
    });

    it('health reports features, auth and path mode', async () => {
        const h = await client.health();
        expect(h).toMatchObject({ ok: true, version: '1.2.0', features: S.features });
        expect(client.getSidecarInfo()).toMatchObject({ tokenSet: false, transfer: 'path' });
    });
});
