// Tests for `_sanitiseAiModelIds` — the state-migration sweep that rewrites
// known-gated HF model ids in `kv['config']` so the operator's saved config
// stops triggering 401s after we update the public defaults.

import { describe, it, expect } from 'vitest';

import { _sanitiseAiModelIds } from '../../src/core/state-migration.js';
import { AI_MODEL_DEFAULTS } from '../../src/core/ai/models.js';

// Tiny in-memory kv stub — same surface the migration function expects.
function fakeKv(initial = {}) {
    const store = { ...initial };
    return {
        kvGet: (k) => (k in store ? structuredClone(store[k]) : null),
        kvSet: (k, v) => {
            store[k] = structuredClone(v);
        },
        snapshot: () => structuredClone(store),
    };
}

describe('_sanitiseAiModelIds', () => {
    it('returns 0 + leaves config alone when no gated id is present', () => {
        const kv = fakeKv({
            config: {
                advanced: {
                    ai: {
                        embeddings: { model: AI_MODEL_DEFAULTS.embeddings.modelId },
                        faces: { model: AI_MODEL_DEFAULTS.faces.modelId },
                        tags: { model: AI_MODEL_DEFAULTS.tags.modelId },
                    },
                },
            },
        });
        const before = kv.snapshot();
        const n = _sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet });
        expect(n).toBe(0);
        expect(kv.snapshot()).toEqual(before);
    });

    it('rewrites a gated tags model id to the public default', () => {
        const kv = fakeKv({
            config: {
                advanced: {
                    ai: { tags: { model: 'Xenova/mobilenet_v2', enabled: true } },
                },
            },
        });
        const logs = [];
        const n = _sanitiseAiModelIds({
            kvGet: kv.kvGet,
            kvSet: kv.kvSet,
            log: (m) => logs.push(m),
        });
        expect(n).toBe(1);
        expect(kv.snapshot().config.advanced.ai.tags.model).toBe(
            AI_MODEL_DEFAULTS.tags.modelId,
        );
        // The other fields must be preserved (we mutate model, not the whole node).
        expect(kv.snapshot().config.advanced.ai.tags.enabled).toBe(true);
        // Migration logs the rewrite for the boot transcript.
        expect(logs.some((m) => m.includes('Xenova/mobilenet_v2'))).toBe(true);
    });

    it('rewrites a gated faces model id', () => {
        const kv = fakeKv({
            config: {
                advanced: { ai: { faces: { model: 'Xenova/yolov5n-face' } } },
            },
        });
        const n = _sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet });
        expect(n).toBe(1);
        expect(kv.snapshot().config.advanced.ai.faces.model).toBe(
            AI_MODEL_DEFAULTS.faces.modelId,
        );
    });

    it('rewrites multiple gated ids in a single pass', () => {
        const kv = fakeKv({
            config: {
                advanced: {
                    ai: {
                        tags: { model: 'Xenova/mobilenet_v2' },
                        faces: { model: 'Xenova/yolov8n-face' },
                    },
                },
            },
        });
        const n = _sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet });
        expect(n).toBe(2);
        expect(kv.snapshot().config.advanced.ai.tags.model).toBe(
            AI_MODEL_DEFAULTS.tags.modelId,
        );
        expect(kv.snapshot().config.advanced.ai.faces.model).toBe(
            AI_MODEL_DEFAULTS.faces.modelId,
        );
    });

    it('is idempotent — second run is a no-op', () => {
        const kv = fakeKv({
            config: {
                advanced: { ai: { tags: { model: 'Xenova/mobilenet_v2' } } },
            },
        });
        expect(_sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet })).toBe(1);
        expect(_sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet })).toBe(0);
    });

    it('does not throw when kv.config has no advanced.ai branch', () => {
        const kv = fakeKv({ config: { downloads: {} } });
        expect(() => _sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet })).not.toThrow();
        expect(_sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet })).toBe(0);
    });

    it('does not throw when kv.config is missing entirely', () => {
        const kv = fakeKv({});
        expect(_sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet })).toBe(0);
    });

    it('does not throw when a cap node lacks a model field', () => {
        const kv = fakeKv({
            config: { advanced: { ai: { tags: { enabled: true } } } },
        });
        expect(_sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet })).toBe(0);
    });

    it('ignores non-string model values without crashing', () => {
        const kv = fakeKv({
            config: {
                advanced: {
                    ai: {
                        tags: { model: 42 },
                        faces: { model: null },
                        embeddings: { model: '   ' },
                    },
                },
            },
        });
        expect(_sanitiseAiModelIds({ kvGet: kv.kvGet, kvSet: kv.kvSet })).toBe(0);
    });
});
