// Covers the auto-forwarder's two decision points: process()'s early-exit
// gate (no group / disabled / missing autoForward block) and
// resolveDestination()'s ID-resolution chain (alias → InputEntity → Entity →
// raw -100 InputPeerChannel fallback).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoForwarder } from '../src/core/forwarder.js';

function fakeClient(overrides = {}) {
    return {
        getInputEntity: vi.fn(),
        getEntity: vi.fn(),
        getDialogs: vi.fn(),
        invoke: vi.fn(),
        sendFile: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('AutoForwarder.process — early-exit gates', () => {
    it('no-ops when the group is not in config', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, { groups: [] });
        await fwd.process({ groupId: '999', groupName: 'unknown', filePath: '/x', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('no-ops when the group has no autoForward block', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, { groups: [{ id: '1' }] });
        await fwd.process({ groupId: '1', groupName: 'g', filePath: '/x', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });

    it('no-ops when autoForward is disabled', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, {
            groups: [{ id: '1', autoForward: { enabled: false, destination: 'me' } }],
        });
        await fwd.process({ groupId: '1', groupName: 'g', filePath: '/x', message: {} });
        expect(client.sendFile).not.toHaveBeenCalled();
    });
});

describe('AutoForwarder.resolveDestination — alias + caching', () => {
    it('returns "me" for the "me" alias verbatim', async () => {
        const fwd = new AutoForwarder(fakeClient(), { groups: [] });
        await expect(fwd.resolveDestination('me', fakeClient())).resolves.toBe('me');
    });

    it('returns "me" for the "saved" alias (Saved Messages)', async () => {
        const fwd = new AutoForwarder(fakeClient(), { groups: [] });
        await expect(fwd.resolveDestination('saved', fakeClient())).resolves.toBe('me');
    });

    it('returns the cached storageChannelId on subsequent storage lookups', async () => {
        const client = fakeClient();
        const fwd = new AutoForwarder(client, { groups: [] });
        const cached = { id: 'cached-channel' };
        fwd.storageChannelId = cached;
        await expect(fwd.resolveDestination('storage', client)).resolves.toBe(cached);
        expect(client.getDialogs).not.toHaveBeenCalled();
    });

    it('passes plain strings through as username/phone', async () => {
        const fwd = new AutoForwarder(fakeClient(), { groups: [] });
        await expect(fwd.resolveDestination('@channel_name', fakeClient())).resolves.toBe(
            '@channel_name',
        );
    });
});

describe('AutoForwarder.resolveDestination — numeric ID chain', () => {
    it('returns the InputEntity when the cheap getInputEntity path succeeds', async () => {
        const peer = { _: 'InputPeerChannel', cached: true };
        const client = fakeClient({ getInputEntity: vi.fn().mockResolvedValue(peer) });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('-1001234567890', client)).resolves.toBe(peer);
        expect(client.getEntity).not.toHaveBeenCalled();
    });

    it('falls back to getEntity when getInputEntity throws', async () => {
        const entity = { _: 'Channel', id: 'resolved' };
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('not cached')),
            getEntity: vi.fn().mockResolvedValue(entity),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('-1001234567890', client)).resolves.toBe(entity);
    });

    it('falls back to a manual InputPeerChannel for -100… IDs when both lookups fail', async () => {
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('nope')),
            getEntity: vi.fn().mockRejectedValue(new Error('nope')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const out = await fwd.resolveDestination('-1001234567890', client);
        expect(out?.className || out?.constructor?.name).toMatch(/InputPeerChannel/);
        expect(BigInt(out.channelId)).toBe(1234567890n);
    });

    it('falls back to InputPeerChat for plain negative IDs (legacy chats)', async () => {
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('nope')),
            getEntity: vi.fn().mockRejectedValue(new Error('nope')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const out = await fwd.resolveDestination('-42', client);
        expect(out?.className || out?.constructor?.name).toMatch(/InputPeerChat/);
        expect(BigInt(out.chatId)).toBe(42n);
    });

    it('returns the parsed BigInt when neither -100 nor - prefix matches', async () => {
        const client = fakeClient({
            getInputEntity: vi.fn().mockRejectedValue(new Error('nope')),
            getEntity: vi.fn().mockRejectedValue(new Error('nope')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const out = await fwd.resolveDestination('1234567890', client);
        expect(typeof out).toBe('bigint');
        expect(out).toBe(1234567890n);
    });
});

describe('AutoForwarder.resolveDestination — storage channel discovery', () => {
    it('caches the dialog match when one already exists', async () => {
        const found = { title: 'Telegram Downloader Storage', entity: { _: 'Channel', id: 5n } };
        const client = fakeClient({
            getDialogs: vi.fn().mockResolvedValue([{ title: 'Other channel', entity: {} }, found]),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        const first = await fwd.resolveDestination('storage', client);
        const second = await fwd.resolveDestination('storage', client);
        expect(first).toBe(found.entity);
        expect(second).toBe(found.entity);
        expect(client.getDialogs).toHaveBeenCalledTimes(1);
    });

    it('creates a new storage channel when no match is found', async () => {
        const created = { _: 'Channel', id: 'new' };
        const client = fakeClient({
            getDialogs: vi.fn().mockResolvedValue([]),
            invoke: vi.fn().mockResolvedValue({ chats: [created] }),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('storage', client)).resolves.toBe(created);
        expect(client.invoke).toHaveBeenCalled();
    });

    it('returns null when the storage-channel discovery throws', async () => {
        const client = fakeClient({
            getDialogs: vi.fn().mockRejectedValue(new Error('rpc down')),
        });
        const fwd = new AutoForwarder(client, { groups: [] });
        await expect(fwd.resolveDestination('storage', client)).resolves.toBeNull();
    });
});
