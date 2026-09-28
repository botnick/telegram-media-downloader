// Chat access state — the classifier (gramJS errors, entity shapes, the
// "migrated to" service message) and the registry (per-account answers,
// chat-level verdict, back-off, dialogs sync, probe). No Telegram: errors
// are built the way gramJS builds them, clients are small fakes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-access-'));

let access;
let db;
let RPCError;
let FloodWaitError;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    access = await import('../src/core/chat-access.js');
    const errors = await import('telegram/errors/index.js');
    RPCError = errors.RPCError;
    FloodWaitError = errors.FloodWaitError;
});

afterAll(() => {
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    access._resetForTests();
});

// An RPC error exactly as gramJS raises it for an unknown-to-it code:
// errorMessage 'CHANNEL_PRIVATE', message '400: CHANNEL_PRIVATE (caused by …)'.
const rpc = (name, code = 400) => new RPCError(name, { className: 'channels.GetMessages' }, code);

describe('classifyAccessError', () => {
    const cases = [
        ['CHANNEL_PRIVATE', 'private'],
        ['CHANNEL_INVALID', 'deleted'],
        ['CHAT_ID_INVALID', 'deleted'],
        ['PEER_ID_INVALID', 'deleted'],
        ['USERNAME_INVALID', 'deleted'],
        ['USERNAME_NOT_OCCUPIED', 'deleted'],
        ['CHAT_FORBIDDEN', 'banned'],
        ['USER_BANNED_IN_CHANNEL', 'banned'],
        ['USER_NOT_PARTICIPANT', 'left'],
        ['CHANNEL_PUBLIC_GROUP_NA', 'restricted'],
        ['CHAT_WRITE_FORBIDDEN', 'restricted'],
    ];
    for (const [name, state] of cases) {
        it(`${name} → ${state}`, () => {
            const v = access.classifyAccessError(rpc(name));
            expect(v).toMatchObject({ state, code: name, definite: true });
        });
    }

    it('reads the code from a plain Error message too (older callers / tests)', () => {
        expect(access.classifyAccessError(new Error('CHANNEL_INVALID'))).toMatchObject({
            state: 'deleted',
            definite: true,
        });
        expect(access.classifyAccessError('CHANNEL_PRIVATE')).toMatchObject({ state: 'private' });
    });

    it("gramJS' own 'could not find the input entity' → left (this account never saw it)", () => {
        const e = new Error(
            'Could not find the input entity for {"channelId":"123"}. Please read https://…',
        );
        expect(access.classifyAccessError(e)).toMatchObject({
            state: 'left',
            code: 'ENTITY_NOT_FOUND',
            definite: true,
        });
    });

    it('a flood wait is transient, never a chat state', () => {
        const e = new FloodWaitError({ request: null, capture: 42 });
        const v = access.classifyAccessError(e);
        expect(v).toMatchObject({ state: 'unknown', definite: false, transient: true });
        expect(v.code).toBe('FLOOD_WAIT');
        expect(v.seconds).toBe(42);
    });

    it('timeouts, dropped connections and 5xx are transient', () => {
        for (const e of [
            new Error('TIMEOUT'),
            new Error('Not connected'),
            new Error('read ECONNRESET'),
            rpc('RPC_CALL_FAIL', 500),
            rpc('SOMETHING_ODD', -503),
        ]) {
            expect(access.classifyAccessError(e)).toMatchObject({
                definite: false,
                transient: true,
            });
        }
    });

    it('a revoked / dead session is about the account, not the chat', () => {
        for (const name of ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED_BAN']) {
            expect(access.classifyAccessError(rpc(name, 401))).toMatchObject({
                state: 'unknown',
                definite: false,
                account: true,
            });
        }
    });

    it('an unrelated error is not definite', () => {
        expect(access.classifyAccessError(rpc('MSG_ID_INVALID'))).toMatchObject({
            state: 'unknown',
            code: 'MSG_ID_INVALID',
            definite: false,
        });
        expect(access.classifyAccessError(new Error('boom'))).toMatchObject({ definite: false });
        expect(access.classifyAccessError(null)).toMatchObject({ definite: false });
    });
});

describe('classifyEntity', () => {
    it('ChannelForbidden / ChatForbidden → banned', () => {
        expect(
            access.classifyEntity({ className: 'ChannelForbidden', id: 1, untilDate: 1700000000 }),
        ).toMatchObject({ state: 'banned', code: 'CHANNEL_FORBIDDEN', detail: 'until:1700000000' });
        expect(access.classifyEntity({ className: 'ChatForbidden', id: 1 })).toMatchObject({
            state: 'banned',
        });
    });

    it('a basic group upgraded to a supergroup → migrated with the new id', () => {
        const v = access.classifyEntity({
            className: 'Chat',
            deactivated: true,
            migratedTo: { className: 'InputChannel', channelId: 1987654321n, accessHash: 5n },
        });
        expect(v).toMatchObject({ state: 'migrated', migratedTo: '-1001987654321' });
    });

    it('deactivated without a target → deleted; ChatEmpty → deleted; deleted user → deleted', () => {
        expect(access.classifyEntity({ className: 'Chat', deactivated: true })).toMatchObject({
            state: 'deleted',
        });
        expect(access.classifyEntity({ className: 'ChatEmpty' })).toMatchObject({
            state: 'deleted',
        });
        expect(access.classifyEntity({ className: 'User', deleted: true })).toMatchObject({
            state: 'deleted',
        });
    });

    it('left / kicked flags', () => {
        expect(access.classifyEntity({ className: 'Channel', left: true })).toMatchObject({
            state: 'left',
            code: 'CHANNEL_LEFT',
        });
        expect(access.classifyEntity({ className: 'Chat', kicked: true })).toMatchObject({
            state: 'banned',
        });
    });

    it('restrictionReason for all platforms → restricted; for one platform → ok', () => {
        const all = access.classifyEntity({
            className: 'Channel',
            restricted: true,
            restrictionReason: [{ platform: 'all', reason: 'terms', text: 'Violates ToS' }],
        });
        expect(all).toMatchObject({ state: 'restricted', detail: 'Violates ToS' });
        const ios = access.classifyEntity({
            className: 'Channel',
            restricted: true,
            restrictionReason: [{ platform: 'ios', reason: 'porn', text: 'x' }],
        });
        expect(ios.state).toBe('ok');
    });

    it('a normal member entity → ok; non-entities → null', () => {
        expect(access.classifyEntity({ className: 'Channel', left: false }).state).toBe('ok');
        expect(access.classifyEntity(null)).toBeNull();
    });
});

describe('classifyMessage', () => {
    it('MessageActionChatMigrateTo → migrated', () => {
        const v = access.classifyMessage({
            id: 9,
            action: { className: 'MessageActionChatMigrateTo', channelId: 777n },
        });
        expect(v).toMatchObject({ state: 'migrated', migratedTo: '-100777' });
        expect(access.classifyMessage({ id: 1, message: 'hi' })).toBeNull();
    });
});

describe('registry — per-account answers and the chat-level verdict', () => {
    const PRIVATE = { state: 'private', code: 'CHANNEL_PRIVATE', definite: true };
    const LEFT = { state: 'left', code: 'ENTITY_NOT_FOUND', definite: true };

    it('a chat with no row is ok and not blocked', () => {
        expect(access.isBlocked('-1001')).toBe(false);
        expect(access.accessOf('-1001')).toEqual({ state: 'ok' });
    });

    it('blocks only when no account can read it; the strongest reason wins', () => {
        const now = 1_000_000;
        const a = access.recordCheck(
            -1001,
            [
                { accountId: 'A', cls: LEFT },
                { accountId: 'B', cls: PRIVATE },
            ],
            { now },
        );
        expect(a.state).toBe('private');
        expect(a.code).toBe('CHANNEL_PRIVATE');
        expect(a.firstSeenAt).toBe(now);
        expect(a.accounts.map((x) => x.id).sort()).toEqual(['A', 'B']);
        // number and string ids are the same chat
        expect(access.isBlocked('-1001')).toBe(true);
    });

    it('another account that can read it keeps the chat ok (and remembers who failed)', () => {
        const a = access.recordCheck('-1002', [
            { accountId: 'A', cls: PRIVATE },
            { accountId: 'B', cls: { state: 'ok' } },
        ]);
        expect(a.state).toBe('ok');
        expect(access.isBlocked('-1002')).toBe(false);
        expect(a.accounts.find((x) => x.id === 'A').state).toBe('private');
        // B later loses it too → now blocked
        access.recordResult('-1002', 'B', PRIVATE);
        expect(access.isBlocked('-1002')).toBe(true);
        // A reads it again → ok, B's failure is kept per account
        access.markReachable('-1002', 'A');
        expect(access.isBlocked('-1002')).toBe(false);
        // …and once nobody fails the row is gone
        access.markReachable('-1002', 'B');
        expect(access.getAccess('-1002')).toBeNull();
    });

    it('transient answers never mark a chat', () => {
        access.recordCheck('-1003', [
            { accountId: 'A', cls: { state: 'unknown', transient: true, definite: false } },
        ]);
        expect(access.getAccess('-1003')).toBeNull();
    });

    it('migration is chat-wide — an account that still reads the old group does not undo it', () => {
        access.recordCheck('-5', [
            { accountId: 'A', cls: { state: 'ok' } },
            {
                accountId: 'B',
                cls: {
                    state: 'migrated',
                    definite: true,
                    code: 'CHAT_MIGRATED',
                    migratedTo: '-1009',
                },
            },
        ]);
        const a = access.accessOf('-5');
        expect(a.state).toBe('migrated');
        expect(a.migratedTo).toBe('-1009');
    });

    it('re-checks back off 1 h → 6 h → daily', () => {
        const H = 3600_000;
        const rnd = () => 0.5; // no jitter
        expect(access.recheckDelay(0, { random: rnd })).toBe(H);
        expect(access.recheckDelay(1, { random: rnd })).toBe(6 * H);
        expect(access.recheckDelay(2, { random: rnd })).toBe(24 * H);
        expect(access.recheckDelay(9, { random: rnd })).toBe(24 * H);
        expect(access.recheckDelay(0, { transient: true })).toBe(15 * 60_000);

        const t0 = 10_000_000;
        access.recordResult('-1004', 'A', PRIVATE, { now: t0 });
        let r = access.getAccess('-1004');
        expect(r.checks).toBe(0);
        expect(r.nextCheckAt - t0).toBeGreaterThanOrEqual(0.9 * H);
        expect(r.nextCheckAt - t0).toBeLessThanOrEqual(1.1 * H);
        expect(access.isDue('-1004', t0 + 2 * H)).toBe(true);
        // a failed re-check → 6 h
        access.recordResult('-1004', 'A', PRIVATE, { now: t0 + 2 * H, isRecheck: true });
        r = access.getAccess('-1004');
        expect(r.checks).toBe(1);
        expect(r.nextCheckAt - (t0 + 2 * H)).toBeGreaterThanOrEqual(5.4 * H);
        // a failure seen while polling doesn't advance the back-off
        const before = r.nextCheckAt;
        access.recordResult('-1004', 'A', PRIVATE, { now: t0 + 3 * H });
        expect(access.getAccess('-1004').nextCheckAt).toBe(before);
        expect(access.getAccess('-1004').firstSeenAt).toBe(t0);
    });

    it('nextDueId picks the most overdue blocked chat and keeps the caller id type', () => {
        const now = 50_000_000;
        access.recordResult(-100111, 'A', PRIVATE, { now: now - 10 * 3600_000 });
        access.recordResult(-100222, 'A', PRIVATE, { now: now - 3 * 3600_000 });
        access.recordResult(-100333, 'A', PRIVATE, { now }); // not due yet
        expect(access.nextDueId([-100333, -100222, -100111, -100444], now)).toBe(-100111);
        expect(access.nextDueId([-100333], now)).toBeNull();
    });

    it('persists across a reload from the DB', () => {
        access.recordResult('-1005', 'A', PRIVATE);
        access._resetForTests({ clearDb: false });
        expect(access.isBlocked('-1005')).toBe(true);
        expect(access.accessOf('-1005').accounts[0]).toMatchObject({ id: 'A', state: 'private' });
    });

    it('emits change events on transitions only', () => {
        const seen = [];
        const on = (e) => seen.push(`${e.prev}->${e.state}`);
        access.accessEvents.on('change', on);
        try {
            access.recordResult('-1006', 'A', PRIVATE);
            access.recordResult('-1006', 'A', PRIVATE);
            access.markReachable('-1006', 'A');
        } finally {
            access.accessEvents.off('change', on);
        }
        expect(seen).toEqual(['ok->private', 'private->ok']);
    });

    it('accountsChanged: a new account makes every blocked chat due; a removed one is forgotten', () => {
        const now = 70_000_000;
        access.recordResult('-1007', 'A', PRIVATE, { now });
        expect(access.isDue('-1007', now + 1000)).toBe(false);
        access.accountsChanged(['A', 'B'], { added: true, now: now + 1000 });
        expect(access.isDue('-1007', now + 1000)).toBe(true);
        access.recordCheck('-1008', [
            { accountId: 'A', cls: PRIVATE },
            { accountId: 'B', cls: { state: 'ok' } },
        ]);
        access.accountsChanged(['B']);
        expect(access.getAccess('-1008')).toBeNull();
    });

    it('legacy suspended / auto-disabled config entries map to the same states', () => {
        expect(
            access.effectiveAccess({
                id: -100,
                suspended: true,
                _resolveFailedAt: 5,
                _resolveFailedReason: 'banned:CHANNEL_PRIVATE',
            }),
        ).toMatchObject({ state: 'private', legacy: true });
        expect(
            access.effectiveAccess({
                id: -101,
                _resolveFailedAt: 5,
                _resolveFailedReason: 'probe_failed:CHANNEL_INVALID',
            }),
        ).toMatchObject({ state: 'deleted', legacy: true });
        expect(access.effectiveAccess({ id: -102, suspended: true })).toMatchObject({
            state: 'banned',
        });
        // an unclear old reason on a switched-off chat isn't shown as blocked
        expect(
            access.effectiveAccess({
                id: -103,
                _resolveFailedAt: 5,
                _resolveFailedReason: 'probe_failed:unknown',
            }),
        ).toEqual({ state: 'ok' });
        expect(access.effectiveAccess({ id: -104, enabled: true })).toEqual({ state: 'ok' });
        // the registry wins over legacy flags
        access.recordResult(-105, 'A', PRIVATE);
        expect(access.effectiveAccess({ id: -105, suspended: true }).legacy).toBeUndefined();
    });
});

describe('syncFromDialogs', () => {
    it('a blocked chat seen again as a member flips back to ok', () => {
        access.recordResult('-100900', 'A', {
            state: 'left',
            code: 'CHANNEL_LEFT',
            definite: true,
        });
        const n = access.syncFromDialogs('A', [
            { id: -100900n, entity: { className: 'Channel', left: false } },
        ]);
        expect(n).toBe(1);
        expect(access.isBlocked('-100900')).toBe(false);
    });

    it('records forbidden / migrated configured chats for free, ignores unconfigured ones', () => {
        const configIds = new Set(['-100901', '-902']);
        access.syncFromDialogs(
            'A',
            [
                { id: '-100901', entity: { className: 'ChannelForbidden' } },
                {
                    id: '-902',
                    entity: {
                        className: 'Chat',
                        deactivated: true,
                        migratedTo: { channelId: 55n },
                    },
                },
                { id: '-100903', entity: { className: 'ChannelForbidden' } },
            ],
            { configIds },
        );
        expect(access.accessOf('-100901').state).toBe('banned');
        expect(access.accessOf('-902')).toMatchObject({ state: 'migrated', migratedTo: '-10055' });
        expect(access.getAccess('-100903')).toBeNull();
    });

    it('left / restricted read off an entity alone never pause a chat', () => {
        const configIds = new Set(['-100904', '-100905']);
        access.syncFromDialogs(
            'A',
            [
                { id: '-100904', entity: { className: 'Channel', left: true } },
                {
                    id: '-100905',
                    entity: {
                        className: 'Channel',
                        restricted: true,
                        restrictionReason: [{ platform: 'all', text: 'ToS' }],
                    },
                },
            ],
            { configIds },
        );
        expect(access.isBlocked('-100904')).toBe(false);
        expect(access.isBlocked('-100905')).toBe(false);
        // …but a later refused read on the restricted chat says "restricted"
        const v = access.classifyChatError('-100905', rpc('CHANNEL_PRIVATE'));
        expect(v).toMatchObject({ state: 'restricted', detail: 'ToS' });
    });
});

describe('probeChatAccess', () => {
    const client = (behaviour) => ({
        connected: true,
        calls: 0,
        async getMessages() {
            this.calls += 1;
            return behaviour();
        },
    });

    it('stops at the first account that can read, records ok, returns the client', async () => {
        const a = client(() => {
            throw rpc('CHANNEL_PRIVATE');
        });
        const b = client(() => [{ id: 77 }]);
        const c = client(() => [{ id: 77 }]);
        const r = await access.probeChatAccess('-10050', [
            { accountId: 'A', client: a },
            { accountId: 'B', client: b },
            { accountId: 'C', client: c },
        ]);
        expect(r.state).toBe('ok');
        expect(r.client).toBe(b);
        expect(r.accountId).toBe('B');
        expect(r.topId).toBe(77);
        expect(c.calls).toBe(0); // never asked
        expect(access.isBlocked('-10050')).toBe(false);
        expect(access.accessOf('-10050').accounts.find((x) => x.id === 'A').state).toBe('private');
    });

    it('no account can read it → blocked with every account listed', async () => {
        const r = await access.probeChatAccess('-10051', [
            {
                accountId: 'A',
                client: client(() => {
                    throw rpc('CHANNEL_PRIVATE');
                }),
            },
            {
                accountId: 'B',
                client: client(() => {
                    throw new Error('Could not find the input entity for {}');
                }),
            },
        ]);
        expect(r.state).toBe('private');
        expect(r.client).toBeNull();
        expect(r.results.map((x) => x.state)).toEqual(['private', 'left']);
        expect(access.isBlocked('-10051')).toBe(true);
    });

    it('a flood wait on the only account leaves the chat alone', async () => {
        const r = await access.probeChatAccess('-10052', [
            {
                accountId: 'A',
                client: client(() => {
                    throw new FloodWaitError({ request: null, capture: 30 });
                }),
            },
        ]);
        expect(r.state).toBe('ok');
        expect(r.results[0]).toMatchObject({ transient: true, seconds: 30 });
        expect(access.getAccess('-10052')).toBeNull();
    });

    it('a migrated group is detected from its last message', async () => {
        const r = await access.probeChatAccess('-53', [
            {
                accountId: 'A',
                client: client(() => [
                    { id: 5, action: { className: 'MessageActionChatMigrateTo', channelId: 99n } },
                ]),
            },
        ]);
        expect(r.state).toBe('migrated');
        expect(r.access.migratedTo).toBe('-10099');
    });

    it('a disconnected client is skipped without a call', async () => {
        const off = { connected: false, getMessages: () => Promise.reject(new Error('x')) };
        const r = await access.probeChatAccess('-10054', [{ accountId: 'A', client: off }]);
        expect(r.results[0]).toMatchObject({ code: 'NOT_CONNECTED', transient: true });
        expect(access.getAccess('-10054')).toBeNull();
    });
});
