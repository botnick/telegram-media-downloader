// Faststart (MP4 moov-atom relocation) contract: library stats, the
// auto-optimise counters, and the "Optimize videos for streaming" sweep
// (faststart_* WS events).
//
// Seed videos: rows 6 and 8 (clip-a) already have the moov atom up front;
// rows 7 and 20 (clip-b) have it at the end and get remuxed in place. The
// remuxed byte size depends on the ffmpeg muxer version, so file sizes are
// never recorded here — only counts.

import { describe, it } from 'vitest';
import { useContract } from './harness.js';

const h = useContract(import.meta.url);

async function runSweep(t, label) {
    const ws = t.ws();
    await ws.opened;
    ws.drain();
    await t.exchange(`${label}: start`, 'POST', '/api/maintenance/faststart/scan', { body: {} });
    await ws.waitFor((m) => m.type === 'faststart_done', 45_000);
    ws.close();
    t.recordWs(`${label}: ws sequence`, ws.drain(), { collapse: ['faststart_progress'] });
}

describe('auth', () => {
    it('guest refused, anon unauthorised', async () => {
        const t = h.t;
        await t.exchange(
            'guest POST faststart/scan → 403',
            'POST',
            '/api/maintenance/faststart/scan',
            {
                as: 'guest',
                body: {},
            },
        );
        await t.exchange(
            'guest GET faststart/stats → 403',
            'GET',
            '/api/maintenance/faststart/stats',
            {
                as: 'guest',
            },
        );
        await t.exchange(
            'anon GET faststart/auto-stats → 401',
            'GET',
            '/api/maintenance/faststart/auto-stats',
            {
                as: 'anon',
            },
        );
    });
});

describe('before the sweep', () => {
    it('stats, auto-stats and idle status', async () => {
        const t = h.t;
        await t.exchange('faststart/stats before sweep', 'GET', '/api/maintenance/faststart/stats');
        await t.exchange(
            'faststart/auto-stats (no downloads seen)',
            'GET',
            '/api/maintenance/faststart/auto-stats',
        );
        await t.exchange('faststart/status idle', 'GET', '/api/maintenance/faststart/status');
    });
});

describe('sweep', () => {
    it('remuxes the two moov-at-end videos', async () => {
        const t = h.t;
        await runSweep(t, 'faststart/scan (first)');
        await t.exchange(
            'faststart/status after first sweep',
            'GET',
            '/api/maintenance/faststart/status',
        );
        await t.exchange(
            'faststart/stats after first sweep',
            'GET',
            '/api/maintenance/faststart/stats',
        );
    });

    it('a second sweep finds everything already optimised', async () => {
        const t = h.t;
        await runSweep(t, 'faststart/scan (second)');
        await t.exchange(
            'faststart/status after second sweep',
            'GET',
            '/api/maintenance/faststart/status',
        );
        await t.exchange(
            'faststart/auto-stats after sweeps (sweeps do not count)',
            'GET',
            '/api/maintenance/faststart/auto-stats',
        );
    });
});
