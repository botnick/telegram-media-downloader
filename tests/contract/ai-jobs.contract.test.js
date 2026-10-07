// AI jobs contract — status, doctor/health, face scans, recluster,
// reindex, quality backfill, auto-scan, detect-test, sidecar probes,
// preload proxies, restart and install-deps.
//
// Three servers:
//   main      seed as-is: AI on, faces backend 'disabled' (no sidecar),
//             scans wait for a sidecar for the default 5 min
//   external  a configured-but-unreachable faces sidecar URL, scans give
//             up at once (sidecarWaitMs 0), PATH = node's own directory
//             only, so the doctor's "host Python" probe and install-deps
//             behave the same on every machine (no Python found)
//   off       AI master switch off
//
// Sidecar probe success paths talk to a fake sidecar served from this test
// process on 127.0.0.1 (loopback is allowed by the sandbox). Its random
// port is replaced by `<fake-sidecar>` in the recorded request.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AMBIENT_WS_TYPES, until, useContract } from './harness.js';

const h = useContract(import.meta.url, {
    afterDb: (db) => {
        // Face 6 without a quality score → the backfill has one row to try.
        db.prepare('UPDATE faces SET quality_score = NULL WHERE id = 6').run();
        // Row 21: a photo whose file is gone from disk (detect-test branch).
        db.prepare(
            `INSERT INTO downloads (id, group_id, group_name, message_id, file_name, file_size, file_type,
                file_path, status, created_at)
             VALUES (21, '-1001000000001', 'Alpha Photos', 121, 'GONE.jpg', 10, 'photo',
                'Alpha Photos/images/GONE.jpg', 'completed', '2024-01-16 10:00:00')`,
        ).run();
    },
});

// Keep the external/off-server contract deterministic even on hosts that
// happen to have Python installed beside Node. The old `dirname(node)` value
// is `/usr/bin` on Linux, which also contains `python3` on many runners.
const NODE_ONLY_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-node-only-'));
fs.symlinkSync(process.execPath, path.join(NODE_ONLY_PATH, 'node'));
const EXTERNAL_URL = 'http://faces.invalid:9';

// ---- fake sidecar ---------------------------------------------------------

let fake;
let fakeBase;
beforeAll(async () => {
    fake = http.createServer((req, res) => {
        const token = req.headers['x-api-token'];
        const send = (status, body, ct = 'application/json') => {
            res.writeHead(status, { 'content-type': ct });
            res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (req.url === '/not-a-sidecar/health')
            return send(200, '<html>login</html>', 'text/html');
        if (req.url === '/health') {
            return send(200, {
                ok: true,
                service: 'tgdl-faces',
                version: '0.9.9-fake',
                model: 'buffalo_l',
                ready: true,
                providers_resolved: ['CPUExecutionProvider'],
                features: ['upload', 'path'],
                auth_required: true,
            });
        }
        if (req.url === '/detect' && req.method === 'POST') {
            if (token !== 'fake-token') return send(401, { error: 'unauthorized' });
            return send(400, { error: 'missing_input' });
        }
        return send(404, { error: 'not_found' });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    fakeBase = `http://127.0.0.1:${fake.address().port}`;
});
afterAll(() => new Promise((r) => fake.close(r)));

/** POST a body that carries the fake sidecar URL; record it with a stable placeholder. */
async function probe(t, label, route, body) {
    const real = JSON.parse(JSON.stringify(body).replaceAll('<fake-sidecar>', fakeBase));
    const res = await t.request('POST', route, { body: real });
    return t.record(label, { method: 'POST', path: route, as: 'admin', body }, res);
}

// The doctor's host-Python row reports whatever interpreter is on PATH;
// only the "external" server (PATH = node's dir) is recorded, so no mask.

describe('main server — faces backend disabled', () => {
    it('status and scan status', async () => {
        const t = h.t;
        await t.exchange('ai status', 'GET', '/api/ai/status');
        await t.exchange('scan status faces', 'GET', '/api/ai/scan/status?feature=faces');
        await t.exchange('scan status without feature → 400', 'GET', '/api/ai/scan/status');
        await t.exchange(
            'scan status removed feature embed → 400',
            'GET',
            '/api/ai/scan/status?feature=embed',
        );
        await t.exchange('ai status as guest → 403', 'GET', '/api/ai/status', { as: 'guest' });
        await t.exchange('ai status as anon → 401', 'GET', '/api/ai/status', { as: 'anon' });
    });

    it('sidecar-less proxies answer 503', async () => {
        const t = h.t;
        await t.exchange(
            'provider-probe without sidecar → 503',
            'GET',
            '/api/ai/faces/provider-probe',
        );
        await t.exchange(
            'preload-model without sidecar → 503',
            'POST',
            '/api/ai/preload-model/buffalo_l',
        );
        await t.exchange(
            'preload-model status without sidecar → 503',
            'GET',
            '/api/ai/preload-model/buffalo_l/status',
        );
    });

    it('detect-test', async () => {
        const t = h.t;
        await t.exchange('detect-test without downloadId → 400', 'POST', '/api/ai/detect-test', {
            body: {},
        });
        await t.exchange('detect-test downloadId 0 → 400', 'POST', '/api/ai/detect-test', {
            body: { downloadId: 0 },
        });
        await t.exchange('detect-test unknown row → 404', 'POST', '/api/ai/detect-test', {
            body: { downloadId: 9999 },
        });
        await t.exchange(
            'detect-test row 1 (no sidecar → raw null)',
            'POST',
            '/api/ai/detect-test',
            {
                body: { downloadId: 1 },
            },
        );
        await t.exchange(
            'detect-test row 21 (file missing on disk)',
            'POST',
            '/api/ai/detect-test',
            {
                body: { downloadId: 21 },
            },
        );
    });

    it('faces sidecar health-test (validation, unreachable, fake sidecar)', async () => {
        const t = h.t;
        const route = '/api/ai/faces/health-test';
        await probe(t, 'health-test without url → 400', route, {});
        await probe(t, 'health-test ftp url → 400', route, { url: 'ftp://faces.example' });
        await probe(t, 'health-test url with credentials → 400', route, {
            url: 'http://u:p@faces.example',
        });
        await probe(t, 'health-test garbage url → 400', route, { url: 'not a url' });
        await probe(t, 'health-test unreachable host', route, { url: 'http://faces.invalid:9' });
        await probe(t, 'health-test fake sidecar with the right token', route, {
            url: '<fake-sidecar>/',
            token: 'fake-token',
        });
        await probe(t, 'health-test fake sidecar without a token', route, {
            url: '<fake-sidecar>',
        });
        await probe(t, 'health-test fake sidecar with a wrong token', route, {
            url: '<fake-sidecar>',
            token: 'nope',
        });
        await probe(t, 'health-test proxy page instead of a sidecar', route, {
            url: '<fake-sidecar>/not-a-sidecar',
        });
    });

    it('scan start / conflicts / cancel while waiting for the sidecar', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('scan start without feature → 400', 'POST', '/api/ai/scan/start', {
            body: {},
        });
        await t.exchange('scan start removed feature tags → 400', 'POST', '/api/ai/scan/start', {
            body: { feature: 'tags' },
        });
        await t.exchange('scan start faces', 'POST', '/api/ai/scan/start', {
            body: { feature: 'faces' },
        });
        await until(
            async () =>
                (await t.request('GET', '/api/ai/scan/status?feature=faces')).json?.state
                    ?.waitingForSidecar,
            { what: 'faces scan waiting for the sidecar' },
        );
        await t.exchange('scan status while waiting', 'GET', '/api/ai/scan/status?feature=faces');
        await t.exchange('scan start again → 409', 'POST', '/api/ai/scan/start', {
            body: { feature: 'faces' },
        });
        await t.exchange('recluster while scanning → 409', 'POST', '/api/ai/faces/recluster', {
            body: {},
        });
        await t.exchange('faces/reindex while scanning → 409', 'POST', '/api/ai/faces/reindex', {
            body: {},
        });
        await t.exchange('scan cancel without feature → 400', 'POST', '/api/ai/scan/cancel', {
            body: {},
        });
        await t.exchange('scan cancel faces', 'POST', '/api/ai/scan/cancel', {
            body: { feature: 'faces' },
        });
        await ws.waitFor((m) => m.type === 'ai_people_done');
        await until(
            async () =>
                (await t.request('GET', '/api/ai/scan/status?feature=faces')).json?.state
                    ?.running === false,
            { what: 'faces scan to stop' },
        );
        await t.exchange('scan status after cancel', 'GET', '/api/ai/scan/status?feature=faces');
        await t.exchange('scan cancel when idle', 'POST', '/api/ai/scan/cancel', {
            body: { feature: 'faces' },
        });
        await t.exchange('people untouched after the cancelled scan', 'GET', '/api/ai/people');
        ws.close();
        // The sidecar restart kicked off by scan/start broadcasts
        // ai_faces_status concurrently with the tracker's first progress
        // tick; their relative order is not part of the contract, so the
        // status events are recorded as their own list.
        const events = ws.drain();
        t.recordWs(
            'ws events: faces scan start → cancel',
            events.filter((m) => m.type !== 'ai_faces_status'),
            { collapse: ['ai_people_progress'] },
        );
        t.recordWs(
            'ws events: faces scan start → cancel (sidecar status only)',
            events.filter((m) => m.type === 'ai_faces_status'),
        );
    });

    it('quality backfill', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('backfill-quality start', 'POST', '/api/ai/backfill-quality', {
            body: {},
        });
        await ws.waitFor((m) => m.type === 'quality_backfill_done');
        await t.exchange(
            'backfill-quality status after run',
            'GET',
            '/api/ai/backfill-quality/status',
        );
        ws.close();
        t.recordWs('ws events: quality backfill', ws.drain(), {
            collapse: ['quality_backfill_progress'],
        });
    });

    it('faces sidecar restart', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('faces restart', 'POST', '/api/ai/faces/restart', { body: {} });
        await ws.waitFor((m) => m.type === 'ai_faces_status');
        ws.close();
        t.recordWs('ws events: faces restart (backend disabled)', ws.drain());
    });

    it('faces/reindex then full ai/reindex wipe the AI tables', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('faces/reindex', 'POST', '/api/ai/faces/reindex', { body: {} });
        await t.exchange('people after faces/reindex', 'GET', '/api/ai/people');
        await t.exchange('ai/reindex', 'POST', '/api/ai/reindex', { body: {} });
        await t.exchange('ai status after reindex', 'GET', '/api/ai/status');
        await ws.waitFor((m) => m.type === 'ai_reindex');
        ws.close();
        t.recordWs('ws events: faces/reindex + ai/reindex', ws.drain());
    });

    // Last on the main server: arming the drip timer queues background
    // work, so nothing is recorded after it.
    it('auto-scan state machine', async () => {
        const t = h.t;
        await t.exchange('auto-scan without action → 400', 'POST', '/api/ai/auto-scan', {
            body: {},
        });
        await t.exchange('auto-scan bad action → 400', 'POST', '/api/ai/auto-scan', {
            body: { action: 'resume' },
        });
        await t.exchange('auto-scan start', 'POST', '/api/ai/auto-scan', {
            body: { action: 'START' },
        });
        await t.exchange('auto-scan pause', 'POST', '/api/ai/auto-scan', {
            body: { action: 'pause' },
        });
        await t.exchange('auto-scan stop', 'POST', '/api/ai/auto-scan', {
            body: { action: 'stop' },
        });
        await t.exchange('auto-scan as guest → 403', 'POST', '/api/ai/auto-scan', {
            as: 'guest',
            body: { action: 'start' },
        });
    });
});

describe('external server — configured but unreachable faces sidecar', () => {
    let x;
    it('boots and marks the sidecar failed', async () => {
        x = await h.extra({
            env: { PATH: NODE_ONLY_PATH, Path: NODE_ONLY_PATH },
            configPatch: (cfg) => {
                cfg.advanced.ai.faces = { sidecarUrl: EXTERNAL_URL, sidecarWaitMs: 0 };
            },
        });
        await until(
            async () =>
                (await x.request('GET', '/api/ai/doctor')).json?.checks?.find(
                    (c) => c.id === 'sidecar',
                )?.status === 'fail',
            { what: 'external faces sidecar marked failed' },
        );
        await x.exchange('external: ai status', 'GET', '/api/ai/status');
        await x.exchange('external: doctor', 'GET', '/api/ai/doctor');
        await x.exchange('external: health (alias of doctor)', 'GET', '/api/ai/health');
    });

    it('proxies surface the network error', async () => {
        await x.exchange('external: provider-probe', 'GET', '/api/ai/faces/provider-probe');
        await x.exchange('external: preload-model', 'POST', '/api/ai/preload-model/buffalo_l');
        await x.exchange(
            'external: preload-model status',
            'GET',
            '/api/ai/preload-model/buffalo_l/status',
        );
        await x.exchange('external: detect-test row 2', 'POST', '/api/ai/detect-test', {
            body: { downloadId: 2 },
        });
    });

    it('scans give up at once without a sidecar', async () => {
        const ws = x.ws();
        await ws.opened;
        ws.drain();
        await x.exchange('external: scan start faces', 'POST', '/api/ai/scan/start', {
            body: { feature: 'faces' },
        });
        await ws.waitFor((m) => m.type === 'ai_people_done');
        await until(
            async () =>
                (await x.request('GET', '/api/ai/scan/status?feature=faces')).json?.state
                    ?.running === false,
            { what: 'scan to end' },
        );
        await x.exchange(
            'external: scan status after failure',
            'GET',
            '/api/ai/scan/status?feature=faces',
        );
        await x.exchange('external: recluster', 'POST', '/api/ai/faces/recluster', { body: {} });
        await ws.waitFor(
            (m) =>
                m.type === 'ai_people_done' &&
                ws.messages.filter((y) => y.type === 'ai_people_done').length >= 2,
        );
        await until(
            async () =>
                (await x.request('GET', '/api/ai/scan/status?feature=faces')).json?.state
                    ?.running === false,
            { what: 'recluster to end' },
        );
        await x.exchange('external: people untouched', 'GET', '/api/ai/people');
        ws.close();
        t_recordFailedScans(x, ws.drain());
    });

    it('install-deps without a Python on PATH', async () => {
        const ws = x.ws();
        await ws.opened;
        ws.drain();
        await x.exchange('external: install-deps', 'POST', '/api/ai/faces/install-deps', {
            body: { force: 'cpu' },
        });
        // The restart is the end marker for the event window: an external
        // sidecar is announced healthy, then its first probe fails.
        await x.exchange('external: faces restart', 'POST', '/api/ai/faces/restart', { body: {} });
        await ws.waitFor((m) => m.type === 'ai_faces_status' && m.ok === false);
        ws.close();
        x.recordWs('external: ws events around install-deps (+ restart marker)', ws.drain());
    });
});

function t_recordFailedScans(x, events) {
    x.recordWs('external: ws events for scan + recluster giving up', events, {
        collapse: ['ai_people_progress'],
        // ai_faces_status comes from the external-URL health watcher whose
        // timer is independent of the scans.
        ignore: [...AMBIENT_WS_TYPES, 'ai_faces_status'],
    });
}

describe('off server — AI master switch off', () => {
    it('scans are refused', async () => {
        const o = await h.extra({
            env: { PATH: NODE_ONLY_PATH, Path: NODE_ONLY_PATH },
            configPatch: (cfg) => {
                cfg.advanced.ai.enabled = false;
            },
        });
        await o.exchange('off: scan start → 503', 'POST', '/api/ai/scan/start', {
            body: { feature: 'faces' },
        });
        await o.exchange('off: ai status', 'GET', '/api/ai/status');
        await o.exchange('off: doctor', 'GET', '/api/ai/doctor');
        expect(o.target).toBeTruthy();
    });
});
