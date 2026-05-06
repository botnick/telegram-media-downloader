// Tests for the gated-model registry helpers in src/core/ai/models.js.
//
// `KNOWN_GATED_MODELS` + `suggestPublicReplacement` are the contract the
// startup state-migration sweep + the runtime /api/ai/status warning banner
// both depend on. If we ever shrink the gated list or relink an entry to the
// wrong capability, those regress without these checks.

import { describe, it, expect } from 'vitest';

import {
    AI_MODEL_DEFAULTS,
    KNOWN_GATED_MODELS,
    suggestPublicReplacement,
    isKnownGatedModel,
} from '../../src/core/ai/models.js';

describe('KNOWN_GATED_MODELS', () => {
    it('points every entry at a real capability key', () => {
        for (const [id, cap] of Object.entries(KNOWN_GATED_MODELS)) {
            expect(id, `${id} cap`).toMatch(/.+\/.+/);
            expect(AI_MODEL_DEFAULTS[cap], `${id} → ${cap} default exists`).toBeDefined();
            expect(AI_MODEL_DEFAULTS[cap].modelId).toBeTruthy();
        }
    });

    it('does not list any current public default as gated', () => {
        // Sanity check — a default that is itself in the gated set would
        // make the migration loop forever.
        for (const def of Object.values(AI_MODEL_DEFAULTS)) {
            expect(KNOWN_GATED_MODELS[def.modelId]).toBeUndefined();
        }
    });

    it('covers the production 401 incident list', () => {
        // These are the exact ids that surfaced in the operator's scan log
        // and motivated this whole branch — guard against regressions if
        // someone trims the list later.
        expect(KNOWN_GATED_MODELS['Xenova/mobilenet_v2']).toBe('tags');
        expect(KNOWN_GATED_MODELS['Xenova/yolov5n-face']).toBe('faces');
        expect(KNOWN_GATED_MODELS['Xenova/yolov8n-face']).toBe('faces');
    });
});

describe('suggestPublicReplacement', () => {
    it('returns the public default for a gated tags model', () => {
        const r = suggestPublicReplacement('Xenova/mobilenet_v2');
        expect(r).toEqual({ cap: 'tags', suggested: AI_MODEL_DEFAULTS.tags.modelId });
    });

    it('returns the public default for a gated faces model', () => {
        const r = suggestPublicReplacement('Xenova/yolov5n-face');
        expect(r).toEqual({ cap: 'faces', suggested: AI_MODEL_DEFAULTS.faces.modelId });
    });

    it('returns null for an unknown id', () => {
        expect(suggestPublicReplacement('some-random/model')).toBeNull();
        expect(suggestPublicReplacement(AI_MODEL_DEFAULTS.tags.modelId)).toBeNull();
    });

    it('handles falsy / non-string inputs gracefully', () => {
        expect(suggestPublicReplacement('')).toBeNull();
        expect(suggestPublicReplacement(null)).toBeNull();
        expect(suggestPublicReplacement(undefined)).toBeNull();
        expect(suggestPublicReplacement(42)).toBeNull();
        expect(suggestPublicReplacement('   ')).toBeNull();
    });
});

describe('isKnownGatedModel', () => {
    it('mirrors suggestPublicReplacement as a boolean predicate', () => {
        expect(isKnownGatedModel('Xenova/mobilenet_v2')).toBe(true);
        expect(isKnownGatedModel(AI_MODEL_DEFAULTS.tags.modelId)).toBe(false);
        expect(isKnownGatedModel('')).toBe(false);
        expect(isKnownGatedModel(null)).toBe(false);
    });
});
