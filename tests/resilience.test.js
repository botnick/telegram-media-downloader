// Covers the in-process error trap: classification, recovery branches, the
// fatal handler's reconnect short-circuit, and the structured error log.
//
// process.exit is stubbed throughout so a controlled-shutdown branch can be
// asserted on without tearing the test runner down.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Resilience } from '../src/core/resilience.js';

describe('Resilience.guard', () => {
    let r;
    beforeEach(() => {
        r = new Resilience();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('returns the wrapped function value when nothing throws', async () => {
        const out = await r.guard(async () => 42, 'unit');
        expect(out).toBe(42);
    });

    it('routes FLOOD_WAIT errors to a WAIT action with the requested seconds', async () => {
        const out = await r.guard(async () => {
            const err = new Error('FLOOD_WAIT_30');
            err.seconds = 30;
            throw err;
        }, 'flood');
        expect(out).toEqual({ action: 'WAIT', duration: 30 });
    });

    it('falls back to a 60s WAIT when the flood error has no .seconds', async () => {
        const out = await r.guard(async () => {
            throw new Error('FLOOD_WAIT triggered');
        }, 'flood');
        expect(out).toEqual({ action: 'WAIT', duration: 60 });
    });

    it('routes ECONNRESET to a RETRY with a 5s backoff', async () => {
        const out = await r.guard(async () => {
            const err = new Error('socket hang up');
            err.code = 'ECONNRESET';
            throw err;
        }, 'net');
        expect(out).toEqual({ action: 'RETRY', delay: 5000 });
    });

    it('routes "fetch" errors to a RETRY (covers undici failures)', async () => {
        const out = await r.guard(async () => {
            throw new Error('fetch failed');
        }, 'net');
        expect(out).toEqual({ action: 'RETRY', delay: 5000 });
    });

    it('exits the process on AUTH_KEY_UNREGISTERED instead of rethrowing', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
        const out = await r.guard(async () => {
            const err = new Error('login required');
            err.errorMessage = 'AUTH_KEY_UNREGISTERED';
            throw err;
        }, 'auth');
        expect(exit).toHaveBeenCalledWith(1);
        // Without the explicit `return` after process.exit, the function would
        // have rethrown — guard would have surfaced the original error.
        expect(out).toBeUndefined();
    });

    it('rethrows unhandled errors so callers can decide', async () => {
        await expect(
            r.guard(async () => {
                throw new Error('something else entirely');
            }, 'misc'),
        ).rejects.toThrow('something else entirely');
    });

    it('appends every handled error to errorLog with timestamp + context', async () => {
        await r.guard(async () => {
            throw new Error('FLOOD_WAIT once');
        }, 'ctx-A');
        await r.guard(async () => {
            const e = new Error('socket hang up');
            e.code = 'ECONNRESET';
            throw e;
        }, 'ctx-B');
        expect(r.errorLog).toHaveLength(2);
        expect(r.errorLog[0]).toMatchObject({ context: 'ctx-A', message: 'FLOOD_WAIT once' });
        expect(r.errorLog[1]).toMatchObject({ context: 'ctx-B', message: 'socket hang up' });
        expect(r.errorLog[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(r.errorLog[0].stack).toBeTruthy();
    });
});

describe('Resilience.handleFatal', () => {
    let r;
    beforeEach(() => {
        r = new Resilience();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('skips process.exit on ECONNRESET so the reconnect path can run', () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
        const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        r.handleFatal('Uncaught', err);
        expect(exit).not.toHaveBeenCalled();
        expect(r.errorLog[0]).toMatchObject({ context: 'FATAL' });
    });

    it('skips process.exit when the message mentions "Connection"', () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
        r.handleFatal('Uncaught', new Error('Connection lost mid-stream'));
        expect(exit).not.toHaveBeenCalled();
    });

    it('exits on a generic uncaught error', () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
        r.handleFatal('Uncaught', new Error('something blew up'));
        expect(exit).toHaveBeenCalledWith(1);
    });
});

describe('Resilience misc', () => {
    it('setNotifier stores the notifier reference', () => {
        const r = new Resilience();
        const notifier = { send: vi.fn() };
        r.setNotifier(notifier);
        expect(r.notifier).toBe(notifier);
    });

    it('init wires uncaughtException + unhandledRejection traps', () => {
        const r = new Resilience();
        const on = vi.spyOn(process, 'on').mockImplementation(() => process);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        r.init();
        const events = on.mock.calls.map((c) => c[0]);
        expect(events).toContain('uncaughtException');
        expect(events).toContain('unhandledRejection');
        vi.restoreAllMocks();
    });
});
