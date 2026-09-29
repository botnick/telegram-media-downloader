// src/web/lib/http-errors.js against the real express / send /
// body-parser stack: the 416 answer for a Range a file can't satisfy, the
// pre-check the /share route uses so a refused request isn't counted, and
// the 400 / 413 answers for bodies express.json() refuses.

import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    bodyParserErrorResponse,
    isUnsatisfiableRange,
    rangeNotSatisfiableOf,
    sendRangeNotSatisfiable,
} from '../src/web/lib/http-errors.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-http-errors-'));
const FILE = path.join(DIR, 'f.bin');
let server;
let base = '';

beforeAll(async () => {
    fs.writeFileSync(FILE, Buffer.alloc(100, 1));
    const app = express();
    // Like the real routes, which sit behind the API limiter (CodeQL
    // js/missing-rate-limiting). Never reached here; adds no headers.
    app.use(
        rateLimit({
            windowMs: 60_000,
            limit: 10_000,
            standardHeaders: false,
            legacyHeaders: false,
        }),
    );
    app.use(express.json({ limit: '1kb' }));
    app.post('/json', (req, res) => res.json({ got: req.body }));
    app.get('/check', (req, res) => res.json({ unsat: isUnsatisfiableRange(req, 100) }));
    app.all('/file', (req, res, next) => {
        res.setHeader('Content-Disposition', 'attachment; filename="f.bin"');
        res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
        res.sendFile(FILE, (err) => err && next(err));
    });
    app.use((err, _req, res, _next) => {
        const cr = rangeNotSatisfiableOf(err);
        if (cr) return sendRangeNotSatisfiable(res, cr);
        const bodyError = bodyParserErrorResponse(err);
        if (bodyError) return res.status(bodyError.status).json(bodyError.body);
        res.status(500).json({ error: err.message });
    });
    await new Promise((r) => {
        server = app.listen(0, '127.0.0.1', r);
    });
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
    server?.close();
    fs.rmSync(DIR, { recursive: true, force: true });
});

const get = (url, headers = {}, method = 'GET') => fetch(base + url, { method, headers });

describe('isUnsatisfiableRange', () => {
    it.each([
        ['bytes=500-', {}, true],
        ['bytes=100-200', {}, true],
        ['bytes=50-10', {}, true],
        ['bytes=0-9', {}, false],
        ['bytes=90-500', {}, false],
        ['bytes=-5', {}, false],
        ['bytes=0-9,500-600', {}, false],
        ['items=500-', {}, false],
        ['bytes=500-', { 'if-range': 'W/"x"' }, false],
    ])('%s %o → %s', async (range, extra, want) => {
        const r = await get('/check', { range, ...extra });
        expect((await r.json()).unsat).toBe(want);
    });

    it('no Range header → false', async () => {
        expect((await (await get('/check')).json()).unsat).toBe(false);
    });
});

describe('send() 416 through the error handler', () => {
    it('answers 416 with Content-Range and none of the file headers', async () => {
        for (const method of ['GET', 'HEAD']) {
            const r = await get('/file', { range: 'bytes=500-600' }, method);
            expect(r.status).toBe(416);
            expect(r.headers.get('content-range')).toBe('bytes */100');
            expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
            expect(r.headers.get('cache-control')).toBe('no-store');
            for (const h of ['etag', 'last-modified', 'content-disposition']) {
                expect(r.headers.get(h), h).toBeNull();
            }
            expect(await r.text()).toBe(method === 'GET' ? 'Range Not Satisfiable' : '');
        }
    });

    it('leaves satisfiable ranges alone', async () => {
        const r = await get('/file', { range: 'bytes=0-9' });
        expect(r.status).toBe(206);
        expect(r.headers.get('content-range')).toBe('bytes 0-9/100');
    });

    it('rangeNotSatisfiableOf ignores other errors', () => {
        expect(rangeNotSatisfiableOf(null)).toBeNull();
        expect(rangeNotSatisfiableOf(Object.assign(new Error('x'), { status: 404 }))).toBeNull();
        expect(rangeNotSatisfiableOf(Object.assign(new Error('x'), { status: 416 }))).toBeNull();
        expect(
            rangeNotSatisfiableOf({ status: 416, headers: { 'Content-Range': 'bytes */7' } }),
        ).toBe('bytes */7');
    });
});

describe('bodies express.json() refuses', () => {
    const post = (body, type = 'application/json') =>
        fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': type }, body });

    it.each([
        ['malformed JSON', '{"a": 1,', 400, 'Malformed JSON body'],
        ['a JSON null (strict)', 'null', 400, 'Malformed JSON body'],
        ['a JSON string (strict)', '"x"', 400, 'Malformed JSON body'],
        [
            'a body over the limit',
            JSON.stringify({ pad: 'x'.repeat(2048) }),
            413,
            'Request body too large',
        ],
    ])('%s → %i', async (_label, body, status, error) => {
        const r = await post(body);
        expect(r.status).toBe(status);
        expect(await r.json()).toEqual({ error });
    });

    it('an unsupported charset → 415', async () => {
        const r = await post('{}', 'application/json; charset=klingon');
        expect(r.status).toBe(415);
        expect(await r.json()).toEqual({ error: 'Unsupported charset' });
    });

    it('valid JSON still reaches the route', async () => {
        const r = await post('{"a":1}');
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ got: { a: 1 } });
    });

    it('bodyParserErrorResponse ignores other errors', () => {
        expect(bodyParserErrorResponse(null)).toBeNull();
        expect(bodyParserErrorResponse(new Error('boom'))).toBeNull();
        expect(bodyParserErrorResponse({ type: 'entity.parse.failed', status: 500 })).toBeNull();
        expect(bodyParserErrorResponse({ type: 'other', status: 400 })).toBeNull();
    });
});
