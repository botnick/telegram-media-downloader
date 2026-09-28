// Seekbar (hover-preview sprite) contract — public sprite/meta reads, the
// maintenance surface (stats, queue, list, health, hwaccel probe), the
// external-sidecar probe, restart, single regen, build-all / rebuild.
//
// Main server: the seeded config points the sidecar at an unreachable
// `http://seekbar.invalid:9` (remote mode, down), so encodes fall back to
// the in-process ffmpeg. Seeded sprite: row 6 (data/seekbar/6.webp + .json).
// A second server talks to a healthy fake sidecar on loopback to cover
// the rich-health / hwaccel paths.

import http from 'http';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { until, useContract } from './harness.js';

const h = useContract(import.meta.url);

// ---- fake seekbar sidecar (loopback) -----------------------------------

let fake;
let fakeBase;
beforeAll(async () => {
    fake = http.createServer((req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        const authed = req.headers['x-api-token'] === 'seek-token';
        if (req.url === '/health') {
            return send(200, {
                ok: true,
                service: 'tgdl-seekbar',
                version: '0.9.0-fake',
                features: ['upload'],
                auth_required: true,
                platform: 'linux',
                arch: 'amd64',
                hwaccel_resolved: 'none',
                gpu_provider: null,
                ffmpeg_version: '7.0-fake',
                stats: { queued: 0, running: 0, done: 3 },
            });
        }
        if (req.url === '/v1/stats') {
            if (!authed) return send(401, { error: 'unauthorized' });
            return send(200, { queued: 0, running: 0, done: 3 });
        }
        if (req.url === '/v1/hwaccel') {
            if (!authed) return send(401, { error: 'unauthorized' });
            return send(200, {
                available: ['none'],
                compiled: ['vaapi', 'cuda'],
                ffmpeg_path: '/opt/fake/ffmpeg',
            });
        }
        return send(404, { error: 'not_found' });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    fakeBase = `http://127.0.0.1:${fake.address().port}`;
});
afterAll(() => new Promise((r) => fake.close(r)));

// The fake sidecar's port is random: swap it for a placeholder in both
// directions before recording.
function scrub(res) {
    if (res.json !== undefined) {
        res.json = JSON.parse(
            JSON.stringify(res.json).replaceAll(fakeBase, 'http://127.0.0.1:<fake-sidecar>'),
        );
    }
    return res;
}
async function viaFake(t, label, method, route, body) {
    const real = body && JSON.parse(JSON.stringify(body).replaceAll('<fake-sidecar>', fakeBase));
    const res = scrub(await t.request(method, route, real ? { body: real } : {}));
    return t.record(label, { method, path: route, as: 'admin', ...(body ? { body } : {}) }, res);
}

// Sprites encoded during the run come out of the host's ffmpeg/libwebp:
// their byte size differs between builds (frames/cols/rows/durations do
// not — they come from the clip length).
const ENCODED = 'size of a sprite encoded by the host ffmpeg/libwebp build during the run';

// Host facts in /seekbar/health: Node's platform/arch and version string.
const HOST_MASK = {
    platform: 'process.platform/process.arch of the host running the server',
    node: 'Node.js version of the host (a Go server reports its own runtime)',
};

describe('public sprite + meta', () => {
    it('sprite', async () => {
        const t = h.t;
        await t.exchange('sprite of row 6', 'GET', '/api/seekbar/sprite/6', { bodyMode: 'sha256' });
        const etag = (await t.request('GET', '/api/seekbar/sprite/6')).headers.etag;
        await t.exchange(
            'sprite of row 6 with matching If-None-Match → 304',
            'GET',
            '/api/seekbar/sprite/6',
            {
                headers: { 'if-none-match': etag },
            },
        );
        await t.exchange(
            'sprite of row 6 with stale If-None-Match',
            'GET',
            '/api/seekbar/sprite/6',
            {
                headers: { 'if-none-match': '"sk-6-0"' },
                bodyMode: 'sha256',
            },
        );
        await t.exchange('sprite as guest (allowed)', 'GET', '/api/seekbar/sprite/6', {
            as: 'guest',
            bodyMode: 'sha256',
        });
        await t.exchange('sprite as anon → 401', 'GET', '/api/seekbar/sprite/6', { as: 'anon' });
        await t.exchange('sprite of a video without one → 404', 'GET', '/api/seekbar/sprite/7');
        await t.exchange('sprite of a bad id → 404', 'GET', '/api/seekbar/sprite/abc');
        await t.exchange('sprite of id 0 → 404', 'GET', '/api/seekbar/sprite/0');
    });

    it('meta', async () => {
        const t = h.t;
        await t.exchange('meta of row 6', 'GET', '/api/seekbar/meta/6');
        await t.exchange('meta as guest (allowed)', 'GET', '/api/seekbar/meta/6', { as: 'guest' });
        await t.exchange('meta of a video without one → 404', 'GET', '/api/seekbar/meta/7');
        await t.exchange('meta of a bad id → 404', 'GET', '/api/seekbar/meta/-1');
    });
});

describe('maintenance reads (sidecar configured but down)', () => {
    it('stats / queue / list / status', async () => {
        const t = h.t;
        await t.exchange('seekbar stats', 'GET', '/api/maintenance/seekbar/stats');
        await t.exchange('seekbar queue stats', 'GET', '/api/maintenance/seekbar/queue/stats');
        await t.exchange('seekbar list', 'GET', '/api/maintenance/seekbar/list');
        await t.exchange(
            'seekbar list limit/offset',
            'GET',
            '/api/maintenance/seekbar/list?limit=1&offset=1',
        );
        await t.exchange(
            'seekbar list limit clamps',
            'GET',
            '/api/maintenance/seekbar/list?limit=999&offset=-3',
        );
        await t.exchange('build status idle', 'GET', '/api/maintenance/seekbar/build/status');
        await t.exchange(
            'build stats (never built)',
            'GET',
            '/api/maintenance/seekbar/build/stats',
        );
        await t.exchange('rebuild status idle', 'GET', '/api/maintenance/seekbar/rebuild/status');
        await t.exchange('seekbar health', 'GET', '/api/maintenance/seekbar/health', {
            mask: HOST_MASK,
        });
        await t.exchange(
            'hwaccel probe without a running sidecar',
            'GET',
            '/api/maintenance/seekbar/hwaccel-probe',
        );
        await t.exchange('seekbar stats as guest → 403', 'GET', '/api/maintenance/seekbar/stats', {
            as: 'guest',
        });
    });

    it('external sidecar probe', async () => {
        const t = h.t;
        const route = '/api/maintenance/seekbar/sidecar-test';
        await viaFake(t, 'sidecar-test without url → 400', 'POST', route, {});
        await viaFake(t, 'sidecar-test javascript: url → 400', 'POST', route, {
            url: 'javascript:alert(1)',
        });
        await viaFake(t, 'sidecar-test unreachable host', 'POST', route, {
            url: 'http://seek-other.invalid:1',
        });
        await viaFake(t, 'sidecar-test saved url reuses the saved token', 'POST', route, {
            url: 'http://seekbar.invalid:9',
        });
        await viaFake(t, 'sidecar-test fake sidecar, right token', 'POST', route, {
            url: '<fake-sidecar>',
            token: 'seek-token',
        });
        await viaFake(t, 'sidecar-test fake sidecar, no token', 'POST', route, {
            url: '<fake-sidecar>',
        });
    });

    it('restart re-probes the configured sidecar', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange(
            'sidecar restart (remote down)',
            'POST',
            '/api/maintenance/seekbar/sidecar/restart',
            {
                body: {},
            },
        );
        await ws.waitFor((m) => m.type === 'seekbar_sidecar_status');
        ws.close();
        t.recordWs('ws events: sidecar restart (remote down)', ws.drain());
    });
});

describe('generation (in-process ffmpeg fallback)', () => {
    it('regen validation', async () => {
        const t = h.t;
        await t.exchange('regen bad id → 400', 'POST', '/api/maintenance/seekbar/regen/abc', {
            body: {},
        });
        await t.exchange('regen id 0 → 400', 'POST', '/api/maintenance/seekbar/regen/0', {
            body: {},
        });
        await t.exchange('regen unknown row → 404', 'POST', '/api/maintenance/seekbar/regen/9999', {
            body: {},
        });
        await t.exchange('regen a photo → 400', 'POST', '/api/maintenance/seekbar/regen/1', {
            body: {},
        });
        await t.exchange('regen as guest → 403', 'POST', '/api/maintenance/seekbar/regen/7', {
            as: 'guest',
            body: {},
        });
    });

    it('regen a video without a sprite', async () => {
        const t = h.t;
        await t.exchange('regen row 7', 'POST', '/api/maintenance/seekbar/regen/7', {
            body: {},
            mask: { bytes: ENCODED },
        });
        await t.exchange('meta of row 7 after regen', 'GET', '/api/seekbar/meta/7', {
            mask: { bytes: ENCODED },
        });
    });

    it('build-all, conflict, cancel', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('build-all', 'POST', '/api/maintenance/seekbar/build-all', { body: {} });
        await ws.waitFor((m) => m.type === 'seekbar_done', 60_000);
        await t.exchange('build status after run', 'GET', '/api/maintenance/seekbar/build/status');
        await t.exchange('build stats after run', 'GET', '/api/maintenance/seekbar/build/stats');
        await t.exchange(
            'build cancel when idle',
            'POST',
            '/api/maintenance/seekbar/build/cancel',
            { body: {} },
        );
        await t.exchange('seekbar list after build', 'GET', '/api/maintenance/seekbar/list', {
            mask: {
                'rows[].bytes': `${ENCODED} (the seeded row 6 is masked too — one path covers all rows)`,
            },
            // Rows 8 and 20 are encoded concurrently; their generated_at
            // order (the list's sort key) depends on which ffmpeg finishes
            // first.
            unordered: ['rows'],
        });
        await t.exchange(
            'seekbar queue stats after build',
            'GET',
            '/api/maintenance/seekbar/queue/stats',
        );
        ws.close();
        t.recordWs('ws events: build-all', ws.drain(), { collapse: ['seekbar_progress'] });
    });

    it('rebuild wipe-only removes every sprite', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('rebuild wipeOnly', 'POST', '/api/maintenance/seekbar/rebuild', {
            body: { wipeOnly: true },
        });
        await ws.waitFor((m) => m.type === 'seekbar_rebuild_done');
        await t.exchange(
            'rebuild status after wipe',
            'GET',
            '/api/maintenance/seekbar/rebuild/status',
            {
                mask: {
                    'progress.wiped.bytes': `sum of sprite sizes — includes ${ENCODED}`,
                    'result.wiped.bytes': `sum of sprite sizes — includes ${ENCODED}`,
                },
            },
        );
        await t.exchange('sprite of row 6 after wipe → 404', 'GET', '/api/seekbar/sprite/6');
        await t.exchange('seekbar stats after wipe', 'GET', '/api/maintenance/seekbar/stats');
        ws.close();
        t.recordWs('ws events: rebuild wipeOnly', ws.drain(), {
            collapse: ['seekbar_rebuild_progress'],
            mask: { 'wiped.bytes': `sum of sprite sizes — includes ${ENCODED}` },
        });
    });
});

describe('healthy (fake) sidecar', () => {
    it('health, hwaccel probe, stats, restart', async () => {
        const f = await h.extra({
            configPatch: (cfg) => {
                cfg.advanced.seekbar = { sidecarUrl: fakeBase, apiToken: 'seek-token' };
            },
        });
        await until(
            async () =>
                (await f.request('GET', '/api/maintenance/seekbar/stats')).json?.sidecar?.ok,
            {
                what: 'fake seekbar sidecar connected',
            },
        );
        await viaFake(f, 'fake: seekbar stats', 'GET', '/api/maintenance/seekbar/stats');
        const health = scrub(await f.request('GET', '/api/maintenance/seekbar/health'));
        await f.record(
            'fake: seekbar health',
            { method: 'GET', path: '/api/maintenance/seekbar/health', as: 'admin' },
            health,
            {
                mask: HOST_MASK,
            },
        );
        await viaFake(f, 'fake: hwaccel probe', 'GET', '/api/maintenance/seekbar/hwaccel-probe');
        await viaFake(
            f,
            'fake: sidecar restart',
            'POST',
            '/api/maintenance/seekbar/sidecar/restart',
            {},
        );
    });
});
