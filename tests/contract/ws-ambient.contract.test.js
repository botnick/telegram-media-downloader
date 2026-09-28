// Timer-driven dashboard events, which every other file filters out:
// `monitor_status_push` (every 3 s while a socket is connected),
// `stats_push` (every 30 s) and the rescue sweeper's first pass (5 s after
// boot), which prunes rescue-mode rows whose keep-window expired.

import { describe, it } from 'vitest';
import { useContract } from './harness.js';

const h = useContract(import.meta.url);

describe('periodic pushes', () => {
    it('monitor_status_push carries the monitor status snapshot', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        const push = await ws.waitFor((m) => m.type === 'monitor_status_push', 10_000);
        const guest = t.ws({ as: 'guest' });
        await guest.opened;
        const guestPush = await guest.waitFor((m) => m.type === 'monitor_status_push', 10_000);
        guest.close();
        t.recordWs('monitor_status_push (admin socket)', [push], { keep: ['monitor_status_push'] });
        t.recordWs('monitor_status_push (guest socket)', [guestPush], {
            keep: ['monitor_status_push'],
        });
        await t.exchange('GET /api/monitor/status for comparison', 'GET', '/api/monitor/status');

        // stats_push: the 30 s timer runs from boot; the socket stays open.
        const stats = await ws.waitFor((m) => m.type === 'stats_push', 40_000);
        ws.close();
        t.recordWs('stats_push after the 30 s tick', [stats], { keep: ['stats_push'] });
    }, 60_000);
});

describe('rescue sweeper', () => {
    it('prunes an expired rescue row on its first pass and reports it', async () => {
        const t = await h.extra({
            afterDb(db) {
                // Row 17 (Delta Mixed, rescue mode): keep-window already over.
                db.prepare('UPDATE downloads SET pending_until = ? WHERE id = 17').run(
                    Date.UTC(2024, 5, 1),
                );
            },
        });
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        await ws.waitFor((m) => m.type === 'rescue_sweep_done', 20_000);
        ws.close();
        t.recordWs('first rescue pass', ws.drain(), {
            ignore: ['monitor_status_push', 'stats_push', 'log', 'stats_update'],
        });
        await t.exchange('rescue stats after the pass', 'GET', '/api/rescue/stats');
        await t.exchange(
            'the pruned file is gone',
            'GET',
            '/files/Delta%20Mixed/images/IMG_0017.jpg',
        );
    }, 40_000);
});
