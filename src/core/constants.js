// Shared magic numbers used across the engine + web tier. Kept here so a
// single edit moves every call site at once and the values stay reviewable
// in one place.

// Hard ceiling on a single backfill batch size — surfaces in the SPA's
// custom-limit input, the auto catch-up cap, and the backfill route's
// query-string clamp.
export const BACKFILL_MAX_LIMIT = 50000;

// /api/dialogs response cache + the in-process name cache TTL. Telegram
// rate-limits getDialogs aggressively, so the same window applies to both.
export const DIALOG_CACHE_TTL_MS = 5 * 60 * 1000;

// Grace window before a finished history job is evicted from the in-memory
// map — long enough for the SPA to grab the final state via /api/history/jobs.
export const HISTORY_JOB_TTL_MS = 5 * 60 * 1000;

// Default downloader-queue ceiling that pauses a backfill until the realtime
// worker drains. Used as the config default and as the clamp fallback when an
// operator-supplied value is missing or out of range.
export const BACKPRESSURE_CAP_DEFAULT = 500;
