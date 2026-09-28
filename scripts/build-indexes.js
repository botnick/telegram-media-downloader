#!/usr/bin/env node
/**
 * Build the downloads-table indexes added after v2.24.5.
 *
 * The web server builds them in the background after an upgrade. If a
 * build was ever interrupted (the process was killed mid-build — e.g. a
 * healthcheck restart on a very large library on a slow disk), the server
 * stops retrying it and logs a hint pointing here. Run this while the
 * dashboard is stopped, so nothing else is writing to the database and no
 * healthcheck can kill the build; it clears the interrupted marker.
 *
 * Usage:
 *   npm run build-indexes
 *   docker compose stop telegram-downloader
 *   docker compose run --rm telegram-downloader node scripts/build-indexes.js
 *   docker compose start telegram-downloader
 */

import { buildDeferredIndex, getDb, listMissingDeferredIndexes } from '../src/core/db.js';

const missing = listMissingDeferredIndexes();
if (!missing.length) {
    console.log('[build-indexes] all indexes are present — nothing to do.');
} else {
    for (const idx of missing) {
        process.stdout.write(`[build-indexes] building ${idx.name} … `);
        const ms = buildDeferredIndex(idx.name);
        console.log(`done in ${(ms / 1000).toFixed(1)} s`);
    }
}
getDb().close();
