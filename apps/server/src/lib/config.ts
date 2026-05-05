/**
 * Thin re-export of @tgdl/core's config loader so the routes don't have
 * to import .js source directly with @ts-expect-error.
 */

// @ts-expect-error — @tgdl/cli's config-manager is .js source.
import { loadConfig as _loadConfig } from "../../../cli/src/config-manager.js";

export const loadConfig = _loadConfig as () => Promise<unknown>;
