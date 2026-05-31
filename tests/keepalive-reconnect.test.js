// keep-alive must REVIVE dropped clients, not skip them.
//
// A gramJS client whose MTProto socket drops (Telegram idle-disconnect, a
// network blip, or gramJS exhausting connectionRetries) has
// `client.connected === false` permanently. The keep-alive sweep used to
// `continue` past such clients, so the account stayed dark forever — dialogs
// returned not_connected and backfill threw NO_ACCESS. These specs prove the
// sweep now reconnects a disconnected client before pinging it, leaves an
// already-connected client untouched (ping only), backs off on reconnect
// failure without throwing, and honours the FloodWait/reconnect penalty.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let AccountManager;

beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `tgdl-keepalive-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    process.env.TGDL_DATA_DIR = dir;
    vi.resetModules();
    ({ AccountManager } = await import('../src/core/accounts.js'));
});

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TGDL_DATA_DIR;
});

// Bare AccountManager with the maps the tick reads. We never call loadAll()
// (no real Telegram clients), so seed the cooldown maps the way
// _startKeepAlive() would.
function makeManager() {
    const am = new AccountManager({ telegram: { apiId: '1', apiHash: 'x' } });
    am._lastWarnAt = new Map();
    am._skipUntil = new Map();
    return am;
}

function fakeClient({ connected }) {
    const client = {
        connected,
        disconnect: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockImplementation(() => {
            client.connected = true;
            return Promise.resolve();
        }),
        invoke: vi.fn().mockResolvedValue({}),
    };
    return client;
}

describe('AccountManager keep-alive reconnect', () => {
    it('reconnects a disconnected client, then pings it', async () => {
        const am = makeManager();
        const client = fakeClient({ connected: false });
        am.clients.set('acct1', client);

        await am._keepAliveTick();

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(client.connected).toBe(true);
        expect(client.invoke).toHaveBeenCalledTimes(1); // ping fires after reconnect
    });

    it('does not call connect() on an already-connected client (ping only)', async () => {
        const am = makeManager();
        const client = fakeClient({ connected: true });
        am.clients.set('acct1', client);

        await am._keepAliveTick();

        expect(client.connect).not.toHaveBeenCalled();
        expect(client.invoke).toHaveBeenCalledTimes(1);
    });

    it('on reconnect failure: does not throw, does not ping, sets a backoff', async () => {
        const am = makeManager();
        const client = fakeClient({ connected: false });
        client.connect = vi.fn().mockRejectedValue(new Error('network down'));
        am.clients.set('acct1', client);

        await expect(am._keepAliveTick()).resolves.toBeUndefined();

        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(client.invoke).not.toHaveBeenCalled(); // never ping a client we couldn't revive
        expect(am._skipUntil.get('acct1')).toBeGreaterThan(Date.now());
    });

    it('skips a client serving a backoff penalty without touching connect()', async () => {
        const am = makeManager();
        const client = fakeClient({ connected: false });
        am.clients.set('acct1', client);
        am._skipUntil.set('acct1', Date.now() + 60_000);

        await am._keepAliveTick();

        expect(client.connect).not.toHaveBeenCalled();
        expect(client.invoke).not.toHaveBeenCalled();
    });
});
