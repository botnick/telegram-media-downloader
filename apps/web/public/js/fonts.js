// Font registry — Thai-capable fonts at the top, Latin-only further
// down. Every choice falls back through IBM Plex Sans Thai → system
// stack, so Thai glyphs render even when the user's primary pick is a
// Latin-only Google Font (e.g. Roboto).
//
// The inline boot-time `<script>` in index.html mirrors this registry
// (it has to run before the ES module graph evaluates to avoid FOUC).
// When you add a font here, ALSO add it to the REG object in that
// inline script.
//
// `category` drives the <optgroup> grouping in the picker:
//   'thai'   — covers Thai natively
//   'latin'  — Latin-only; Thai falls through to IBM Plex Sans Thai
//   'system' — no webfont download
//
// `query` is the GoogleFonts CSS API path fragment ("css2?family=" +
// query + "&display=swap"); `null` for the system option.
// `family` is the CSS font-family value; the apply() helper appends
// the FALLBACK_STACK so emoji, mono, and Thai glyphs still resolve.

export const FALLBACK_STACK = "'IBM Plex Sans', 'IBM Plex Sans Thai', 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export const FONTS = [
    // ─── Thai-capable ────────────────────────────────────────────
    { id: 'ibm-plex-sans',  category: 'thai',   name: 'IBM Plex Sans (default)', query: 'IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600;700', family: "'IBM Plex Sans', 'IBM Plex Sans Thai'" },
    { id: 'noto-sans-thai', category: 'thai',   name: 'Noto Sans Thai',          query: 'Noto+Sans:wght@400;500;600;700&family=Noto+Sans+Thai:wght@400;500;600;700',         family: "'Noto Sans', 'Noto Sans Thai'" },
    { id: 'sarabun',        category: 'thai',   name: 'Sarabun',                 query: 'Sarabun:wght@400;500;600;700',                                                      family: "'Sarabun'" },
    { id: 'prompt',         category: 'thai',   name: 'Prompt',                  query: 'Prompt:wght@400;500;600;700',                                                       family: "'Prompt'" },
    { id: 'kanit',          category: 'thai',   name: 'Kanit',                   query: 'Kanit:wght@400;500;600;700',                                                        family: "'Kanit'" },
    { id: 'mitr',           category: 'thai',   name: 'Mitr',                    query: 'Mitr:wght@400;500;600;700',                                                         family: "'Mitr'" },
    { id: 'k2d',            category: 'thai',   name: 'K2D',                     query: 'K2D:wght@400;500;600;700',                                                          family: "'K2D'" },
    { id: 'bai-jamjuree',   category: 'thai',   name: 'Bai Jamjuree',            query: 'Bai+Jamjuree:wght@400;500;600;700',                                                 family: "'Bai Jamjuree'" },
    { id: 'athiti',         category: 'thai',   name: 'Athiti',                  query: 'Athiti:wght@400;500;600;700',                                                       family: "'Athiti'" },
    { id: 'niramit',        category: 'thai',   name: 'Niramit',                 query: 'Niramit:wght@400;500;600;700',                                                      family: "'Niramit'" },

    // ─── Latin-only (Thai chars fall back to IBM Plex Sans Thai) ─
    { id: 'roboto',          category: 'latin', name: 'Roboto',           query: 'Roboto:wght@400;500;700',                family: "'Roboto'" },
    { id: 'inter',           category: 'latin', name: 'Inter',            query: 'Inter:wght@400;500;600;700',             family: "'Inter'" },
    { id: 'open-sans',       category: 'latin', name: 'Open Sans',        query: 'Open+Sans:wght@400;500;600;700',         family: "'Open Sans'" },
    { id: 'lato',            category: 'latin', name: 'Lato',             query: 'Lato:wght@400;700',                      family: "'Lato'" },
    { id: 'source-sans-3',   category: 'latin', name: 'Source Sans 3',    query: 'Source+Sans+3:wght@400;500;600;700',     family: "'Source Sans 3'" },
    { id: 'manrope',         category: 'latin', name: 'Manrope',          query: 'Manrope:wght@400;500;600;700',           family: "'Manrope'" },
    { id: 'dm-sans',         category: 'latin', name: 'DM Sans',          query: 'DM+Sans:wght@400;500;600;700',           family: "'DM Sans'" },
    { id: 'work-sans',       category: 'latin', name: 'Work Sans',        query: 'Work+Sans:wght@400;500;600;700',         family: "'Work Sans'" },
    { id: 'plus-jakarta',    category: 'latin', name: 'Plus Jakarta Sans', query: 'Plus+Jakarta+Sans:wght@400;500;600;700', family: "'Plus Jakarta Sans'" },
    { id: 'outfit',          category: 'latin', name: 'Outfit',           query: 'Outfit:wght@400;500;600;700',            family: "'Outfit'" },

    // ─── No webfont ──────────────────────────────────────────────
    { id: 'system',          category: 'system', name: 'System default', query: null, family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
];

const LS_KEY = 'tgdl-font';
const LINK_ID = 'tgdl-fonts-user';

export function getActiveFontId() {
    const id = localStorage.getItem(LS_KEY);
    return FONTS.some(f => f.id === id) ? id : 'ibm-plex-sans';
}

/**
 * Apply a font by id — injects the matching Google Fonts <link> if not
 * already present, sets the `--tgdl-font-family` CSS var, and persists
 * the choice. Triggering it with the current id is a no-op besides the
 * persist (so callers don't have to dedupe).
 */
export function applyFont(id) {
    const font = FONTS.find(f => f.id === id) || FONTS[0];
    try { localStorage.setItem(LS_KEY, font.id); } catch { /* private mode */ }

    // Strip a previous user-selected font link so we don't pile them up
    // when the user toggles back and forth (each variant is a separate
    // network request — keep one at a time).
    document.getElementById(LINK_ID)?.remove();
    if (font.query) {
        const link = document.createElement('link');
        link.id = LINK_ID;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${font.query}&display=swap`;
        document.head.appendChild(link);
    }
    document.documentElement.style.setProperty(
        '--tgdl-font-family',
        `${font.family}, ${FALLBACK_STACK}`,
    );
}

/**
 * Populate a `<select id="setting-font">` with the registry, grouped
 * by category. Each <option> previews its own family so the user can
 * see what they're picking before the page applies it.
 */
export function populateSelect(selectEl) {
    if (!selectEl) return;
    const groups = {
        thai:   { label: 'Thai-capable',                items: [] },
        latin:  { label: 'Latin (Thai falls back)',     items: [] },
        system: { label: 'No webfont',                  items: [] },
    };
    for (const f of FONTS) (groups[f.category] || groups.thai).items.push(f);
    selectEl.innerHTML = Object.values(groups)
        .filter(g => g.items.length)
        .map(g => `
            <optgroup label="${g.label}">
                ${g.items.map(f => `<option value="${f.id}" style="font-family: ${f.family.replace(/"/g, '&quot;')}, ${FALLBACK_STACK}">${f.name}</option>`).join('')}
            </optgroup>
        `).join('');
    selectEl.value = getActiveFontId();
}
