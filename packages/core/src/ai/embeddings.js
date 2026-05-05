/**
 * CLIP image + text embeddings via Transformers.js.
 *
 * Encodes images to a 512-dim vector and text queries to the same 512-dim
 * space. Cosine similarity between an image vector and a text vector then
 * gives a "how well does this caption match this photo" score — the
 * mechanism behind every "show me beach photos" search.
 *
 * Default model: `Xenova/clip-vit-base-patch32`. ~90 MB, downloads on first
 * use, lives in the project's `data/models/` cache so a `docker compose
 * down` doesn't lose the weights.
 *
 * Both encoders are L2-normalised before storage so the search hot path
 * is a plain dot product (see vector-store.js).
 *
 * Model lifecycle is owned by `models.js`; this module is a thin wrapper.
 */

import { existsSync } from 'fs';
import { getPipeline, AI_MODEL_DEFAULTS } from './models.js';
import { l2Normalize } from './vector-store.js';

let _imagePipelinePromise = null;
let _textPipelinePromise = null;

function _imageModelId(cfg) { return cfg?.model || AI_MODEL_DEFAULTS.embeddings.modelId; }
function _textModelId(cfg)  { return cfg?.textModel || _imageModelId(cfg); }

async function _getImagePipeline(cfg, onProgress, onLog) {
    if (_imagePipelinePromise) return _imagePipelinePromise;
    _imagePipelinePromise = getPipeline({
        kind: AI_MODEL_DEFAULTS.embeddings.kind,
        modelId: _imageModelId(cfg),
        cacheDir: cfg?.cacheDir,
        onProgress, onLog,
    }).catch((e) => { _imagePipelinePromise = null; throw e; });
    return _imagePipelinePromise;
}

async function _getTextPipeline(cfg, onProgress, onLog) {
    if (_textPipelinePromise) return _textPipelinePromise;
    _textPipelinePromise = getPipeline({
        kind: AI_MODEL_DEFAULTS.embeddings.textKind,
        modelId: _textModelId(cfg),
        cacheDir: cfg?.cacheDir,
        onProgress, onLog,
    }).catch((e) => { _textPipelinePromise = null; throw e; });
    return _textPipelinePromise;
}

/**
 * Encode an image file to a 512-dim L2-normalised Float32Array.
 *
 * Returns null when the file is missing or the pipeline fails to decode it
 * (corrupt JPEG / unsupported format) — the caller persists the row's
 * `ai_indexed_at` timestamp regardless so the loop doesn't keep retrying.
 */
export async function embedImage(absPath, cfg, onProgress, onLog) {
    if (!absPath || !existsSync(absPath)) return null;
    const pipeline = await _getImagePipeline(cfg, onProgress, onLog);
    let out;
    try {
        out = await pipeline(absPath);
    } catch {
        return null;
    }
    return _toFloat32(out);
}

/**
 * Encode a text query to a 512-dim L2-normalised Float32Array.
 */
export async function embedText(query, cfg, onProgress, onLog) {
    if (!query || typeof query !== 'string') return null;
    const pipeline = await _getTextPipeline(cfg, onProgress, onLog);
    let out;
    try {
        out = await pipeline(query, { pooling: 'mean', normalize: false });
    } catch {
        return null;
    }
    return _toFloat32(out);
}

/**
 * Coerce the various output shapes Transformers.js may return into a
 * single Float32Array. Different pipeline kinds return:
 *   - { data: Float32Array | number[] }                     (newer image-feature-extraction)
 *   - { dims: [...], data: Float32Array, ... } (Tensor)     (image / text embeddings)
 *   - [ { data: ... } ]                                     (some text pipelines wrap)
 *   - Float32Array                                          (rare)
 *
 * After flattening, we L2-normalise so `dot(a, b) === cosine(a, b)`.
 */
function _toFloat32(out) {
    if (!out) return null;
    let arr = null;
    if (out instanceof Float32Array) arr = out;
    else if (Array.isArray(out) && out.length && out[0]?.data) arr = _arrayLikeToFloat32(out[0].data);
    else if (out.data) arr = _arrayLikeToFloat32(out.data);
    else if (Array.isArray(out)) arr = _arrayLikeToFloat32(out);
    if (!arr || !arr.length) return null;
    return l2Normalize(arr);
}

function _arrayLikeToFloat32(x) {
    if (x instanceof Float32Array) return new Float32Array(x);  // copy so the caller's normalize doesn't mutate the pipeline's buffer
    if (Array.isArray(x) || ArrayBuffer.isView(x)) return Float32Array.from(x);
    return null;
}

/**
 * Reset the cached pipelines — used by tests + the `/api/ai/index/cancel`
 * path when an operator wants to swap models without restarting the process.
 */
export function _resetForTests() {
    _imagePipelinePromise = null;
    _textPipelinePromise = null;
}
