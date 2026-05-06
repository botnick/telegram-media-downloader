// Covers the in-process orchestrator surface area: lifecycle guards,
// state-machine emissions, and status() shape. The downloader / monitor /
// forwarder are heavyweight Telegram-coupled classes, so we exercise the
// runtime through public methods that don't require a wired engine.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let Runtime;

beforeEach(async () => {
    // Re-import for a fresh class per suite so module-level singletons in
    // sibling files don't bleed between tests.
    const mod = await import('../src/core/runtime.js');
    // Rebuild a clean instance via the same constructor the singleton uses.
    Runtime = mod.runtime.constructor;
});

afterEach(() => vi.restoreAllMocks());

describe('Runtime initial state', () => {
    it('boots into the "stopped" state with no error or startedAt', () => {
        const rt = new Runtime();
        expect(rt.state).toBe('stopped');
        expect(rt.error).toBeNull();
        expect(rt.startedAt).toBeNull();
    });

    it('exposes EventEmitter semantics (state channel)', () => {
        const rt = new Runtime();
        const seen = [];
        rt.on('state', (e) => seen.push(e));
        rt.setState('starting');
        rt.setState('running');
        expect(seen).toEqual([
            { state: 'starting', error: null },
            { state: 'running', error: null },
        ]);
    });

    it('passes the error payload through setState', () => {
        const rt = new Runtime();
        const seen = [];
        rt.on('state', (e) => seen.push(e));
        rt.setState('error', 'boom');
        expect(seen[0]).toEqual({ state: 'error', error: 'boom' });
        expect(rt.error).toBe('boom');
    });
});

describe('Runtime.start guards', () => {
    it('rejects when already running', async () => {
        const rt = new Runtime();
        rt.state = 'running';
        await expect(rt.start({ config: {}, accountManager: { count: 1 } })).rejects.toThrow(
            /already running/i,
        );
    });

    it('rejects when already starting (no double-init)', async () => {
        const rt = new Runtime();
        rt.state = 'starting';
        await expect(rt.start({ config: {}, accountManager: { count: 1 } })).rejects.toThrow(
            /already starting/i,
        );
    });

    it('rejects when no accounts are loaded', async () => {
        const rt = new Runtime();
        await expect(rt.start({ config: {}, accountManager: { count: 0 } })).rejects.toThrow(
            /no telegram accounts/i,
        );
    });

    it('rejects when accountManager is missing entirely', async () => {
        const rt = new Runtime();
        await expect(rt.start({ config: {} })).rejects.toThrow(/no telegram accounts/i);
    });
});

describe('Runtime.stop', () => {
    it('is a noop when already stopped (no state event fires)', async () => {
        const rt = new Runtime();
        const seen = [];
        rt.on('state', (e) => seen.push(e));
        await rt.stop();
        expect(seen).toEqual([]);
        expect(rt.state).toBe('stopped');
    });

    it('walks stopping → stopped when we have an active engine', async () => {
        const rt = new Runtime();
        rt.state = 'running';
        rt._monitor = { stop: vi.fn().mockResolvedValue() };
        rt._downloader = { stop: vi.fn().mockResolvedValue() };

        const seen = [];
        rt.on('state', (e) => seen.push(e.state));
        await rt.stop();

        expect(seen).toEqual(['stopping', 'stopped']);
        expect(rt._monitor).toBeNull();
        expect(rt._downloader).toBeNull();
    });

    it('still reaches the "stopped" state even if a child stop() throws', async () => {
        const rt = new Runtime();
        rt.state = 'running';
        rt._monitor = { stop: vi.fn().mockRejectedValue(new Error('monitor down')) };
        rt._downloader = { stop: vi.fn().mockRejectedValue(new Error('dl down')) };
        await rt.stop();
        expect(rt.state).toBe('stopped');
    });
});

describe('Runtime.status', () => {
    it('returns the documented shape with sane defaults when stopped', () => {
        const rt = new Runtime();
        const s = rt.status();
        expect(s).toMatchObject({
            state: 'stopped',
            error: null,
            startedAt: null,
            uptimeMs: 0,
            stats: null,
            queue: 0,
            active: 0,
            workers: 0,
            accounts: 0,
        });
    });

    it('reports uptimeMs once startedAt is populated', () => {
        const rt = new Runtime();
        rt.startedAt = Date.now() - 1000;
        const s = rt.status();
        expect(s.uptimeMs).toBeGreaterThanOrEqual(900);
        expect(s.uptimeMs).toBeLessThan(5000);
    });

    it('surfaces queue / active / workers / accounts from wired children', () => {
        const rt = new Runtime();
        rt._downloader = { pendingCount: 7, active: new Set([1, 2]), workerCount: 4 };
        rt._monitor = { stats: { messages: 10 } };
        rt._accountManager = { count: 3 };
        const s = rt.status();
        expect(s).toMatchObject({
            queue: 7,
            active: 2,
            workers: 4,
            accounts: 3,
            stats: { messages: 10 },
        });
    });
});
