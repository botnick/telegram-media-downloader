// NSFW review contract — status/results, the v2 tier page (tiers,
// histogram, list, bulk ops), whitelist/delete, blocklist, model status,
// preload, cache wipe, sidecar probe and the scan lifecycle.
//
// The classifier runs in an external sidecar here (a configured but
// unreachable `http://nsfw.invalid:9`): the in-process model path depends
// on whether @huggingface/transformers + a cached model exist on the host,
// which is not part of the HTTP contract. The model cache dir is pointed
// inside the temp data dir so the cache wipe never touches the repo's
// data/models (the default cacheDir resolves against the repo root).
//
// Seed scores (photos): row1 0.05, row2 0.45, row3 0.72, row4 0.93,
// row5 0.88 whitelisted; blocklist holds one hash.

import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AMBIENT_WS_TYPES, useContract } from './harness.js';

const h = useContract(import.meta.url, {
    configPatch: (cfg) => {
        cfg.advanced.nsfw = {
            ...cfg.advanced.nsfw,
            sidecarUrl: 'http://nsfw.invalid:9',
            apiToken: 'saved-nsfw-token',
            blocklistEnabled: true,
        };
    },
    afterDb: (db) => {
        // Absolute cache dir inside this target's data dir.
        const dataDir = path.dirname(db.name);
        const row = db.prepare("SELECT value FROM kv WHERE key = 'config'").get();
        const cfg = JSON.parse(row.value);
        cfg.advanced.nsfw.cacheDir = path.join(dataDir, 'models');
        db.prepare("UPDATE kv SET value = ? WHERE key = 'config'").run(JSON.stringify(cfg));
    },
    beforeStart: (dataDir) => {
        const dir = path.join(dataDir, 'models', 'AdamCodd', 'vit-base-nsfw-detector');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'config.json'), '{"fake":true}\n');
        fs.writeFileSync(path.join(dir, 'model_quantized.onnx'), Buffer.alloc(1000, 7));
    },
});

// ---- fake NSFW sidecar (loopback) ---------------------------------------

let fake;
let fakeBase;
beforeAll(async () => {
    fake = http.createServer((req, res) => {
        const send = (status, body, ct = 'application/json') => {
            res.writeHead(status, { 'content-type': ct });
            res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (req.url === '/health') {
            return send(200, {
                ok: true,
                service: 'tgdl-nsfw',
                version: '1.0.0-fake',
                model: 'AdamCodd/vit-base-nsfw-detector',
                ready: true,
                device: 'cpu',
                features: ['upload'],
                auth_required: true,
                path_mode: false,
            });
        }
        if (req.url === '/classify' && req.method === 'POST') {
            if (req.headers['x-api-token'] !== 'nsfw-token')
                return send(401, { error: 'unauthorized' });
            return send(400, { error: 'missing_input' });
        }
        return send(404, { error: 'not_found' });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    fakeBase = `http://127.0.0.1:${fake.address().port}`;
});
afterAll(() => new Promise((r) => fake.close(r)));

async function probe(t, label, body) {
    const route = '/api/maintenance/nsfw/sidecar-test';
    const real = JSON.parse(JSON.stringify(body).replaceAll('<fake-sidecar>', fakeBase));
    const res = await t.request('POST', route, { body: real });
    return t.record(label, { method: 'POST', path: route, as: 'admin', body }, res);
}

async function bulk(t, ws, label, route, body) {
    const before = ws.messages.filter((m) => m.type === 'nsfw_bulk_done').length;
    await t.exchange(label, 'POST', route, { body });
    await ws.waitFor(() => ws.messages.filter((m) => m.type === 'nsfw_bulk_done').length > before);
}

describe('read surface', () => {
    it('status and legacy results', async () => {
        const t = h.t;
        await t.exchange('nsfw status', 'GET', '/api/maintenance/nsfw/status');
        await t.exchange('results default', 'GET', '/api/maintenance/nsfw/results');
        await t.exchange(
            'results page 2 limit 1',
            'GET',
            '/api/maintenance/nsfw/results?page=2&limit=1',
        );
        await t.exchange(
            'results limit clamps to 200',
            'GET',
            '/api/maintenance/nsfw/results?limit=5000&page=0',
        );
    });

    it('v2 tiers, histogram, list', async () => {
        const t = h.t;
        await t.exchange('v2 tiers-meta', 'GET', '/api/maintenance/nsfw/v2/tiers-meta');
        await t.exchange('v2 tiers', 'GET', '/api/maintenance/nsfw/v2/tiers');
        await t.exchange('v2 histogram default bins', 'GET', '/api/maintenance/nsfw/v2/histogram');
        await t.exchange('v2 histogram bins=5', 'GET', '/api/maintenance/nsfw/v2/histogram?bins=5');
        await t.exchange(
            'v2 histogram bins=abc',
            'GET',
            '/api/maintenance/nsfw/v2/histogram?bins=abc',
        );
        await t.exchange('v2 list default', 'GET', '/api/maintenance/nsfw/v2/list');
        for (const tier of ['def_not', 'maybe_not', 'uncertain', 'maybe', 'def']) {
            await t.exchange(
                `v2 list tier=${tier}`,
                'GET',
                `/api/maintenance/nsfw/v2/list?tier=${tier}`,
            );
        }
        await t.exchange(
            'v2 list unknown tier (ignored)',
            'GET',
            '/api/maintenance/nsfw/v2/list?tier=bogus',
        );
        await t.exchange(
            'v2 list include_whitelisted',
            'GET',
            '/api/maintenance/nsfw/v2/list?include_whitelisted=1',
        );
        await t.exchange(
            'v2 list group filter',
            'GET',
            '/api/maintenance/nsfw/v2/list?group=-1001000000001&kind=photo',
        );
        await t.exchange('v2 list kind=video', 'GET', '/api/maintenance/nsfw/v2/list?kind=video');
        await t.exchange(
            'v2 list page 2 limit 2',
            'GET',
            '/api/maintenance/nsfw/v2/list?page=2&limit=2',
        );
        await t.exchange('v2 bulk status idle', 'GET', '/api/maintenance/nsfw/v2/bulk/status');
    });

    it('blocklist and model status', async () => {
        const t = h.t;
        await t.exchange('blocklist stats', 'GET', '/api/maintenance/nsfw/blocklist/stats');
        await t.exchange(
            'model-status (sidecar configured, nothing loaded)',
            'GET',
            '/api/maintenance/nsfw/model-status',
        );
    });

    it('admin only', async () => {
        const t = h.t;
        await t.exchange('status as guest → 403', 'GET', '/api/maintenance/nsfw/status', {
            as: 'guest',
        });
        await t.exchange('v2 list as anon → 401', 'GET', '/api/maintenance/nsfw/v2/list', {
            as: 'anon',
        });
        await t.exchange('whitelist as guest → 403', 'POST', '/api/maintenance/nsfw/whitelist', {
            as: 'guest',
            body: { ids: [1] },
        });
    });
});

describe('sidecar probe, preload, scan', () => {
    it('sidecar-test', async () => {
        const t = h.t;
        await probe(t, 'sidecar-test without url → 400', {});
        await probe(t, 'sidecar-test file:// url → 400', { url: 'file:///etc/passwd' });
        await probe(t, 'sidecar-test unreachable host', { url: 'http://nsfw-other.invalid:1' });
        await probe(t, 'sidecar-test saved url reuses the saved token', {
            url: 'http://nsfw.invalid:9/',
        });
        await probe(t, 'sidecar-test fake sidecar, right token', {
            url: '<fake-sidecar>',
            token: 'nsfw-token',
        });
        await probe(t, 'sidecar-test fake sidecar, no token', {
            url: '<fake-sidecar>',
            useSavedToken: false,
        });
        await probe(t, 'sidecar-test fake sidecar, wrong token', {
            url: '<fake-sidecar>',
            token: 'bad',
        });
    });

    it('preload against the unreachable sidecar', async () => {
        const t = h.t;
        await t.exchange(
            'preload (remote sidecar unreachable)',
            'POST',
            '/api/maintenance/nsfw/preload',
            {
                body: {},
            },
        );
        await t.exchange('model-status after preload', 'GET', '/api/maintenance/nsfw/model-status');
    });

    it('scan ends with the sidecar error', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('scan start', 'POST', '/api/maintenance/nsfw/scan', { body: {} });
        await ws.waitFor((m) => m.type === 'nsfw_done');
        await t.exchange('status after the failed scan', 'GET', '/api/maintenance/nsfw/status');
        await t.exchange('scan cancel when idle', 'POST', '/api/maintenance/nsfw/scan/cancel', {
            body: {},
        });
        ws.close();
        t.recordWs('ws events: scan with unreachable sidecar', ws.drain());
    });
});

describe('review actions (mutations, in order)', () => {
    it('whitelist', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('whitelist without ids → 400', 'POST', '/api/maintenance/nsfw/whitelist', {
            body: {},
        });
        await t.exchange(
            'whitelist with no valid ids → 400',
            'POST',
            '/api/maintenance/nsfw/whitelist',
            {
                body: { ids: ['x', -1, 0] },
            },
        );
        await t.exchange('whitelist row 2', 'POST', '/api/maintenance/nsfw/whitelist', {
            body: { ids: [2, '2'] },
        });
        await ws.waitFor((m) => m.type === 'nsfw_progress');
        ws.close();
        t.recordWs('ws events: whitelist', ws.drain());
    });

    it('v2 bulk operations', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await bulk(t, ws, 'v2 unwhitelist ids [2, 5]', '/api/maintenance/nsfw/v2/unwhitelist', {
            ids: [2, 5],
        });
        await t.exchange(
            'v2 bulk status after unwhitelist',
            'GET',
            '/api/maintenance/nsfw/v2/bulk/status',
        );
        await bulk(
            t,
            ws,
            'v2 bulk-whitelist tier=maybe',
            '/api/maintenance/nsfw/v2/bulk-whitelist',
            {
                tier: 'maybe',
            },
        );
        await bulk(
            t,
            ws,
            'v2 unwhitelist tier=maybe (forces includeWhitelisted)',
            '/api/maintenance/nsfw/v2/unwhitelist',
            {
                tier: 'maybe',
            },
        );
        await bulk(
            t,
            ws,
            'v2 bulk-whitelist empty selection',
            '/api/maintenance/nsfw/v2/bulk-whitelist',
            {
                scoreMin: 0.99,
            },
        );
        await bulk(t, ws, 'v2 reclassify row 3', '/api/maintenance/nsfw/v2/reclassify', {
            ids: [3],
        });
        await t.exchange(
            'v2 bulk-delete without confirm → 400',
            'POST',
            '/api/maintenance/nsfw/v2/bulk-delete',
            {
                body: { ids: [4] },
            },
        );
        await t.exchange(
            'v2 bulk-delete unknown tier fails closed → 400',
            'POST',
            '/api/maintenance/nsfw/v2/bulk-delete',
            {
                body: { tier: 'bogus', confirm: true },
            },
        );
        await bulk(t, ws, 'v2 bulk-delete tier=def', '/api/maintenance/nsfw/v2/bulk-delete', {
            tier: 'def',
            confirm: true,
        });
        await t.exchange('v2 tiers after bulk ops', 'GET', '/api/maintenance/nsfw/v2/tiers');
        await t.exchange(
            'v2 bulk status after delete',
            'GET',
            '/api/maintenance/nsfw/v2/bulk/status',
        );
        ws.close();
        t.recordWs('ws events: v2 bulk operations', ws.drain(), {
            collapse: ['nsfw_bulk_progress'],
            ignore: [...AMBIENT_WS_TYPES],
        });
    });

    it('legacy delete adds to the blocklist', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('delete without ids → 400', 'POST', '/api/maintenance/nsfw/delete', {
            body: { ids: [] },
        });
        await t.exchange('delete with no valid ids → 400', 'POST', '/api/maintenance/nsfw/delete', {
            body: { ids: ['abc'] },
        });
        await t.exchange('delete row 2', 'POST', '/api/maintenance/nsfw/delete', {
            body: { ids: [2] },
        });
        await t.exchange('delete an already-deleted row', 'POST', '/api/maintenance/nsfw/delete', {
            body: { ids: [2] },
        });
        await t.exchange(
            'file of row 2 is gone',
            'GET',
            '/files/Alpha%20Photos/images/IMG_0002.jpg',
        );
        await t.exchange(
            'blocklist stats after deletes',
            'GET',
            '/api/maintenance/nsfw/blocklist/stats',
        );
        await t.exchange('status after deletes', 'GET', '/api/maintenance/nsfw/status');
        await ws.waitFor(
            (m) =>
                m.type === 'nsfw_progress' &&
                ws.messages.filter((x) => x.type === 'nsfw_progress').length >= 2,
        );
        ws.close();
        t.recordWs('ws events: legacy delete', ws.drain());
    });

    it('blocklist wipe and model cache wipe', async () => {
        const t = h.t;
        await t.exchange(
            'blocklist wipe without confirm → 400',
            'DELETE',
            '/api/maintenance/nsfw/blocklist',
            {
                body: {},
            },
        );
        await t.exchange('blocklist wipe', 'DELETE', '/api/maintenance/nsfw/blocklist', {
            body: { confirm: true },
        });
        await t.exchange(
            'blocklist stats after wipe',
            'GET',
            '/api/maintenance/nsfw/blocklist/stats',
        );
        await t.exchange('model cache wipe', 'DELETE', '/api/maintenance/nsfw/cache');
        await t.exchange('model cache wipe again (empty)', 'DELETE', '/api/maintenance/nsfw/cache');
        await t.exchange(
            'model-status after cache wipe',
            'GET',
            '/api/maintenance/nsfw/model-status',
        );
    });
});

describe('NSFW review switched off', () => {
    it('scan is refused, reads still answer', async () => {
        const o = await h.extra({
            configPatch: (cfg) => {
                cfg.advanced.nsfw = { enabled: false, sidecarUrl: 'http://nsfw.invalid:9' };
            },
        });
        await o.exchange('off: scan → 503', 'POST', '/api/maintenance/nsfw/scan', { body: {} });
        await o.exchange('off: status', 'GET', '/api/maintenance/nsfw/status');
        await o.exchange(
            'off: v2 tiers (default threshold)',
            'GET',
            '/api/maintenance/nsfw/v2/tiers',
        );
    });
});
