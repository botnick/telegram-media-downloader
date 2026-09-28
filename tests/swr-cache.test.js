// Stale-while-revalidate holder behind the dialogs name cache that
// /api/groups + /api/downloads read on first paint.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSwrCache } from '../src/web/lib/swr-cache.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function harness(opts = {}) {
    let t = 1_000_000;
    const loads = [];
    const load = vi.fn(() => {
        const d = deferred();
        loads.push(d);
        return d.promise;
    });
    const cache = createSwrCache({
        load,
        ttlMs: 1000,
        retryAfterFailureMs: 500,
        now: () => t,
        ...opts,
    });
    return {
        cache,
        load,
        loads,
        advance: (ms) => {
            t += ms;
        },
    };
}

const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => {
    vi.useRealTimers();
});

describe('createSwrCache', () => {
    it('cold get() waits for the first load within waitMs', async () => {
        const h = harness();
        const p = h.cache.get({ waitMs: 1000 });
        h.loads[0].resolve('v1');
        expect(await p).toBe('v1');
        expect(h.load).toHaveBeenCalledTimes(1);
    });

    it('cold get() gives up after waitMs but the load still lands for the next caller', async () => {
        vi.useFakeTimers();
        const h = harness();
        const p = h.cache.get({ waitMs: 50 });
        await vi.advanceTimersByTimeAsync(60);
        expect(await p).toBeUndefined();
        h.loads[0].resolve('late');
        await vi.advanceTimersByTimeAsync(0);
        expect(await h.cache.get({ waitMs: 50 })).toBe('late');
        expect(h.load).toHaveBeenCalledTimes(1);
    });

    it('serves a stale value immediately and refreshes once in the background', async () => {
        const h = harness();
        const first = h.cache.get({ waitMs: 1000 });
        h.loads[0].resolve('old');
        await first;
        h.advance(1500); // past ttl
        // Several concurrent readers: all get the stale value, one load runs.
        const reads = await Promise.all([
            h.cache.get({ waitMs: 1000 }),
            h.cache.get({ waitMs: 1000 }),
            h.cache.get(),
        ]);
        expect(reads).toEqual(['old', 'old', 'old']);
        expect(h.load).toHaveBeenCalledTimes(2);
        h.loads[1].resolve('new');
        await flush();
        expect(h.cache.peek()).toBe('new');
        expect(h.load).toHaveBeenCalledTimes(2);
    });

    it('does not reload while fresh', async () => {
        const h = harness();
        const p = h.cache.get({ waitMs: 1000 });
        h.loads[0].resolve('v');
        await p;
        h.advance(500);
        expect(h.cache.peek()).toBe('v');
        expect(h.load).toHaveBeenCalledTimes(1);
    });

    it('keeps the last good value on failure and backs off retries', async () => {
        const h = harness();
        const p = h.cache.get({ waitMs: 1000 });
        h.loads[0].resolve('good');
        await p;
        h.advance(1500);
        expect(h.cache.peek()).toBe('good');
        h.loads[1].reject(new Error('FLOOD_WAIT'));
        await flush();
        // Within the failure window: stale value, no new load.
        h.advance(100);
        expect(h.cache.peek()).toBe('good');
        expect(h.load).toHaveBeenCalledTimes(2);
        // After the window: retried once.
        h.advance(500);
        expect(h.cache.peek()).toBe('good');
        expect(h.load).toHaveBeenCalledTimes(3);
    });

    it('treats an unusable (empty) result as a failure', async () => {
        const h = harness({ isUsable: (m) => m instanceof Map && m.size > 0 });
        const p = h.cache.get({ waitMs: 1000 });
        h.loads[0].resolve(new Map());
        expect(await p).toBeUndefined();
        // Cold + recent failure: no hammering on every request.
        expect(await h.cache.get({ waitMs: 1000 })).toBeUndefined();
        expect(h.load).toHaveBeenCalledTimes(1);
        h.advance(600);
        const p2 = h.cache.get({ waitMs: 1000 });
        h.loads[1].resolve(new Map([['1', 'a']]));
        expect((await p2).get('1')).toBe('a');
    });

    it('invalidate() revalidates on the next read but keeps serving the old value', async () => {
        const h = harness();
        const p = h.cache.get({ waitMs: 1000 });
        h.loads[0].resolve('v1');
        await p;
        h.cache.invalidate();
        expect(h.cache.peek()).toBe('v1');
        expect(h.load).toHaveBeenCalledTimes(2);
    });

    it('set() seeds the value and current() never triggers a load', () => {
        const h = harness();
        expect(h.cache.current()).toBeUndefined();
        h.cache.set('seeded');
        expect(h.cache.current()).toBe('seeded');
        expect(h.cache.peek()).toBe('seeded');
        expect(h.load).not.toHaveBeenCalled();
    });

    it('a hung load times out so later refreshes are not blocked', async () => {
        vi.useFakeTimers();
        const h = harness({ loadTimeoutMs: 100 });
        h.cache.peek();
        expect(h.load).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(150);
        h.advance(600); // past the failure back-off
        h.cache.peek();
        expect(h.load).toHaveBeenCalledTimes(2);
    });
});
