// Maintenance — AI search & smart organisation page (coordinator).
//
// Slim entry point. Owns:
//   - Search hero binding (delegates to ai-search.js)
//   - Sub-module init/dispose lifecycle
//   - WS subscription wire-up + cleanup
//   - Single /api/ai/status fetch that fans data out to every section
//
// Each section lives in its own file under js/ai/ — see plan
// `federated-leaping-popcorn` for the rationale.

import { bindSearchUi, refreshChips } from './ai-search.js';
import { aiGet } from './ai/api.js';
import { update } from './ai/state.js';
import { attach as attachWs } from './ai/ws.js';

import * as doctor from './ai/doctor.js';
import * as master from './ai/master.js';
import * as capabilities from './ai/capabilities.js';
import * as models from './ai/models.js';
import * as hfToken from './ai/hf-token.js';
import * as people from './ai/people.js';
import * as tags from './ai/tags.js';
import * as phash from './ai/phash.js';
import * as gatedWarning from './ai/gated-warning.js';

const SUB_MODULES = [
    doctor,
    master,
    capabilities,
    models,
    hfToken,
    people,
    tags,
    phash,
    gatedWarning,
];

let _wsDispose = null;
let _initOnce = false;
let _searchBound = false;

const $ = (id) => document.getElementById(id);

async function _refreshStatus() {
    try {
        const r = await aiGet('/api/ai/status');
        update({
            enabled: !!r.enabled,
            capabilities: {
                embeddings: !!r.capabilities?.embeddings,
                faces: !!r.capabilities?.faces,
                tags: !!r.capabilities?.tags,
                phash: !!r.capabilities?.phash,
            },
            models: r.models || {},
            counts: r.counts || { indexed: 0, totalEligible: 0 },
            loadedPipelines: r.loadedPipelines || [],
            gatedWarnings: r.gatedWarnings || [],
            embeddingPresets: r.embeddingPresets || [],
            currentEmbeddingModel: r.currentEmbeddingModel || '',
            staleEmbeddings: r.staleEmbeddings || { count: 0, distinctModels: [] },
        });
    } catch {
        /* leave previous state — Doctor card will surface server-down */
    }
}

async function _hydrateScanProgress() {
    const targets = [
        ['embeddings', '/api/ai/index/scan/status'],
        ['faces', '/api/ai/people/scan/status'],
        ['tags', '/api/ai/tags/scan/status'],
        ['phash', '/api/ai/perceptual-dedup/scan/status'],
    ];
    await Promise.all(
        targets.map(async ([cap, url]) => {
            try {
                const s = await aiGet(url);
                if (s?.running) {
                    const { patchScanProgress, patchScanRunning } = await import('./ai/state.js');
                    patchScanProgress(cap, s.progress || {});
                    patchScanRunning(cap, true);
                }
            } catch {
                /* status endpoints are best-effort */
            }
        }),
    );
}

export async function init() {
    if (!_searchBound) {
        bindSearchUi({
            inputEl: $('ai-search-input'),
            buttonEl: $('ai-search-btn'),
            resultsEl: $('ai-search-results'),
            emptyEl: $('ai-search-empty'),
            metaEl: $('ai-search-meta'),
            ctaEl: $('ai-search-cta'),
        });
        _searchBound = true;
    }
    if (!_wsDispose) {
        _wsDispose = attachWs({
            onModelProgress: () => models.refresh(),
            onScanDone: async () => {
                await _refreshStatus();
                people.refresh().catch(() => {});
                tags.refresh().catch(() => {});
                phash.refresh().catch(() => {});
                refreshChips();
            },
        });
    }
    for (const m of SUB_MODULES) {
        try {
            m.init?.();
        } catch (e) {
            console.error('ai sub-module init', e);
        }
    }
    await _refreshStatus();
    _hydrateScanProgress().catch(() => {});
    _initOnce = true;
}

/**
 * Page-level cleanup. Call from the SPA router when leaving /maintenance/ai.
 * Idempotent — calling twice is safe.
 */
export function dispose() {
    if (_wsDispose) {
        try {
            _wsDispose();
        } catch {}
        _wsDispose = null;
    }
    for (const m of SUB_MODULES) {
        try {
            m.dispose?.();
        } catch {}
    }
}
