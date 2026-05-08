// Unit tests for the safe-route Express wrapper.
//
// The whole point: a thrown handler must NOT escape into an unhandled
// rejection. We assert the wrapper turns sync + async + late throws into a
// JSON envelope the dashboard can render, and never crashes the process.

import { describe, it, expect, vi } from 'vitest';
import { makeSafe, HttpError } from '../src/web/lib/safe-route.js';

function fakeRes() {
    const res = {
        statusCode: 200,
        headersSent: false,
        body: null,
        status(n) {
            this.statusCode = n;
            return this;
        },
        json(b) {
            this.body = b;
            this.headersSent = true;
            return this;
        },
    };
    return res;
}

function fakeReq(method = 'GET', url = '/api/ai/test') {
    return { method, originalUrl: url, url };
}

describe('makeSafe', () => {
    it('passes through a handler that resolves cleanly', async () => {
        const log = vi.fn();
        const safe = makeSafe({ log, prefix: 'ai' });
        const handler = safe(async (_req, res) => res.json({ ok: true }));
        const res = fakeRes();
        await handler(fakeReq(), res);
        expect(res.body).toEqual({ ok: true });
        expect(log).not.toHaveBeenCalled();
    });

    it('catches a synchronous throw → 500 envelope', async () => {
        const log = vi.fn();
        const safe = makeSafe({ log, prefix: 'ai' });
        const handler = safe((_req, _res) => {
            throw new Error('boom');
        });
        const res = fakeRes();
        await handler(fakeReq(), res);
        expect(res.statusCode).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('AI_ROUTE_ERROR');
        expect(res.body.message).toBe('boom');
        expect(res.body.where).toBe('GET /api/ai/test');
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0].level).toBe('error');
        expect(log.mock.calls[0][0].source).toBe('ai');
    });

    it('catches an async rejection → 500 envelope', async () => {
        const log = vi.fn();
        const safe = makeSafe({ log, prefix: 'ai' });
        const handler = safe(async () => {
            await Promise.resolve();
            throw new Error('async boom');
        });
        const res = fakeRes();
        await handler(fakeReq(), res);
        expect(res.statusCode).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.message).toBe('async boom');
    });

    it('respects HttpError status + code', async () => {
        const log = vi.fn();
        const safe = makeSafe({ log, prefix: 'ai' });
        const handler = safe(() => {
            throw new HttpError(409, 'ALREADY_RUNNING', 'already running');
        });
        const res = fakeRes();
        await handler(fakeReq(), res);
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('ALREADY_RUNNING');
        expect(res.body.message).toBe('already running');
    });

    it('skips response when headers were already sent', async () => {
        const log = vi.fn();
        const safe = makeSafe({ log, prefix: 'ai' });
        const handler = safe(async (_req, res) => {
            res.json({ partial: true });
            // Throw AFTER responding — wrapper should log but not double-send.
            throw new Error('post-send');
        });
        const res = fakeRes();
        await handler(fakeReq(), res);
        // body retains the original send (json sets headersSent true);
        // wrapper noticed and did not overwrite.
        expect(res.body).toEqual({ partial: true });
        expect(log).toHaveBeenCalledTimes(1);
    });

    it('logger errors never escape', async () => {
        const safe = makeSafe({
            log: () => {
                throw new Error('logger broken');
            },
            prefix: 'ai',
        });
        const handler = safe(() => {
            throw new Error('boom');
        });
        const res = fakeRes();
        await handler(fakeReq(), res);
        expect(res.statusCode).toBe(500);
    });

    it('rejects non-function handlers eagerly', () => {
        const safe = makeSafe({});
        expect(() => safe('not a fn')).toThrow(TypeError);
    });
});
