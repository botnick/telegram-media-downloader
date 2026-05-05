/**
 * Last-resort error handler. Wraps thrown errors in the canonical
 * { error, code? } JSON shape so the SPA's api wrapper can pattern-
 * match on `data.error` regardless of which route blew up.
 *
 * Hono's `app.onError(handler)` runs this for any uncaught throw inside
 * a route handler or middleware. Synchronous returns (c.json(),
 * c.text()) bypass this — only thrown errors / rejected promises land
 * here.
 */

import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export const errorHandler: ErrorHandler = (err, c) => {
    if (err instanceof HTTPException) {
        const res = err.getResponse();
        return res;
    }
    // eslint-disable-next-line no-console
    console.error("[server]", err);
    return c.json(
        {
            error: err instanceof Error ? err.message : "Internal error",
        },
        500
    );
};
