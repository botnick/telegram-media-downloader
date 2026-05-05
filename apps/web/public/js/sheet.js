// Bottom-sheet primitive that doubles as a desktop centered modal.
//
// On viewports < 768 px (the dashboard's md breakpoint) the sheet slides up
// from the bottom, includes a drag handle, and can be dismissed by swiping
// down. On wider viewports it renders as a centered card. Either way it
// traps focus, listens for Esc, and returns a close() handle.
//
//   const handle = openSheet({
//       title: 'Group settings',
//       content: 'string-or-Element',
//       size: 'sm' | 'md' | 'lg' | 'fit',  // desktop card width
//       onClose: () => {...},
//   });
//   handle.close();

import { t as i18nT } from './i18n.js';

const FOCUSABLE_SELECTOR = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
const DESKTOP = window.matchMedia('(min-width: 768px)');

const stack = []; // { root, opts, returnFocus }

function trapFocus(root) {
    function onKeydown(e) {
        if (e.key !== 'Tab') return;
        const focusables = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))
            .filter(el => !el.hasAttribute('inert'));
        if (focusables.length === 0) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    root.addEventListener('keydown', onKeydown);
    return () => root.removeEventListener('keydown', onKeydown);
}

function attachDragToDismiss(card, handleEl, onDismiss) {
    if (!DESKTOP.matches === false) return () => {};   // desktop → no-op
    if (REDUCED.matches) return () => {};

    let startY = 0;
    let dy = 0;
    let dragging = false;
    let pointerId = null;

    const onDown = (e) => {
        // Only respond to taps on the drag handle (or the title bar) so users
        // can still scroll the sheet content with their finger anywhere else.
        if (e.target !== handleEl && !handleEl.contains(e.target)) return;
        dragging = true;
        pointerId = e.pointerId;
        startY = e.clientY;
        dy = 0;
        card.style.transition = 'none';
        card.setPointerCapture(pointerId);
    };
    const onMove = (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        dy = Math.max(0, e.clientY - startY);
        card.style.transform = `translateY(${dy}px)`;
    };
    const onUp = (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        dragging = false;
        card.style.transition = '';
        if (dy > 80) {
            // Animate the rest of the way down, then dismiss.
            card.style.transform = 'translateY(100%)';
            setTimeout(onDismiss, 180);
        } else {
            card.style.transform = '';
        }
    };
    handleEl.addEventListener('pointerdown', onDown);
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
    return () => {
        handleEl.removeEventListener('pointerdown', onDown);
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerup', onUp);
        card.removeEventListener('pointercancel', onUp);
    };
}

export function openSheet(opts) {
    const { title = '', content = '', size = 'md', onClose, dismissible = true } = opts || {};

    const root = document.createElement('div');
    root.className = 'sheet-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    if (title) root.setAttribute('aria-label', title);
    root.tabIndex = -1;

    const widthByDesktopSize = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', fit: 'max-w-fit' };
    const dw = widthByDesktopSize[size] || widthByDesktopSize.md;
    root.innerHTML = `
        <div class="sheet-backdrop"></div>
        <div class="sheet-card ${dw}" tabindex="-1">
            ${title ? `
                <div class="sheet-header">
                    <span class="sheet-handle" aria-hidden="true"></span>
                    <h3 class="sheet-title">${escapeHtml(title)}</h3>
                    <button class="sheet-close" aria-label="${escapeHtml(i18nT('common.close', 'Close'))}">&times;</button>
                </div>
            ` : `<span class="sheet-handle" aria-hidden="true"></span>`}
            <div class="sheet-body"></div>
        </div>`;
    const card = root.querySelector('.sheet-card');
    const body = root.querySelector('.sheet-body');
    const handleEl = root.querySelector('.sheet-handle');
    const closeBtn = root.querySelector('.sheet-close');

    if (typeof content === 'string') body.innerHTML = content;
    else if (content) body.appendChild(content);

    document.body.appendChild(root);

    // Lock body scroll while a sheet is open.
    if (stack.length === 0) {
        document.body.style.overflow = 'hidden';
        document.body.dataset.sheetOpen = '1';
    }

    // Animate in.
    requestAnimationFrame(() => root.classList.add('sheet-open'));

    const returnFocus = document.activeElement;
    setTimeout(() => {
        const first = card.querySelector(FOCUSABLE_SELECTOR);
        if (first) first.focus(); else card.focus();
    }, 50);

    const releaseTrap = trapFocus(root);
    const releaseDrag = dismissible ? attachDragToDismiss(card, handleEl, close) : () => {};

    function onBackdropClick(e) {
        // Only the topmost sheet responds to its own backdrop. Without
        // this, a stacked Sheet B's backdrop click could fall through and
        // close the underlying Sheet A instead.
        if (stack[stack.length - 1]?.root !== root) return;
        if (e.target === root || e.target.classList.contains('sheet-backdrop')) close();
    }
    function onEsc(e) {
        if (e.key !== 'Escape') return;
        // Only close the topmost sheet, and let the event continue if we're
        // not the active one.
        if (stack[stack.length - 1]?.root !== root) return;
        e.stopPropagation();
        close();
    }
    // Non-dismissible sheets *must* provide their own close button (e.g. an
    // OK/Cancel inside the content) — Esc + backdrop click intentionally
    // do nothing. `closeBtn` is always wired below so the × in the header
    // works regardless.
    if (dismissible) {
        root.addEventListener('click', onBackdropClick);
        document.addEventListener('keydown', onEsc, true);
    }
    closeBtn?.addEventListener('click', close);

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        releaseTrap();
        releaseDrag();
        root.removeEventListener('click', onBackdropClick);
        document.removeEventListener('keydown', onEsc, true);
        root.classList.remove('sheet-open');
        const after = () => {
            root.remove();
            const idx = stack.findIndex(s => s.root === root);
            if (idx >= 0) stack.splice(idx, 1);
            if (stack.length === 0) {
                document.body.style.overflow = '';
                delete document.body.dataset.sheetOpen;
            }
            try { returnFocus?.focus?.(); } catch {}
            try { onClose?.(); } catch {}
        };
        if (REDUCED.matches) after();
        else setTimeout(after, 220);
    }

    const entry = { root, opts, returnFocus, body, close };
    stack.push(entry);
    return entry;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** Close the topmost open sheet, if any. */
export function closeTopSheet() {
    const top = stack[stack.length - 1];
    if (top) top.close();
}

export function sheetCount() { return stack.length; }

/**
 * Themed prompt dialog — async drop-in replacement for `window.prompt()`.
 * Resolves to the entered string on confirm, `null` on cancel/dismiss.
 *
 *   const pw = await promptSheet({
 *       title: 'Confirm', message: 'Re-enter your password',
 *       inputType: 'password',
 *   });
 *   if (pw == null) return;  // user cancelled
 */
export function promptSheet(opts = {}) {
    const {
        title = i18nT('common.confirm', 'Confirm'),
        message = '',
        inputType = 'text',
        placeholder = '',
        confirmLabel = i18nT('common.confirm', 'Confirm'),
        cancelLabel = i18nT('common.cancel', 'Cancel'),
        defaultValue = '',
    } = opts;

    return new Promise((resolve) => {
        let decided = false;
        const settle = (value) => { if (decided) return; decided = true; resolve(value); };

        const escMsg = String(message).split('\n').map(l => escapeHtml(l)).join('<br>');

        const sheet = openSheet({
            title,
            size: 'sm',
            content: `
                ${escMsg ? `<div class="text-tg-text text-sm leading-relaxed mb-3">${escMsg}</div>` : ''}
                <input data-prompt-input type="${escapeHtml(inputType)}"
                       autocomplete="${inputType === 'password' ? 'current-password' : 'off'}"
                       placeholder="${escapeHtml(placeholder)}"
                       value="${escapeHtml(defaultValue)}"
                       class="tg-input w-full text-sm" />
                <div class="flex items-center justify-end gap-2 mt-4">
                    <button data-prompt-cancel class="px-4 py-2 rounded-lg text-tg-textSecondary hover:bg-tg-hover transition text-sm">${escapeHtml(cancelLabel)}</button>
                    <button data-prompt-ok class="px-4 py-2 rounded-lg bg-tg-blue text-white hover:bg-opacity-90 font-medium text-sm transition">${escapeHtml(confirmLabel)}</button>
                </div>`,
            onClose: () => settle(null),
        });

        setTimeout(() => {
            const root = stack[stack.length - 1]?.root;
            if (!root) { settle(null); return; }
            const input = root.querySelector('[data-prompt-input]');
            const ok = root.querySelector('[data-prompt-ok]');
            const cancel = root.querySelector('[data-prompt-cancel]');
            cancel?.addEventListener('click', () => sheet.close());
            const submit = () => { settle(input?.value ?? ''); sheet.close(); };
            ok?.addEventListener('click', submit);
            input?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
            });
            input?.focus();
            input?.select?.();
        }, 60);
    });
}

/**
 * Themed confirm dialog — drop-in async replacement for native `confirm()`.
 * Resolves to `true` if the user clicks the confirm button, `false` if they
 * dismiss (Esc, backdrop click, Cancel button, or close-button).
 *
 *   if (!(await confirmSheet({ title: 'Delete?', message: '…' }))) return;
 *
 * Uses the same sheet primitive as every other modal, so styling, focus
 * trap, drag-to-dismiss, and a11y all come for free. `danger: true` paints
 * the confirm button in the destructive red palette.
 */
export function confirmSheet(opts = {}) {
    // Tolerate both naming conventions used across the codebase:
    //   - { message, confirmLabel, cancelLabel, danger }   (original)
    //   - { body,    confirmText,  cancelText,  destructive } (newer)
    // Without this, callers passing the modern field names got an empty
    // body + default Confirm label.
    const title = opts.title ?? i18nT('common.confirm', 'Confirm');
    const message = opts.message ?? opts.body ?? '';
    const confirmLabel = opts.confirmLabel ?? opts.confirmText ?? i18nT('common.confirm', 'Confirm');
    const cancelLabel  = opts.cancelLabel  ?? opts.cancelText  ?? i18nT('common.cancel', 'Cancel');
    const danger = opts.danger === true || opts.destructive === true;

    return new Promise((resolve) => {
        let decided = false;
        const settle = (value) => { if (decided) return; decided = true; resolve(value); };

        const confirmCls = danger
            ? 'px-4 py-2 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 font-medium text-sm transition'
            : 'px-4 py-2 rounded-lg bg-tg-blue text-white hover:bg-opacity-90 font-medium text-sm transition';

        const escMsg = String(message).split('\n').map(line => escapeHtml(line)).join('<br>');

        const sheet = openSheet({
            title,
            size: 'sm',
            content: `
                <div class="text-tg-text text-sm leading-relaxed">${escMsg || ''}</div>
                <div class="flex items-center justify-end gap-2 mt-5">
                    <button data-confirm-cancel class="px-4 py-2 rounded-lg text-tg-textSecondary hover:bg-tg-hover transition text-sm">${escapeHtml(cancelLabel)}</button>
                    <button data-confirm-ok class="${confirmCls}">${escapeHtml(confirmLabel)}</button>
                </div>`,
            onClose: () => settle(false),
        });

        // Wire the per-button handlers after the sheet's DOM is in place.
        setTimeout(() => {
            const root = stack[stack.length - 1]?.root;
            if (!root) { settle(false); return; }
            root.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => sheet.close());
            const ok = root.querySelector('[data-confirm-ok]');
            if (ok) {
                ok.addEventListener('click', () => { settle(true); sheet.close(); });
                // Make Enter on the dialog confirm — natural follow-on from
                // typing in the previous input or hitting the action.
                root.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.target.matches('textarea')) {
                        e.preventDefault();
                        settle(true);
                        sheet.close();
                    }
                });
                ok.focus();
            }
        }, 60);
    });
}
