/**
 * Bridge to @tgdl/core / @tgdl/cli .js source.
 *
 * Every helper here is `any`-typed deliberately — these modules will
 * gain proper .d.ts when they convert to TypeScript. The handlers that
 * call into them (apps/server/src/routes/*) are typed at their public
 * boundary via Zod schemas in @tgdl/shared, so the un-typed gap stays
 * small and contained.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

// @ts-expect-error — js source
export * as accounts from "@tgdl/core/accounts";
// @ts-expect-error — js source
export * as connection from "@tgdl/core/connection";
// @ts-expect-error — js source
export * as db from "@tgdl/core/db";
// @ts-expect-error — js source
export * as dedup from "@tgdl/core/dedup";
// @ts-expect-error — js source
export * as diskRotator from "@tgdl/core/disk-rotator";
// @ts-expect-error — js source
export * as downloader from "@tgdl/core/downloader";
// @ts-expect-error — js source
export * as forwarder from "@tgdl/core/forwarder";
// @ts-expect-error — js source
export * as hashWorker from "@tgdl/core/hash-worker";
// @ts-expect-error — js source
export * as history from "@tgdl/core/history";
// @ts-expect-error — js source
export * as integrity from "@tgdl/core/integrity";
// @ts-expect-error — js source
export * as jobTracker from "@tgdl/core/job-tracker";
// @ts-expect-error — js source
export * as logger from "@tgdl/core/logger";
// @ts-expect-error — js source
export * as metrics from "@tgdl/core/metrics";
// @ts-expect-error — js source
export * as monitor from "@tgdl/core/monitor";
// @ts-expect-error — js source
export * as nsfw from "@tgdl/core/nsfw";
// proxy + secret converted to .ts already; types resolve directly.
export * as proxy from "@tgdl/core/proxy";
// @ts-expect-error — js source
export * as rescue from "@tgdl/core/rescue";
// @ts-expect-error — js source
export * as resilience from "@tgdl/core/resilience";
// @ts-expect-error — js source
export * as runtime from "@tgdl/core/runtime";
export * as secret from "@tgdl/core/secret";
// @ts-expect-error — js source
export * as security from "@tgdl/core/security";
// @ts-expect-error — js source
export * as share from "@tgdl/core/share";
// @ts-expect-error — js source
export * as stories from "@tgdl/core/stories";
// @ts-expect-error — js source
export * as thumbs from "@tgdl/core/thumbs";
// @ts-expect-error — js source
export * as updater from "@tgdl/core/updater";
// @ts-expect-error — js source
export * as urlResolver from "@tgdl/core/url-resolver";
// @ts-expect-error — js source
export * as webAuth from "@tgdl/core/web-auth";
// @ts-expect-error — js source
export * as zipStream from "@tgdl/core/zip-stream";

// @ts-expect-error — cli/config-manager.js (runtime config loader)
import * as _config from "../../../cli/src/config-manager.js";
export const config: any = _config;

/* eslint-enable @typescript-eslint/no-explicit-any */
/* eslint-enable @typescript-eslint/no-unsafe-assignment */
/* eslint-enable @typescript-eslint/no-unsafe-member-access */
