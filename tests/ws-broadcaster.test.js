// Coalescing WebSocket broadcaster behind server.js' broadcast().

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
    createWsBroadcaster,
    WS_MAX_BUFFERED_BYTES,
    WS_COALESCE_WINDOW_MS,
} from '../src/web/lib/ws-broadcaster.js';

class FakeWs extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.bufferedAmount = 0;
        this.sent = [];
        this.pings = 0;
        this.terminated = false;
    }
    send(text) {
        this.sent.push(JSON.parse(text));
    }
    ping() {
        this.pings += 1;
    }
    terminate() {
        this.terminated = true;
        this.readyState = 3;
    }
    types() {
        return this.sent.map((m) => m.type);
    }
}

let clients;
let b;

beforeEach(() => {
    vi.useFakeTimers();
    clients = new Set([new FakeWs(), new FakeWs()]);
    b = createWsBroadcaster({ getClients: () => clients, onTerminate: (ws) => clients.delete(ws) });
});

afterEach(() => {
    b.stop();
    vi.useRealTimers();
});

const first = () => Array.from(clients)[0];
const progress = (key, received) => ({
    type: 'download_progress',
    payload: { key, received, total: 100, progress: received },
});

describe('coalescing', () => {
    it('sends uncoalesced messages immediately and unchanged', () => {
        b.broadcast({ type: 'config_updated', x: 1 });
        for (const ws of clients) expect(ws.sent).toEqual([{ type: 'config_updated', x: 1 }]);
    });

    it('collapses download_progress per key to the latest within the window', () => {
        for (let i = 1; i <= 50; i++) b.broadcast(progress('a', i));
        b.broadcast(progress('b', 7));
        expect(first().sent).toEqual([]);
        vi.advanceTimersByTime(WS_COALESCE_WINDOW_MS);
        expect(first().sent).toEqual([progress('a', 50), progress('b', 7)]);
    });

    it('caps a key at ~2 frames per second', () => {
        for (let t = 0; t < 1000; t += 20) {
            b.broadcast(progress('a', t));
            vi.advanceTimersByTime(20);
        }
        vi.advanceTimersByTime(WS_COALESCE_WINDOW_MS);
        expect(first().sent.length).toBeLessThanOrEqual(3);
    });

    it("flushes a job's pending progress before its download_complete", () => {
        b.broadcast(progress('a', 90));
        b.broadcast(progress('b', 10));
        b.broadcast({ type: 'download_complete', payload: { key: 'a' } });
        expect(first().sent).toEqual([
            progress('a', 90),
            { type: 'download_complete', payload: { key: 'a' } },
        ]);
        vi.advanceTimersByTime(WS_COALESCE_WINDOW_MS);
        expect(first().sent.at(-1)).toEqual(progress('b', 10));
    });

    it('flushes download_error progress via payload.job.key', () => {
        b.broadcast(progress('a', 5));
        b.broadcast({ type: 'download_error', payload: { job: { key: 'a' }, error: 'x' } });
        expect(first().types()).toEqual(['download_progress', 'download_error']);
    });

    it('flushes everything before monitor_state', () => {
        b.broadcast(progress('a', 5));
        b.broadcast({ type: 'queue_length', payload: { length: 3 } });
        b.broadcast({ type: 'monitor_state', state: 'stopped' });
        expect(first().types()).toEqual(['download_progress', 'queue_length', 'monitor_state']);
        expect(b.pendingCount()).toBe(0);
    });

    it('coalesces history_progress per job and flushes it before history_done', () => {
        for (let i = 0; i < 20; i++)
            b.broadcast({ type: 'history_progress', jobId: 'j1', processed: i });
        b.broadcast({ type: 'history_progress', jobId: 'j2', processed: 1 });
        b.broadcast({ type: 'history_done', jobId: 'j1' });
        expect(first().sent).toEqual([
            { type: 'history_progress', jobId: 'j1', processed: 19 },
            { type: 'history_done', jobId: 'j1' },
        ]);
    });

    it('coalesces queue_length and enqueue churn but not other queue ops', () => {
        for (let i = 0; i < 100; i++) {
            b.broadcast({ type: 'queue_length', payload: { length: i } });
            b.broadcast({ type: 'queue_changed', payload: { key: `k${i}`, op: 'enqueue' } });
        }
        b.broadcast({ type: 'queue_changed', payload: { key: 'k1', op: 'pause' } });
        expect(first().sent).toEqual([
            { type: 'queue_length', payload: { length: 99 } },
            { type: 'queue_changed', payload: { key: 'k99', op: 'enqueue' } },
            { type: 'queue_changed', payload: { key: 'k1', op: 'pause' } },
        ]);
    });
});

describe('per-row events', () => {
    it('delivers every file_deleted immediately and unchanged (tiles are removed per row)', () => {
        for (let i = 0; i < 30; i++) b.broadcast({ type: 'file_deleted', id: i });
        expect(first().sent).toEqual(
            Array.from({ length: 30 }, (_, id) => ({ type: 'file_deleted', id })),
        );
        expect(b.pendingCount()).toBe(0);
    });
});

describe('backpressure + heartbeat', () => {
    it('skips a client whose send buffer is over the limit', () => {
        const [slow, fast] = Array.from(clients);
        slow.bufferedAmount = WS_MAX_BUFFERED_BYTES + 1;
        b.broadcast({ type: 'config_updated' });
        expect(slow.sent).toEqual([]);
        expect(fast.sent).toEqual([{ type: 'config_updated' }]);
        expect(b.stats().skippedBackpressure).toBe(1);
    });

    it('pings live clients and terminates ones that never pong', () => {
        const [alive, dead] = Array.from(clients);
        b.attach(alive);
        b.attach(dead);
        b.startHeartbeat();
        vi.advanceTimersByTime(30_000);
        expect(alive.pings).toBe(1);
        expect(dead.pings).toBe(1);
        alive.emit('pong');
        vi.advanceTimersByTime(30_000);
        expect(alive.terminated).toBe(false);
        expect(alive.pings).toBe(2);
        expect(dead.terminated).toBe(true);
        expect(clients.has(dead)).toBe(false);
    });

    it('terminates a client that stays backed up across two ticks', () => {
        const [stuck] = Array.from(clients);
        b.attach(stuck);
        stuck.bufferedAmount = WS_MAX_BUFFERED_BYTES * 4;
        b.heartbeat();
        stuck.emit('pong');
        expect(stuck.terminated).toBe(false);
        b.heartbeat();
        expect(stuck.terminated).toBe(true);
    });

    it('ignores sockets that are not open', () => {
        const [closing] = Array.from(clients);
        closing.readyState = 2;
        b.broadcast({ type: 'x' });
        b.heartbeat();
        expect(closing.sent).toEqual([]);
        expect(closing.pings).toBe(0);
    });
});
