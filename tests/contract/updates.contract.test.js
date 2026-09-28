// Auto-update contract: capability probe, job-tracker status, the
// update_history audit log and POST /api/update. Outside Docker (and
// without WATCHTOWER_* env) the update run fails its capability check, is
// audited as a failed row and reported through the tracker + WS.
//
// NOTE: all /api/update*, /api/auto-update/status routes are registered
// before the global checkAuth / guestGate middleware, so today they answer
// guests and anonymous callers too (POST /api/update included). The goldens
// record that as-is; see the report / docs for the bug.

import { describe, it } from 'vitest';
import { sleep, useContract } from './harness.js';

const h = useContract(import.meta.url);

describe('update capability and history', () => {
    it('status probe', async () => {
        const t = h.t;
        await t.exchange('GET update/status', 'GET', '/api/update/status');
        await t.exchange('GET update/status guest (no auth gate)', 'GET', '/api/update/status', {
            as: 'guest',
        });
        await t.exchange('GET update/status anon (no auth gate)', 'GET', '/api/update/status', {
            as: 'anon',
        });
    });

    it('idle tracker', async () => {
        const t = h.t;
        await t.exchange('GET auto-update/status (idle)', 'GET', '/api/auto-update/status');
        await t.exchange(
            'GET auto-update/status guest (no auth gate)',
            'GET',
            '/api/auto-update/status',
            {
                as: 'guest',
            },
        );
    });

    it('history paging', async () => {
        const t = h.t;
        await t.exchange('GET update/history', 'GET', '/api/update/history');
        await t.exchange('GET update/history limit=1', 'GET', '/api/update/history?limit=1');
        await t.exchange(
            'GET update/history limit=0 (defaults to 25)',
            'GET',
            '/api/update/history?limit=0',
        );
        await t.exchange('GET update/history limit=abc', 'GET', '/api/update/history?limit=abc');
        await t.exchange(
            'GET update/history limit=-5 (clamped to 1)',
            'GET',
            '/api/update/history?limit=-5',
        );
        await t.exchange('GET update/history guest (no auth gate)', 'GET', '/api/update/history', {
            as: 'guest',
        });
    });
});

describe('POST /api/update', () => {
    it('reachable by guest and anonymous callers (registered before checkAuth)', async () => {
        const t = h.t;
        await t.exchange('POST update guest (no auth gate) → started', 'POST', '/api/update', {
            as: 'guest',
            body: {},
        });
        await t.exchange('POST update anon (no auth gate) → started', 'POST', '/api/update', {
            as: 'anon',
            body: {},
        });
    });

    it('starts, fails the capability check, is audited and broadcast', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('POST update (not in Docker)', 'POST', '/api/update', { body: {} });
        await ws.waitFor((m) => m.type === 'update_done');
        await sleep(150);
        // Keep only the tracker's own log lines — other subsystems may log
        // at any time.
        const events = ws.drain().filter((m) => m.type !== 'log' || m.source === 'autoUpdate');
        t.recordWs('ws events of a failed update run', events, {
            keep: ['log'],
            note: 'log events filtered to source=autoUpdate',
        });
        ws.close();
        await t.exchange('GET auto-update/status after failure', 'GET', '/api/auto-update/status');
        await t.exchange('GET update/history after failure', 'GET', '/api/update/history?limit=2');
        const total = {
            total: 'number of lines the process has logged since boot — depends on async boot ordering',
        };
        await t.exchange(
            'logs/recent source=autoUpdate',
            'GET',
            '/api/maintenance/logs/recent?source=autoUpdate',
            { mask: total },
        );
        await t.exchange(
            'logs/recent source=autoUpdate level=error limit=1',
            'GET',
            '/api/maintenance/logs/recent?source=autoUpdate&level=error&limit=1',
            { mask: total },
        );
    });

    it('a second run starts again (the failed one is not running)', async () => {
        const t = h.t;
        await t.exchange('POST update again', 'POST', '/api/update', { body: {} });
        await sleep(200);
        await t.exchange(
            'GET auto-update/status after second failure',
            'GET',
            '/api/auto-update/status',
        );
    });
});
