// Navigation model — four top-level places on every screen size:
//
//   Library   #/viewer, #/viewer/<chat>          (gallery, All Media or one chat)
//   Chats     #/groups, #/backfill               (chat list + Backfill tab)
//   Queue     #/queue, #/queue/<filter>
//   Settings  #/settings[/<section>], #/engine, and the Tools pages:
//             #/settings/tools/<group>[/<tool>]
//
// The desktop sidebar and the phone bottom nav both light up the place
// the page belongs to. Old hashes keep working: #/maintenance lands on
// the Tools card in Settings, #/maintenance/<tool> on the tool's group
// page (scrolled to its card).
//
// Also owns the small bits of shell chrome that follow the page: the
// Chats | Backfill tabs, the tool tab strip on a tool page, the Library
// link's target and the Settings scroll offset / section chips.

import { state } from './store.js';
import { navigate } from './router.js';
import { t as i18nT } from './i18n.js';
import { groupOfTool, getGroup, groupHref } from './tools-catalog.js';

// Page (renderPage name) → nav place (data-page / data-nav value).
const PLACE = {
    viewer: 'viewer',
    groups: 'groups',
    backfill: 'groups',
    queue: 'queue',
    settings: 'settings',
    engine: 'settings',
    maintenance: 'settings',
};

export function navPlace(page) {
    if (PLACE[page]) return PLACE[page];
    if (String(page).startsWith('maintenance-')) return 'settings';
    return page;
}

/**
 * Routes for the Tools pages and the old Maintenance hashes. Registered
 * before app.js's own routes so `/settings/tools/...` wins over the
 * generic `/settings/:section`.
 */
export function registerNavRoutes(router, renderPage) {
    router.route('/settings/tools/:group', ({ params, query }) => {
        const group = getGroup(params.group);
        if (!group) {
            // A tool slug in the group slot (#/settings/tools/thumbs) —
            // forgive it and open that tool's group.
            const g = groupOfTool(params.group);
            router.navigate(g ? `${groupHref(g)}?focus=${params.group}` : '#/settings/tools', {
                replace: true,
            });
            return;
        }
        renderPage('maintenance', { group: group.slug, focus: query.focus, navKey: 'settings' });
    });
    router.route('/settings/tools/:group/:tool', ({ params }) => {
        const g = groupOfTool(params.tool);
        if (!g) {
            router.navigate(groupHref(getGroup(params.group) ? params.group : 'library'), {
                replace: true,
            });
            return;
        }
        if (g !== params.group) {
            router.navigate(`${groupHref(g)}/${params.tool}`, { replace: true });
            return;
        }
        renderPage(`maintenance-${params.tool}`, { group: g, navKey: 'settings' });
    });
    router.route('/maintenance', () => router.navigate('#/settings/tools', { replace: true }));
    router.route('/maintenance/:tool', ({ params }) => {
        const g = groupOfTool(params.tool);
        router.navigate(g ? `${groupHref(g)}?focus=${params.tool}` : '#/settings/tools', {
            replace: true,
        });
    });
}

// ---------------------------------------------------------------- shell sync

function _syncChatsTabs(page) {
    const nav = document.getElementById('chats-tabs');
    if (!nav) return;
    for (const a of nav.querySelectorAll('[data-chats-tab]')) {
        if (a.dataset.chatsTab === page) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
}

// On a tool page the strip shows only that tool's group, with a back link
// to the group page.
function _syncToolStrip(page) {
    const strip = document.getElementById('maintenance-tabs');
    if (!strip || !String(page).startsWith('maintenance-')) return;
    const tool = page.slice('maintenance-'.length);
    const g = getGroup(groupOfTool(tool));
    if (!g) return;
    strip.dataset.group = g.slug;
    const back = strip.querySelector('.maintenance-tab-back');
    if (back) {
        const name = i18nT(g.title[0], g.title[1]);
        back.setAttribute('href', groupHref(g.slug));
        back.setAttribute('aria-label', name);
        back.setAttribute('title', name);
        const label = back.querySelector('.maintenance-tab-back-label');
        if (label) label.textContent = name;
    }
    strip.setAttribute('aria-label', i18nT(g.title[0], g.title[1]));
}

// The Library link goes back to the chat you had open when you're on
// another page; from inside the library it goes to All Media.
function _syncLibraryLinks(page) {
    const id = state.currentGroupId;
    const href =
        page !== 'viewer' && id != null ? `#/viewer/${encodeURIComponent(String(id))}` : '#/viewer';
    for (const a of document.querySelectorAll('a[data-library-link]')) a.setAttribute('href', href);
}

/** Called by renderPage() after the page is visible. */
export function syncShell(page) {
    _syncChatsTabs(page);
    _syncToolStrip(page);
    _syncLibraryLinks(page);
    if (page === 'settings') requestAnimationFrame(() => _toc?.spy());
}

// ------------------------------------------------------------- settings page

// The Settings page's sticky bar (search + section chips on phones; a side
// rail on desktop). Section jumps land just below it: the offset is the
// bar's real height, measured, instead of a guessed constant.
function _watchSettingsBar() {
    const page = document.getElementById('page-settings');
    const bar = page?.querySelector('.settings-top-bar');
    if (!page || !bar || typeof ResizeObserver !== 'function') return;
    const scroller = document.getElementById('content-area');
    const update = () => {
        if (page.classList.contains('hidden')) return;
        const cs = getComputedStyle(bar);
        // Desktop: the bar is the side rail, nothing sits above the cards.
        const onTop = cs.position === 'sticky' && cs.gridColumnStart !== '1';
        // Stuck, the bar's bottom sits at scroller padding + top + height
        // below the scrollport's edge (sticky insets start inside the padding).
        const top = Number.parseFloat(cs.top) || 0;
        const pad = scroller ? Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0 : 0;
        const h = onTop ? Math.max(0, Math.round(bar.offsetHeight + top + pad)) : 0;
        page.style.setProperty('--settings-sticky-h', `${h}px`);
    };
    new ResizeObserver(update).observe(bar);
    window.addEventListener('resize', update, { passive: true });
    update();
    _watchSettingsBar.update = update;
}

// Section chips / side table of contents: a click jumps (through the
// router, so #/settings/<section> is shareable), and the chip of the
// section at the top of the page lights up while scrolling.
let _toc = null;
function _wireSettingsToc() {
    const page = document.getElementById('page-settings');
    const nav = page?.querySelector('.settings-chip-nav');
    const scroller = document.getElementById('content-area');
    if (!nav || !scroller) return;
    const chips = Array.from(nav.querySelectorAll('.settings-chip'));
    const target = (c) => document.getElementById(`settings-${c.dataset.chip}`);
    const shown = (el) => !!el && el.getClientRects().length > 0;
    let lockUntil = 0;

    const select = (anchor) => {
        let active = null;
        for (const c of chips) {
            const on = c.dataset.chip === anchor;
            c.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on) active = c;
        }
        // Phones: keep the active chip in view in the sideways-scrolling row.
        if (active && nav.scrollWidth > nav.clientWidth + 1) {
            const n = nav.getBoundingClientRect();
            const r = active.getBoundingClientRect();
            if (r.left < n.left + 16)
                nav.scrollBy({ left: r.left - n.left - 16, behavior: 'smooth' });
            else if (r.right > n.right - 16)
                nav.scrollBy({ left: r.right - n.right + 16, behavior: 'smooth' });
        }
    };
    const spy = () => {
        if (page.classList.contains('hidden') || page.classList.contains('is-searching')) return;
        if (Date.now() < lockUntil) return;
        const visible = chips.filter((c) => shown(target(c)));
        if (!visible.length) return;
        const box = scroller.getBoundingClientRect();
        const offset = Number.parseFloat(page.style.getPropertyValue('--settings-sticky-h')) || 0;
        const line = box.top + offset + 32;
        let current = visible[0];
        for (const c of visible) if (target(c).getBoundingClientRect().top <= line) current = c;
        // At the very bottom the last sections can't reach the top line.
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
            for (const c of visible)
                if (target(c).getBoundingClientRect().top < box.bottom - 80) current = c;
        }
        select(current.dataset.chip);
    };
    let raf = 0;
    scroller.addEventListener(
        'scroll',
        () => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                spy();
            });
        },
        { passive: true },
    );
    for (const c of chips) {
        c.addEventListener('click', (e) => {
            e.preventDefault();
            navigate(`#/settings/${c.dataset.chip}`);
        });
    }
    _toc = {
        spy,
        select,
        hold(ms) {
            lockUntil = Date.now() + ms;
        },
    };
}

// Old section names that point at a card.
const SECTION_ALIAS = { engine: 'card-engine' };

/**
 * Scroll the Settings page to `section` (#settings-<section>, a
 * [data-settings-section] or a #setting-<id> field). Retries once after
 * the settings load so late layout shifts don't strand the jump.
 */
export function scrollToSettingsSection(rawSection, { smooth = true } = {}) {
    const section = SECTION_ALIAS[rawSection] || rawSection;
    const find = () =>
        document.getElementById(`settings-${section}`) ||
        document.querySelector(`[data-settings-section="${CSS.escape(section)}"]`) ||
        document.getElementById(`setting-${section}`);
    _watchSettingsBar.update?.();
    const el = find();
    if (!el) return false;
    // The chip follows the jump, not the sections scrolling past.
    _toc?.hold(smooth ? 900 : 700);
    _toc?.select(section);
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    if (!smooth) {
        // First visit: cards above fill in as settings load. Re-anchor.
        setTimeout(() => find()?.scrollIntoView({ behavior: 'auto', block: 'start' }), 450);
    }
    return true;
}

export function initNav() {
    _watchSettingsBar();
    _wireSettingsToc();
}
