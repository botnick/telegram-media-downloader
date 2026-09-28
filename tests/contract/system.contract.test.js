// System contract: /api/system/health, /api/stats, /api/rescue/stats, the
// log file browser (/api/maintenance/logs, /logs/download, /logs/recent)
// and the password-guarded maintenance actions (session export,
// sign-out-everywhere).
//
// The data dir gets a few fixed log files and one undecryptable session
// file before boot. revoke-all runs last: it kills the seeded sessions.

import fs from 'fs';
import path from 'path';
import { describe, it } from 'vitest';
import { SEED, sleep, useContract } from './harness.js';

const LOG_MTIMES = {
    'app.log': Date.UTC(2024, 0, 3, 12, 0, 0),
    'บันทึก.log': Date.UTC(2024, 0, 2, 12, 0, 0),
    'old.log': Date.UTC(2024, 0, 1, 12, 0, 0),
    'notes.txt': Date.UTC(2024, 0, 4, 12, 0, 0),
};

function seedLogsAndSessions(dataDir) {
    const logs = path.join(dataDir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const appLines = Array.from({ length: 15 }, (_, i) => `2024-01-03 line ${i + 1}`);
    fs.writeFileSync(path.join(logs, 'app.log'), `${appLines.join('\r\n')}\r\n`);
    fs.writeFileSync(path.join(logs, 'บันทึก.log'), 'บรรทัดแรก\nsecond line\n');
    fs.writeFileSync(path.join(logs, 'old.log'), 'a\nb\nc');
    fs.writeFileSync(path.join(logs, 'notes.txt'), 'not a log\n');
    for (const [name, ms] of Object.entries(LOG_MTIMES)) {
        const t = new Date(ms);
        fs.utimesSync(path.join(logs, name), t, t);
    }
    // A session blob no key can open (random salt/iv/tag): export → 500.
    const sessions = path.join(dataDir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
        path.join(sessions, 'broken.enc'),
        JSON.stringify({
            v: 2,
            salt: '11'.repeat(16),
            iv: '22'.repeat(16),
            data: '3333',
            tag: '44'.repeat(16),
        }),
    );
}

const h = useContract(import.meta.url, { beforeStart: seedLogsAndSessions });

// Host / runtime identity and load — differ between machines and runs.
const HEALTH_MASKS = {
    'process.nodeVersion': 'runtime version of the host',
    'system.platform': 'host OS',
    'system.arch': 'host CPU architecture',
    'system.hostname': 'host name',
    'system.cpuCount': 'host CPU count',
    'system.cpuModel': 'host CPU model',
    'system.loadAvg': 'host load average',
    'system.totalMemMB': 'host memory',
    'system.freeMemMB': 'host memory',
    'system.usedMemPercent': 'host memory',
};

describe('/api/system/health', () => {
    it('admin gets process / system / database / goCore status', async () => {
        const t = h.t;
        await t.exchange('GET system/health', 'GET', '/api/system/health', { mask: HEALTH_MASKS });
    });

    it('counts open dashboard sockets', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        await t.exchange('GET system/health with one WS client', 'GET', '/api/system/health', {
            mask: HEALTH_MASKS,
        });
        ws.close();
        await sleep(200);
    });

    it('guest and anonymous callers are refused', async () => {
        const t = h.t;
        await t.exchange('GET system/health guest → 403', 'GET', '/api/system/health', {
            as: 'guest',
        });
        await t.exchange('GET system/health anon → 401', 'GET', '/api/system/health', {
            as: 'anon',
        });
    });
});

describe('/api/stats and /api/rescue/stats', () => {
    it('stats per role (guest gets no peer stats)', async () => {
        const t = h.t;
        await t.exchange('GET stats admin', 'GET', '/api/stats');
        await t.exchange('GET stats guest', 'GET', '/api/stats', { as: 'guest' });
        await t.exchange('GET stats admin again (role switch recomputes)', 'GET', '/api/stats');
        await t.exchange('GET stats anon → 401', 'GET', '/api/stats', { as: 'anon' });
    });

    it('rescue counters', async () => {
        const t = h.t;
        await t.exchange('GET rescue/stats', 'GET', '/api/rescue/stats');
        await t.exchange('GET rescue/stats guest → 403', 'GET', '/api/rescue/stats', {
            as: 'guest',
        });
    });
});

describe('log files', () => {
    it('lists *.log files newest first', async () => {
        const t = h.t;
        await t.exchange('GET maintenance/logs', 'GET', '/api/maintenance/logs');
        await t.exchange('GET maintenance/logs guest → 403', 'GET', '/api/maintenance/logs', {
            as: 'guest',
        });
    });

    it('download validates the name and tails the file', async () => {
        const t = h.t;
        const dl = (label, q, o = {}) =>
            t.exchange(label, 'GET', `/api/maintenance/logs/download${q}`, {
                bodyMode: 'text',
                ...o,
            });
        await dl('logs/download without name → 400', '');
        await dl('logs/download with a slash → 400', '?name=..%2Fdb.sqlite');
        await dl('logs/download with a backslash → 400', '?name=..%5Capp.log');
        await dl('logs/download non-.log → 400', '?name=notes.txt');
        await dl('logs/download missing file → 404', '?name=nope.log');
        await dl('logs/download app.log (default 5000 lines)', '?name=app.log');
        await dl('logs/download app.log lines=2 (clamped to 10)', '?name=app.log&lines=2');
        await dl('logs/download app.log lines=12', '?name=app.log&lines=12');
        await dl('logs/download old.log (no trailing newline)', '?name=old.log');
        await dl('logs/download unicode name', `?name=${encodeURIComponent('บันทึก.log')}`);
        await dl('logs/download guest → 403', '?name=app.log', { as: 'guest' });
    });

    it('recent in-memory log ring (filters)', async () => {
        const t = h.t;
        const total = {
            total: 'number of lines the process has logged since boot — depends on async boot ordering',
        };
        await t.exchange(
            'logs/recent unknown source',
            'GET',
            '/api/maintenance/logs/recent?source=__none__',
            {
                mask: total,
            },
        );
        await t.exchange(
            'logs/recent unknown source, error level, limit',
            'GET',
            '/api/maintenance/logs/recent?source=__none__,__other__&level=error&limit=5',
            { mask: total },
        );
        await t.exchange('logs/recent guest → 403', 'GET', '/api/maintenance/logs/recent', {
            as: 'guest',
        });
    });
});

describe('POST /api/maintenance/session/export', () => {
    const url = '/api/maintenance/session/export';
    it('guards: confirm, password, accountId', async () => {
        const t = h.t;
        await t.exchange('session/export without confirm → 400', 'POST', url, {
            body: { accountId: 'broken', password: SEED.adminPassword },
        });
        await t.exchange('session/export without password → 400', 'POST', url, {
            body: { confirm: true, accountId: 'broken' },
        });
        await t.exchange('session/export wrong password → 403', 'POST', url, {
            body: { confirm: true, accountId: 'broken', password: 'not-the-password' },
        });
        await t.exchange(
            'session/export with the GUEST password passes the password gate',
            'POST',
            url,
            {
                body: { confirm: true, password: SEED.guestPassword },
                note: 'the re-auth guard uses loginVerify, which accepts the guest password too',
            },
        );
        await t.exchange('session/export missing accountId → 400', 'POST', url, {
            body: { confirm: true, password: SEED.adminPassword },
        });
        await t.exchange('session/export path-like accountId → 400', 'POST', url, {
            body: { confirm: true, password: SEED.adminPassword, accountId: '../secret' },
        });
        await t.exchange('session/export unknown account → 404', 'POST', url, {
            body: { confirm: true, password: SEED.adminPassword, accountId: 'nobody' },
        });
        await t.exchange('session/export undecryptable blob → 500', 'POST', url, {
            body: { confirm: true, password: SEED.adminPassword, accountId: 'broken' },
        });
        await t.exchange('session/export guest → 403', 'POST', url, {
            as: 'guest',
            body: { confirm: true, password: SEED.adminPassword, accountId: 'broken' },
        });
    });
});

describe('POST /api/maintenance/sessions/revoke-all', () => {
    const url = '/api/maintenance/sessions/revoke-all';
    it('guards', async () => {
        const t = h.t;
        await t.exchange('revoke-all without confirm → 400', 'POST', url, {
            body: { password: SEED.adminPassword },
        });
        await t.exchange('revoke-all without password → 400', 'POST', url, {
            body: { confirm: true },
        });
        await t.exchange('revoke-all wrong password → 403', 'POST', url, {
            body: { confirm: true, password: 'nope-nope-nope' },
        });
        await t.exchange('revoke-all guest → 403', 'POST', url, {
            as: 'guest',
            body: { confirm: true, password: SEED.adminPassword },
        });
        await t.exchange('revoke-all anon → 401', 'POST', url, {
            as: 'anon',
            body: { confirm: true, password: SEED.adminPassword },
        });
    });

    it('signs every session out and broadcasts sessions_revoked', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'guest' });
        await ws.opened;
        ws.drain();
        await t.exchange('revoke-all', 'POST', url, {
            body: { confirm: true, password: SEED.adminPassword },
        });
        await ws.waitFor((m) => m.type === 'sessions_revoked');
        await sleep(100);
        t.recordWs('ws after revoke-all (open guest socket)', ws.drain());
        ws.close();
        await t.exchange('auth_check admin after revoke-all', 'GET', '/api/auth_check');
        await t.exchange('auth_check guest after revoke-all', 'GET', '/api/auth_check', {
            as: 'guest',
        });
        await t.exchange('GET stats with the revoked admin cookie → 401', 'GET', '/api/stats');
    });
});
