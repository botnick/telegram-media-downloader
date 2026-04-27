// Unit tests for the canonical group-name lookup in src/web/public/js/store.js.
//
// Why this matters: every render path in the SPA (sidebar, modal header,
// gallery breadcrumb, engine "live downloads", history toasts) used to look
// up the name independently. When the cache had the real label but a render
// path read from a stale slice of state, the UI flickered between
// "Telegram Tips" and "Unknown chat (#-100…)". This test pins the
// resolution-order contract so future refactors don't reopen that gap.

import { describe, it, expect, beforeEach } from 'vitest';
import { state, getGroupName, updateGroupNameCache, isUnresolvedName }
    from '../src/web/public/js/store.js';

beforeEach(() => {
    // Reset every slice we touch — store.js is a singleton, so leaks across
    // tests would shadow real bugs.
    state.groupNameCache = {};
    state.groups = [];
    state.allDialogs = [];
    state.downloads = [];
    state.files = [];
});

describe('getGroupName resolution order', () => {
    it('prefers the explicit cache over every other source', () => {
        state.groupNameCache['-100123'] = 'Telegram Tips';
        state.groups = [{ id: -100123, name: 'Stale Config Name' }];
        state.allDialogs = [{ id: -100123, name: 'Stale Dialog Name' }];
        expect(getGroupName('-100123')).toBe('Telegram Tips');
    });

    it('falls through to state.groups when the cache is empty', () => {
        state.groups = [{ id: -100123, name: 'My Channel' }];
        expect(getGroupName('-100123')).toBe('My Channel');
    });

    it('falls through to state.allDialogs when groups missed', () => {
        state.allDialogs = [{ id: -100999, name: 'Browseable Chat' }];
        expect(getGroupName('-100999')).toBe('Browseable Chat');
    });

    it('falls through to state.downloads', () => {
        state.downloads = [{ id: -100777, name: 'DB Folder' }];
        expect(getGroupName('-100777')).toBe('DB Folder');
    });

    it('falls through to a state.files row carrying group_name', () => {
        state.files = [{ groupId: '-100555', groupName: 'From File Row' }];
        expect(getGroupName('-100555')).toBe('From File Row');
    });

    it('returns the friendly placeholder, never the bare numeric id', () => {
        const r = getGroupName('-1009999999999');
        expect(r).toBe('Unknown chat (#-1009999999999)');
        expect(r).not.toMatch(/^-?\d+$/);
    });

    it('rejects placeholder labels at every layer', () => {
        // Cache → "Unknown" should NOT shadow a good config name.
        state.groupNameCache['-100123'] = 'Unknown';
        state.groups = [{ id: -100123, name: 'Real Name' }];
        expect(getGroupName('-100123')).toBe('Real Name');

        // Config "Group -100…" placeholder → fall through.
        state.groupNameCache = {};
        state.groups = [{ id: -100222, name: 'Group -100222' }];
        state.downloads = [{ id: -100222, name: 'Real DB Name' }];
        expect(getGroupName('-100222')).toBe('Real DB Name');
    });

    it('caches updates from the WS broadcast shape', () => {
        const n = updateGroupNameCache([
            { id: -100123, name: 'Hi' },
            { id: -100456, name: 'There' },
            // Skipped: empty / placeholder / numeric-string-as-name.
            { id: -100789, name: '' },
            { id: -100789, name: 'Unknown' },
            { id: -100789, name: '-100789' },
        ]);
        expect(n).toBe(2);
        expect(getGroupName('-100123')).toBe('Hi');
        expect(getGroupName('-100456')).toBe('There');
        expect(getGroupName('-100789')).toBe('Unknown chat (#-100789)');
    });

    it('uses opts.fallback when provided', () => {
        expect(getGroupName('-100xyz', { fallback: 'My Fallback' })).toBe('My Fallback');
    });

    it('isUnresolvedName flags placeholder and numeric inputs', () => {
        expect(isUnresolvedName('', '-100')).toBe(true);
        expect(isUnresolvedName('Unknown', '-100')).toBe(true);
        expect(isUnresolvedName('-100123', '-100123')).toBe(true);
        expect(isUnresolvedName('1234567890')).toBe(true);
        expect(isUnresolvedName('Group -100222')).toBe(true);
        expect(isUnresolvedName('Real Name')).toBe(false);
    });
});
