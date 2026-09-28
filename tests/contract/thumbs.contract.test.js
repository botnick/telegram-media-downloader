// Thumbnail maintenance contract: cache stats, the paginated preview list,
// "Build thumbnails" (thumbs_* WS events), per-tile rebuild, cache wipe
// (thumbs_rebuild_* events) and the ffmpeg hwaccel probe.
//
// Thumbnails are WebP files produced by sharp (images) and ffmpeg
// (videos); their byte sizes depend on encoder versions, so cache byte
// totals are masked. Counts are not.

import { describe, expect, it } from 'vitest';
import { useContract } from './harness.js';

const h = useContract(import.meta.url);

const BYTES_REASON =
    'sum of encoder output sizes (sharp/libvips + ffmpeg/libwebp versions differ per host)';

async function runJob(t, label, { path, body, prefix }) {
    const ws = t.ws();
    await ws.opened;
    ws.drain();
    await t.exchange(`${label}: start`, 'POST', path, { body });
    await ws.waitFor((m) => m.type === `${prefix}_done`, 45_000);
    ws.close();
    t.recordWs(`${label}: ws sequence`, ws.drain(), { collapse: [`${prefix}_progress`] });
}

describe('auth', () => {
    it('guest refused, anon unauthorised', async () => {
        const t = h.t;
        await t.exchange(
            'guest POST thumbs/build-all → 403',
            'POST',
            '/api/maintenance/thumbs/build-all',
            {
                as: 'guest',
                body: {},
            },
        );
        await t.exchange('guest GET thumbs/list → 403', 'GET', '/api/maintenance/thumbs/list', {
            as: 'guest',
        });
        await t.exchange('anon GET thumbs/stats → 401', 'GET', '/api/maintenance/thumbs/stats', {
            as: 'anon',
        });
    });
});

describe('before any build', () => {
    it('empty cache stats', async () => {
        // No cache yet: count 0 / bytes 0 is exact, nothing to mask.
        await h.t.exchange('thumbs/stats empty cache', 'GET', '/api/maintenance/thumbs/stats');
    });

    it('list: kinds, pagination, cursor, fallbacks', async () => {
        const t = h.t;
        await t.exchange('thumbs/list default', 'GET', '/api/maintenance/thumbs/list');
        await t.exchange(
            'thumbs/list image limit=3',
            'GET',
            '/api/maintenance/thumbs/list?kind=image&limit=3',
        );
        await t.exchange(
            'thumbs/list image limit=3 cursor=16',
            'GET',
            '/api/maintenance/thumbs/list?kind=image&limit=3&cursor=16',
        );
        await t.exchange('thumbs/list video', 'GET', '/api/maintenance/thumbs/list?kind=video');
        await t.exchange(
            'thumbs/list audio (none)',
            'GET',
            '/api/maintenance/thumbs/list?kind=audio',
        );
        await t.exchange(
            'thumbs/list unknown kind → all',
            'GET',
            '/api/maintenance/thumbs/list?kind=bogus&limit=2',
        );
        await t.exchange(
            'thumbs/list limit=0 → default 60',
            'GET',
            '/api/maintenance/thumbs/list?limit=0&kind=video',
        );
        await t.exchange(
            'thumbs/list limit=999 clamps to 200, negative cursor ignored',
            'GET',
            '/api/maintenance/thumbs/list?limit=999&cursor=-5',
        );
        await t.exchange(
            'thumbs/list cachedOnly (nothing cached)',
            'GET',
            '/api/maintenance/thumbs/list?cachedOnly=1',
        );
    });

    it('build status/stats idle, cancel while idle', async () => {
        const t = h.t;
        await t.exchange('thumbs/build/status idle', 'GET', '/api/maintenance/thumbs/build/status');
        await t.exchange(
            'thumbs/build/stats before any build',
            'GET',
            '/api/maintenance/thumbs/build/stats',
        );
        await t.exchange(
            'thumbs/build/cancel while idle',
            'POST',
            '/api/maintenance/thumbs/build/cancel',
            {
                body: {},
            },
        );
        await t.exchange(
            'thumbs/rebuild/status idle',
            'GET',
            '/api/maintenance/thumbs/rebuild/status',
        );
    });
});

describe('build', () => {
    it('kind=video builds the four video thumbs', async () => {
        const t = h.t;
        await runJob(t, 'thumbs/build-all video', {
            path: '/api/maintenance/thumbs/build-all',
            body: { kind: 'video' },
            prefix: 'thumbs',
        });
        await t.exchange(
            'thumbs/build/status after video build',
            'GET',
            '/api/maintenance/thumbs/build/status',
        );
        await t.exchange(
            'thumbs/build/stats after video build',
            'GET',
            '/api/maintenance/thumbs/build/stats',
        );
        await t.exchange('thumbs/stats after video build', 'GET', '/api/maintenance/thumbs/stats', {
            mask: { bytes: BYTES_REASON },
        });
        await t.exchange(
            'thumbs/list video cached',
            'GET',
            '/api/maintenance/thumbs/list?kind=video',
        );
    });

    it('unknown kind falls back to all; cached videos are skipped', async () => {
        const t = h.t;
        await runJob(t, 'thumbs/build-all kind=Bogus', {
            path: '/api/maintenance/thumbs/build-all',
            body: { kind: 'Bogus' },
            prefix: 'thumbs',
        });
        await t.exchange(
            'thumbs/build/status after full build',
            'GET',
            '/api/maintenance/thumbs/build/status',
        );
        await t.exchange('thumbs/stats after full build', 'GET', '/api/maintenance/thumbs/stats', {
            mask: { bytes: BYTES_REASON },
        });
        await t.exchange(
            'thumbs/list cachedOnly after build',
            'GET',
            '/api/maintenance/thumbs/list?cachedOnly=1&limit=5',
        );
    });
});

describe('rebuild one tile', () => {
    it('validates the id and re-warms the default width', async () => {
        const t = h.t;
        await t.exchange(
            'thumbs/rebuild-one/abc → 400',
            'POST',
            '/api/maintenance/thumbs/rebuild-one/abc',
            {
                body: {},
            },
        );
        await t.exchange(
            'thumbs/rebuild-one/0 → 400',
            'POST',
            '/api/maintenance/thumbs/rebuild-one/0',
            {
                body: {},
            },
        );
        await t.exchange(
            'thumbs/rebuild-one/1 (cached photo)',
            'POST',
            '/api/maintenance/thumbs/rebuild-one/1',
            {
                body: {},
            },
        );
        await t.exchange(
            'thumbs/rebuild-one/10 (pdf, not thumbnailable)',
            'POST',
            '/api/maintenance/thumbs/rebuild-one/10',
            {
                body: {},
            },
        );
        await t.exchange(
            'thumbs/rebuild-one/9999 (unknown row)',
            'POST',
            '/api/maintenance/thumbs/rebuild-one/9999',
            {
                body: {},
            },
        );
    });
});

describe('cache wipe', () => {
    it('kind=video wipes only video thumbs', async () => {
        const t = h.t;
        await runJob(t, 'thumbs/rebuild video', {
            path: '/api/maintenance/thumbs/rebuild',
            body: { kind: 'video' },
            prefix: 'thumbs_rebuild',
        });
        await t.exchange(
            'thumbs/rebuild/status after video wipe',
            'GET',
            '/api/maintenance/thumbs/rebuild/status',
        );
        await t.exchange('thumbs/stats after video wipe', 'GET', '/api/maintenance/thumbs/stats', {
            mask: { bytes: BYTES_REASON },
        });
    });

    it('no body wipes everything', async () => {
        const t = h.t;
        await runJob(t, 'thumbs/rebuild all', {
            path: '/api/maintenance/thumbs/rebuild',
            body: {},
            prefix: 'thumbs_rebuild',
        });
        await t.exchange('thumbs/stats after full wipe', 'GET', '/api/maintenance/thumbs/stats');
    });
});

describe('hwaccel probe', () => {
    it('answers with the probe shape (values are host-specific)', async () => {
        const t = h.t;
        const res = await t.request('GET', '/api/maintenance/thumbs/hwaccel-probe');
        const j = res.json || {};
        const shape = {
            route: 'GET /api/maintenance/thumbs/hwaccel-probe',
            status: res.status,
            contentType: res.headers['content-type'],
            keys: Object.keys(j).sort(),
            available: Array.isArray(j.available) ? 'array<string>' : typeof j.available,
            compiledIn: Array.isArray(j.compiledIn) ? 'array<string>' : typeof j.compiledIn,
            ffmpegPath: typeof j.ffmpegPath,
            recommended:
                j.recommended === null
                    ? 'null|string'
                    : typeof j.recommended === 'string'
                      ? 'null|string'
                      : typeof j.recommended,
            availableSubsetOfCompiledIn: (j.available || []).every((x) =>
                (j.compiledIn || []).includes(x),
            ),
            recommendedIsAvailable:
                j.recommended === null || (j.available || []).includes(j.recommended),
            note: 'available/compiledIn/ffmpegPath/recommended depend on the host ffmpeg build and GPU; only the shape and invariants are contract',
        };
        expect(res.status).toBe(200);
        t.store.record('thumbs/hwaccel-probe shape', shape);
    });
});
