// Web "Add account" flow (AccountManager.beginPhoneAuth / submit* / cancel)
// driven through gramJS's REAL sign-in loop (telegram/client/auth.js) over a
// fake transport, so the tests pin the interaction that broke:
//
//   - A wrong code (or phone number) made gramJS ask again, and the flow
//     handed it the same already-resolved promise — gramJS retried the
//     wrong value in a tight loop until Telegram answered FLOOD_WAIT, and
//     the HTTP submit waited 30 s for a state change that never came.
//   - Cancelling on the code step spun gramJS forever in microtasks (it
//     swallows the rejected prompt, throws "Code is empty", asks again),
//     which starves the event loop — the whole server froze.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const auth = require('telegram/client/auth.js');
const { Api } = require('telegram');

let AccountManager;
const managers = [];

beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `tgdl-authflow-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    process.env.TGDL_DATA_DIR = dir;
    vi.resetModules();
    ({ AccountManager } = await import('../src/core/accounts.js'));
});

afterEach(async () => {
    for (const am of managers.splice(0)) {
        am.stopKeepAlive?.();
        for (const id of [...am._authFlows.keys()]) await am.cancelAuth(id);
    }
    delete process.env.TGDL_DATA_DIR;
});

function rpcError(errorMessage, extra = {}) {
    const e = new Error(extra.message || errorMessage);
    e.errorMessage = errorMessage;
    Object.assign(e, extra);
    return e;
}

// A client object shaped like TelegramClient for gramJS's auth helpers.
// `invoke` answers SendCode / SignIn from the test's script.
function fakeGramClient({ goodCode = '12345', sendCodeError = null } = {}) {
    const calls = { sendCode: 0, signIn: [] };
    const c = {
        connected: true,
        apiId: 1,
        apiHash: 'hash',
        _log: { info() {}, warn() {}, error() {} },
        session: { save: () => 'session-string' },
        connect: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        checkAuthorization: vi.fn().mockResolvedValue(false),
        getMe: vi.fn().mockResolvedValue({ id: 42, firstName: 'Test', username: 'tester' }),
        invoke: vi.fn(async (req) => {
            if (req instanceof Api.auth.SendCode) {
                calls.sendCode += 1;
                if (sendCodeError) throw sendCodeError;
                return new Api.auth.SentCode({
                    type: new Api.auth.SentCodeTypeApp({ length: 5 }),
                    phoneCodeHash: 'hash-1',
                });
            }
            if (req instanceof Api.auth.SignIn) {
                calls.signIn.push(req.phoneCode);
                if (req.phoneCode !== goodCode) throw rpcError('PHONE_CODE_INVALID');
                return new Api.auth.Authorization({
                    user: new Api.User({ id: 42n, firstName: 'Test' }),
                });
            }
            throw new Error(`unexpected request ${req?.className}`);
        }),
    };
    c.start = (params) => auth.start(c, params);
    c.sendCode = (creds, phone, forceSMS) => auth.sendCode(c, creds, phone, forceSMS);
    c.signInUser = (creds, params) => auth.signInUser(c, creds, params);
    c.signInWithPassword = (creds, params) => auth.signInWithPassword(c, creds, params);
    return { client: c, calls };
}

function manager(client) {
    const am = new AccountManager({ telegram: { apiId: 1, apiHash: 'hash' } });
    managers.push(am);
    am.createClient = vi.fn().mockResolvedValue(client);
    am.syncToConfig = vi.fn().mockResolvedValue(undefined);
    am.secure = { encrypt: () => ({ stub: true }), decrypt: () => '' };
    am._startKeepAlive = vi.fn();
    return am;
}

// A macrotask boundary. If gramJS spins in microtasks this never resolves
// and the test times out instead of passing.
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('web add-account flow', () => {
    it('a wrong code comes back as an error on the code step, and the next code signs in', async () => {
        const { client, calls } = fakeGramClient();
        const am = manager(client);
        const { sessionId } = await am.beginPhoneAuth('');

        const afterPhone = await am.submitPhone(sessionId, '+66800000000');
        expect(afterPhone.state).toBe('code');

        const t0 = Date.now();
        const wrong = await am.submitCode(sessionId, '00000');
        expect(Date.now() - t0).toBeLessThan(2000); // no 30 s wait
        expect(wrong.state).toBe('code');
        expect(wrong.code).toBe('PHONE_CODE_INVALID');
        await tick();
        // gramJS tried the wrong code once — it is waiting for a new one,
        // not retrying the old one.
        expect(calls.signIn).toEqual(['00000']);

        const ok = await am.submitCode(sessionId, '12345');
        expect(ok.state).toBe('done');
        expect(ok.error).toBeNull();
        expect(ok.accountId).toBe('tester');
        expect(calls.signIn).toEqual(['00000', '12345']);
        expect(calls.sendCode).toBe(1);
    });

    it('a phone number submitted before gramJS asks for it is still used', async () => {
        const { client, calls } = fakeGramClient();
        // Slow authorization check: the submit lands before the prompt.
        client.checkAuthorization = vi.fn(async () => {
            await tick(30);
            return false;
        });
        const am = manager(client);
        const { sessionId } = await am.beginPhoneAuth('');
        const r = await am.submitPhone(sessionId, '+66800000000');
        expect(r.state).toBe('code');
        expect(calls.sendCode).toBe(1);
    });

    it('a flood wait on the phone step reports FLOOD_WAIT with the seconds', async () => {
        const flood = rpcError('FLOOD', {
            seconds: 300,
            message: 'A wait of 300 seconds is required (caused by auth.SendCode)',
        });
        const { client, calls } = fakeGramClient({ sendCodeError: flood });
        const am = manager(client);
        const { sessionId } = await am.beginPhoneAuth('');
        const r = await am.submitPhone(sessionId, '+66800000000');
        expect(r.state).toBe('phone');
        expect(r.code).toBe('FLOOD_WAIT');
        expect(r.seconds).toBe(300);
        await tick();
        expect(calls.sendCode).toBe(1);
    });

    it('cancelling on the code step stops gramJS instead of spinning', async () => {
        const { client, calls } = fakeGramClient();
        const am = manager(client);
        const { sessionId } = await am.beginPhoneAuth('');
        await am.submitPhone(sessionId, '+66800000000');
        const r = await am.cancelAuth(sessionId);
        expect(r.ok).toBe(true);
        await tick(50); // would never fire if the loop spun in microtasks
        expect(calls.signIn).toEqual([]);
        expect(client.destroy).toHaveBeenCalled();
        expect(am.getAuthStatus(sessionId)).toBeNull();
    });

    it('missing API credentials are reported with a code', async () => {
        const am = new AccountManager({ telegram: {} });
        managers.push(am);
        await expect(am.beginPhoneAuth('')).rejects.toMatchObject({ code: 'NO_API_CREDS' });
    });
});
