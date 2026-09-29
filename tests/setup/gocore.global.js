// Vitest global setup: find or build tgdl-core once per run and hand it to
// every worker (and every server a suite spawns) as TGDL_CORE_BIN, so no
// test ever tries to download a release. Without Go and without a dev
// build, TGDL_CORE_BIN points at a path that doesn't exist: the app then
// reports tgdl-core as missing (503 for the features that need it) and the
// suites that need the real engine fail with that message.

import { locateGoCore, MISSING_BIN } from '../helpers/gocore-bin.js';

export default function setup() {
    const bin = locateGoCore();
    process.env.TGDL_CORE_BIN = bin || MISSING_BIN;
    if (!bin) {
        console.warn(
            '[tests] no tgdl-core: install Go 1.22+ or run `npm run build:core` — suites that hash, stat, walk or cluster will fail',
        );
    }
}
