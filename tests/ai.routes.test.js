// Integration test for the AI router.
//
// We mount `createAiRouter` on a fresh Express instance with hand-rolled
// fakes for every dep — never touches the real DB, real AI engine, or real
// HuggingFace. Asserts:
//   - safeRoute envelope shape on a forced throw
//   - happy-path responses include both `ok:true` and `success:true`
//   - 503 + code: AI_DISABLED when the master switch is off
//   - 409 + code: ALREADY_RUNNING when tracker rejects
//   - /api/ai/health returns the four-check summary
//
// No supertest dep — we use express's `listen()` on port 0 + node fetch.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createAiRouter } from '../src/web/routes/ai.js';

let server;
let baseUrl;
const log = vi.fn();
const broadcast = vi.fn();

// Tracker fake: tryStart returns a configurable result *synchronously* —
// matching the real job-tracker contract (route handler reads `r.started`
// off the synchronous return value, the work runs detached in the BG).
function makeTracker(initial = { started: true }) {
    let result = { ...initial };
    return {
        tryStart: vi.fn(() => result),
        getStatus: vi.fn(() => ({ running: false, progress: null })),
        cancel: vi.fn(() => true),
        _setNext(next) {
            result = next;
        },
    };
}

const trackers = {
    aiIndex: makeTracker(),
    aiPeople: makeTracker(),
    aiPhash: makeTracker(),
    aiTags: makeTracker(),
};

const aiFake = {
    AI_DEFAULTS: {
        embeddings: { enabled: false, model: 'Xenova/clip-vit-base-patch32' },
        faces: { enabled: false, model: 'Xenova/yolos-tiny', epsilon: 0.4, minPoints: 3 },
        tags: { enabled: false, model: 'Xenova/vit-base-patch16-224', topK: 5 },
        phash: { enabled: false },
        indexConcurrency: 2,
        batchSize: 16,
        fileTypes: ['photo'],
    },
    AI_MODEL_DEFAULTS: {
        embeddings: { kind: 'image-feature-extraction', modelId: 'Xenova/clip-vit-base-patch32' },
        faces: { kind: 'object-detection', modelId: 'Xenova/yolos-tiny' },
        tags: { kind: 'image-classification', modelId: 'Xenova/vit-base-patch16-224' },
    },
    EMBEDDING_PRESETS: [],
    setModelProgressHook: vi.fn(),
    suggestPublicReplacement: () => null,
    loadedPipelines: () => [],
    pipelineMetaSnapshot: () => [],
    pipelineErrorsSnapshot: () => [],
    inspectModelCache: vi.fn(async () => ({ bytes: 0, files: 0, dir: null })),
    resolveCacheDir: () => '/tmp/models',
    deleteModelCache: vi.fn(async () => ({ removed: true, bytes: 0 })),
    clearPipelineForModel: vi.fn(async () => 0),
    runIndexScan: vi.fn(async () => ({ scanned: 0 })),
    runFaceClustering: vi.fn(async () => ({ clusters: 0 })),
    runPhashScan: vi.fn(async () => ({ scanned: 0 })),
    findPhashGroups: () => ({ groups: [] }),
    searchByText: vi.fn(async () => ({ results: [] })),
    loadVecExtension: vi.fn(async () => false),
    clearVectorCache: vi.fn(),
};

const dbFake = {
    getAiCounts: () => ({ indexed: 5, totalEligible: 10 }),
    listPeople: () => ({ people: [] }),
    listPhotosForPerson: () => ({ photos: [] }),
    renamePerson: vi.fn(() => 1),
    deletePerson: vi.fn(() => 1),
    listAllTags: () => [],
    listPhotosForTag: () => ({ photos: [] }),
    listEmbeddingModels: () => [],
    clearStaleEmbeddings: () => ({ dropped: 0, requeued: 0 }),
};

let configEnabled = false;
let configPatch = null;
function loadConfig() {
    return {
        advanced: { ai: { enabled: configEnabled, ...(configPatch || {}) } },
    };
}

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
        '/api/ai',
        createAiRouter({
            ai: aiFake,
            db: dbFake,
            jobTrackers: trackers,
            getDb: () => null,
            loadConfig,
            log,
            broadcast,
        }),
    );
    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });
});

afterAll(() => {
    return new Promise((resolve) => server?.close(resolve));
});

async function get(path) {
    const res = await fetch(baseUrl + path);
    const body = await res.json();
    return { status: res.status, body };
}
async function post(path, body) {
    const res = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    return { status: res.status, body: data };
}

describe('GET /api/ai/health', () => {
    it('returns a four-check summary', async () => {
        const r = await get('/api/ai/health');
        expect(r.status).toBe(200);
        expect(r.body.ok).toBeDefined();
        expect(Array.isArray(r.body.checks)).toBe(true);
        expect(r.body.checks.length).toBe(4);
    });
});

describe('GET /api/ai/status', () => {
    it('returns ok:true + capability flags when AI is off', async () => {
        configEnabled = false;
        const r = await get('/api/ai/status');
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.success).toBe(true);
        expect(r.body.enabled).toBe(false);
        expect(r.body.capabilities.master).toBe(false);
        expect(r.body.counts.indexed).toBe(5);
    });
});

describe('POST /api/ai/index/scan', () => {
    it('refuses with 503 + AI_DISABLED when master is off', async () => {
        configEnabled = false;
        const r = await post('/api/ai/index/scan', {});
        expect(r.status).toBe(503);
        expect(r.body.ok).toBe(false);
        expect(r.body.code).toBe('AI_DISABLED');
    });

    it('returns 200 + started:true when tracker accepts', async () => {
        configEnabled = true;
        trackers.aiIndex._setNext({ started: true });
        const r = await post('/api/ai/index/scan', {});
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.started).toBe(true);
    });

    it('returns 409 + ALREADY_RUNNING when tracker rejects', async () => {
        configEnabled = true;
        trackers.aiIndex._setNext({ started: false });
        const r = await post('/api/ai/index/scan', {});
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('ALREADY_RUNNING');
    });
});

describe('POST /api/ai/hf/test', () => {
    it('returns 400 + NO_TOKEN when no token is provided', async () => {
        const r = await post('/api/ai/hf/test', {});
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('NO_TOKEN');
    });
});

describe('GET /api/ai/people', () => {
    it('happy path returns ok:true', async () => {
        const r = await get('/api/ai/people');
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(Array.isArray(r.body.people)).toBe(true);
    });
});

describe('PUT /api/ai/people/:id', () => {
    it('returns 400 on bad id', async () => {
        const res = await fetch(baseUrl + '/api/ai/people/abc', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: 'foo' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('BAD_ID');
    });

    it('renames a person', async () => {
        const res = await fetch(baseUrl + '/api/ai/people/42', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: 'Alice' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(dbFake.renamePerson).toHaveBeenCalledWith(42, 'Alice');
    });
});

describe('safeRoute envelope on uncaught throw', () => {
    it('catches a thrown helper deep in the handler chain → 500 envelope', async () => {
        // Force the underlying fake to throw next time.
        const orig = aiFake.findPhashGroups;
        aiFake.findPhashGroups = () => {
            throw new Error('synthetic-explode');
        };
        try {
            const r = await get('/api/ai/perceptual-dedup/groups?threshold=6');
            expect(r.status).toBe(500);
            expect(r.body.ok).toBe(false);
            expect(r.body.success).toBe(false);
            expect(r.body.code).toBe('AI_ROUTE_ERROR');
            expect(r.body.message).toContain('synthetic-explode');
            expect(r.body.where).toContain('/api/ai/perceptual-dedup/groups');
        } finally {
            aiFake.findPhashGroups = orig;
        }
    });
});

describe('GET /api/ai/models/status', () => {
    it('returns model metadata for embeddings/faces/tags', async () => {
        const r = await get('/api/ai/models/status');
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.models.embeddings).toBeDefined();
        expect(r.body.models.faces).toBeDefined();
        expect(r.body.models.tags).toBeDefined();
    });
});

describe('DELETE /api/ai/models/cache', () => {
    it('returns 400 when model id is missing', async () => {
        const res = await fetch(baseUrl + '/api/ai/models/cache', { method: 'DELETE' });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe('MODEL_ID_REQUIRED');
    });

    it('wipes cache when model id is provided via query', async () => {
        const res = await fetch(baseUrl + '/api/ai/models/cache?model=Xenova%2Ffoo', {
            method: 'DELETE',
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(aiFake.deleteModelCache).toHaveBeenCalled();
    });
});

describe('createAiRouter validation', () => {
    it('throws when ai is missing', () => {
        expect(() => createAiRouter({})).toThrow(/ai is required/);
    });
});
