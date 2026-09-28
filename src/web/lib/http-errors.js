// Client-error answers the last-resort Express error handler gives instead
// of its generic 500:
//
//   - a Range no part of the file can satisfy (send()'s 416) → a proper
//     416 with `Content-Range: bytes */<size>` (RFC 9110 §15.5.17).
//
// Anything else stays a 500 (see the handler in server.js).
//
// (Line comments on purpose: `bytes */<size>` would end a block comment.)

// Answer 416 Range Not Satisfiable. `contentRange` is the
// `bytes */<size>` value (send() hands it over on its error). The headers
// the file route already set for the file — type, disposition,
// validators — don't describe this answer and are dropped; the /files
// `immutable` cache policy mustn't pin it either.
export function sendRangeNotSatisfiable(res, contentRange) {
    for (const h of [
        'Content-Type',
        'Content-Length',
        'Content-Disposition',
        'ETag',
        'Last-Modified',
    ]) {
        res.removeHeader(h);
    }
    res.setHeader('Content-Range', contentRange);
    res.setHeader('Cache-Control', 'no-store');
    // res.end, not res.send: send() would add an ETag of this text.
    res.statusCode = 416;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Range Not Satisfiable');
}

// The `bytes */<size>` value of send()'s 416 error, or null when `err` is
// something else.
export function rangeNotSatisfiableOf(err) {
    if (!err || Number(err.status || err.statusCode) !== 416) return null;
    const cr = err.headers?.['Content-Range'] ?? err.headers?.['content-range'];
    return typeof cr === 'string' && /^bytes \*\/\d+$/.test(cr) ? cr : null;
}

// Whether serving `size` bytes for this request ends in a 416: a `bytes=`
// Range none of whose parts overlaps the file. Mirrors send()'s own check
// (range-parser with `combine`), minus If-Range — with an If-Range the
// answer depends on the validators, so it's left to send(). Used where
// something must not happen for a request that will be refused (the
// /share access counter).
export function isUnsatisfiableRange(req, size) {
    const range = req.headers.range;
    if (!range || !/^ *bytes=/.test(range) || req.headers['if-range']) return false;
    return req.range(size, { combine: true }) === -1;
}
