// Download queue (IDM-style) API. Without a Telegram session the engine
// never runs, so every per-job action answers 409 "Engine is not running"
// (checked before any body validation); the snapshot and clear-finished
// work on the persisted recent list, seeded into kv['queue_history'].

import { describe, it } from 'vitest';
import { SEED, useContract } from './harness.js';

const T = (iso) => Date.parse(`${iso}Z`);
const G = SEED.groups;

const SEEDED_RECENT = [
    {
        key: `${G.alpha.id}_101`,
        groupId: G.alpha.id,
        groupName: G.alpha.name,
        mediaType: 'photos',
        messageId: 101,
        fileName: 'IMG_0001.jpg',
        filePath: 'Alpha Photos/images/IMG_0001.jpg',
        fileSize: 3365,
        status: 'done',
        deduped: false,
        addedAt: T('2024-06-01T10:00:00'),
        finishedAt: T('2024-06-01T10:00:05'),
        error: null,
    },
    {
        key: `${G.beta.id}_199`,
        groupId: G.beta.id,
        groupName: G.beta.name,
        mediaType: 'videos',
        messageId: 199,
        fileName: 'VID_0199.mp4',
        fileSize: 0,
        status: 'failed',
        addedAt: T('2024-06-01T09:00:00'),
        finishedAt: T('2024-06-01T09:00:30'),
        error: 'FILE_REFERENCE_EXPIRED',
    },
];

const h = useContract(import.meta.url, {
    afterDb: (db) => {
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            'queue_history',
            JSON.stringify(SEEDED_RECENT),
            T('2024-06-01T10:00:05'),
        );
    },
});

const KEY = encodeURIComponent(`${G.alpha.id}_101`);

describe('queue snapshot', () => {
    it('idle engine + persisted recent list', async () => {
        const t = h.t;
        await t.exchange('queue/snapshot admin', 'GET', '/api/queue/snapshot');
        await t.exchange('queue/snapshot guest → 403', 'GET', '/api/queue/snapshot', {
            as: 'guest',
        });
        await t.exchange('queue/snapshot anon → 401', 'GET', '/api/queue/snapshot', { as: 'anon' });
    });
});

describe('engine-bound actions answer 409 while the engine is stopped', () => {
    it('global actions', async () => {
        const t = h.t;
        await t.exchange('queue/pause-all → 409', 'POST', '/api/queue/pause-all', { body: {} });
        await t.exchange('queue/resume-all → 409', 'POST', '/api/queue/resume-all', { body: {} });
        await t.exchange('queue/cancel-all → 409', 'POST', '/api/queue/cancel-all', { body: {} });
        await t.exchange('queue/retry-all → 409', 'POST', '/api/queue/retry-all', { body: {} });
    });

    it('per-job actions', async () => {
        const t = h.t;
        await t.exchange('queue/:key/pause → 409', 'POST', `/api/queue/${KEY}/pause`, { body: {} });
        await t.exchange('queue/:key/resume → 409', 'POST', `/api/queue/${KEY}/resume`, {
            body: {},
        });
        await t.exchange('queue/:key/cancel → 409', 'POST', `/api/queue/${KEY}/cancel`, {
            body: {},
        });
        await t.exchange('queue/:key/retry → 409', 'POST', `/api/queue/${KEY}/retry`, { body: {} });
        await t.exchange('queue/:key/retry unknown key → 409', 'POST', '/api/queue/nope/retry', {
            body: {},
        });
    });

    it('batch: engine check precedes body validation', async () => {
        const t = h.t;
        await t.exchange('queue/batch valid body → 409', 'POST', '/api/queue/batch', {
            body: { keys: [`${G.alpha.id}_101`], action: 'dismiss' },
        });
        await t.exchange('queue/batch empty keys → 409 (not 400)', 'POST', '/api/queue/batch', {
            body: { keys: [], action: 'pause' },
        });
        await t.exchange('queue/batch bad action → 409 (not 400)', 'POST', '/api/queue/batch', {
            body: { keys: ['x'], action: 'explode' },
        });
    });

    it('guests are refused before the engine check', async () => {
        const t = h.t;
        await t.exchange('queue/pause-all guest → 403', 'POST', '/api/queue/pause-all', {
            as: 'guest',
            body: {},
        });
        await t.exchange('queue/batch anon → 401', 'POST', '/api/queue/batch', {
            as: 'anon',
            body: { keys: ['x'], action: 'pause' },
        });
    });
});

describe('clear-finished works without the engine', () => {
    it('empties the recent list and broadcasts queue_changed', async () => {
        const t = h.t;
        const ws = t.ws();
        await ws.opened;
        ws.drain();
        await t.exchange('queue/clear-finished', 'POST', '/api/queue/clear-finished', { body: {} });
        await t.exchange('queue/snapshot after clear-finished', 'GET', '/api/queue/snapshot');
        await t.exchange(
            'queue/clear-finished again (idempotent)',
            'POST',
            '/api/queue/clear-finished',
            {
                body: {},
            },
        );
        await ws.waitFor(
            (m) =>
                m.type === 'queue_changed' &&
                ws.messages.filter((x) => x.type === 'queue_changed').length >= 2,
        );
        ws.close();
        t.recordWs('ws events from clear-finished ×2', ws.drain());
    });
});
