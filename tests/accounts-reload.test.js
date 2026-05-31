// loadAll() / reloadAccounts() must not leak TelegramClients.
//
// Two adversarial-audit findings (v2.24.4):
//   #1a — disconnect-before-overwrite: a reload that re-stores the same
//         accountId used to orphan the previously-connected client (leaked
//         MTProto socket + gramJS timers that _keepAliveTick can never reap,
//         since it only iterates this.clients). loadAll() must disconnect the
//         old client before replacing it on the authorized success path.
//   #1b — single-flight: two concurrent reloadAccounts() used to both walk the
//         session dir and double-connect every account, orphaning the loser of
//         the final set(). reloadAccounts() must coalesce overlapping calls onto
//         one in-flight promise.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let AccountManager;

// Every real AccountManager built here goes through loadAll(), whose tail calls
// _startKeepAlive() — that arms a NON-unref'd setTimeout(_keepAliveTick, 5s) plus
// an unref'd 60s interval. Under the singleThread pool all files share one worker,
// so a timer that outlives this file fires _keepAliveTick() against a sibling
// file's clients and pollutes it. Track every manager and stopKeepAlive() them in
// afterEach so no timer escapes. (Harmless under the default forks pool too.)
const _managers = [];
function track(am) {
    _managers.push(am);
    return am;
}

beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `tgdl-reload-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    process.env.TGDL_DATA_DIR = dir;
    vi.resetModules();
    ({ AccountManager } = await import('../src/core/accounts.js'));
});

afterEach(() => {
    for (const am of _managers.splice(0)) am.stopKeepAlive?.();
    vi.restoreAllMocks();
    delete process.env.TGDL_DATA_DIR;
});

// A connected fake client. checkAuthorization() resolves true so loadAll()
// treats it as authorized and stores it.
function fakeClient() {
    return {
        connected: true,
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        checkAuthorization: vi.fn().mockResolvedValue(true),
        getMe: vi.fn().mockResolvedValue({ id: 1, firstName: 'T', username: 'u' }),
        invoke: vi.fn().mockResolvedValue({}),
    };
}

// Build an AccountManager whose disk + crypto + createClient are all stubbed so
// loadAll() runs end-to-end without a real Telegram client. createClient hands
// back the next fake from the supplied queue; we assert on those instances.
function stubManager(sessionFiles, clientQueue) {
    const am = track(new AccountManager({ telegram: { apiId: '1', apiHash: 'x' } }));
    const SESSIONS_DIR = path.join(process.env.TGDL_DATA_DIR, 'sessions');
    for (const f of sessionFiles) {
        fs.writeFileSync(path.join(SESSIONS_DIR, `${f}.enc`), '{"stub":true}');
    }
    // Skip the DB-backed legacy migration + config sync (guarded by try/catch
    // in the real code anyway, but make the test fully offline + deterministic).
    am.migrateLegacy = vi.fn().mockResolvedValue(undefined);
    am.syncToConfig = vi.fn().mockResolvedValue(undefined);
    am.secure = { decrypt: () => 'session-string', encrypt: () => ({}) };
    const queue = [...clientQueue];
    am.createClient = vi.fn().mockImplementation(() => Promise.resolve(queue.shift()));
    return am;
}

describe('AccountManager loadAll — disconnect-before-overwrite (#1a)', () => {
    it('disconnects the previously-stored client before replacing it on reload', async () => {
        const first = fakeClient();
        const second = fakeClient();
        const am = stubManager(['acct1'], [first, second]);

        // First load stores `first` under acct1.
        await am.loadAll();
        expect(am.clients.get('acct1')).toBe(first);
        expect(first.disconnect).not.toHaveBeenCalled();

        // Second load builds `second` for the same id — `first` must be torn
        // down before `second` replaces it, or its socket/timers leak.
        await am.loadAll();
        expect(first.disconnect).toHaveBeenCalledTimes(1);
        expect(am.clients.get('acct1')).toBe(second);
    });

    it('leaves the working client in place when the reload session is unauthorized', async () => {
        const working = fakeClient();
        const stale = fakeClient();
        stale.checkAuthorization = vi.fn().mockResolvedValue(false); // session expired
        const am = stubManager(['acct1'], [working, stale]);

        await am.loadAll();
        expect(am.clients.get('acct1')).toBe(working);

        // Reload: the new client comes back unauthorized. The unauthorized
        // branch disconnects ITS OWN client and continues — the previously
        // working client must NOT be disconnected or evicted.
        await am.loadAll();
        expect(working.disconnect).not.toHaveBeenCalled();
        expect(stale.disconnect).toHaveBeenCalledTimes(1);
        expect(am.clients.get('acct1')).toBe(working);
    });
});

describe('AccountManager reloadAccounts — single-flight (#1b)', () => {
    it('coalesces concurrent reloads onto one loadAll run', async () => {
        const am = new AccountManager({ telegram: { apiId: '1', apiHash: 'x' } });
        let calls = 0;
        // Slow loadAll so the second call lands while the first is in flight.
        am.loadAll = vi.fn().mockImplementation(() => {
            calls++;
            return new Promise((resolve) => setTimeout(() => resolve(calls), 20));
        });

        const p1 = am.reloadAccounts();
        const p2 = am.reloadAccounts();

        // The gate IS the shared in-flight promise; the second concurrent
        // caller must observe the same stored _loadingAll the first set.
        // reloadAccounts is `async`, so its two RETURN values are distinct
        // wrapper promises even though both resolve from one loadAll run —
        // so identity is asserted on the gate, and equivalence on the result.
        expect(am._loadingAll).toBeInstanceOf(Promise);
        const [r1, r2] = await Promise.all([p1, p2]);
        // loadAll ran exactly once and both callers resolved from that one run.
        expect(am.loadAll).toHaveBeenCalledTimes(1);
        expect(calls).toBe(1);
        expect(r1).toBe(r2);
    });

    it('allows a fresh reload after the previous one settles', async () => {
        const am = new AccountManager({ telegram: { apiId: '1', apiHash: 'x' } });
        am.loadAll = vi.fn().mockResolvedValue(0);

        await am.reloadAccounts();
        await am.reloadAccounts();

        expect(am.loadAll).toHaveBeenCalledTimes(2);
        expect(am._loadingAll).toBeNull(); // gate cleared
    });

    it('clears the in-flight gate even when loadAll rejects', async () => {
        const am = new AccountManager({ telegram: { apiId: '1', apiHash: 'x' } });
        am.loadAll = vi.fn().mockRejectedValue(new Error('boom'));

        await expect(am.reloadAccounts()).rejects.toThrow('boom');
        expect(am._loadingAll).toBeNull();

        // A subsequent reload is not stuck behind the failed promise.
        am.loadAll = vi.fn().mockResolvedValue(0);
        await expect(am.reloadAccounts()).resolves.toBe(0);
    });
});
