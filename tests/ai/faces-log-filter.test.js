import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import {
    inferPyLevel,
    isAccessNoise,
    wirePipeLogging,
} from '../../src/core/ai/faces-log-filter.js';

// ---------------------------------------------------------------------------
// inferPyLevel
// ---------------------------------------------------------------------------

describe('inferPyLevel', () => {
    it('returns "error" for ERROR keyword', () => {
        expect(inferPyLevel('ERROR: something broke', 'info')).toBe('error');
    });
    it('returns "error" for CRITICAL keyword', () => {
        expect(inferPyLevel('CRITICAL core dumped', 'info')).toBe('error');
    });
    it('is case-insensitive for ERROR', () => {
        expect(inferPyLevel('error: lowercase error', 'info')).toBe('error');
    });
    it('returns "warn" for WARNING', () => {
        expect(inferPyLevel('WARNING: disk full', 'info')).toBe('warn');
    });
    it('returns "warn" for bare WARN', () => {
        expect(inferPyLevel('WARN something', 'info')).toBe('warn');
    });
    it('returns "info" for INFO', () => {
        expect(inferPyLevel('INFO model loaded', 'warn')).toBe('info');
    });
    it('returns "info" for DEBUG (suppress noisy debug output)', () => {
        expect(inferPyLevel('DEBUG tick', 'warn')).toBe('info');
    });
    it('returns fallback for unrecognised lines', () => {
        expect(inferPyLevel('uvicorn startup complete', 'warn')).toBe('warn');
        expect(inferPyLevel('uvicorn startup complete', 'info')).toBe('info');
    });
});

// ---------------------------------------------------------------------------
// isAccessNoise
// ---------------------------------------------------------------------------

describe('isAccessNoise', () => {
    it('filters uvicorn-style successful GET /health', () => {
        expect(isAccessNoise('"GET /health HTTP/1.1" 200')).toBe(true);
    });
    it('filters uvicorn-style successful POST /detect', () => {
        expect(isAccessNoise('"POST /detect HTTP/1.1" 200 OK')).toBe(true);
    });
    it('filters uvicorn-style successful POST /detect_b64', () => {
        expect(isAccessNoise('"POST /detect_b64 HTTP/1.1" 200')).toBe(true);
    });
    it('filters uvicorn-style successful GET /info', () => {
        expect(isAccessNoise('"GET /info HTTP/1.1" 200')).toBe(true);
    });
    it('keeps non-200 detect responses (errors must surface)', () => {
        expect(isAccessNoise('"POST /detect HTTP/1.1" 500')).toBe(false);
    });
    it('keeps non-access lines', () => {
        expect(isAccessNoise('Model loaded in 3.2 s')).toBe(false);
        expect(isAccessNoise('')).toBe(false);
    });
    it('filters in-process logger style POST /detect -> 200', () => {
        expect(isAccessNoise('POST /detect -> 200')).toBe(true);
    });
    it('filters in-process logger style GET /health -> 200', () => {
        expect(isAccessNoise('GET /health -> 200')).toBe(true);
    });
    it('keeps arbitrary /other routes (not in the filter list)', () => {
        expect(isAccessNoise('"GET /admin HTTP/1.1" 200')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// wirePipeLogging
// ---------------------------------------------------------------------------

describe('wirePipeLogging', () => {
    function makeStream(lines) {
        const r = new Readable({ read() {} });
        // Emit lines with a line-feed delimiter as real stdout/stderr does.
        r.push(lines.join('\n') + '\n');
        r.push(null);
        return r;
    }

    it('calls logFn for each non-empty, non-noise line', async () => {
        const logFn = vi.fn();
        const stream = makeStream(['INFO model loaded', 'DEBUG tick', 'WARNING slow']);
        wirePipeLogging(stream, 'info', logFn);
        // Wait for the stream to drain.
        await new Promise((resolve) => stream.on('end', resolve));
        expect(logFn).toHaveBeenCalledTimes(3);
        // Level inference should kick in.
        expect(logFn.mock.calls[0][0]).toBe('info');
        expect(logFn.mock.calls[2][0]).toBe('warn');
    });

    it('drops access-noise lines', async () => {
        const logFn = vi.fn();
        const stream = makeStream([
            '"POST /detect HTTP/1.1" 200 OK',
            '"GET /health HTTP/1.1" 200',
            'INFO actual log line',
        ]);
        wirePipeLogging(stream, 'info', logFn);
        await new Promise((resolve) => stream.on('end', resolve));
        expect(logFn).toHaveBeenCalledTimes(1);
        expect(logFn.mock.calls[0][1]).toContain('actual log line');
    });

    it('is a no-op for a null stream', () => {
        expect(() => wirePipeLogging(null, 'info', vi.fn())).not.toThrow();
    });
});
