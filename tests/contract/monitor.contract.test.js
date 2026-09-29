// Monitor / runtime control, history backfill jobs, and the two
// Telegram-bound maintenance jobs (resync-dialogs, restart-monitor).
//
// No Telegram account exists anywhere in the suite, so everything that
// needs one is recorded in its "not possible" shape:
//   - main target: no API credentials → NO_API_CREDS (503) / 500 paths
//   - `creds` target: apiId/apiHash set but no session → "No Telegram
//     accounts loaded" (409) paths
// Finished backfill jobs are seeded into kv['history_jobs'] (with a 10-year
// retention so the 2024 timestamps survive the prune).

import { describe, expect, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const T = (iso) => Date.parse(`${iso}Z`);
const G = SEED.groups;

const SEEDED_JOBS = [
    {
        id: 'a1b2c3000001',
        state: 'done',
        processed: 120,
        downloaded: 14,
        error: null,
        group: G.alpha.name,
        groupId: G.alpha.id,
        limit: 100,
        startedAt: T('2024-06-10T08:00:00'),
        finishedAt: T('2024-06-10T08:05:00'),
        cancelled: false,
        mode: 'pull-older',
    },
    {
        id: 'a1b2c3000002',
        state: 'cancelled',
        processed: 40,
        downloaded: 3,
        error: null,
        group: G.beta.name,
        groupId: G.beta.id,
        limit: null,
        startedAt: T('2024-06-11T08:00:00'),
        finishedAt: T('2024-06-11T08:01:00'),
        cancelled: true,
        mode: 'catch-up',
    },
    {
        id: 'a1b2c3000003',
        state: 'error',
        processed: 0,
        downloaded: 0,
        error: 'No available account can read this chat',
        group: G.delta.name,
        groupId: G.delta.id,
        limit: 50,
        startedAt: T('2024-06-12T08:00:00'),
        finishedAt: T('2024-06-12T08:00:02'),
        cancelled: false,
    },
];

const withHistory = {
    configPatch: (cfg) => {
        cfg.advanced.history = { retentionDays: 3650 };
    },
    afterDb: (db) => {
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            'history_jobs',
            JSON.stringify(SEEDED_JOBS),
            T('2024-06-12T08:00:02'),
        );
    },
};

const withCreds = (cfg) => {
    cfg.telegram = { apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' };
};

const h = useContract(import.meta.url, withHistory);

describe('monitor status and control (no API credentials)', () => {
    it('status per role', async () => {
        const t = h.t;
        await t.exchange('monitor/status admin', 'GET', '/api/monitor/status');
        await t.exchange('monitor/status guest (allowed)', 'GET', '/api/monitor/status', {
            as: 'guest',
        });
        await t.exchange('monitor/status anon → 401', 'GET', '/api/monitor/status', { as: 'anon' });
    });

    it('start / restart need credentials, stop is a no-op when stopped', async () => {
        const t = h.t;
        await t.exchange('monitor/start without API creds → 503', 'POST', '/api/monitor/start', {
            body: {},
        });
        await t.exchange(
            'monitor/restart without API creds → 503',
            'POST',
            '/api/monitor/restart',
            {
                body: {},
            },
        );
        await t.exchange('monitor/stop while stopped', 'POST', '/api/monitor/stop', { body: {} });
        await t.exchange('monitor/start guest → 403', 'POST', '/api/monitor/start', {
            as: 'guest',
            body: {},
        });
        await t.exchange('monitor/stop anon → 401', 'POST', '/api/monitor/stop', {
            as: 'anon',
            body: {},
        });
        // stop persists the operator's intent (autoStart=false) to config.
        const cfg = await t.request('GET', '/api/config');
        expect(cfg.json?.config?.monitor?.autoStart ?? cfg.json?.monitor?.autoStart).toBe(false);
    });
});

describe('history backfill jobs', () => {
    it('POST /api/history validation and refusals', async () => {
        const t = h.t;
        await t.exchange('history start without body → 400', 'POST', '/api/history');
        await t.exchange('history start without groupId → 400', 'POST', '/api/history', {
            body: { limit: 10 },
        });
        await t.exchange('history start for an unreachable chat → 409', 'POST', '/api/history', {
            body: { groupId: G.gamma.id, limit: 10 },
        });
        await t.exchange('history start without API creds → 500', 'POST', '/api/history', {
            body: { groupId: G.alpha.id, limit: 0, mode: 'rescan' },
        });
        await t.exchange('history start guest → 403', 'POST', '/api/history', {
            as: 'guest',
            body: { groupId: G.alpha.id },
        });
    });

    it('lists persisted jobs; unknown ids are 404', async () => {
        const t = h.t;
        await t.exchange('history/jobs with seeded finished jobs', 'GET', '/api/history/jobs');
        await t.exchange('history (in-memory jobs) is empty', 'GET', '/api/history');
        await t.exchange('history/:jobId unknown → 404', 'GET', '/api/history/ffffffffffff');
        await t.exchange(
            'history/:jobId seeded-but-not-in-memory → 404',
            'GET',
            '/api/history/a1b2c3000001',
        );
        await t.exchange(
            'history/:jobId/cancel unknown → 404',
            'POST',
            '/api/history/ffffffffffff/cancel',
            {
                body: {},
            },
        );
        await t.exchange('history/jobs guest → 403', 'GET', '/api/history/jobs', { as: 'guest' });
    });

    it('delete one, then clear all — with WS events', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('history delete one finished job', 'DELETE', '/api/history/a1b2c3000002');
        await t.exchange('history/jobs after delete', 'GET', '/api/history/jobs');
        await t.exchange(
            'history delete unknown id (idempotent)',
            'DELETE',
            '/api/history/ffffffffffff',
        );
        await t.exchange('history clear all', 'DELETE', '/api/history');
        await t.exchange('history/jobs after clear', 'GET', '/api/history/jobs');
        await t.exchange('history clear guest → 403', 'DELETE', '/api/history', { as: 'guest' });
        await ws.waitFor((m) => m.type === 'history_cleared');
        ws.close();
        t.recordWs('ws events from history delete + clear', ws.drain());
    });
});

describe('Telegram-bound maintenance jobs', () => {
    it('resync-dialogs needs credentials', async () => {
        const t = h.t;
        await t.exchange(
            'resync-dialogs without API creds → 503',
            'POST',
            '/api/maintenance/resync-dialogs',
            {
                body: {},
            },
        );
        await t.exchange(
            'resync-dialogs status (idle)',
            'GET',
            '/api/maintenance/resync-dialogs/status',
        );
        await t.exchange('resync-dialogs guest → 403', 'POST', '/api/maintenance/resync-dialogs', {
            as: 'guest',
            body: {},
        });
    });

    it('restart-monitor requires confirm; with the monitor stopped it is a no-op job', async () => {
        const t = h.t;
        await t.exchange(
            'restart-monitor status before (idle)',
            'GET',
            '/api/maintenance/restart-monitor/status',
        );
        await t.exchange(
            'restart-monitor without confirm → 400',
            'POST',
            '/api/maintenance/restart-monitor',
            {
                body: {},
            },
        );
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('restart-monitor confirmed', 'POST', '/api/maintenance/restart-monitor', {
            body: { confirm: true },
        });
        await ws.waitFor((m) => m.type === 'restart_monitor_done');
        await t.exchange(
            'restart-monitor status after (done)',
            'GET',
            '/api/maintenance/restart-monitor/status',
        );
        ws.close();
        t.recordWs('ws events from restart-monitor', ws.drain());
    });
});

describe('with API credentials but no Telegram session', () => {
    it('every engine entry point answers "no accounts"', async () => {
        const c = await h.extra({ configPatch: (cfg) => withCreds(cfg) });
        await c.exchange('[creds] monitor/status hint add-account', 'GET', '/api/monitor/status');
        await c.exchange('[creds] monitor/start → 409', 'POST', '/api/monitor/start', { body: {} });
        await c.exchange('[creds] monitor/restart → 409', 'POST', '/api/monitor/restart', {
            body: {},
        });
        await c.exchange('[creds] history start → 409', 'POST', '/api/history', {
            body: { groupId: G.alpha.id },
        });
        await c.exchange(
            '[creds] history start for a DB-only group → 409',
            'POST',
            '/api/history',
            {
                body: { groupId: G.epsilon.id, limit: 5 },
            },
        );
        await c.exchange(
            '[creds] resync-dialogs → 409',
            'POST',
            '/api/maintenance/resync-dialogs',
            {
                body: {},
            },
        );
        const ws = c.ws();
        await ws.opened;
        ws.drain();
        await c.exchange(
            '[creds] restart-monitor confirmed',
            'POST',
            '/api/maintenance/restart-monitor',
            {
                body: { confirm: true },
            },
        );
        await ws.waitFor((m) => m.type === 'restart_monitor_done');
        ws.close();
        c.recordWs('[creds] ws events from restart-monitor', ws.drain());
    });
});
