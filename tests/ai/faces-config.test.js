// Track I — config + env resolver. Locks in:
//   - precedence: env > config > default
//   - parse rules (bool, number, number-array, string-array)
//   - that every faces.* key has an explicit TGDL_FACES_<UPPER_SNAKE> env

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _envMap, resolveAllFaces, resolveFacesValue } from '../../src/core/ai/faces-config.js';

// Snapshot the original env so tests can mutate freely without leaking
// state across files.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    // Clear every TGDL_FACES_* var from the environment so the test
    // starts in a known clean state — leftovers from a previous spec
    // would otherwise turn into spooky-action-at-a-distance.
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('TGDL_FACES_')) delete process.env[k];
    }
});

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('TGDL_FACES_')) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
});

describe('resolveFacesValue precedence', () => {
    it('returns config value when no env override is set', () => {
        expect(resolveFacesValue('epsilon', { epsilon: 0.42 })).toBe(0.42);
    });

    it('env overrides config', () => {
        process.env.TGDL_FACES_EPSILON = '0.6';
        expect(resolveFacesValue('epsilon', { epsilon: 0.42 })).toBe(0.6);
    });

    it('empty env string falls back to config', () => {
        process.env.TGDL_FACES_EPSILON = '   ';
        expect(resolveFacesValue('epsilon', { epsilon: 0.42 })).toBe(0.42);
    });

    it('unknown key passes through unchanged', () => {
        expect(resolveFacesValue('nonexistent', { x: 1 })).toBeUndefined();
    });
});

describe('env parsing', () => {
    it('parses booleans (true/false/yes/no/1/0/on/off)', () => {
        const truthy = ['1', 'true', 'TRUE', 'yes', 'on', 'y'];
        const falsy = ['0', 'false', 'FALSE', 'no', 'off', 'n'];
        for (const t of truthy) {
            process.env.TGDL_FACES_AUTO_DOWNLOAD = t;
            expect(resolveFacesValue('autoDownload', { autoDownload: false })).toBe(true);
        }
        for (const f of falsy) {
            process.env.TGDL_FACES_AUTO_DOWNLOAD = f;
            expect(resolveFacesValue('autoDownload', { autoDownload: true })).toBe(false);
        }
    });

    it('falls back to config when bool is unparseable', () => {
        process.env.TGDL_FACES_AUTO_DOWNLOAD = 'maybe';
        expect(resolveFacesValue('autoDownload', { autoDownload: true })).toBe(true);
    });

    it('parses numbers and falls back on garbage', () => {
        process.env.TGDL_FACES_DET_SIZE = '480';
        expect(resolveFacesValue('detSize', { detSize: 640 })).toBe(480);
        process.env.TGDL_FACES_DET_SIZE = 'not-a-number';
        expect(resolveFacesValue('detSize', { detSize: 640 })).toBe(640);
    });

    it('parses number arrays from comma OR colon separators', () => {
        process.env.TGDL_FACES_PORT_RANGE = '5000,5999';
        expect(resolveFacesValue('portRange', { portRange: [41000, 49999] })).toEqual([5000, 5999]);
        process.env.TGDL_FACES_PORT_RANGE = '5000:5999';
        expect(resolveFacesValue('portRange', { portRange: [41000, 49999] })).toEqual([5000, 5999]);
        process.env.TGDL_FACES_PORT_RANGE = '[5000,5999]';
        expect(resolveFacesValue('portRange', { portRange: [41000, 49999] })).toEqual([5000, 5999]);
    });

    it('parses ar_range arrays', () => {
        process.env.TGDL_FACES_AR_RANGE = '0.4,2.5';
        expect(resolveFacesValue('arRange', { arRange: [0.5, 2.0] })).toEqual([0.4, 2.5]);
    });

    it('parses retryBackoffMs as a number array', () => {
        process.env.TGDL_FACES_RETRY_BACKOFF_MS = '100,200,400,800';
        expect(resolveFacesValue('retryBackoffMs', {})).toEqual([100, 200, 400, 800]);
    });

    it('parses string arrays', () => {
        process.env.TGDL_FACES_DOWNLOAD_MIRRORS = 'https://a.com,https://b.com,https://c.com';
        expect(resolveFacesValue('downloadMirrors', {})).toEqual([
            'https://a.com',
            'https://b.com',
            'https://c.com',
        ]);
    });

    it('parses fileTypes', () => {
        process.env.TGDL_FACES_FILE_TYPES = 'photo, video';
        expect(resolveFacesValue('fileTypes', { fileTypes: ['photo'] })).toEqual([
            'photo',
            'video',
        ]);
    });

    it('passes strings through', () => {
        process.env.TGDL_FACES_PROVIDERS = 'cuda';
        expect(resolveFacesValue('providers', { providers: 'auto' })).toBe('cuda');
        process.env.TGDL_FACES_SIDECAR_URL = 'http://other:8011';
        expect(resolveFacesValue('sidecarUrl', { sidecarUrl: '' })).toBe('http://other:8011');
        process.env.TGDL_FACES_BACKEND = 'disabled';
        expect(resolveFacesValue('backend', { backend: 'sidecar' })).toBe('disabled');
    });
});

describe('resolveAllFaces', () => {
    it('merges env on top of cfg for every known key', () => {
        process.env.TGDL_FACES_EPSILON = '0.7';
        process.env.TGDL_FACES_MIN_POINTS = '5';
        process.env.TGDL_FACES_PROVIDERS = 'coreml';
        const out = resolveAllFaces({
            epsilon: 0.5,
            minPoints: 3,
            providers: 'auto',
            detSize: 640,
        });
        expect(out.epsilon).toBe(0.7);
        expect(out.minPoints).toBe(5);
        expect(out.providers).toBe('coreml');
        // Unmodified key stays at its config value.
        expect(out.detSize).toBe(640);
    });

    it('returns a frozen snapshot', () => {
        const out = resolveAllFaces({ epsilon: 0.5 });
        expect(Object.isFrozen(out)).toBe(true);
        expect(() => {
            out.epsilon = 99;
        }).toThrow();
    });
});

describe('env map completeness', () => {
    it('exposes a stable TGDL_FACES_* name for every faces.* key', () => {
        const map = _envMap();
        // Every value is uppercase + matches the convention.
        for (const [key, env] of Object.entries(map)) {
            expect(env).toMatch(/^TGDL_FACES_[A-Z0-9_]+$/);
            expect(env.endsWith('_')).toBe(false);
            // Sanity-check a known mapping that the docs document.
            if (key === 'sidecarMaxConcurrency') {
                expect(env).toBe('TGDL_FACES_MAX_CONCURRENCY');
            }
        }
        // Spot-check a few required keys are present.
        for (const k of [
            'backend',
            'sidecarUrl',
            'autoDownload',
            'providers',
            'detSize',
            'epsilon',
            'minPoints',
            'portRange',
            'downloadMirrors',
            'federate',
            'labelMatchEps',
        ]) {
            expect(map[k]).toBeTruthy();
        }
    });
});
