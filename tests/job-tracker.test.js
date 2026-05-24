import { describe, it, expect } from 'vitest';
import { createJobTracker } from '../src/core/job-tracker.js';

function flushAsync(times = 4) {
    let p = Promise.resolve();
    for (let i = 0; i < times; i++) p = p.then(() => undefined);
    return p;
}

describe('createJobTracker', () => {
    it('rejects construction without a kind', () => {
        expect(() => createJobTracker({})).toThrow(/kind/);
    });

    it('returns a stable status snapshot before any run', () => {
        const t = createJobTracker({ kind: 'demo', broadcast: () => {} });
        const a = t.getStatus();
        const b = t.getStatus();
        expect(a.kind).toBe('demo');
        expect(a.running).toBe(false);
        expect(a.stage).toBe('idle');
        expect(a).toEqual(b);
    });

    it('tryStart × 2 — second call returns ALREADY_RUNNING with snapshot', async () => {
        const t = createJobTracker({ kind: 'slow', broadcast: () => {} });
        const first = t.tryStart(async () => {
            // Hold so we can observe single-flight.
            await new Promise((res) => setTimeout(res, 50));
            return { ok: true };
        });
        expect(first.started).toBe(true);
        expect(t.isRunning()).toBe(true);

        const second = t.tryStart(async () => ({ never: true }));
        expect(second.started).toBe(false);
        expect(second.code).toBe('ALREADY_RUNNING');
        expect(second.snapshot.running).toBe(true);

        // Wait for first to finish.
        await new Promise((res) => setTimeout(res, 80));
        expect(t.isRunning()).toBe(false);
        expect(t.getStatus().result).toEqual({ ok: true });
    });

    it('captures a thrown error in state and emits done with {error}', async () => {
        const broadcasts = [];
        const t = createJobTracker({ kind: 'oops', broadcast: (m) => broadcasts.push(m) });
        t.tryStart(async () => {
            throw new Error('boom');
        });
        await flushAsync(20);
        const s = t.getStatus();
        expect(s.running).toBe(false);
        expect(s.stage).toBe('error');
        expect(s.error).toBe('boom');
        expect(s.failures).toBe(1);
        const done = broadcasts.find((m) => m.type === 'oops_done');
        expect(done).toBeTruthy();
        expect(done.error).toBe('boom');
    });

    it('cancel during run aborts via signal and transitions to running:false', async () => {
        const t = createJobTracker({ kind: 'cancellable', broadcast: () => {} });
        let aborted = false;
        const start = t.tryStart(async ({ signal }) => {
            await new Promise((res, rej) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    rej(new Error('aborted'));
                });
            });
        });
        expect(start.started).toBe(true);
        expect(t.cancel()).toBe(true);
        await flushAsync(10);
        expect(aborted).toBe(true);
        expect(t.isRunning()).toBe(false);
    });

    it('subsequent tryStart works after a previous run completed', async () => {
        const t = createJobTracker({ kind: 'reusable', broadcast: () => {} });
        t.tryStart(async () => ({ run: 1 }));
        await flushAsync(10);
        expect(t.getStatus().result).toEqual({ run: 1 });

        t.tryStart(async () => ({ run: 2 }));
        await flushAsync(10);
        expect(t.getStatus().result).toEqual({ run: 2 });
        expect(t.getStatus().attempts).toBe(2);
        expect(t.getStatus().successes).toBe(2);
    });

    it('broadcasts a done event whose payload includes runFn return fields', async () => {
        const broadcasts = [];
        const t = createJobTracker({ kind: 'data', broadcast: (m) => broadcasts.push(m) });
        t.tryStart(async () => ({ rows: 42, freedBytes: 1024 }));
        await flushAsync(10);
        const done = broadcasts.find((m) => m.type === 'data_done');
        expect(done).toBeTruthy();
        expect(done.rows).toBe(42);
        expect(done.freedBytes).toBe(1024);
    });

    it('progress events broadcast to every subscriber via the supplied broadcast fn', async () => {
        const sinkA = [];
        const sinkB = [];
        // Simulate "broadcast to every connected client" by feeding two sinks.
        const broadcast = (m) => {
            sinkA.push(m);
            sinkB.push(m);
        };
        const t = createJobTracker({ kind: 'multi', broadcast });
        t.tryStart(async ({ onProgress }) => {
            onProgress({ processed: 1, total: 10, stage: 'hashing' });
            onProgress({ processed: 5, total: 10 });
            return { processed: 10 };
        });
        await flushAsync(10);
        const aProg = sinkA.filter((m) => m.type === 'multi_progress');
        const bProg = sinkB.filter((m) => m.type === 'multi_progress');
        expect(aProg.length).toBe(bProg.length);
        // 1 starting frame + 2 onProgress frames = 3.
        expect(aProg.length).toBe(3);
        expect(aProg[1].processed).toBe(1);
        expect(aProg[2].processed).toBe(5);
        expect(sinkA.find((m) => m.type === 'multi_done')).toBeTruthy();
    });

    it('honours an eventPrefix override', async () => {
        const broadcasts = [];
        const t = createJobTracker({
            kind: 'group:purge:42',
            broadcast: (m) => broadcasts.push(m),
            eventPrefix: 'group_purge',
        });
        t.tryStart(async () => ({ deleted: 5 }));
        await flushAsync(10);
        expect(broadcasts.find((m) => m.type === 'group_purge_progress')).toBeTruthy();
        expect(broadcasts.find((m) => m.type === 'group_purge_done')).toBeTruthy();
    });

    it('logs through the supplied log fn', async () => {
        const logs = [];
        const t = createJobTracker({
            kind: 'logged',
            broadcast: () => {},
            log: (e) => logs.push(e),
        });
        t.tryStart(async () => ({ ok: true }));
        await flushAsync(10);
        const sources = logs.map((l) => l.source);
        expect(sources.every((s) => s === 'logged')).toBe(true);
        // At least starting + done.
        expect(logs.length).toBeGreaterThanOrEqual(2);
    });
});

describe('createJobTracker — multi-client WS guarantees', () => {
    it('every progress + done frame reaches every connected client', async () => {
        // Two virtual WS clients reading the same broadcast pipe.
        const clientA = [];
        const clientB = [];
        const broadcast = (m) => {
            clientA.push(m);
            clientB.push(m);
        };
        const t = createJobTracker({ kind: 'fan', broadcast });
        t.tryStart(async ({ onProgress }) => {
            for (let i = 0; i < 3; i++) {
                onProgress({ processed: i, total: 3 });
                await new Promise((res) => setTimeout(res, 5));
            }
            return { processed: 3 };
        });
        // Windows CI runners are slow — wait longer for async completion.
        await new Promise((res) => setTimeout(res, 200));
        expect(clientA).toEqual(clientB);
        const aProg = clientA.filter((m) => m.type === 'fan_progress');
        const aDone = clientA.find((m) => m.type === 'fan_done');
        expect(aProg.length).toBeGreaterThanOrEqual(3);
        expect(aDone?.processed).toBe(3);
    });
});
