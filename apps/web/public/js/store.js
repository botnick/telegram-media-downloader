// Central State Store
//
// Beyond the bag-of-state, this module owns the *canonical* group-name
// lookup used by every render path in the SPA. Multiple paths used to
// resolve names independently (`g.name`, `g.title`, dataset attrs,
// per-event payloads, DB rows) — the result was that the sidebar would
// say "Telegram Tips" while a paste-link page or a download toast for
// the same id still said "Unknown chat" or showed the bare numeric id.
//
// Resolution order (first hit wins):
//   1. state.groupNameCache[id]   — populated by the WS `groups_refreshed`
//                                   handler and the post-refresh-info update.
//   2. state.groups               — /api/config (the authoritative human-set
//                                   label for monitored groups).
//   3. state.allDialogs           — /api/dialogs (Telegram-side titles, only
//                                   loaded on the Groups page).
//   4. state.downloads            — /api/downloads (DB-side group_name).
//   5. last group_name on any state.files entry — for the gallery breadcrumb
//                                   when /api/downloads/:id replied with a
//                                   row whose group_name was filled in later.
//   6. fallback "Unknown chat (#<id>)" — never leak a bare numeric id.

export const state = {
    currentPage: 'viewer',
    currentGroup: null,
    currentFilter: 'all',
    groups: [],
    downloads: [],
    files: [],
    allFiles: [],
    currentFileIndex: 0,
    config: {},
    page: 1,
    hasMore: true,
    loading: false,
    observer: null,
    imageObserver: null,
    viewMode: 'grid',
    searchQuery: '',
    // Canonical name cache — fed by /api/groups/refresh-info responses and
    // the WS `groups_refreshed` broadcast. Keyed by stringified id.
    groupNameCache: {},
    // 'admin' | 'guest' | null — populated from /api/auth_check on boot.
    // Drives both router.js (admin-only routes redirect guests) and the
    // body[data-role] CSS gate that hides admin-only UI elements.
    role: null,
};

/** True for "missing / placeholder / numeric-id-as-name" inputs. */
function looksUnresolved(name, id) {
    if (!name) return true;
    const s = String(name).trim();
    if (!s) return true;
    if (s === 'Unknown' || s === 'unknown') return true;
    if (id != null && s === String(id)) return true;
    if (/^-?\d{6,}$/.test(s)) return true;
    if (/^Group\s/i.test(s)) return true;
    return false;
}

/**
 * Canonical group-name lookup. Always returns a non-empty string, never
 * leaks a bare numeric id. Pass `{ fallback }` to override the default
 * "Unknown chat (#<id>)" placeholder.
 */
export function getGroupName(id, opts = {}) {
    if (id == null || id === '') return opts.fallback || 'Unknown chat';
    const key = String(id);

    // 1. Explicit cache (refresh-info / WS groups_refreshed).
    const cached = state.groupNameCache?.[key];
    if (cached && !looksUnresolved(cached, key)) return cached;

    // 2. Config-defined groups (state.groups).
    const cfg = (state.groups || []).find(g => String(g.id) === key);
    if (cfg && !looksUnresolved(cfg.name, key)) return cfg.name;

    // 3. Dialogs list (browse-chats picker).
    const dlg = (state.allDialogs || []).find(d => String(d.id) === key);
    if (dlg) {
        const dn = dlg.name || dlg.title;
        if (!looksUnresolved(dn, key)) return dn;
    }

    // 4. Downloads list (DB-side group_name).
    const dn2 = (state.downloads || []).find(d => String(d.id) === key);
    if (dn2 && !looksUnresolved(dn2.name, key)) return dn2.name;

    // 5. Any file row carrying group_name for this id.
    const file = (state.files || []).find(
        f => String(f.groupId ?? f.group_id ?? '') === key && (f.groupName || f.group_name)
    );
    if (file) {
        const fn = file.groupName || file.group_name;
        if (!looksUnresolved(fn, key)) return fn;
    }

    // 6. Fallback — friendly placeholder, never the bare id.
    if (opts.fallback) return opts.fallback;
    return `Unknown chat (#${key})`;
}

/**
 * Merge updates from /api/groups/refresh-info (and the matching WS
 * `groups_refreshed` broadcast) into the cache. Accepts an array of
 * `{id, name}` pairs OR a `{id: name}` map.
 */
export function updateGroupNameCache(updates) {
    if (!updates) return 0;
    if (!state.groupNameCache) state.groupNameCache = {};
    let n = 0;
    if (Array.isArray(updates)) {
        for (const u of updates) {
            if (!u || u.id == null || !u.name) continue;
            if (looksUnresolved(u.name, u.id)) continue;
            state.groupNameCache[String(u.id)] = String(u.name);
            n++;
        }
    } else if (typeof updates === 'object') {
        for (const [id, name] of Object.entries(updates)) {
            if (!name || looksUnresolved(name, id)) continue;
            state.groupNameCache[String(id)] = String(name);
            n++;
        }
    }
    return n;
}

/** Exposed for the unresolved-row detection in the sidebar render. */
export function isUnresolvedName(name, id) {
    return looksUnresolved(name, id);
}
