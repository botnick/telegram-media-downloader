// Config contract: GET /api/config (redaction), POST /api/config (deep
// merge, validation, clamping/allow-lists, prototype-pollution strip,
// proxy/cluster/goCore sub-blocks, body-parser edge cases) and
// GET /api/maintenance/config/raw, plus the WS events a save emits.
//
// Every POST persists, so the scenarios run in a fixed order on one server;
// the GETs in between record the cumulative state.

import { describe, it } from 'vitest';
import { AMBIENT_WS_TYPES, sleep, useContract } from './harness.js';

const h = useContract(import.meta.url);

// A save emits `config_updated` synchronously and a debounced (400 ms)
// `stats_update` afterwards; wait for the latter so the sequence is whole.
async function saveAndCollect(
    t,
    ws,
    label,
    body,
    { terminal = 'stats_update', settleMs = 150 } = {},
) {
    ws.drain();
    await t.exchange(label, 'POST', '/api/config', { body });
    await ws.waitFor((m) => m.type === terminal, 10_000);
    await sleep(settleMs);
    return ws.drain();
}

describe('GET /api/config', () => {
    it('admin sees the merged config with secrets redacted', async () => {
        const t = h.t;
        await t.exchange('GET config (seed)', 'GET', '/api/config');
    });

    it('guest and anonymous callers are refused', async () => {
        const t = h.t;
        await t.exchange('GET config guest → 403', 'GET', '/api/config', { as: 'guest' });
        await t.exchange('GET config anon → 401', 'GET', '/api/config', { as: 'anon' });
        await t.exchange('GET config/raw guest → 403', 'GET', '/api/maintenance/config/raw', {
            as: 'guest',
        });
        await t.exchange('GET config/raw anon → 401', 'GET', '/api/maintenance/config/raw', {
            as: 'anon',
        });
    });

    it('config/raw returns the pretty-printed tree with tokens redacted', async () => {
        const t = h.t;
        await t.exchange('GET config/raw (seed)', 'GET', '/api/maintenance/config/raw');
    });
});

describe('POST /api/config validation', () => {
    it('refuses dashboard auth fields', async () => {
        const t = h.t;
        await t.exchange('POST web.password → 400', 'POST', '/api/config', {
            body: { web: { password: 'sneaky-password' } },
        });
        await t.exchange('POST web.passwordHash → 400', 'POST', '/api/config', {
            body: { web: { passwordHash: { algo: 'scrypt', salt: '00', hash: '00' } } },
        });
    });

    it('range-checks download / polling settings', async () => {
        const t = h.t;
        await t.exchange('POST download.concurrent 0 → 400', 'POST', '/api/config', {
            body: { download: { concurrent: 0 } },
        });
        await t.exchange('POST download.concurrent 51 → 400', 'POST', '/api/config', {
            body: { download: { concurrent: 51 } },
        });
        await t.exchange('POST download.retries -1 → 400', 'POST', '/api/config', {
            body: { download: { retries: -1 } },
        });
        await t.exchange('POST download.retries 51 → 400', 'POST', '/api/config', {
            body: { download: { retries: 51 } },
        });
        await t.exchange('POST pollingInterval 0 → 400', 'POST', '/api/config', {
            body: { pollingInterval: 0 },
        });
        await t.exchange('GET config unchanged after rejected saves', 'GET', '/api/config');
    });

    it('guest and anonymous saves are refused', async () => {
        const t = h.t;
        await t.exchange('POST config guest → 403', 'POST', '/api/config', {
            as: 'guest',
            body: { pollingInterval: 30 },
        });
        await t.exchange('POST config anon → 401', 'POST', '/api/config', {
            as: 'anon',
            body: { pollingInterval: 30 },
        });
    });

    // Body-parser failures (400 / 413 inside body-parser) reach the global
    // error handler, which answers 500 with err.message.
    it('body-parser edge cases', async () => {
        const t = h.t;
        await t.exchange('POST malformed JSON', 'POST', '/api/config', {
            headers: { 'content-type': 'application/json' },
            body: '{"pollingInterval": 5,',
            mask: {
                error: 'JSON.parse error text is engine-specific (V8 wording); status + shape are the contract',
            },
        });
        await t.exchange('POST JSON null (strict body parser)', 'POST', '/api/config', {
            headers: { 'content-type': 'application/json' },
            body: 'null',
            mask: {
                error: 'body-parser strict-mode text mimics the V8 JSON.parse wording; status + shape are the contract',
            },
        });
        const big = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 10) });
        const res = await t.request('POST', '/api/config', {
            headers: { 'content-type': 'application/json' },
            body: big,
        });
        await t.record(
            'POST oversized body (>2 MB)',
            {
                method: 'POST',
                path: '/api/config',
                as: 'admin',
                body: `<${big.length} bytes of JSON>`,
            },
            res,
        );
        await t.exchange(
            'POST text/plain body is ignored (saves unchanged config)',
            'POST',
            '/api/config',
            {
                headers: { 'content-type': 'text/plain' },
                body: '{"pollingInterval": 99}',
            },
        );
    });
});

describe('POST /api/config saves', () => {
    it('deep-merges top-level sections and broadcasts config_updated', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        const events = await saveAndCollect(t, ws, 'POST pollingInterval + download.concurrent', {
            pollingInterval: 15,
            download: { concurrent: 5 },
        });
        t.recordWs('ws after a plain save', events);
        ws.close();
        await t.exchange('GET config after plain save (retries kept)', 'GET', '/api/config');
        await t.exchange('GET stats after plain save', 'GET', '/api/stats');
    });

    it('telegram credentials: apiHash is write-only', async () => {
        const t = h.t;
        await t.exchange('POST telegram.apiId only', 'POST', '/api/config', {
            body: { telegram: { apiId: '123456' } },
        });
        await t.exchange('GET config apiHashSet false', 'GET', '/api/config');
        await t.exchange('POST telegram.apiHash', 'POST', '/api/config', {
            body: { telegram: { apiHash: 'contract-api-hash' } },
        });
        await t.exchange('GET config apiHashSet true, apiId kept', 'GET', '/api/config');
        await t.exchange('GET config/raw apiHash redacted', 'GET', '/api/maintenance/config/raw');
    });

    it('advanced.* values are clamped and allow-listed', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('POST advanced out-of-range values', 'POST', '/api/config', {
            body: {
                advanced: {
                    downloader: {
                        minConcurrency: 0,
                        maxConcurrency: 500,
                        scalerIntervalSec: 'abc',
                        idleSleepMs: 5,
                    },
                    history: { backpressureCap: 1, retentionDays: 99999, autoFirstBackfill: 'no' },
                    diskRotator: { sweepBatch: 0, maxDeletesPerSweep: 10_000_000 },
                    integrity: { intervalMin: 0, batchSize: 99999 },
                    web: { sessionTtlDays: 0 },
                    share: { ttlMinSec: 0, ttlMaxSec: 10, ttlDefaultSec: 999_999_999 },
                    thumbs: { hwaccel: 'rm -rf /', warnMisses: 'yes', autoOnDownload: 0 },
                    nsfw: {
                        enabled: 'true',
                        threshold: 5,
                        dtype: 'BOGUS',
                        concurrency: 99,
                        fileTypes: ['photo', 'exe', 'VIDEO'],
                        apiToken: '  secret-nsfw-token  ',
                        model: '   ',
                    },
                    seekbar: {
                        format: 'gif',
                        maxTiles: 99999,
                        hwaccel: 'bogus',
                        overwrite: 'sometimes',
                        quality: 1,
                        columns: 1,
                    },
                    ai: {
                        facesEpsilon: 9,
                        facesMinPoints: 1,
                        tagsMode: 'weird',
                        fileTypes: ['video'],
                        autoScan: 'PAUSED',
                        tagLabels: ['cat', 'cat', ' dog ', ''],
                        facesDetector: 'huge',
                    },
                },
            },
        });
        await ws.waitFor((m) => m.type === 'stats_update', 10_000);
        await sleep(300);
        // The seekbar block restarts the (unreachable) sidecar; its status
        // push races the save's own events, so only the relative order of
        // the save's events is kept (sorted by type — see note).
        const events = ws
            .drain()
            .filter((m) => !AMBIENT_WS_TYPES.includes(m.type))
            .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
        t.recordWs('ws after an advanced.* save', events, {
            note: 'sorted by type: seekbar_sidecar_status (async sidecar probe) races config_updated/ai_config_changed',
        });
        ws.close();
        await t.exchange('GET config after clamping', 'GET', '/api/config');
    });

    it('proxy block: deep merge, null removes a field, null clears', async () => {
        const t = h.t;
        await t.exchange('POST proxy', 'POST', '/api/config', {
            body: {
                proxy: {
                    type: 'socks5',
                    host: 'proxy.invalid',
                    port: 1080,
                    username: 'u',
                    password: 'proxy-pass',
                },
            },
        });
        await t.exchange('GET config with proxy', 'GET', '/api/config');
        await t.exchange(
            'GET config/raw proxy password redacted',
            'GET',
            '/api/maintenance/config/raw',
        );
        await t.exchange('POST proxy partial (port only)', 'POST', '/api/config', {
            body: { proxy: { port: 1081, password: null } },
        });
        await t.exchange('GET config proxy merged, password removed', 'GET', '/api/config');
        await t.exchange('POST proxy null clears', 'POST', '/api/config', {
            body: { proxy: null },
        });
        await t.exchange('GET config proxy cleared', 'GET', '/api/config');
    });

    it('cluster.replicate merges one level deep', async () => {
        const t = h.t;
        await t.exchange('POST cluster.replicate groups', 'POST', '/api/config', {
            body: { cluster: { replicate: { groups: 'shared' }, failover_grace_minutes: 10 } },
        });
        await t.exchange('POST cluster.replicate nsfw', 'POST', '/api/config', {
            body: { cluster: { replicate: { nsfw: 'local' } } },
        });
        await t.exchange('GET config cluster merged', 'GET', '/api/config');
    });

    it('advanced.goCore is sanitised and null removes it', async () => {
        const t = h.t;
        await t.exchange('POST advanced.goCore', 'POST', '/api/config', {
            body: { advanced: { goCore: { mode: 'bogus', features: { hash: 'on', nope: 'on' } } } },
        });
        await t.exchange('GET config goCore stored', 'GET', '/api/config');
        await t.exchange('POST advanced.goCore null', 'POST', '/api/config', {
            body: { advanced: { goCore: null } },
        });
        await t.exchange('GET config goCore removed', 'GET', '/api/config');
    });

    it('prototype-pollution keys are stripped', async () => {
        const t = h.t;
        await t.exchange('POST __proto__ / constructor keys', 'POST', '/api/config', {
            headers: { 'content-type': 'application/json' },
            body: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"download":{"__proto__":{"y":2},"retries":7}}',
        });
        await t.exchange('GET config after pollution attempt', 'GET', '/api/config');
    });

    it('web block: flags merge, auth fields are kept from the stored config', async () => {
        const t = h.t;
        await t.exchange(
            'POST web.rateLimit (disabled) + web.forceHttps false',
            'POST',
            '/api/config',
            {
                body: { web: { rateLimit: { enabled: false, perMinute: 50 }, forceHttps: false } },
            },
        );
        await t.exchange('GET config web merged', 'GET', '/api/config');
        await t.exchange('auth still works after web save', 'GET', '/api/auth_check');
    });

    it('rescue and diskManagement merges', async () => {
        const t = h.t;
        await t.exchange('POST rescue + diskManagement', 'POST', '/api/config', {
            body: {
                rescue: { retentionHours: 12 },
                diskManagement: { maxTotalSize: '10GB' },
            },
        });
        await t.exchange('GET config rescue/diskManagement merged', 'GET', '/api/config');
    });

    it('a JSON array body is spread into the config as index keys', async () => {
        const t = h.t;
        await t.exchange('POST array body', 'POST', '/api/config', { body: ['a', 'b'] });
        await t.exchange('GET config after array body', 'GET', '/api/config');
    });
});
