// Global keyboard shortcuts. Press `?` to open the cheatsheet, `Esc` closes
// any open sheet (sheet.js handles that for us). Listener is no-op while
// focus is in an input / textarea / contenteditable so search and form
// fields stay usable.

import { openSheet, closeTopSheet, sheetCount } from './sheet.js';

const SHORTCUTS = [
    { keys: '?',          description: 'Open this shortcuts cheatsheet' },
    { keys: 'Esc',        description: 'Close any modal / sheet / drawer' },
    { keys: 'g v',        description: 'Go to Library' },
    { keys: 'g g',        description: 'Go to Chats' },
    { keys: 'g e',        description: 'Go to Engine' },
    { keys: 'g s',        description: 'Go to Settings' },
    { keys: '/',          description: 'Focus the gallery search box' },
    { keys: 'l',          description: 'Open the "paste t.me link" drawer' },
    { keys: 's',          description: 'Toggle gallery selection mode' },
    { keys: 'Enter',      description: '(in viewer) play / pause video' },
    { keys: '← / →',      description: '(in viewer) previous / next item' },
    { keys: 'f',          description: '(in viewer) toggle fullscreen' },
];

let lastG = 0; // chord buffer

function buildContent() {
    const wrap = document.createElement('ul');
    wrap.className = 'space-y-1.5 text-sm';
    wrap.innerHTML = SHORTCUTS.map(s => `
        <li class="flex items-center justify-between">
            <span class="text-tg-textSecondary">${s.description}</span>
            <kbd class="px-1.5 py-0.5 text-xs rounded bg-tg-bg/60 border border-tg-border font-mono">${s.keys}</kbd>
        </li>
    `).join('') +
    `<li class="text-[11px] text-tg-textSecondary pt-2 border-t border-tg-border mt-2">Tip — none of these fire while you're typing in a text field.</li>`;
    return wrap;
}

function show() {
    if (sheetCount() > 0 && document.querySelector('.sheet-root[data-shortcuts]')) return;
    const handle = openSheet({
        title: 'Keyboard shortcuts',
        content: buildContent(),
        size: 'sm',
    });
    handle.root.setAttribute('data-shortcuts', '1');
}

function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function dispatchG(letter) {
    const map = { v: 'viewer', g: 'groups', e: 'engine', s: 'settings' };
    const target = map[letter];
    if (target && typeof window.navigateTo === 'function') window.navigateTo(target);
}

export function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (isTyping(e)) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
            e.preventDefault();
            show();
            return;
        }
        if (e.key === '/') {
            const search = document.getElementById('media-search');
            if (search) { e.preventDefault(); search.focus(); }
            return;
        }
        if (e.key === 'l' || e.key === 'L') {
            document.getElementById('paste-url-btn')?.click();
            return;
        }
        if (e.key === 's' || e.key === 'S') {
            document.getElementById('select-mode-btn')?.click();
            return;
        }
        if (e.key === 'g' || e.key === 'G') {
            lastG = Date.now();
            return;
        }
        if (Date.now() - lastG < 800 && /^[a-z]$/i.test(e.key)) {
            lastG = 0;
            dispatchG(e.key.toLowerCase());
        }
    });
}
