// Multi-client WebSocket guarantee tests for createJobTracker.
//
// The "fire-and-forget admin job" pattern hinges on every connected
// client seeing the same WS frames — `${kind}_progress` and
// `${kind}_done`. If a job started on a phone fanned out only to that
// phone, the desktop's button would stay enabled and the user could
// fire the same job twice. These tests pin the contract: when one
// runFn streams progress, every subscriber sees identical frames in
// identical order.

import { describe, it, expect } from 'vitest';
import { createJobTracker } from '../src/core/job-tracker.js';

function flush(ms = 30) {
    return new Promise((res) => setTimeout(res, ms));
}

describe('JobTracker multi-client WS contract', () => {
    it('two virtual clients receive every progress + done frame from a slow runFn', async () => {
        const clientA = [];
        const clientB = [];
        // Mimic server.js's broadcast() which iterates `clients` and
        // sends to each one. We approximate with two sinks.
        const broadcast = (msg) => {
            const cloned = JSON.parse(JSON.stringify(msg));
            clientA.push(cloned);
            clientB.push(cloned);
        };
        const tracker = createJobTracker({ kind: 'fanout', broadcast });

        const r = tracker.tryStart(async ({ onProgress }) => {
            for (let i = 0; i < 5; i++) {
                onProgress({ processed: i + 1, total: 5, stage: 'walking' });
                await flush(5);
            }
            return { processed: 5, total: 5, walked: 5 };
        });
        expect(r.started).toBe(true);

        await flush(80);

        expect(clientA).toEqual(clientB);
        const aProg = clientA.filter((m) => m.type === 'fanout_progress');
        // 1 starting frame + 5 emitted progress = 6.
        expect(aProg.length).toBe(6);
        const aDone = clientA.find((m) => m.type === 'fanout_done');
        expect(aDone).toBeTruthy();
        expect(aDone.walked).toBe(5);
        expect(aDone.kind).toBe('fanout');
    });

    it('a second tryStart while the first is in flight returns ALREADY_RUNNING with snapshot', async () => {
        const broadcasts = [];
        const tracker = createJobTracker({
            kind: 'singleflight',
            broadcast: (m) => broadcasts.push(m),
        });

        tracker.tryStart(async ({ onProgress }) => {
            onProgress({ processed: 1, total: 100, stage: 'walking' });
            await flush(40);
            return { processed: 100, total: 100 };
        });

        // Meanwhile, a "second client" hits the same endpoint.
        const collision = tracker.tryStart(async () => ({ ok: true }));
        expect(collision.started).toBe(false);
        expect(collision.code).toBe('ALREADY_RUNNING');
        expect(collision.snapshot.running).toBe(true);
        expect(collision.snapshot.stage).toBe('walking');

        await flush(60);
        // First run finishes, status reflects done.
        expect(tracker.isRunning()).toBe(false);
        expect(tracker.getStatus().result).toMatchObject({ processed: 100 });
    });

    it('cancelling notifies every client by setting running:false in the next snapshot', async () => {
        const sinkA = [];
        const sinkB = [];
        const broadcast = (m) => {
            sinkA.push(m);
            sinkB.push(m);
        };
        const tracker = createJobTracker({ kind: 'cancelfan', broadcast });

        tracker.tryStart(async ({ signal }) => {
            await new Promise((_res, rej) => {
                signal.addEventListener('abort', () => rej(new Error('aborted')));
            });
        });

        const cancelled = tracker.cancel();
        expect(cancelled).toBe(true);
        await flush(20);

        expect(tracker.isRunning()).toBe(false);
        // Both clients see a done frame after cancel — same payload.
        const aDone = sinkA.find((m) => m.type === 'cancelfan_done');
        const bDone = sinkB.find((m) => m.type === 'cancelfan_done');
        expect(aDone).toEqual(bDone);
        expect(aDone.error).toMatch(/abort/i);
    });
});
