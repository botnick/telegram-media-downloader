/**
 * Aggregate entry — re-exports the most-used public surface of @tgdl/core.
 *
 * Importing individual modules via subpath is also fine (e.g.
 * `import { getDb } from '@tgdl/core/db'`) and avoids pulling the
 * entire dependency graph; this index is for the convenience of code
 * that needs many things at once (server bootstrap, CLI menu).
 *
 * Subpaths must use the `.js` extension because `exports."./*"` in
 * package.json maps `@tgdl/core/db` → `./src/db.js`. tsc rewrites the
 * `.ts` extension at emit time when this aggregator is converted.
 */

// Auth + sessions
export * from "./web-auth.js";
export * from "./security.js";
export * from "./secret.js";

// Storage
export * from "./db.js";

// Pipeline
export * from "./downloader.js";
export * from "./monitor.js";
export * from "./runtime.js";
export * from "./forwarder.js";
export * from "./rescue.js";

// Media processing
export * from "./thumbs.js";

// Networking
export * from "./connection.js";
export * from "./proxy.js";

// Multi-account
export * from "./accounts.js";

// Logging + telemetry
export * from "./logger.js";
export * from "./metrics.js";

// Shared infra
export * from "./job-tracker.js";
