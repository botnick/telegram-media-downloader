import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

import {
    authHeaders,
    formatPathMap,
    fromSidecarPath,
    normalizeSidecarUrl,
    parsePathMap,
    probeSidecar,
    toSidecarPath,
    uploadTimeoutMs,
} from '../src/core/sidecar-remote.js';

describe('normalizeSidecarUrl', () => {
    it('keeps proxy path prefixes and https, drops trailing slashes/query/hash', () => {
        expect(normalizeSidecarUrl(' https://gpu.example.com/nsfw/// ')).toBe(
            'https://gpu.example.com/nsfw',
        );
        expect(normalizeSidecarUrl('http://10.0.0.5:8012/?x=1#y')).toBe('http://10.0.0.5:8012');
        expect(normalizeSidecarUrl('https://h/a/b/')).toBe('https://h/a/b');
    });
    it('adds http:// when the scheme is missing', () => {
        expect(normalizeSidecarUrl('gpu-box:8089')).toBe('http://gpu-box:8089');
    });
    it('returns empty for unset input', () => {
        expect(normalizeSidecarUrl('')).toBe('');
        expect(normalizeSidecarUrl(null)).toBe('');
        expect(normalizeSidecarUrl('   ')).toBe('');
    });
});

describe('authHeaders', () => {
    it('sends X-API-Token only when a token is set', () => {
        expect(authHeaders('')).toEqual({});
        expect(authHeaders(undefined)).toEqual({});
        expect(authHeaders(' s3cret ')).toEqual({ 'X-API-Token': 's3cret' });
    });
});

describe('path mapping', () => {
    it('parses newline / ; separated rules, `=` or `=>`, longest prefix first', () => {
        const rules = parsePathMap(
            '/app/data/downloads=/mnt/media\n# comment\n/app/data/downloads/big => /mnt/big; bad-rule',
        );
        expect(rules).toEqual([
            { from: '/app/data/downloads/big', to: '/mnt/big' },
            { from: '/app/data/downloads', to: '/mnt/media' },
        ]);
        expect(parsePathMap([['/a', '/b'], { from: '/c', to: '/d' }, '/e=/f'])).toHaveLength(3);
        expect(parsePathMap(undefined)).toEqual([]);
    });

    it('rewrites on path boundaries only', () => {
        const rules = parsePathMap('/app/data/downloads=/mnt/media');
        expect(toSidecarPath('/app/data/downloads/g/photos/a.jpg', rules)).toBe(
            '/mnt/media/g/photos/a.jpg',
        );
        expect(toSidecarPath('/app/data/downloads', rules)).toBe('/mnt/media');
        expect(toSidecarPath('/app/data/downloads2/a.jpg', rules)).toBe(
            '/app/data/downloads2/a.jpg',
        );
        expect(toSidecarPath('/tmp/x.jpg', rules)).toBe('/tmp/x.jpg');
        expect(toSidecarPath('/tmp/x.jpg', [])).toBe('/tmp/x.jpg');
    });

    it('maps Windows app paths to POSIX sidecar paths and back', () => {
        const rules = parsePathMap('D:\\TG\\data\\downloads=/media');
        expect(toSidecarPath('d:\\tg\\data\\downloads\\g\\v.mp4', rules)).toBe('/media/g/v.mp4');
        expect(fromSidecarPath('/media/g/v.mp4', rules)).toBe('D:\\TG\\data\\downloads\\g\\v.mp4');
    });

    it('reverse-maps sidecar output paths (nested rules pick the longest)', () => {
        const rules = parsePathMap('/app/data=/srv/tgdl;/app/data/seekbar=/data/output');
        expect(fromSidecarPath('/data/output/12.webp', rules)).toBe('/app/data/seekbar/12.webp');
        expect(fromSidecarPath('/srv/tgdl/downloads/x.mp4', rules)).toBe(
            '/app/data/downloads/x.mp4',
        );
        expect(fromSidecarPath('/elsewhere/x', rules)).toBe('/elsewhere/x');
    });

    it('formats rules back to editable text', () => {
        expect(formatPathMap(parsePathMap('/a=/b;/a/c=/d'))).toBe('/a/c=/d\n/a=/b');
    });
});

describe('uploadTimeoutMs', () => {
    it('scales with body size above a floor', () => {
        expect(uploadTimeoutMs(0)).toBe(30_000);
        expect(uploadTimeoutMs(64 * 1024 * 1024)).toBeGreaterThan(500_000);
    });
});

describe('probeSidecar', () => {
    let server;
    let base;
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const json = (code, obj) => {
                res.writeHead(code, { 'content-type': 'application/json' });
                res.end(JSON.stringify(obj));
            };
            if (req.url === '/svc/health') {
                return json(200, {
                    ok: true,
                    version: '9.9.9',
                    service: 'x',
                    features: ['upload'],
                    auth_required: true,
                });
            }
            if (req.url === '/svc/v1/stats') {
                if (req.headers['x-api-token'] !== 'good')
                    return json(401, { error: 'unauthorized' });
                return json(200, {});
            }
            res.writeHead(404, { 'content-type': 'text/html' });
            res.end('<html>not found</html>');
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => new Promise((r) => server.close(r)));

    const authCheck = { method: 'GET', path: '/v1/stats' };

    it('reports version, features and an accepted token', async () => {
        const r = await probeSidecar({ url: `${base}/svc/`, token: 'good', authCheck });
        expect(r).toMatchObject({
            ok: true,
            reachable: true,
            version: '9.9.9',
            features: ['upload'],
            auth: 'ok',
            authRequired: true,
        });
    });

    it('flags a rejected or missing token', async () => {
        const bad = await probeSidecar({ url: `${base}/svc`, token: 'nope', authCheck });
        expect(bad).toMatchObject({ ok: false, auth: 'failed', error: 'token_rejected' });
        const none = await probeSidecar({ url: `${base}/svc`, authCheck });
        expect(none).toMatchObject({ ok: false, auth: 'failed', error: 'token_required' });
    });

    it('explains a wrong path prefix instead of a JSON parse error', async () => {
        const r = await probeSidecar({ url: base, authCheck });
        expect(r).toMatchObject({ ok: false, reachable: true, error: 'http_404' });
    });

    it('reports an unreachable host', async () => {
        const r = await probeSidecar({ url: 'http://127.0.0.1:1', timeoutMs: 2000 });
        expect(r.reachable).toBe(false);
        expect(r.error).toBeTruthy();
    });
});
