/**
 * AI subsystem public entry point.
 *
 * Re-exports the small surface area the rest of the app cares about. Every
 * AI feature is opt-in via `config.advanced.ai`; importing this module is
 * cheap because `models.js` keeps every Transformers.js call lazy.
 */

export {
    runIndexScan,
    runPhashScan,
    runFaceClustering,
    findPhashGroups,
    searchByText,
    pregenerateAi,
    AI_DEFAULTS,
} from './manager.js';

export {
    loadExtensionOnce as loadVecExtension,
    clearCache as clearVectorCache,
    cosine,
    l2Normalize,
} from './vector-store.js';

export {
    computePhash,
    hammingDistance,
    groupNearDuplicates,
} from './phash.js';

export { embedText, embedImage } from './embeddings.js';
export { dbscan } from './faces.js';
export {
    loadedPipelines, AI_MODEL_DEFAULTS,
    inspectModelCache, deleteModelCache, clearPipelineForModel,
    pipelineMetaSnapshot, pipelineErrorsSnapshot, setModelProgressHook,
    resolveCacheDir,
} from './models.js';
