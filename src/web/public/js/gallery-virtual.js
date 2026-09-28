/**
 * Gallery DOM window — keeps #media-grid bounded on 10k–100k-file
 * libraries while the full list stays in memory (`state.files`).
 *
 * The grid renders a sequence of *positions* (0 … length-1). Each
 * position maps to an index into `state.files` (`_order`); a few
 * positions are preceded by a full-row time-section header (`_headers`).
 * Only a contiguous slice [_start, _end) is in the DOM:
 *
 *   #media-grid
 *     .gallery-spacer     ← full-row item, height = measured height of [0, _start)
 *     header? tile, header? tile, …   ← positions _start … _end-1
 *
 *   - Scrolling down: app.js appends fetched pages via `appendPositions()`
 *     (or `extendBottom()` re-renders rows trimmed earlier), then the
 *     window drops whole rows from the top once it exceeds the cap and
 *     grows the spacer by the height it removed — nothing visible moves.
 *   - Scrolling up: an IntersectionObserver on the spacer (root =
 *     #content-area, the real scroller) re-inserts whole rows from memory
 *     above the window, shrinks the spacer by the measured delta, and
 *     drops rows far below the viewport.
 *
 * Cuts always land on row starts, computed from the live column count and
 * the header positions, so tiles never shift columns. `#content-area` has
 * `overflow-anchor: none` (main.css) so browser scroll anchoring doesn't
 * fight the spacer bookkeeping.
 */

// Distances (px) from the scroller's viewport.
const RESTORE_MARGIN_PX = 1500; // re-insert rows when the spacer gets this close
const KEEP_PX = 2500; // never drop rows closer than this to the viewport

let _grid = null;
let _scroller = null;
let _renderItem = null; // (fileIndex) => tile HTML
let _renderHeader = null; // (label, pos) => header HTML
let _onInserted = null; // (elements[]) => void
let _onRemoved = null; // (elements[]) => void

let _order = []; // position → state.files index
let _headers = new Map(); // position → label
let _headerPos = []; // sorted header positions
let _start = 0;
let _end = 0;
let _spacer = null;
let _spacerObserver = null;
let _restoreScheduled = false;

/**
 * One-time wiring. `renderItem(fileIndex)` returns a tile's HTML (one
 * root element), `renderHeader(label, pos)` a header's HTML (one root
 * element). `onInserted` / `onRemoved` receive the tile + header
 * elements that entered / left the DOM so the caller can (un)observe them.
 */
export function configureGalleryWindow({
    grid,
    scroller,
    renderItem,
    renderHeader,
    onInserted,
    onRemoved,
}) {
    _grid = grid;
    _scroller = scroller;
    _renderItem = renderItem;
    _renderHeader = renderHeader;
    _onInserted = onInserted || null;
    _onRemoved = onRemoved || null;
}

// ---- geometry helpers -------------------------------------------------

function _visible() {
    return !!(_grid?.isConnected && _scroller && _grid.getClientRects().length > 0);
}

function _columns() {
    const tpl = getComputedStyle(_grid).gridTemplateColumns;
    if (!tpl || tpl === 'none') return 1;
    return Math.max(1, tpl.trim().split(/\s+/).length);
}

function _rowGap() {
    return parseFloat(getComputedStyle(_grid).rowGap) || 0;
}

// Tiles per row can be large on wide desktop screens (compact mode), so
// the caps scale with the column count.
function _maxTiles(cols) {
    return Math.max(400, cols * 60);
}
function _trimBatch(cols) {
    return Math.max(120, cols * 20);
}
function _chunk(cols) {
    return Math.max(90, cols * 15);
}

// Largest header position <= p (0 when none). Headers restart the row.
function _sectionStart(p) {
    let lo = 0;
    let hi = _headerPos.length - 1;
    let best = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (_headerPos[mid] <= p) {
            best = _headerPos[mid];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

// First header position > p, or Infinity.
function _nextHeaderAfter(p) {
    let lo = 0;
    let hi = _headerPos.length - 1;
    let best = Infinity;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (_headerPos[mid] > p) {
            best = _headerPos[mid];
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }
    return best;
}

// Number of headers with a position in [a, b).
function _headersIn(a, b) {
    if (!_headerPos.length || b <= a) return 0;
    const lower = (x) => {
        let lo = 0;
        let hi = _headerPos.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (_headerPos[mid] < x) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    return lower(b) - lower(a);
}

function _rowStartAtOrBefore(p, cols) {
    if (p <= 0) return 0;
    const s = _sectionStart(p);
    return p - ((p - s) % cols);
}

function _rowStartAtOrAfter(p, cols) {
    const r = _rowStartAtOrBefore(p, cols);
    if (r === p) return p;
    return Math.min(r + cols, _nextHeaderAfter(r), _order.length);
}

// First DOM element belonging to position p (its header if it has one,
// otherwise its tile). p must be within [_start, _end].
function _elementAt(p) {
    let idx = _spacer && _spacer.parentNode === _grid ? 1 : 0;
    idx += p - _start + _headersIn(_start, p);
    return _grid.children[idx] || null;
}

// All DOM elements for positions [a, b) (a, b within the window).
function _elementsIn(a, b) {
    const first = _elementAt(a);
    if (!first) return [];
    const count = b - a + _headersIn(a, b);
    const out = [];
    let el = first;
    for (let i = 0; i < count && el; i++) {
        out.push(el);
        el = el.nextElementSibling;
    }
    return out;
}

function _html(a, b) {
    let html = '';
    for (let p = a; p < b; p++) {
        const label = _headers.get(p);
        if (label) html += _renderHeader(label, p);
        html += _renderItem(_order[p]);
    }
    return html;
}

// Parse HTML into detached elements (keeps insertion a single DOM op).
// Whitespace text nodes are dropped so trims never leave strays behind.
function _fragment(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const nodes = Array.from(tpl.content.children);
    const frag = document.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    return { frag, nodes };
}

function _ensureSpacer() {
    if (_spacer && _spacer.parentNode === _grid) return _spacer;
    _spacer = document.createElement('div');
    _spacer.className = 'gallery-spacer';
    _spacer.setAttribute('aria-hidden', 'true');
    _spacer.style.cssText = 'grid-column: 1 / -1; width: 100%; height: 0; pointer-events: none;';
    _grid.prepend(_spacer);
    _observeSpacer();
    return _spacer;
}

function _removeSpacer() {
    if (_spacerObserver && _spacer) _spacerObserver.unobserve(_spacer);
    if (_spacer?.parentNode) _spacer.remove();
    _spacer = null;
}

function _observeSpacer() {
    if (!_spacerObserver) {
        _spacerObserver = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) _scheduleRestore();
                }
            },
            { root: _scroller, rootMargin: `${RESTORE_MARGIN_PX}px 0px`, threshold: 0 },
        );
    }
    _spacerObserver.observe(_spacer);
}

function _setOrder(order, headers) {
    _order = order;
    _headers = headers || new Map();
    _headerPos = Array.from(_headers.keys()).sort((a, b) => a - b);
}

// ---- public API -------------------------------------------------------

/**
 * Full render from the top. `order` = state.files indices in display
 * order, `headers` = Map(position → section label). Renders at most one
 * window's worth of positions; the rest is paged in on scroll.
 */
export function resetGalleryWindow(order, headers) {
    if (!_grid) return;
    _removeSpacer();
    _setOrder(order, headers);
    _start = 0;
    const cols = _visible() ? _columns() : 1;
    _end = Math.min(_order.length, _maxTiles(cols));
    const { frag, nodes } = _fragment(_html(0, _end));
    const old = Array.from(_grid.children);
    _grid.replaceChildren(frag);
    if (old.length) _onRemoved?.(old);
    _onInserted?.(nodes);
}

/**
 * Re-render after the list shrank in place (bulk delete, single delete
 * from the viewer) while keeping the scroll position: the window stays
 * where it was (clamped + row-aligned) and the spacer keeps its height.
 */
export function rerenderGalleryWindow(order, headers) {
    if (!_grid) return;
    if (_start === 0) {
        const keepEnd = Math.max(_end, 1);
        resetGalleryWindow(order, headers);
        if (_end < Math.min(keepEnd, _order.length)) extendBottom(keepEnd - _end);
        return;
    }
    _setOrder(order, headers);
    const cols = _visible() ? _columns() : 1;
    _start = _rowStartAtOrBefore(Math.min(_start, Math.max(0, _order.length - 1)), cols);
    _end = Math.min(_order.length, Math.max(_end, _start + _chunk(cols)));
    const spacer = _spacer;
    const { frag, nodes } = _fragment(_html(_start, _end));
    const old = Array.from(_grid.children).filter((el) => el !== spacer);
    _grid.replaceChildren(frag);
    if (spacer && _start > 0) _grid.prepend(spacer);
    else _removeSpacer();
    if (old.length) _onRemoved?.(old);
    _onInserted?.(nodes);
}

/** Append freshly fetched positions (state.files indices) to the list. */
export function appendPositions(indices) {
    if (!_grid || !indices.length) return;
    const wasAtEnd = _end === _order.length;
    for (const i of indices) _order.push(i);
    if (wasAtEnd) {
        const from = _end;
        _end = _order.length;
        const { frag, nodes } = _fragment(_html(from, _end));
        _grid.append(frag);
        _onInserted?.(nodes);
    }
    trimTop();
}

/** True when loaded positions below the window aren't in the DOM. */
export function hasPendingBelow() {
    return _end < _order.length;
}

/** Render the next chunk of already-loaded positions below the window. */
export function extendBottom(count) {
    if (!_grid || _end >= _order.length) return;
    const cols = _visible() ? _columns() : 1;
    const to = Math.min(_order.length, _end + (count || _chunk(cols)));
    const { frag, nodes } = _fragment(_html(_end, to));
    _grid.append(frag);
    _end = to;
    _onInserted?.(nodes);
    trimTop();
}

/** Drop whole rows from the top once the window exceeds its cap. */
export function trimTop() {
    if (!_visible()) return;
    const cols = _columns();
    const count = _end - _start;
    const max = _maxTiles(cols);
    if (count <= max) return;
    const cut = _rowStartAtOrAfter(_start + (count - max) + _trimBatch(cols), cols);
    if (cut <= _start || cut >= _end) return;
    const cutEl = _elementAt(cut);
    const firstEl = _elementAt(_start);
    if (!cutEl || !firstEl) return;
    const rootTop = _scroller.getBoundingClientRect().top;
    const cutTop = cutEl.getBoundingClientRect().top;
    // Everything removed must sit well above the viewport.
    if (cutTop > rootTop - KEEP_PX) return;
    const firstTop = firstEl.getBoundingClientRect().top;
    const hadSpacer = !!(_spacer && _spacer.parentNode === _grid);
    const oldH = hadSpacer ? parseFloat(_spacer.style.height) || 0 : 0;
    // [spacer H][gap][first … cut-1][gap][cut] → [spacer H'][gap][cut]
    const newH = hadSpacer ? oldH + (cutTop - firstTop) : cutTop - firstTop - _rowGap();
    const removed = _elementsIn(_start, cut);
    const spacer = _ensureSpacer();
    for (const el of removed) el.remove();
    spacer.style.height = `${Math.max(0, newH)}px`;
    _start = cut;
    _onRemoved?.(removed);
}

/** Drop whole rows far below the viewport (after scrolling back up). */
function _trimBottom() {
    const cols = _columns();
    const count = _end - _start;
    const max = _maxTiles(cols);
    if (count <= max) return;
    const cut = _rowStartAtOrAfter(_end - (count - max) - _trimBatch(cols), cols);
    if (cut <= _start || cut >= _end) return;
    const cutEl = _elementAt(cut);
    if (!cutEl) return;
    const rootBottom = _scroller.getBoundingClientRect().bottom;
    if (cutEl.getBoundingClientRect().top < rootBottom + KEEP_PX) return;
    const removed = _elementsIn(cut, _end);
    for (const el of removed) el.remove();
    _end = cut;
    _onRemoved?.(removed);
}

function _spacerNearViewport() {
    if (!_spacer || _spacer.parentNode !== _grid) return false;
    const rootTop = _scroller.getBoundingClientRect().top;
    return _spacer.getBoundingClientRect().bottom > rootTop - RESTORE_MARGIN_PX;
}

function _scheduleRestore() {
    if (_restoreScheduled) return;
    _restoreScheduled = true;
    requestAnimationFrame(() => {
        _restoreScheduled = false;
        _restoreTop();
    });
}

// Re-insert rows above the window while the spacer is near the viewport.
// Bounded per frame so a long fling doesn't block the main thread; the
// next frame continues if the spacer is still close.
function _restoreTop() {
    if (!_visible() || _start <= 0) return;
    let rounds = 0;
    while (_start > 0 && rounds < 4 && _spacerNearViewport()) {
        _prependChunk();
        _trimBottom();
        rounds++;
    }
    if (_start > 0 && _spacerNearViewport()) _scheduleRestore();
}

function _prependChunk() {
    const cols = _columns();
    const from = _rowStartAtOrBefore(Math.max(0, _start - _chunk(cols)), cols);
    const anchor = _elementAt(_start);
    if (!anchor) return;
    const before = anchor.getBoundingClientRect().top;
    const { frag, nodes } = _fragment(_html(from, _start));
    _spacer.after(frag);
    _start = from;
    const delta = anchor.getBoundingClientRect().top - before;
    const h = (parseFloat(_spacer.style.height) || 0) - delta;
    // Whole list back → drop the spacer (and its row gap). Otherwise shrink
    // it by what we inserted. If the spacer can't absorb it all (column
    // count changed since the trim) or we removed it, pin the anchor row
    // in place through scrollTop instead.
    if (_start === 0) _removeSpacer();
    else _spacer.style.height = `${Math.max(0, h)}px`;
    if (_start === 0 || h < 0) {
        const drift = anchor.getBoundingClientRect().top - before;
        if (Math.abs(drift) > 0.5) _scroller.scrollTop += drift;
    }
    _onInserted?.(nodes);
}

/**
 * A file was removed from `state.files` (index `fileIndex`). Drop its
 * position, shift every later index down by one, and patch the DOM.
 * Returns true when the gallery tracked that index.
 */
export function removeFileIndex(fileIndex) {
    const p = _order.indexOf(fileIndex);
    for (let i = 0; i < _order.length; i++) if (_order[i] > fileIndex) _order[i]--;
    if (_grid) {
        for (const el of _grid.querySelectorAll('.media-item[data-index]')) {
            const n = Number(el.dataset.index);
            if (n > fileIndex) el.dataset.index = String(n - 1);
        }
    }
    if (p < 0) return false;
    const inWindow = p >= _start && p < _end;
    const removed = inWindow ? _elementsIn(p, p + 1) : [];
    _order.splice(p, 1);
    // Shift header positions after p.
    const next = new Map();
    let dropHeaderAt = -1;
    for (const [pos, label] of _headers) {
        if (pos < p) next.set(pos, label);
        else if (pos === p) {
            // Header stays with the next tile unless that tile opens its
            // own section (or there is none) — then the section is empty.
            if (_headers.has(p + 1) || p >= _order.length) dropHeaderAt = p;
            else next.set(p, label);
        } else next.set(pos - 1, label);
    }
    // When the header survives, only the tile element leaves the DOM.
    const toRemove = dropHeaderAt === p ? removed : removed.filter((el) => !_isHeader(el));
    for (const el of toRemove) el.remove();
    _headers = next;
    _headerPos = Array.from(next.keys()).sort((a, b) => a - b);
    if (p < _start) {
        _start--;
        _end--;
    } else if (inWindow) {
        _end--;
    }
    if (toRemove.length) _onRemoved?.(toRemove);
    return true;
}

function _isHeader(el) {
    return !el.classList.contains('media-item');
}

/** Current window, for diagnostics / tests. */
export function getGalleryWindow() {
    return { start: _start, end: _end, length: _order.length };
}
