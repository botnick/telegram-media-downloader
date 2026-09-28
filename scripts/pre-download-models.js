#!/usr/bin/env node
/**
 * Pre-download the NSFW classifier model.
 *
 * The model is normally fetched lazily on the first NSFW scan. Run this
 * once while online to seed the cache dir (`advanced.nsfw.cacheDir`,
 * default `data/models`) — e.g. before moving a box onto a restricted or
 * offline network — so the first scan starts without a cold download.
 *
 * Uses the configured model + precision (Maintenance → NSFW review),
 * falling back to NSFW_DEFAULTS on a fresh install. Exits 0 without
 * downloading when an external NSFW sidecar is configured (the model lives
 * there) or when the optional `@huggingface/transformers` dep is missing.
 *
 * Usage:
 *   npm run pre-download-models
 *   docker compose exec -u node telegram-downloader npm run pre-download-models
 */

import { loadConfig } from '../src/config/manager.js';
import { downloadClassifier, getNsfwSidecarUrl, initNsfwSidecar } from '../src/core/nsfw.js';

async function main() {
    const config = loadConfig();
    initNsfwSidecar(config);
    const sidecarUrl = getNsfwSidecarUrl();
    if (sidecarUrl) {
        console.log(
            `[pre-download-models] NSFW sidecar configured (${sidecarUrl}) — nothing to do.`,
        );
        return 0;
    }

    const nsfw = config.advanced?.nsfw || {};
    const cfg = { model: nsfw.model, dtype: nsfw.dtype, cacheDir: nsfw.cacheDir };
    const doneFiles = new Set();
    try {
        const { model, cacheDir } = await downloadClassifier(
            cfg,
            (p) => {
                if (p?.status === 'done' && p.file && !doneFiles.has(p.file)) {
                    doneFiles.add(p.file);
                    console.log(`[pre-download-models]   ${p.file}`);
                }
            },
            ({ level, msg }) => console.log(`[pre-download-models] ${level}: ${msg}`),
        );
        console.log(`[pre-download-models] ${model} ready in ${cacheDir}`);
        return 0;
    } catch (e) {
        if (e?.code === 'NSFW_LIB_MISSING') {
            console.log(
                '[pre-download-models] @huggingface/transformers not installed — skipping.',
            );
            return 0;
        }
        console.error(`[pre-download-models] failed: ${e?.message || e}`);
        return 1;
    }
}

// Explicit exit: the DB handle and the WASM runtime would otherwise keep
// the event loop alive after the download finishes.
main().then(
    (code) => process.exit(code),
    (e) => {
        console.error(`[pre-download-models] failed: ${e?.message || e}`);
        process.exit(1);
    },
);
