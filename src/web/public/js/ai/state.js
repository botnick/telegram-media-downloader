// Centralised AI page state.
//
// One store, one render path. Sub-modules subscribe via `on(fn)` and read
// via `get()`; the coordinator dispatches `update(patch)` after each fetch.
// Avoids the previous file's pattern where four globals (_capState, etc.)
// drifted out of sync after every optimistic flip.

const _state = {
    health: null, // {ok, checks, recommendations, platform, nodeVersion}
    enabled: false, // master toggle
    capabilities: { embeddings: false, faces: false, tags: false, phash: false },
    models: { embeddings: '', faces: '', tags: '' },
    counts: { indexed: 0, totalEligible: 0 },
    loadedPipelines: [],
    gatedWarnings: [],
    embeddingPresets: [],
    currentEmbeddingModel: '',
    staleEmbeddings: { count: 0, distinctModels: [] },
    modelStatus: null, // /api/ai/models/status payload
    scanProgress: {
        // last progress per cap (for UI rehydrate)
        embeddings: null,
        faces: null,
        tags: null,
        phash: null,
    },
    scanRunning: {
        // mirrors tracker.running by cap
        embeddings: false,
        faces: false,
        tags: false,
        phash: false,
    },
};

const listeners = new Set();

export function get() {
    return _state;
}

export function update(patch) {
    if (!patch || typeof patch !== 'object') return;
    Object.assign(_state, patch);
    for (const fn of listeners) {
        try {
            fn(_state);
        } catch (e) {
            console.error('ai/state listener:', e);
        }
    }
}

export function patchScanProgress(cap, payload) {
    _state.scanProgress = { ..._state.scanProgress, [cap]: payload };
    update({}); // notify
}

export function patchScanRunning(cap, running) {
    _state.scanRunning = { ..._state.scanRunning, [cap]: !!running };
    update({}); // notify
}

export function on(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function reset() {
    listeners.clear();
}
