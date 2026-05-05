// Gallery selection — desktop-grade picker.
//
// Replaces the v2.3.0 click-each-tile-individually flow with the standard
// file-manager gestures every desktop user already knows:
//
//   - Plain click            → toggle (in select-mode) | open viewer (otherwise)
//   - Ctrl/Cmd + click       → toggle (auto-enables select-mode)
//   - Shift + click          → range-select from the last anchor to here
//   - Drag from empty space  → rubber-band lasso (any tile overlapping
//                              the rectangle joins the selection)
//   - Ctrl/Cmd + A           → select all visible (current filter)
//   - Esc                    → exit select-mode + clear selection
//
// All selection updates are IN-PLACE — toggling `.is-selected` on the
// matching `[data-path]` tile, no re-render of the whole grid. This is
// the only way the lasso stays smooth on a 1000-tile gallery.

import { state } from './store.js';

let _wired = false;
let _lastAnchorPath = null;       // last single-toggle target — pivot for shift+click ranges
let _hooks = {};                  // captured at setup; reused by selectAllVisible

function _autoEnableSelectMode() {
    if (state.selectMode) return;
    state.selectMode = true;
    const grid = document.getElementById('media-grid');
    if (grid) grid.classList.add('in-select-mode');
    const btn = document.getElementById('select-mode-btn');
    if (btn) btn.classList.add('bg-tg-blue', 'text-white');
}

/**
 * Wire up the gallery picker once at SPA boot. Idempotent — a second
 * call is a no-op so router re-mounts can't double-bind handlers.
 *
 * @param {Object} hooks
 * @param {() => void} hooks.onChange         called after any selection mutation
 * @param {(path:string) => void} hooks.openViewer  called for a plain click outside select-mode
 * @param {() => void} hooks.deleteSelected   called for the Delete key on a non-empty selection
 */
export function setupGallerySelect(hooks = {}) {
    if (_wired) return;
    const grid = document.getElementById('media-grid');
    const lasso = document.getElementById('gallery-lasso');
    if (!grid) return;
    _wired = true;
    _hooks = hooks;

    state.selected = state.selected || new Set();

    // ----- Click handler (single-tile toggle / range / open) ------------
    //
    // Bound here in CAPTURE phase so we run before any per-tile
    // delegation in app.js — this lets us correctly intercept Ctrl/Shift
    // clicks (which would otherwise fall through to "open viewer").
    grid.addEventListener('click', (ev) => {
        const tile = ev.target.closest('.media-item[data-path]');
        if (!tile) return;
        const path = tile.dataset.path;
        if (!path) return;

        // Buttons inside the tile (e.g. list-mode "open" eye icon)
        // bubble up here too — handle them as plain open clicks even in
        // select mode so the user can still preview without exiting.
        const onActionBtn = !!ev.target.closest('[data-tile-open]');

        const isToggleMod = (ev.ctrlKey || ev.metaKey);
        const isRangeMod  = ev.shiftKey;

        if (isRangeMod && _lastAnchorPath && _lastAnchorPath !== path) {
            ev.preventDefault();
            ev.stopPropagation();
            _autoEnableSelectMode();
            _selectRange(_lastAnchorPath, path);
            hooks.onChange?.();
            return;
        }
        if (isToggleMod) {
            ev.preventDefault();
            ev.stopPropagation();
            _autoEnableSelectMode();
            _toggleOne(path, tile);
            _lastAnchorPath = path;
            hooks.onChange?.();
            return;
        }
        if (state.selectMode && !onActionBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            _toggleOne(path, tile);
            _lastAnchorPath = path;
            hooks.onChange?.();
            return;
        }
        // Else: fall through to app.js's existing open-viewer click handler.
    }, true);

    // ----- Drag-to-select lasso ----------------------------------------
    //
    // Three gesture sources, all routed through the same pointer-event
    // pipeline so the math stays in one place:
    //
    //   - Desktop / pen: mousedown anywhere on the grid → drag = lasso.
    //   - iOS-style: two-finger drag → lasso. Native iOS Photos uses
    //     this; one-finger drag is reserved for scroll.
    //   - Android-style: long-press on a tile → enter select mode +
    //     toggle; **drag the finger after** the long-press → continue
    //     toggling tiles the finger passes over (material pattern).
    //     Honored when select-mode is already active.
    //
    // Pinch-zoom must NOT trigger selection, so we ignore the first
    // touch when a SECOND touch lands quickly afterwards (handled by
    // the touch-id tracker below).
    let drag = null;     // { startX, startY, additive, baseSelection, tileRects }
    const DRAG_THRESHOLD = 5;   // px — distance before we treat as lasso
    const LONG_PRESS_MS = 500;  // standard mobile long-press duration
    const _activeTouchIds = new Set();   // tracks concurrent touch fingers
    let _longPressTimer = 0;
    let _longPressTile = null;
    let _longPressStartX = 0;
    let _longPressStartY = 0;

    function _cancelLongPress() {
        if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = 0; }
        _longPressTile = null;
    }

    grid.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;

        // --- Touch: enter the activeTouchIds tracker so we know if a
        // pinch is happening. Touch select model:
        //
        //   - One-finger tap on tile (no movement)        → toggle (in select-mode)
        //                                                   or open viewer (otherwise) — handled by click
        //   - One-finger long-press (~500ms hold)         → enter select-mode + toggle
        //   - One-finger drag AFTER a long-press fired    → continue-select (Android material)
        //   - Two-finger drag                             → lasso (iOS Photos pattern)
        //   - One-finger drag without long-press          → page scroll (do nothing here)
        //
        // Pinch-zoom is filtered: a second finger landing
        // CANCELS the in-progress long-press (so a pinch-to-zoom never
        // accidentally triggers select).
        if (ev.pointerType === 'touch') {
            _activeTouchIds.add(ev.pointerId);
            const insideButton = ev.target.closest('button, a, input, [data-tile-open]');
            if (insideButton) { _cancelLongPress(); return; }

            // Second finger landed — pinch / two-finger lasso. Cancel
            // the long-press timer the first finger started so we don't
            // also enter select-mode mid-pinch.
            const isTwoFinger = _activeTouchIds.size >= 2;
            if (isTwoFinger) {
                _cancelLongPress();
                drag = {
                    startX: ev.clientX, startY: ev.clientY,
                    curX: ev.clientX, curY: ev.clientY,
                    additive: true,
                    baseSelection: new Set(state.selected),
                    tileRects: null, moved: false,
                    pointerId: ev.pointerId, continueMode: false,
                };
                return;
            }

            // First finger on a tile — start long-press timer. Cleared
            // by pointermove (above DRAG_THRESHOLD) or pointerup.
            const tile = ev.target.closest('.media-item[data-path]');
            if (tile) {
                _longPressTile = tile;
                _longPressStartX = ev.clientX;
                _longPressStartY = ev.clientY;
                _cancelLongPress();
                _longPressTimer = setTimeout(() => {
                    _longPressTimer = 0;
                    if (!_longPressTile) return;
                    // Promote: enter select-mode, toggle this tile, and
                    // arm continue-select drag so subsequent finger
                    // movement keeps adding tiles.
                    _autoEnableSelectMode();
                    const path = _longPressTile.dataset.path;
                    state.selected = state.selected || new Set();
                    state.selected.add(path);
                    _longPressTile.classList.add('is-selected');
                    _lastAnchorPath = path;
                    hooks.onChange?.();
                    // Haptic feedback when supported (Chrome on Android).
                    if (navigator.vibrate) try { navigator.vibrate(10); } catch {}
                    // Arm continue-select for the remaining finger gesture.
                    drag = {
                        startX: _longPressStartX, startY: _longPressStartY,
                        curX: _longPressStartX, curY: _longPressStartY,
                        additive: true,
                        baseSelection: new Set(state.selected),
                        tileRects: null, moved: true,    // skip threshold (already pressed)
                        pointerId: ev.pointerId,
                        continueMode: true,
                    };
                    // Cache rects for the continue-select hit-test.
                    drag.tileRects = [];
                    grid.querySelectorAll('.media-item[data-path]').forEach(t => {
                        drag.tileRects.push({ el: t, path: t.dataset.path, rect: t.getBoundingClientRect() });
                    });
                    grid.classList.add('lasso-active');
                }, LONG_PRESS_MS);
            }
            return;
        }

        // --- Mouse / pen path (desktop) ---
        // Only start a lasso when the press lands on grid empty space OR
        // on a tile that the user actually wants to drag-select. The
        // common shared-CSS-grid layout has very little empty space, so
        // we allow tile-pointerdown too BUT we suppress the eventual
        // click if the pointer moved past the threshold.
        const target = ev.target;
        if (target.closest('button, a, input, [data-tile-open]')) return;

        drag = {
            startX: ev.clientX,
            startY: ev.clientY,
            curX: ev.clientX,
            curY: ev.clientY,
            // Modifier semantics on drag-start match click semantics:
            //   plain     → replace selection
            //   ctrl/meta → add to selection
            //   shift     → add to selection (no range — range needs an anchor click)
            additive: ev.ctrlKey || ev.metaKey || ev.shiftKey,
            // Snapshot original selection so an ADDITIVE drag can XOR
            // back to it as the rectangle shrinks.
            baseSelection: new Set(state.selected),
            // Cache every rendered tile's rect once. Lasso lifetime is
            // short; if the user scrolls during the drag the cached
            // positions go stale — acceptable trade-off vs O(N) per
            // pointermove call to getBoundingClientRect.
            tileRects: null,
            moved: false,
            pointerId: ev.pointerId,
            continueMode: false,
        };
    }, { passive: true });

    window.addEventListener('pointermove', (ev) => {
        // Cancel a pending long-press if the finger drifted before the
        // timer fired — the user is scrolling, not long-pressing.
        if (_longPressTimer && ev.pointerType === 'touch') {
            const dx = ev.clientX - _longPressStartX;
            const dy = ev.clientY - _longPressStartY;
            if (Math.hypot(dx, dy) > 10) _cancelLongPress();
        }
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        const dist = Math.hypot(dx, dy);
        if (!drag.moved && dist < DRAG_THRESHOLD) return;

        if (!drag.moved) {
            // First movement past threshold — capture pointer + cache rects.
            drag.moved = true;
            try { grid.setPointerCapture?.(drag.pointerId); } catch {}
            grid.classList.add('lasso-active');
            // Cache rect of every rendered tile (current filter window).
            drag.tileRects = [];
            const tiles = grid.querySelectorAll('.media-item[data-path]');
            for (const t of tiles) {
                const r = t.getBoundingClientRect();
                drag.tileRects.push({ el: t, path: t.dataset.path, rect: r });
            }
        }
        drag.curX = ev.clientX;
        drag.curY = ev.clientY;

        // Continue-select mode (Android material long-press-then-drag):
        // walk the finger across tiles and toggle each one ONCE the
        // first time it's crossed. No rectangle — selection is sticky.
        if (drag.continueMode) {
            // Find the tile under the current pointer position.
            for (const { el, path, rect } of drag.tileRects) {
                if (drag.curX >= rect.left && drag.curX <= rect.right
                    && drag.curY >= rect.top && drag.curY <= rect.bottom) {
                    if (!el.classList.contains('is-selected')) {
                        state.selected.add(path);
                        el.classList.add('is-selected');
                        hooks.onChange?.();
                    }
                    break;
                }
            }
            return;
        }

        // Position the lasso rectangle (viewport-fixed coords).
        const left   = Math.min(drag.startX, drag.curX);
        const top    = Math.min(drag.startY, drag.curY);
        const width  = Math.abs(drag.curX - drag.startX);
        const height = Math.abs(drag.curY - drag.startY);
        if (lasso) {
            lasso.style.left = left + 'px';
            lasso.style.top = top + 'px';
            lasso.style.width = width + 'px';
            lasso.style.height = height + 'px';
            lasso.classList.add('visible');
        }

        // Live highlight tiles overlapping the rectangle. We mark them
        // with `.is-marquee` (dashed outline) — the actual selection
        // commit happens on pointerup so user can still escape with Esc.
        const lassoRect = { left, top, right: left + width, bottom: top + height };
        for (const { el, rect } of drag.tileRects) {
            const overlap = !(rect.right < lassoRect.left
                || rect.left > lassoRect.right
                || rect.bottom < lassoRect.top
                || rect.top > lassoRect.bottom);
            el.classList.toggle('is-marquee', overlap);
        }
    });

    const finishDrag = (commit) => {
        if (!drag) return;
        const wasMoved = drag.moved;
        const wasContinue = drag.continueMode;
        if (lasso) {
            lasso.classList.remove('visible');
            lasso.style.width = '0';
            lasso.style.height = '0';
        }
        grid.classList.remove('lasso-active');
        if (wasMoved && commit && !wasContinue) {
            _autoEnableSelectMode();
            // additive=false → replace; additive=true → union with base.
            const baseSel = drag.additive ? new Set(drag.baseSelection) : new Set();
            for (const { el, path } of drag.tileRects) {
                if (el.classList.contains('is-marquee')) baseSel.add(path);
            }
            state.selected = baseSel;
            // Repaint .is-selected on every cached tile (cheap — only
            // the rendered window).
            for (const { el, path } of drag.tileRects) {
                el.classList.toggle('is-selected', state.selected.has(path));
                el.classList.remove('is-marquee');
            }
            hooks.onChange?.();
        } else if (drag.tileRects && !wasContinue) {
            // Cancelled / sub-threshold drag — clear marquee highlights.
            for (const { el } of drag.tileRects) el.classList.remove('is-marquee');
        }
        // Continue-mode already updated each tile in pointermove; nothing
        // to commit here.
        try { grid.releasePointerCapture?.(drag.pointerId); } catch {}
        const wasReal = wasMoved;
        drag = null;
        // Suppress the trailing click after a real drag so it doesn't
        // toggle the tile we released over.
        if (wasReal) {
            const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
            window.addEventListener('click', swallow, { capture: true, once: true });
        }
    };
    window.addEventListener('pointerup', (ev) => {
        // Touch finger lifted — drop from the active-touches tracker.
        if (ev.pointerType === 'touch') _activeTouchIds.delete(ev.pointerId);
        _cancelLongPress();
        finishDrag(true);
    });
    window.addEventListener('pointercancel', (ev) => {
        if (ev.pointerType === 'touch') _activeTouchIds.delete(ev.pointerId);
        _cancelLongPress();
        finishDrag(false);
    });

    // ----- Keyboard shortcuts ------------------------------------------
    //
    // Fired on document so they work even when no input is focused — the
    // common case for "I'm browsing the gallery and want to select all".
    document.addEventListener('keydown', (ev) => {
        // Don't hijack typing in inputs / textareas / contenteditable.
        const tag = (ev.target?.tagName || '').toLowerCase();
        const inField = tag === 'input' || tag === 'textarea' || ev.target?.isContentEditable;
        if (inField) return;

        // Ctrl/Cmd + A — select all currently rendered tiles.
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
            // Only when the gallery is visible — the SPA shows multiple pages.
            if (state.currentPage !== 'viewer') return;
            ev.preventDefault();
            selectAllVisible();
            return;
        }

        // Esc — exit select mode + clear.
        if (ev.key === 'Escape' && state.selectMode) {
            ev.preventDefault();
            exitSelectMode();
            hooks.onChange?.();
            return;
        }

        // Delete / Backspace — trigger bulk delete on a non-empty selection.
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selectMode
            && state.selected && state.selected.size > 0) {
            ev.preventDefault();
            hooks.deleteSelected?.();
        }
    });

    // ----- Helpers ------------------------------------------------------
    // (moved to module scope so exported helpers like selectAllVisible can
    // reuse them without recapturing the setup closure.)

    function _toggleOne(path, tile) {
        if (!state.selected) state.selected = new Set();
        if (state.selected.has(path)) {
            state.selected.delete(path);
            tile.classList.remove('is-selected');
        } else {
            state.selected.add(path);
            tile.classList.add('is-selected');
        }
    }

    function _selectRange(fromPath, toPath) {
        const tiles = Array.from(grid.querySelectorAll('.media-item[data-path]'));
        const fromIdx = tiles.findIndex(t => t.dataset.path === fromPath);
        const toIdx   = tiles.findIndex(t => t.dataset.path === toPath);
        if (fromIdx === -1 || toIdx === -1) return;
        const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        if (!state.selected) state.selected = new Set();
        for (let i = lo; i <= hi; i++) {
            const t = tiles[i];
            state.selected.add(t.dataset.path);
            t.classList.add('is-selected');
        }
    }
}

/** Exit select mode + clear selection + repaint visible tiles. */
export function exitSelectMode() {
    state.selectMode = false;
    state.selected = new Set();
    _lastAnchorPath = null;
    const grid = document.getElementById('media-grid');
    if (grid) {
        grid.classList.remove('in-select-mode');
        grid.querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
        grid.querySelectorAll('.is-marquee').forEach(el => el.classList.remove('is-marquee'));
    }
    const btn = document.getElementById('select-mode-btn');
    if (btn) btn.classList.remove('bg-tg-blue', 'text-white');
}

/**
 * Select every currently-rendered tile in the gallery grid. Auto-enables
 * select-mode if it isn't on. Idempotent: calling twice with no changes
 * to the rendered set leaves the selection identical.
 *
 * Exposed so the selection-bar "Select all" button + the Ctrl/Cmd+A
 * shortcut share one implementation.
 */
export function selectAllVisible() {
    const grid = document.getElementById('media-grid');
    if (!grid) return;
    _autoEnableSelectMode();
    const tiles = grid.querySelectorAll('.media-item[data-path]');
    state.selected = new Set();
    for (const t of tiles) {
        state.selected.add(t.dataset.path);
        t.classList.add('is-selected');
    }
    _hooks.onChange?.();
}

/** Update tile DOM `.is-selected` for every visible tile from `state.selected`. */
export function repaintSelection() {
    const grid = document.getElementById('media-grid');
    if (!grid) return;
    const sel = state.selected || new Set();
    grid.querySelectorAll('.media-item[data-path]').forEach(el => {
        el.classList.toggle('is-selected', sel.has(el.dataset.path));
    });
    grid.classList.toggle('in-select-mode', !!state.selectMode);
}
