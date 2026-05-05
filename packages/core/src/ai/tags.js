/**
 * Auto-tag classifier.
 *
 * Runs an ImageNet-class classifier over each photo and stores the top-K
 * labels with their confidence in `image_tags`. Default model is
 * `Xenova/mobilenet_v2` — small (~14 MB), fast, and the 1000 ImageNet
 * classes give the SPA a useful tag cloud out of the box ("dog",
 * "beach", "tabby cat", "espresso", ...).
 *
 * Operators can swap models by setting `config.advanced.ai.tags.model` —
 * the only constraint is that it has to be an `image-classification`
 * pipeline that returns `[{ label, score }]`.
 */

import { existsSync } from 'fs';
import { getPipeline, AI_MODEL_DEFAULTS } from './models.js';

let _classifierPromise = null;

async function _getClassifier(cfg, onProgress, onLog) {
    if (_classifierPromise) return _classifierPromise;
    _classifierPromise = getPipeline({
        kind: AI_MODEL_DEFAULTS.tags.kind,
        modelId: cfg?.model || AI_MODEL_DEFAULTS.tags.modelId,
        cacheDir: cfg?.cacheDir,
        onProgress, onLog,
    }).catch((e) => { _classifierPromise = null; throw e; });
    return _classifierPromise;
}

/**
 * Classify an image into top-K {label, score}. Empty array on missing /
 * unreadable inputs — caller still marks the row as ai-indexed so the
 * scan loop doesn't keep retrying.
 */
export async function classifyImage(absPath, cfg, onProgress, onLog) {
    if (!absPath || !existsSync(absPath)) return [];
    const classifier = await _getClassifier(cfg, onProgress, onLog);
    let out;
    const topK = Math.max(1, Math.min(20, Number(cfg?.topK) || AI_MODEL_DEFAULTS.tags.topK));
    try {
        out = await classifier(absPath, { topk: topK });
    } catch {
        return [];
    }
    if (!Array.isArray(out)) return [];
    // Normalise label strings — ImageNet labels often look like
    //   "tabby, tabby cat" — we keep just the head word for a cleaner cloud.
    return out.slice(0, topK).map((r) => ({
        tag: _cleanLabel(r?.label || ''),
        score: Math.max(0, Math.min(1, Number(r?.score) || 0)),
    })).filter((t) => !!t.tag);
}

function _cleanLabel(raw) {
    if (!raw) return '';
    const head = String(raw).split(',')[0].trim().toLowerCase();
    // Replace whitespace + underscores with single hyphens for a tag-friendly slug.
    return head.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}
