// Settings search — the box above the section chips. Typing hides the
// cards that don't match, highlights the matching labels, opens the
// Advanced panel when a hit is inside it, and lists matching tools that
// live elsewhere (Tools, Backfill, Queue, …) as shortcuts. Enter
// jumps to the first hit. Matches both the current language and English,
// so "proxy" finds พร็อกซี on a Thai dashboard and vice versa.

import { t as i18nT, tf as i18nTf, getLang, onLanguageChange } from './i18n.js';
import { escapeHtml } from './utils.js';

const MISS = 'settings-search-miss';
const HIT = 'settings-search-hit';
const DEBOUNCE_MS = 120;

// Tools that live on other pages, so a settings search for "backup" or
// "duplicates" still leads somewhere. [route, name key, name, keywords key, keywords]
const ELSEWHERE = [
    [
        '#/settings/tools/library/duplicates',
        'nav.maintenance.duplicates',
        'Duplicates',
        'maintenance.duplicates.subtitle',
        'Hash every file and reclaim space from byte-identical copies',
    ],
    [
        '#/settings/tools/library/thumbs',
        'nav.maintenance.thumbs',
        'Thumbnails',
        'maintenance.thumbs.subtitle',
        'Generate WebP previews for older files',
    ],
    [
        '#/settings/tools/library/seekbar',
        'nav.maintenance.seekbar',
        'Seekbar previews',
        'maintenance.seekbar.subtitle',
        'Generate WebP sprite sheets for video hover-preview thumbnails.',
    ],
    [
        '#/settings/tools/library/video',
        'tools.video',
        'Video faststart',
        'maintenance.video.subtitle',
        'faststart streaming optimise',
    ],
    [
        '#/settings/tools/safety/nsfw',
        'nav.maintenance.nsfw',
        'NSFW',
        'maintenance.nsfw.subtitle',
        'classifier review 18+',
    ],
    [
        '#/settings/tools/safety/ai',
        'tools.faces',
        'Faces',
        'maintenance.ai.subtitle',
        'AI face clustering people search',
    ],
    [
        '#/settings/tools/sync/backup',
        'nav.maintenance.backup',
        'Backup',
        'maintenance.backup.subtitle',
        'Mirror new downloads to S3 / SFTP / local NAS storage',
    ],
    [
        '#/settings/tools/sync/cluster',
        'nav.maintenance.cluster',
        'Cluster',
        'maintenance.cluster.subtitle',
        'Federate multiple instances peers pair',
    ],
    [
        '#/settings/tools/system/recovery',
        'nav.maintenance.recovery',
        'Recovery',
        'maintenance.recovery.subtitle',
        'groups no account can access',
    ],
    [
        '#/settings/tools/system/logs',
        'nav.maintenance.logs',
        'Logs',
        'maintenance.logs.subtitle',
        'Realtime tail of every backend log source',
    ],
    [
        '#/settings/tools/system/updates',
        'nav.maintenance.updates',
        'Updates',
        'update.history.help',
        'update history version',
    ],
    [
        '#/backfill',
        'nav.backfill',
        'Backfill',
        'backfill.page.subtitle',
        'Pull older messages from a chat into the queue history',
    ],
    ['#/queue', 'nav.queue', 'Queue', 'queue.page.subtitle', 'downloads pause resume speed limit'],
    [
        '#/groups',
        'nav.chats',
        'Chats',
        'groups.page.subtitle',
        'Configure monitoring and filters groups channels',
    ],
];

let _wired = false;
let _en = null; // English strings by i18n key, for cross-language matching
let _enLoading = null;
let _index = null; // [{ card, section, texts: [{ el, text }], all }]
let _elsewhere = null;
let _openedDetails = new Set();
let _timer = 0;

const $ = (id) => document.getElementById(id);

function norm(s) {
    return String(s || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function loadEnglish() {
    if (_en) return Promise.resolve(_en);
    if (getLang() === 'en') {
        _en = {};
        return Promise.resolve(_en);
    }
    if (!_enLoading) {
        _enLoading = fetch('/locales/en.json')
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({}))
            .then((d) => {
                _en = d || {};
                return _en;
            });
    }
    return _enLoading;
}

// Every card on the page: the direct children of each section, plus the
// Danger Zone that sits outside them.
function _cards() {
    const page = $('page-settings');
    if (!page) return [];
    const out = [];
    for (const section of page.querySelectorAll('.settings-section')) {
        for (const card of section.children) {
            if (card.matches('script, template')) continue;
            out.push({ card, section });
        }
    }
    for (const card of page.querySelectorAll(':scope > [data-settings-search-card]')) {
        out.push({ card, section: null });
    }
    return out;
}

// Label-ish elements whose own text is worth matching / highlighting.
const LABEL_SEL = 'h3, h4, summary, label, [data-i18n], option';

function buildIndex() {
    const en = _en || {};
    _index = _cards().map(({ card, section }) => {
        const texts = [];
        for (const el of card.querySelectorAll(LABEL_SEL)) {
            // Skip wrappers whose text is just their children's labels.
            if (el.matches('label') && el.querySelector('[data-i18n]')) continue;
            const own = el.textContent;
            const key = el.dataset?.i18n;
            // The key's words are extra keywords: "advanced.min_concurrency"
            // lets "concurrency" find the "Min workers" field.
            const keyWords = key ? key.split('.').slice(1).join(' ').replace(/_/g, ' ') : '';
            const visible = norm(`${own} ${key && en[key] ? en[key] : ''}`);
            const text = `${visible} ${norm(keyWords)}`.trim();
            if (text) texts.push({ el, text, visible });
        }
        // Hint paragraphs without data-i18n (rare) still count for the card.
        const all = texts.map((t) => t.text).join(' • ');
        return { card, section, texts, all };
    });
    _elsewhere = ELSEWHERE.map(([href, nameKey, name, kwKey, kw]) => ({
        href,
        label: i18nT(nameKey, name),
        text: norm(
            `${i18nT(nameKey, name)} ${name} ${i18nT(kwKey, kw)} ${kw} ${en[nameKey] || ''} ${en[kwKey] || ''}`,
        ),
    }));
}

function _clearMarks() {
    const page = $('page-settings');
    if (!page) return;
    page.querySelectorAll(`.${MISS}`).forEach((el) => el.classList.remove(MISS));
    page.querySelectorAll(`.${HIT}`).forEach((el) => el.classList.remove(HIT));
}

function apply(raw) {
    const q = norm(raw);
    const page = $('page-settings');
    const status = $('settings-search-status');
    const others = $('settings-search-elsewhere');
    if (!page) return;
    _clearMarks();
    page.classList.toggle('is-searching', !!q);
    $('settings-search-clear')?.classList.toggle('hidden', !raw);
    if (!q) {
        // Close only the panels the search opened.
        for (const d of _openedDetails) d.open = false;
        _openedDetails = new Set();
        status?.classList.add('hidden');
        others?.classList.add('hidden');
        return;
    }
    if (!_index) buildIndex();
    // Long words also match without their last two letters, so
    // "concurrency" finds "Concurrent downloads" and "notifications"
    // finds "notification".
    const tokens = q
        .split(' ')
        .filter(Boolean)
        .map((tok) => (tok.length >= 7 ? [tok, tok.slice(0, -2)] : [tok]));
    const has = (text, variants) => variants.some((v) => text.includes(v));
    const matches = (text) => tokens.every((variants) => has(text, variants));

    let shown = 0;
    let firstHit = null;
    const sectionsWithHits = new Set();
    for (const entry of _index) {
        // Cards hidden for another reason (guest role, no cluster peers…)
        // don't count.
        const available = entry.card.getClientRects().length > 0;
        if (!available) continue;
        if (!matches(entry.all)) {
            entry.card.classList.add(MISS);
            continue;
        }
        shown++;
        if (entry.section) sectionsWithHits.add(entry.section);
        // Highlight labels whose visible text matches; only when none do
        // (the card matched through a key word) fall back to those.
        const anyVisible = entry.texts.some((t) =>
            tokens.some((variants) => has(t.visible, variants)),
        );
        for (const t of entry.texts) {
            const hay = anyVisible ? t.visible : t.text;
            if (!tokens.some((variants) => has(hay, variants))) continue;
            const target = t.el.matches('option') ? t.el.closest('select') : t.el;
            if (!target) continue;
            target.classList.add(HIT);
            const details = target.closest('details');
            if (details && !details.open) {
                details.open = true;
                _openedDetails.add(details);
            }
            if (!firstHit) firstHit = target;
        }
    }
    for (const section of page.querySelectorAll('.settings-section')) {
        if (!sectionsWithHits.has(section)) section.classList.add(MISS);
    }

    const elsewhere = (_elsewhere || []).filter((e) => matches(e.text));
    if (others) {
        others.innerHTML = elsewhere.length
            ? `<div class="settings-search-elsewhere-title">${escapeHtml(i18nT('settings.search.elsewhere', 'Also on other pages'))}</div>
               <div class="settings-search-links">${elsewhere
                   .map(
                       (e) =>
                           `<a class="settings-search-link" href="${e.href}"><span>${escapeHtml(e.label)}</span><i class="ri-arrow-right-s-line" aria-hidden="true"></i></a>`,
                   )
                   .join('')}</div>`
            : '';
        others.classList.toggle('hidden', elsewhere.length === 0);
    }
    if (status) {
        status.classList.remove('hidden');
        // Nothing anywhere: a proper empty state, not just a line of text.
        status.classList.toggle('is-empty', shown === 0 && elsewhere.length === 0);
        status.textContent =
            shown === 0
                ? elsewhere.length
                    ? i18nTf(
                          'settings.search.none_here',
                          { q: raw.trim() },
                          `No settings match “${raw.trim()}” — but see below.`,
                      )
                    : i18nTf(
                          'settings.search.none',
                          { q: raw.trim() },
                          `No settings match “${raw.trim()}”. Try another word, in English or your language.`,
                      )
                : shown === 1
                  ? i18nT('settings.search.count_one', '1 section matches')
                  : i18nTf('settings.search.count', { count: shown }, `${shown} sections match`);
    }
    return firstHit;
}

// The control a label / heading belongs to, when it's obvious which one.
function _controlFor(el) {
    return (
        (el.matches('select, input') && el) ||
        (el.htmlFor && document.getElementById(el.htmlFor)) ||
        el.closest('label')?.querySelector('input, select, textarea, .tg-toggle') ||
        null
    );
}

function jumpToFirst() {
    const first = $('page-settings')?.querySelector(`.${HIT}`);
    if (!first) return;
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const control = _controlFor(first);
    if (control && typeof control.focus === 'function') {
        setTimeout(() => control.focus({ preventScroll: true }), 300);
    }
}

export function initSettingsSearch() {
    const input = $('settings-search-input');
    if (!input) return;
    // Re-index on every visit: cards can change (accounts list, peers).
    _index = null;
    if (_wired) {
        if (input.value) {
            loadEnglish().then(() => {
                buildIndex();
                apply(input.value);
            });
        }
        return;
    }
    _wired = true;
    input.addEventListener('focus', () => loadEnglish(), { once: true });
    input.addEventListener('input', () => {
        clearTimeout(_timer);
        $('settings-search-clear')?.classList.toggle('hidden', !input.value);
        _timer = setTimeout(() => {
            loadEnglish().then(() => {
                if (!_index) buildIndex();
                apply(input.value);
            });
        }, DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(_timer);
            loadEnglish().then(() => {
                if (!_index) buildIndex();
                apply(input.value);
                jumpToFirst();
            });
        } else if (e.key === 'Escape' && input.value) {
            e.preventDefault();
            input.value = '';
            apply('');
        }
    });
    input.addEventListener('search', () => {
        if (!input.value) apply('');
    });
    $('settings-search-clear')?.addEventListener('click', () => {
        input.value = '';
        apply('');
        input.focus();
    });
    onLanguageChange(() => {
        _index = null;
        _en = null;
        _enLoading = null;
        if (input.value) {
            loadEnglish().then(() => {
                buildIndex();
                apply(input.value);
            });
        }
    });
}
