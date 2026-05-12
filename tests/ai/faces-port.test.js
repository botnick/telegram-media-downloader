import net from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPortFree, pickAvailablePort } from '../../src/core/ai/faces-port.js';

// ---------------------------------------------------------------------------
// isPortFree
// ---------------------------------------------------------------------------

describe('isPortFree', () => {
    it('returns true for a port nothing is listening on', async () => {
        // Use port 0 trick: bind to get a free port, close, then check.
        const port = await new Promise((resolve) => {
            const srv = net.createServer();
            srv.listen(0, '127.0.0.1', () => {
                const p = srv.address().port;
                srv.close(() => resolve(p));
            });
        });
        expect(await isPortFree(port)).toBe(true);
    });

    it('returns false while a server is actively listening', async () => {
        const srv = net.createServer();
        await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
        const port = srv.address().port;
        try {
            expect(await isPortFree(port)).toBe(false);
        } finally {
            await new Promise((resolve) => srv.close(resolve));
        }
    });
});

// ---------------------------------------------------------------------------
// pickAvailablePort
// ---------------------------------------------------------------------------

describe('pickAvailablePort', () => {
    it('returns a port within the requested range', async () => {
        const port = await pickAvailablePort({ portRange: [40000, 49999], probeAttempts: 20 });
        expect(port).toBeGreaterThanOrEqual(40000);
        expect(port).toBeLessThanOrEqual(49999);
    });

    it('throws when every probe attempt finds a busy port', async () => {
        // Bind a server on the only port in the range.
        const srv = net.createServer();
        await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
        const port = srv.address().port;
        try {
            await expect(
                pickAvailablePort({ portRange: [port, port], probeAttempts: 3 }),
            ).rejects.toThrow();
        } finally {
            await new Promise((resolve) => srv.close(resolve));
        }
    });

    it('uses default range when no options are passed', async () => {
        const port = await pickAvailablePort();
        expect(typeof port).toBe('number');
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
    });
});
