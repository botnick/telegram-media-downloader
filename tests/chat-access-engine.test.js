// Chat access state in the engine: every place that talks to Telegram for a
// configured chat must skip a chat no account can read — with no call — and
// must not mark a chat dead while another account can still read it.
// Fake clients + gramJS-shaped errors only; no Telegram.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-access-engine-'));

let db;
let dbApi;
let manager;
let access;
let RealtimeMonitor;
let HistoryDownloader;
let DownloadManager;
let AutoForwarder;
let RPCError;
let FloodWaitError;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    dbApi = await import('../src/core/db.js');
    db = dbApi.getDb();
    manager = await import('../src/config/manager.js');
    access = await import('../src/core/chat-access.js');
    ({ RealtimeMonitor } = await import('../src/core/monitor.js'));
    ({ HistoryDownloader } = await import('../src/core/history.js'));
    ({ DownloadManager } = await import('../src/core/downloader.js'));
    ({ AutoForwarder } = await import('../src/core/forwarder.js'));
    const errors = await import('telegram/errors/index.js');
    RPCError = errors.RPCError;
    FloodWaitError = errors.FloodWaitError;
});

afterAll(() => {
    vi.restoreAllMocks();
    try {
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    access._resetForTests();
    dbApi.kvDelete('config');
    manager._resetConfigBus();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const rpc = (name, code = 400) => new RPCError(name, { className: 'channels.GetMessages' }, code);

/**
 * Fake gramJS client. `read(id, opts)` decides what getMessages returns
 * or throws; every call is logged in `calls`.
 */
function fakeClient(read = () => [{ id: 1 }]) {
    const c = {
        connected: true,
        calls: [],
        dialogs: [],
        async getMessages(id, opts) {
            c.calls.push(String(id));
            return read(String(id), opts);
        },
        async getDialogs() {
            return c.dialogs;
        },
        addEventHandler() {},
        removeEventHandler() {},
    };
    return c;
}

function fakeAccountManager(entries) {
    const clients = new Map(entries);
    return {
        clients,
        metadata: new Map(),
        get count() {
            return clients.size;
        },
        getClient(id) {
            return clients.get(id) || clients.values().next().value || null;
        },
        getDefaultClient() {
            return clients.values().next().value || null;
        },
        getIdForClient(client) {
            for (const [id, c] of clients) if (c === client) return id;
            return null;
        },
    };
}

function fakeDownloader() {
    const ee = new EventEmitter();
    ee.start = () => {};
    ee.stop = async () => {};
    ee.enqueue = vi.fn(async () => true);
    ee.dropGroup = vi.fn(() => 0);
    return ee;
}

function monitorFor(groups, am, downloader = fakeDownloader()) {
    const cfg = manager.loadConfig();
    cfg.groups = groups;
    manager.saveConfig(cfg);
    const mon = new RealtimeMonitor(am.getDefaultClient(), downloader, manager.loadConfig(), am);
    mon.running = true;
    mon.lastIds = new Map();
    mon.groupClientCache = new Map();
    mon.pollGapMs = 0;
    return mon;
}

const PRIVATE = { state: 'private', code: 'CHANNEL_PRIVATE', definite: true };

describe('monitor polling', () => {
    it('skips a chat no account can read — no call at all — and keeps polling the rest', async () => {
        const a = fakeClient();
        const am = fakeAccountManager([['A', a]]);
        const mon = monitorFor(
            [
                { id: -100111, name: 'dead', enabled: true },
                { id: -100222, name: 'fine', enabled: true },
            ],
            am,
        );
        access.recordResult(-100111, 'A', PRIVATE);
        await mon.poll();
        expect(a.calls).toEqual(['-100222']);
        mon.stop().catch(() => {});
    });

    it('another account that still reads the chat takes over; the chat is not marked dead', async () => {
        const a = fakeClient(() => {
            throw rpc('CHANNEL_PRIVATE');
        });
        const b = fakeClient(() => [{ id: 9 }]);
        const am = fakeAccountManager([
            ['A', a],
            ['B', b],
        ]);
        const dl = fakeDownloader();
        const mon = monitorFor(
            [{ id: -100333, name: 'g', enabled: true, monitorAccount: 'A' }],
            am,
            dl,
        );
        await mon.poll();
        expect(access.isBlocked(-100333)).toBe(false);
        expect(mon.getClientForGroup(mon.config.groups[0])).toBe(b);
        expect(manager.loadConfig().groups[0].monitorAccount).toBe('B');
        expect(dl.dropGroup).not.toHaveBeenCalled();
        // the next pass polls through B only
        a.calls.length = 0;
        b.calls.length = 0;
        await mon.poll();
        expect(a.calls).toEqual([]);
        expect(b.calls).toEqual(['-100333']);
        mon.stop().catch(() => {});
    });

    it('no account can read it → paused once, queued downloads dropped, then never asked again', async () => {
        const a = fakeClient(() => {
            throw rpc('CHANNEL_PRIVATE');
        });
        const b = fakeClient(() => {
            throw new Error('Could not find the input entity for {"channelId":"444"}');
        });
        const am = fakeAccountManager([
            ['A', a],
            ['B', b],
        ]);
        const dl = fakeDownloader();
        const mon = monitorFor([{ id: -100444, name: 'gone', enabled: true }], am, dl);
        await mon.poll();
        const acc = access.accessOf(-100444);
        expect(acc.state).toBe('private');
        expect(acc.accounts.map((x) => x.id).sort()).toEqual(['A', 'B']);
        expect(dl.dropGroup).toHaveBeenCalledWith(-100444, 'private');
        // the config entry is untouched — monitoring intent stays on
        expect(manager.loadConfig().groups[0].enabled).toBe(true);
        a.calls.length = 0;
        b.calls.length = 0;
        for (let i = 0; i < 3; i++) await mon.poll();
        expect(a.calls.length + b.calls.length).toBe(0);
        mon.stop().catch(() => {});
    });

    it('downloads failing one after another on a paused chat ask nobody else', async () => {
        const a = fakeClient(() => {
            throw rpc('CHANNEL_PRIVATE');
        });
        const b = fakeClient(() => {
            throw rpc('CHANNEL_PRIVATE');
        });
        const am = fakeAccountManager([
            ['A', a],
            ['B', b],
        ]);
        const mon = monitorFor([{ id: -100445, name: 'gone', enabled: true }], am);
        const group = mon.config.groups[0];
        const cls = { state: 'private', code: 'CHANNEL_PRIVATE', definite: true };
        // the first failure asks the other account once, then pauses
        await mon._handleAccessLoss(group, a, cls);
        expect(access.isBlocked(-100445)).toBe(true);
        expect(b.calls.length).toBe(1);
        // five more in-flight downloads fail: no more probes
        for (let i = 0; i < 5; i++) await mon._handleAccessLoss(group, a, cls);
        expect(a.calls.length + b.calls.length).toBe(1);
        mon.stop().catch(() => {});
    });

    it('a flood wait changes nothing — the chat is polled again next pass', async () => {
        let n = 0;
        const a = fakeClient(() => {
            n += 1;
            throw new FloodWaitError({ request: null, capture: 5 });
        });
        const am = fakeAccountManager([['A', a]]);
        const mon = monitorFor([{ id: -100555, name: 'busy', enabled: true }], am);
        await mon.poll();
        await mon.poll();
        expect(n).toBe(2);
        expect(access.getAccess(-100555)).toBeNull();
        mon.stop().catch(() => {});
    });

    it('a "migrated to" service message marks the group migrated with the new id', async () => {
        const a = fakeClient(() => [
            {
                id: 50,
                chatId: -600n,
                action: { className: 'MessageActionChatMigrateTo', channelId: 777n },
            },
        ]);
        const am = fakeAccountManager([['A', a]]);
        const mon = monitorFor([{ id: -600, name: 'old basic group', enabled: true }], am);
        await mon.poll();
        expect(access.accessOf(-600)).toMatchObject({ state: 'migrated', migratedTo: '-100777' });
        mon.stop().catch(() => {});
    });
});

describe('monitor update handler', () => {
    it('ignores updates from an unreachable chat', async () => {
        const a = fakeClient();
        const am = fakeAccountManager([['A', a]]);
        const dl = fakeDownloader();
        const mon = monitorFor([{ id: -100666, name: 'r', enabled: true }], am, dl);
        access.recordResult(-100666, 'A', {
            state: 'restricted',
            code: 'CHANNEL_PUBLIC_GROUP_NA',
            definite: true,
        });
        await mon.handleEvent({
            message: { id: 3, chatId: -100666n, photo: { id: 1 }, _client: a },
        });
        expect(dl.enqueue).not.toHaveBeenCalled();
    });

    it('a live update from a chat we had "left" proves we are back: flips to ok and downloads', async () => {
        const a = fakeClient();
        const am = fakeAccountManager([['A', a]]);
        const dl = fakeDownloader();
        const mon = monitorFor([{ id: -100667, name: 'back', enabled: true }], am, dl);
        access.recordResult(-100667, 'A', { state: 'left', code: 'CHANNEL_LEFT', definite: true });
        await mon.handleEvent({
            message: { id: 4, chatId: -100667n, photo: { id: 1 }, _client: a },
        });
        expect(access.isBlocked(-100667)).toBe(false);
        expect(dl.enqueue).toHaveBeenCalledTimes(1);
    });
});

describe('monitor re-checks', () => {
    it('start() does not probe a chat already known unreachable (not due); one call per healthy chat', async () => {
        const a = fakeClient(() => [{ id: 12 }]);
        const am = fakeAccountManager([['A', a]]);
        const mon = monitorFor(
            [
                { id: -100701, name: 'dead', enabled: true },
                { id: -100702, name: 'ok', enabled: true },
            ],
            am,
        );
        mon.running = false; // start() sets it
        access.recordResult(-100701, 'A', PRIVATE);
        await mon.start();
        // let the first polling pass finish
        await new Promise((r) => setTimeout(r, 100));
        await mon.stop();
        // the healthy chat: one discovery probe + the first poll — not the
        // old probe + second top-id fetch + poll
        expect(a.calls.filter((x) => x === '-100701')).toEqual([]);
        expect(a.calls.filter((x) => x === '-100702').length).toBe(2);
        expect(mon.lastIds.get(-100702)).toBe(12);
        // still enabled in the config (paused by access state, not disabled)
        expect(manager.loadConfig().groups.find((g) => g.id === -100701).enabled).toBe(true);
    });

    it('a flaky boot (flood wait) no longer auto-disables a healthy chat', async () => {
        const a = fakeClient(() => {
            throw new FloodWaitError({ request: null, capture: 3 });
        });
        const am = fakeAccountManager([['A', a]]);
        const mon = monitorFor([{ id: -100703, name: 'ok', enabled: true }], am);
        mon.running = false;
        mon.pollGapMs = 0;
        await mon.start();
        await mon.stop();
        expect(manager.loadConfig().groups[0].enabled).toBe(true);
        expect(manager.loadConfig().groups[0]._resolveFailedAt).toBeUndefined();
        expect(access.getAccess(-100703)).toBeNull();
    });

    it('the re-check tick asks at most one due chat and brings it back', async () => {
        const reachable = new Set();
        const a = fakeClient((id) => {
            if (reachable.has(id)) return [{ id: 88 }];
            throw rpc('CHANNEL_PRIVATE');
        });
        const am = fakeAccountManager([['A', a]]);
        const mon = monitorFor(
            [
                { id: -100801, name: 'x', enabled: true },
                { id: -100802, name: 'y', enabled: true },
                { id: -100803, name: 'z', enabled: false },
            ],
            am,
        );
        const t0 = Date.now() - 5 * 3600_000; // both due by now, 801 first
        access.recordResult(-100801, 'A', PRIVATE, { now: t0 });
        access.recordResult(-100802, 'A', PRIVATE, { now: t0 + 3600_000 });
        access.recordResult(-100803, 'A', PRIVATE, { now: t0 }); // disabled: never re-checked
        reachable.add('-100801');

        await mon._accessTick();
        expect(a.calls).toEqual(['-100801']);
        expect(access.isBlocked(-100801)).toBe(false);
        expect(mon.lastIds.get(-100801)).toBe(88);

        a.calls.length = 0;
        await mon._accessTick();
        expect(a.calls).toEqual(['-100802']);
        // still failing → backs off to 6 h
        const r = access.getAccess(-100802);
        expect(r.checks).toBe(1);
        expect(r.nextCheckAt - Date.now()).toBeGreaterThan(5 * 3600_000);

        a.calls.length = 0;
        await mon._accessTick();
        expect(a.calls).toEqual([]); // nothing else due; the disabled one is left alone
        mon.stop().catch(() => {});
    });
});

describe('downloader', () => {
    function job(groupId, client, extra = {}) {
        return {
            key: `${groupId}_1`,
            groupId: String(groupId),
            groupName: 'g',
            mediaType: 'photos',
            client,
            accountId: 'A',
            message: { id: 1, date: 1_700_000_000, photo: { id: 1 } },
            ...extra,
        };
    }

    it('an access error fails the job at once (no retries) and is reported', async () => {
        const client = {
            downloadMedia: vi.fn(async () => {
                throw rpc('CHANNEL_PRIVATE');
            }),
        };
        const dm = new DownloadManager(client, { download: { retries: 5 } }, null);
        const seen = [];
        dm.on('access_error', (e) => seen.push(e.cls.state));
        await expect(dm.download(job(-100901, client))).rejects.toMatchObject({
            accessError: { state: 'private' },
        });
        expect(client.downloadMedia).toHaveBeenCalledTimes(1);
        expect(seen).toEqual(['private']);
    });

    it('without a monitor listening, the downloader records the answer itself', async () => {
        const client = {
            downloadMedia: vi.fn(async () => {
                throw rpc('CHANNEL_INVALID');
            }),
        };
        const dm = new DownloadManager(client, { download: { retries: 5 } }, null);
        await expect(dm.download(job(-100902, client))).rejects.toBeTruthy();
        expect(access.accessOf(-100902).state).toBe('deleted');
    });

    it('a lost chat seen while refreshing an expired file reference stops the retries', async () => {
        const client = {
            downloadMedia: vi.fn(async () => {
                throw rpc('FILE_REFERENCE_EXPIRED');
            }),
            getMessages: vi.fn(async () => {
                throw rpc('CHANNEL_PRIVATE');
            }),
        };
        const dm = new DownloadManager(client, { download: { retries: 5 } }, null);
        await expect(
            dm.download(job(-100903, client, { message: { id: 1, photo: {}, peerId: {} } })),
        ).rejects.toMatchObject({ accessError: { state: 'private' } });
        expect(client.downloadMedia).toHaveBeenCalledTimes(1);
        expect(client.getMessages).toHaveBeenCalledTimes(1);
    });

    it('LOCATION_INVALID on media that was deleted fails once, without blind retries', async () => {
        const client = {
            downloadMedia: vi.fn(async () => {
                throw rpc('LOCATION_INVALID');
            }),
            getMessages: vi.fn(async () => [undefined]),
        };
        const dm = new DownloadManager(client, { download: { retries: 5 } }, null);
        await expect(
            dm.download(job(-100905, client, { message: { id: 1, photo: {}, peerId: {} } })),
        ).rejects.toThrow(/no longer available/);
        expect(client.downloadMedia).toHaveBeenCalledTimes(1);
        expect(client.getMessages).toHaveBeenCalledTimes(1);
    });

    it('a queued job of an unreachable chat is skipped without a download call', async () => {
        const client = { downloadMedia: vi.fn(async () => {}) };
        const dm = new DownloadManager(client, { download: { concurrent: 1 } }, null);
        access.recordResult(-100904, 'A', PRIVATE);
        const failed = new Promise((resolve) => dm.once('error', resolve));
        await dm.enqueue(job(-100904, client));
        dm.start();
        const e = await failed;
        await dm.stop();
        expect(e.error).toMatch(/can't be reached/);
        expect(client.downloadMedia).not.toHaveBeenCalled();
    });

    it('reuses a Telegram media row before calling downloadMedia', async () => {
        const mediaDir = path.join(DATA_DIR, 'downloads', 'telegram-dedup');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(path.join(mediaDir, 'original.jpg'), Buffer.from('same'));
        dbApi.insertDownload({
            groupId: '-100910',
            groupName: 'source',
            messageId: 10,
            fileName: 'original.jpg',
            fileSize: 4,
            fileType: 'photo',
            filePath: 'telegram-dedup/original.jpg',
            fileHash: 'hash-from-source',
            telegramMediaKind: 'photo',
            telegramMediaId: '777',
            telegramMediaSize: 4,
        });

        const client = { downloadMedia: vi.fn(async () => {}) };
        const dm = new DownloadManager(client, { download: { retries: 1 } }, null);
        const message = { id: 11, photo: { id: 777, sizes: [{ size: 4 }] } };
        const job = jobFactoryForDedup('-100911', client, { message });
        const stored = await dm.download(job);

        expect(client.downloadMedia).not.toHaveBeenCalled();
        expect(stored).toBe(path.join(DATA_DIR, 'downloads', 'telegram-dedup', 'original.jpg'));
        expect(job.deduped).toBe(true);
        expect(job.dedupReason).toBe('telegram_media');
        expect(
            db
                .prepare(
                    'SELECT telegram_media_kind, telegram_media_id FROM downloads WHERE group_id = ? AND message_id = ?',
                )
                .get('-100911', 11),
        ).toMatchObject({ telegram_media_kind: 'photo', telegram_media_id: '777' });
    });

    it('dropGroup removes only that chat’s queued jobs', async () => {
        const dm = new DownloadManager(null, {}, null);
        await dm.enqueue(job(-1, null, { key: undefined, message: { id: 1 } }));
        await dm.enqueue(job(-1, null, { key: undefined, message: { id: 2 } }), 2);
        await dm.enqueue(job(-2, null, { key: undefined, message: { id: 3 } }));
        expect(dm.dropGroup(-1, 'private')).toBe(2);
        expect(dm.pendingCount).toBe(1);
    });
});

function jobFactoryForDedup(groupId, client, extra = {}) {
    return {
        key: `${groupId}_11`,
        groupId: String(groupId),
        groupName: 'g',
        mediaType: 'photos',
        client,
        accountId: 'A',
        message: { id: 11, date: 1_700_000_000, photo: { id: 777 } },
        ...extra,
    };
}

describe('backfill', () => {
    it('refuses an unreachable chat before any call, with CHAT_UNREACHABLE', async () => {
        const a = fakeClient();
        const am = fakeAccountManager([['A', a]]);
        const cfg = { groups: [{ id: -100950, name: 'g', enabled: true }] };
        const h = new HistoryDownloader(a, fakeDownloader(), cfg, am);
        access.recordResult(-100950, 'A', PRIVATE);
        await expect(h.downloadHistory(-100950, { limit: 10 })).rejects.toMatchObject({
            code: 'CHAT_UNREACHABLE',
            access: { state: 'private' },
        });
        expect(a.calls).toEqual([]);
    });

    it('a backfill whose probe finds no account marks the chat and says why', async () => {
        const a = fakeClient(() => {
            throw rpc('USER_BANNED_IN_CHANNEL');
        });
        const am = fakeAccountManager([['A', a]]);
        const cfg = { groups: [{ id: -100951, name: 'g', enabled: true }] };
        const h = new HistoryDownloader(a, fakeDownloader(), cfg, am);
        h.on('error', () => {});
        await expect(h.downloadHistory(-100951, { limit: 10 })).rejects.toMatchObject({
            code: 'CHAT_UNREACHABLE',
        });
        expect(access.accessOf(-100951).state).toBe('banned');
    });
});

describe('auto-forwarder', () => {
    const cfg = (destination) => ({
        groups: [
            {
                id: '-100960',
                autoForward: { enabled: true, destination, deleteAfterForward: false },
            },
        ],
    });

    it('a destination we cannot post to is remembered and skipped until its re-check', async () => {
        const client = {
            getInputEntity: vi.fn(async () => ({ className: 'InputPeerChannel' })),
            sendFile: vi.fn(async () => {
                throw rpc('CHAT_WRITE_FORBIDDEN', 403);
            }),
        };
        const fwd = new AutoForwarder(client, cfg('-100961'));
        const info = { groupId: '-100960', groupName: 'g', filePath: '/x', message: { id: 1 } };
        await fwd.process(info);
        expect(access.accessOf('dest:-100961').state).toBe('restricted');
        // reading the same chat is NOT affected (namespaced key)
        expect(access.isBlocked('-100961')).toBe(false);
        await fwd.process(info);
        await fwd.process(info);
        expect(client.sendFile).toHaveBeenCalledTimes(1);
    });

    it('skips forwarding from an unreachable source chat', async () => {
        const client = { getInputEntity: vi.fn(), sendFile: vi.fn() };
        const fwd = new AutoForwarder(client, cfg('me'));
        access.recordResult('-100960', 'A', PRIVATE);
        await fwd.process({ groupId: '-100960', groupName: 'g', filePath: '/x', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });
});
