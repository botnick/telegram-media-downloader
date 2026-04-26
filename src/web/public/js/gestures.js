// Pointer-event helpers. The dashboard uses these for long-press selection
// in the gallery, pull-to-refresh on lists, and swipe between items in the
// viewer. Everything is built on the unified Pointer Events API so a mouse,
// touch, and pen all behave the same way without separate handlers.

const TAP_DISTANCE = 10;     // px — beyond this, a press is no longer a tap
const LONG_PRESS_MS = 500;   // ms — Telegram-typical long-press threshold

/**
 * Fire `onLongPress(target, event)` when the user holds a press for at least
 * 500 ms without moving more than ~10 px. Returns an unsubscribe function.
 *
 * The target can be a single element or a parent we delegate from; in the
 * latter case `selector` filters to children that match.
 */
export function attachLongPress(host, { selector, onLongPress }) {
    let timer = null;
    let startX = 0, startY = 0, target = null, pointerId = null;

    function clear() {
        if (timer) { clearTimeout(timer); timer = null; }
        target = null;
        pointerId = null;
    }
    function down(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const t = selector ? e.target.closest(selector) : host;
        if (!t || !host.contains(t)) return;
        target = t;
        pointerId = e.pointerId;
        startX = e.clientX; startY = e.clientY;
        timer = setTimeout(() => {
            if (!target) return;
            try { onLongPress(target, e); } catch (err) { console.error(err); }
            // Suppress the click that would otherwise fire after release.
            target.dataset.longPressFired = '1';
            timer = null;
        }, LONG_PRESS_MS);
    }
    function move(e) {
        if (!timer || e.pointerId !== pointerId) return;
        if (Math.hypot(e.clientX - startX, e.clientY - startY) > TAP_DISTANCE) clear();
    }
    function up(e) {
        if (e.pointerId !== pointerId) return;
        clear();
    }
    function suppressClick(e) {
        if (e.target?.dataset?.longPressFired === '1') {
            e.preventDefault(); e.stopPropagation();
            delete e.target.dataset.longPressFired;
        }
    }

    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
    host.addEventListener('click', suppressClick, true);

    return () => {
        host.removeEventListener('pointerdown', down);
        host.removeEventListener('pointermove', move);
        host.removeEventListener('pointerup', up);
        host.removeEventListener('pointercancel', up);
        host.removeEventListener('click', suppressClick, true);
        clear();
    };
}

/**
 * Pull-to-refresh on a scroll container. Drag down from `scrollTop=0` past
 * `threshold` px → call `onRefresh()` (returns a Promise; spinner shows
 * while it pends). The container needs `overscroll-behavior: contain` if
 * you want to defeat the iOS bounce.
 */
export function attachPullToRefresh(container, { onRefresh, threshold = 70 }) {
    if (!container) return () => {};
    let startY = 0;
    let dy = 0;
    let active = false;
    let pointerId = null;

    let indicator = container.querySelector(':scope > .ptr-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'ptr-indicator';
        indicator.style.cssText = 'position:sticky;top:0;display:flex;align-items:center;justify-content:center;height:0;overflow:hidden;color:var(--tg-textSecondary,#8B9BAA);font-size:13px;pointer-events:none;transition:height 120ms ease;';
        indicator.innerHTML = '<i class="ri-arrow-down-line"></i>&nbsp;Pull to refresh';
        container.insertBefore(indicator, container.firstChild);
    }

    function down(e) {
        if (container.scrollTop > 0) return;
        active = true;
        pointerId = e.pointerId;
        startY = e.clientY;
        dy = 0;
    }
    function move(e) {
        if (!active || e.pointerId !== pointerId) return;
        const d = e.clientY - startY;
        if (d <= 0) { active = false; indicator.style.height = '0'; return; }
        dy = Math.min(d, threshold * 1.5);
        indicator.style.height = `${Math.min(dy, threshold)}px`;
        indicator.firstChild.style.transform = dy > threshold ? 'rotate(180deg)' : 'rotate(0deg)';
        e.preventDefault();
    }
    function up(e) {
        if (!active || e.pointerId !== pointerId) return;
        active = false;
        if (dy > threshold) {
            indicator.innerHTML = '<i class="ri-loader-4-line ri-spin"></i>&nbsp;Refreshing…';
            indicator.style.height = '40px';
            Promise.resolve(onRefresh?.()).finally(() => {
                indicator.innerHTML = '<i class="ri-arrow-down-line"></i>&nbsp;Pull to refresh';
                indicator.style.height = '0';
            });
        } else {
            indicator.style.height = '0';
        }
        dy = 0;
    }

    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move, { passive: false });
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
    return () => {
        container.removeEventListener('pointerdown', down);
        container.removeEventListener('pointermove', move);
        container.removeEventListener('pointerup', up);
        container.removeEventListener('pointercancel', up);
    };
}

/**
 * Detect a left/right swipe on `el`. Calls `onSwipe('left'|'right', dx)`
 * once when the gesture ends past `threshold` px AND the horizontal
 * displacement dominates (≥ 1.5× the vertical).
 */
export function attachSwipe(el, { onSwipe, threshold = 60 }) {
    let startX = 0, startY = 0, pointerId = null, active = false;
    function down(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        active = true;
        pointerId = e.pointerId;
        startX = e.clientX; startY = e.clientY;
    }
    function up(e) {
        if (!active || e.pointerId !== pointerId) return;
        active = false;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5) {
            onSwipe(dx < 0 ? 'left' : 'right', dx);
        }
    }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
    };
}

/**
 * Vertical drag-to-dismiss. Drag down from inside `el` past `threshold` →
 * onDismiss(); release without crossing → snaps back. The element gets a
 * temporary translateY for visual feedback.
 */
export function attachDragDismiss(el, { onDismiss, threshold = 80 }) {
    let startY = 0, dy = 0, pointerId = null, active = false;
    function down(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        active = true;
        pointerId = e.pointerId;
        startY = e.clientY;
        dy = 0;
        el.style.transition = 'none';
    }
    function move(e) {
        if (!active || e.pointerId !== pointerId) return;
        dy = Math.max(0, e.clientY - startY);
        el.style.transform = `translateY(${dy}px)`;
    }
    function up(e) {
        if (!active || e.pointerId !== pointerId) return;
        active = false;
        el.style.transition = '';
        if (dy > threshold) {
            el.style.transform = 'translateY(100vh)';
            setTimeout(() => onDismiss?.(), 180);
        } else {
            el.style.transform = '';
        }
    }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
    };
}
