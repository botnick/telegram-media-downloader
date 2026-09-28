// Compression middleware wiring — drives a real Express app over HTTP so
// the assertions cover what the browser actually sees (Content-Encoding),
// including the mounted `/files` handler whose req.url is prefix-stripped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import {
    compressionLevelFromEnv,
    createCompression,
    shouldCompress,
} from '../src/web/lib/http-compression.js';

const BIG_TEXT = 'lorem ipsum dolor sit amet '.repeat(400); // ~10 KB, well over the 1 KB threshold

let server;
let base;

beforeAll(async () => {
    const app = express();
    app.use(createCompression(6));
    app.get('/api/list', (req, res) => res.json({ rows: BIG_TEXT }));
    app.get('/js/app.js', (req, res) => res.type('application/javascript').send(BIG_TEXT));
    app.get('/api/thumbs/1', (req, res) => res.type('image/webp').send(Buffer.from(BIG_TEXT)));
    app.use('/files', (req, res) => res.type('text/plain').send(BIG_TEXT));
    app.get('/share/abc', (req, res) => res.type('text/plain').send(BIG_TEXT));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((r) => server.close(r));
});

async function encodingOf(p, headers = {}) {
    const r = await fetch(base + p, {
        headers: { 'accept-encoding': 'gzip, br', ...headers },
    });
    await r.arrayBuffer();
    return r.headers.get('content-encoding');
}

describe('http compression', () => {
    it('compresses JSON API responses and JS bundles', async () => {
        expect(await encodingOf('/api/list')).toMatch(/gzip|br/);
        expect(await encodingOf('/js/app.js')).toMatch(/gzip|br/);
    });

    it('leaves raw file routes alone even for text content (Range semantics)', async () => {
        expect(await encodingOf('/files/Group/documents/notes.txt')).toBeNull();
        expect(await encodingOf('/share/abc')).toBeNull();
    });

    it('skips Range requests and media types', async () => {
        expect(await encodingOf('/api/list', { range: 'bytes=0-10' })).toBeNull();
        expect(await encodingOf('/api/thumbs/1')).toBeNull();
    });

    it('honours x-no-compression', async () => {
        expect(await encodingOf('/api/list', { 'x-no-compression': '1' })).toBeNull();
    });
});

describe('compression config', () => {
    it('parses COMPRESSION_LEVEL with 6 as default and 0 as off', () => {
        expect(compressionLevelFromEnv(undefined)).toBe(6);
        expect(compressionLevelFromEnv('abc')).toBe(6);
        expect(compressionLevelFromEnv('12')).toBe(6);
        expect(compressionLevelFromEnv('3')).toBe(3);
        expect(compressionLevelFromEnv('0')).toBe(0);
        expect(createCompression(0)).toBeNull();
        expect(typeof createCompression(6)).toBe('function');
    });

    it('shouldCompress checks originalUrl for mounted routes', () => {
        const res = { getHeader: () => 'text/plain' };
        expect(
            shouldCompress({ headers: {}, url: '/x.txt', originalUrl: '/files/x.txt' }, res),
        ).toBe(false);
    });
});
