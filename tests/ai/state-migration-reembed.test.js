// Tests for `_reembedOnModelChange` — the state-migration sweep that drops
// stale `image_embeddings` rows when the operator's saved embedding model
// no longer matches the model the rows were built against (e.g. CLIP-EN
// 512-dim → SigLIP multilingual 768-dim swap at v2.7.x).

import { describe, it, expect } from 'vitest';

import { _reembedOnModelChange } from '../../src/core/state-migration.js';
import { AI_MODEL_DEFAULTS } from '../../src/core/ai/models.js';

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

function fakeDb({ models = [], wipe = null } = {}) {
    let calls = [];
    return {
        listEmbeddingModels: () => models,
        clearStaleEmbeddings: (currentModelId) => {
            calls.push(currentModelId);
            return wipe || { dropped: 0, requeued: 0 };
        },
        calls: () => calls,
    };
}

describe('_reembedOnModelChange', () => {
    it('returns 0 when image_embeddings is empty', () => {
        const kv = fakeKv({});
        const db = fakeDb({ models: [] });
        expect(
            _reembedOnModelChange({
                kvGet: kv.kvGet,
                listEmbeddingModels: db.listEmbeddingModels,
                clearStaleEmbeddings: db.clearStaleEmbeddings,
            }),
        ).toBe(0);
        expect(db.calls()).toEqual([]);
    });

    it('returns 0 when every row already matches the current default', () => {
        const kv = fakeKv({}); // no override → use default
        const db = fakeDb({
            models: [{ model: AI_MODEL_DEFAULTS.embeddings.modelId, count: 100 }],
        });
        expect(
            _reembedOnModelChange({
                kvGet: kv.kvGet,
                listEmbeddingModels: db.listEmbeddingModels,
                clearStaleEmbeddings: db.clearStaleEmbeddings,
            }),
        ).toBe(0);
        expect(db.calls()).toEqual([]);
    });

    it('wipes when stored rows are built against an older model id', () => {
        const kv = fakeKv({}); // default = SigLIP-multilingual
        const db = fakeDb({
            models: [{ model: 'Xenova/clip-vit-base-patch32', count: 1234 }],
            wipe: { dropped: 1234, requeued: 1234 },
        });
        const logs = [];
        const r = _reembedOnModelChange({
            kvGet: kv.kvGet,
            listEmbeddingModels: db.listEmbeddingModels,
            clearStaleEmbeddings: db.clearStaleEmbeddings,
            log: (m) => logs.push(m),
        });
        expect(r).toBe(1);
        expect(db.calls()).toEqual([AI_MODEL_DEFAULTS.embeddings.modelId]);
        expect(logs.some((m) => m.includes('1234'))).toBe(true);
        expect(logs.some((m) => m.includes('clip-vit-base-patch32'))).toBe(true);
    });

    it('respects an explicit advanced.ai.embeddings.model override', () => {
        // Operator pinned an older model on purpose — migration must
        // NOT wipe rows that match that pin.
        const pinned = 'Xenova/clip-vit-base-patch32';
        const kv = fakeKv({
            config: { advanced: { ai: { embeddings: { model: pinned } } } },
        });
        const db = fakeDb({
            models: [{ model: pinned, count: 50 }],
        });
        expect(
            _reembedOnModelChange({
                kvGet: kv.kvGet,
                listEmbeddingModels: db.listEmbeddingModels,
                clearStaleEmbeddings: db.clearStaleEmbeddings,
            }),
        ).toBe(0);
        expect(db.calls()).toEqual([]);
    });

    it('handles a mixed-model table by passing the current id to the wipe', () => {
        // Rare but possible: rows from two different historical defaults.
        // The wipe helper takes the current id and DELETEs everything else.
        const kv = fakeKv({});
        const db = fakeDb({
            models: [
                { model: 'Xenova/clip-vit-base-patch32', count: 800 },
                { model: 'old/legacy-clip', count: 200 },
                { model: AI_MODEL_DEFAULTS.embeddings.modelId, count: 50 },
            ],
            wipe: { dropped: 1000, requeued: 1000 },
        });
        const r = _reembedOnModelChange({
            kvGet: kv.kvGet,
            listEmbeddingModels: db.listEmbeddingModels,
            clearStaleEmbeddings: db.clearStaleEmbeddings,
        });
        expect(r).toBe(1);
        expect(db.calls()).toEqual([AI_MODEL_DEFAULTS.embeddings.modelId]);
    });

    it('is idempotent — second run is a no-op when the table is clean', () => {
        // Simulate first run with stale rows, then a second run after the
        // wipe by toggling the fake DB.
        const kv = fakeKv({});
        const db1 = fakeDb({
            models: [{ model: 'Xenova/clip-vit-base-patch32', count: 100 }],
            wipe: { dropped: 100, requeued: 100 },
        });
        expect(
            _reembedOnModelChange({
                kvGet: kv.kvGet,
                listEmbeddingModels: db1.listEmbeddingModels,
                clearStaleEmbeddings: db1.clearStaleEmbeddings,
            }),
        ).toBe(1);
        // Second pass — fake DB now reports a clean table.
        const db2 = fakeDb({
            models: [{ model: AI_MODEL_DEFAULTS.embeddings.modelId, count: 100 }],
        });
        expect(
            _reembedOnModelChange({
                kvGet: kv.kvGet,
                listEmbeddingModels: db2.listEmbeddingModels,
                clearStaleEmbeddings: db2.clearStaleEmbeddings,
            }),
        ).toBe(0);
        expect(db2.calls()).toEqual([]);
    });

    it('returns 0 when listEmbeddingModels throws (table missing)', () => {
        const kv = fakeKv({});
        const db = {
            listEmbeddingModels: () => {
                throw new Error('no such table: image_embeddings');
            },
            clearStaleEmbeddings: () => ({ dropped: 0, requeued: 0 }),
        };
        expect(
            _reembedOnModelChange({
                kvGet: kv.kvGet,
                listEmbeddingModels: db.listEmbeddingModels,
                clearStaleEmbeddings: db.clearStaleEmbeddings,
            }),
        ).toBe(0);
    });

    it('handles an empty-string model column entry', () => {
        const kv = fakeKv({});
        const db = fakeDb({
            models: [{ model: '', count: 12 }],
            wipe: { dropped: 12, requeued: 12 },
        });
        expect(
            _reembedOnModelChange({
                kvGet: kv.kvGet,
                listEmbeddingModels: db.listEmbeddingModels,
                clearStaleEmbeddings: db.clearStaleEmbeddings,
            }),
        ).toBe(1);
    });
});
