// Python's `logging` + uvicorn write EVERYTHING to stderr (INFO included),
// so wiring stderr → error blindly mis-tags every healthy startup line as
// a hard error. Parse the level prefix from common Python log formats so
// the dashboard log feed colours each line correctly.
const _PY_LEVEL_PATTERNS = [
    [/\bERROR\b/i, 'error'],
    [/\bCRITICAL\b/i, 'error'],
    [/\bWARN(ING)?\b/i, 'warn'],
    [/\bINFO\b/i, 'info'],
    [/\bDEBUG\b/i, 'info'],
];

export function inferPyLevel(line, fallback) {
    for (const [re, lvl] of _PY_LEVEL_PATTERNS) {
        if (re.test(line)) return lvl;
    }
    return fallback;
}

// Drop successful per-request access lines from the dashboard log feed.
// Uvicorn + the in-process logger each emit one line per inference hit
// (`POST /detect -> 200` and `"POST /detect HTTP/1.1" 200 OK`). At scan
// rates of ~1 req/s that floods the Maintenance → Logs panel with
// thousands of green noise entries, drowning real warnings. We keep any
// non-200 response so failures still surface. Health probes are
// filtered too since `/health` fires every few seconds from the health
// monitor.
const _ACCESS_NOISE_RE =
    /(?:"(?:GET|POST|PUT|DELETE|OPTIONS)\s+\/(?:detect|health|info|detect_b64)(?:\?\S*)?\s+HTTP\/[\d.]+"\s+200\b|(?:GET|POST|PUT|DELETE|OPTIONS)\s+\/(?:detect|health|info|detect_b64)\s+->\s+200\b)/;

export function isAccessNoise(line) {
    return _ACCESS_NOISE_RE.test(line);
}

/**
 * Wire a child-process stdout/stderr pipe through the level classifier and
 * into the provided logFn. Drops empty lines and access noise; infers level
 * from Python log format keywords so INFO/DEBUG don't get tagged as errors.
 *
 * @param {import('stream').Readable|null} stream
 * @param {'info'|'warn'|'error'} level  fallback level for unrecognised lines
 * @param {(level: string, line: string) => void} logFn
 */
export function wirePipeLogging(stream, level, logFn) {
    if (!stream) return;
    let leftover = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        const text = leftover + chunk;
        const lines = text.split(/\r?\n/);
        leftover = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (isAccessNoise(trimmed)) continue;
            logFn(inferPyLevel(trimmed, level), line);
        }
    });
    stream.on('end', () => {
        if (leftover.trim() && !isAccessNoise(leftover)) {
            logFn(inferPyLevel(leftover, level), leftover);
        }
        leftover = '';
    });
    stream.on('error', () => {
        /* don't crash if the pipe goes away */
    });
}
