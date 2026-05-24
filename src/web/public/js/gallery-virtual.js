/**
 * Gallery sliding-window — caps visible DOM at MAX_TILES nodes.
 * When the gallery appends past the cap, the oldest tiles are removed
 * from the top and replaced by a height-preserving spacer. Scrolling
 * back up re-fetches those pages (existing IntersectionObserver
 * pagination handles this via the `load-more-sentinel` mechanics).
 *
 * This module exports a single function `trimGalleryDOM(grid)` called
 * after every append render. It measures the excess, records heights
 * into the spacer, and removes the overflow from the DOM.
 *
 * The spacer sits as the first child of #media-grid. Its height grows
 * monotonically during a downward scroll session. A full re-render
 * (filter switch, group change) resets it via `resetGalleryWindow()`.
 */

const MAX_TILES = 600;
const TRIM_BATCH = 200;

let _spacer = null;
let _trimmedHeight = 0;
let _trimmedCount = 0;

function _getOrCreateSpacer(grid) {
    if (_spacer && _spacer.parentNode === grid) return _spacer;
    _spacer = grid.querySelector('.gallery-spacer');
    if (!_spacer) {
        _spacer = document.createElement('div');
        _spacer.className = 'gallery-spacer';
        _spacer.style.cssText = 'grid-column: 1 / -1; width: 100%; pointer-events: none;';
        grid.prepend(_spacer);
    }
    return _spacer;
}

export function trimGalleryDOM(grid) {
    if (!grid) return;
    const items = grid.querySelectorAll('.media-item');
    if (items.length <= MAX_TILES) return;

    const excess = items.length - MAX_TILES + TRIM_BATCH;
    if (excess <= 0) return;

    const spacer = _getOrCreateSpacer(grid);
    let removedHeight = 0;

    // Measure heights before removing (batch read to avoid layout thrash)
    const heights = [];
    for (let i = 0; i < excess; i++) {
        heights.push(items[i].offsetHeight);
    }

    // Also remove section headers that precede the trimmed tiles
    const toRemove = [];
    let collected = 0;
    for (const child of grid.children) {
        if (child === spacer) continue;
        if (collected >= excess) break;
        if (child.classList.contains('media-item')) {
            toRemove.push(child);
            removedHeight += heights[collected];
            collected++;
        } else if (child.classList.contains('grid-section-header')) {
            // Remove orphaned headers too
            toRemove.push(child);
            removedHeight += child.offsetHeight || 0;
        }
    }

    for (const el of toRemove) el.remove();

    _trimmedHeight += removedHeight;
    _trimmedCount += collected;
    spacer.style.height = `${_trimmedHeight}px`;
}

export function resetGalleryWindow(grid) {
    _trimmedHeight = 0;
    _trimmedCount = 0;
    if (_spacer && _spacer.parentNode) {
        _spacer.remove();
    }
    _spacer = null;
}

export function getTrimmedCount() {
    return _trimmedCount;
}
