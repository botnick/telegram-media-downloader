// Gallery selection → bulk-delete request body (src/web/public/js/gallery-select.js).

import { describe, it, expect } from 'vitest';
import { bulkDeleteTargets } from '../src/web/public/js/gallery-select.js';

describe('bulkDeleteTargets', () => {
    it('sends every own tile id under a selected path (shared-file rows)', () => {
        const files = [
            { id: 1, fullPath: 'G1/images/x.jpg' },
            { id: 2, fullPath: 'G1/images/x.jpg' }, // dedup reference from another group
            { id: 3, fullPath: 'G1/images/y.jpg' },
        ];
        expect(bulkDeleteTargets(['G1/images/x.jpg'], files)).toEqual({ ids: [1, 2], paths: [] });
    });

    it('keeps own ids even when a peer tile shares the path', () => {
        const files = [
            { id: 7, fullPath: 'G/a.jpg', peer_id: 'self' },
            { id: 7, fullPath: 'G/a.jpg', peer_id: 'peer-b' },
        ];
        expect(bulkDeleteTargets(['G/a.jpg'], files)).toEqual({ ids: [7], paths: [] });
    });

    it('falls back to the path for peer tiles and rows without an id', () => {
        const files = [
            { id: 9, fullPath: 'P/p.jpg', peer_id: 'peer-b' },
            { fullPath: 'L/legacy.jpg' },
        ];
        expect(bulkDeleteTargets(new Set(['P/p.jpg', 'L/legacy.jpg']), files)).toEqual({
            ids: [],
            paths: ['P/p.jpg', 'L/legacy.jpg'],
        });
    });
});
