// Page-transition helper. Mobile = horizontal slide. Desktop = cross-fade.
// Honours prefers-reduced-motion → no transition, instant swap.

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
const DESKTOP = window.matchMedia('(min-width: 768px)');
const DURATION_MS = 180;

function shouldAnimate() { return !REDUCED.matches; }

/**
 * Animate from `from` to `to` (both DOM elements). Either may be null when a
 * page is appearing/disappearing alone. Direction can be 'forward' (default)
 * or 'back'.
 */
export function transitionViews(from, to, direction = 'forward') {
    // Always make `to` visible first so we can animate it in. The caller
    // is responsible for `from.style.display = 'none'` after the promise.
    if (to) {
        to.classList.remove('hidden');
        if (!shouldAnimate()) return Promise.resolve();
    } else if (!shouldAnimate()) {
        return Promise.resolve();
    }

    const sign = direction === 'back' ? -1 : 1;
    const slide = !DESKTOP.matches; // mobile only
    const xPx = slide ? 24 : 0;
    const fromKeyframes = slide
        ? [{ transform: 'translate3d(0,0,0)', opacity: 1 }, { transform: `translate3d(${-sign * xPx}px,0,0)`, opacity: 0 }]
        : [{ opacity: 1 }, { opacity: 0 }];
    const toKeyframes = slide
        ? [{ transform: `translate3d(${sign * xPx}px,0,0)`, opacity: 0 }, { transform: 'translate3d(0,0,0)', opacity: 1 }]
        : [{ opacity: 0 }, { opacity: 1 }];

    const opts = { duration: DURATION_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' };
    const promises = [];
    if (from) promises.push(from.animate(fromKeyframes, opts).finished);
    if (to)   promises.push(to.animate(toKeyframes, opts).finished);
    return Promise.allSettled(promises).then(() => {});
}
