// Centralised media-URL builders for the dashboard SPA. Every gallery /
// lightbox / context-menu surface should go through these helpers so the
// federated-gallery routing (Layer 1, v2.12+) stays in one place — no
// inline `/api/thumbs/${id}` or `/files/${path}` constructions scattered
// across the codebase.
//
// The two functions both consume a row object as returned by the gallery
// endpoints. Each row carries:
//   - `id` (number)             — local download id, OR peer-side remote id
//                                  for federated rows
//   - `peer_id` (string)        — `'self'` for own rows, peer's id otherwise
//   - `fullPath` (string)       — relative file path (own-side or peer-side)
//
// Server-side routing rules (matched here):
//   - Own rows  → `/api/thumbs/<id>?w=<N>` and `/files/<fullPath>?inline=1`
//   - Peer rows → `/api/cluster/thumbs/<peerId>/<remoteId>?w=<N>` and
//                  `/files/<fullPath>?inline=1&peer=<peerId>`
//
// The peer-thumb route is HMAC-signed server-to-server; the browser only
// hits the cookie-authed cluster proxy (`/api/cluster/thumbs/...`) which
// in turn fetches from the peer's `/api/cluster/peer-thumbs/<remoteId>`.

// ---- file-access bearer token ---------------------------------------------

let _ft = null; // { token, exp }
let _ftTimer = 0;
const _FT_MARGIN = 300; // refresh 5 min before expiry

async function _fetchFileToken() {
    try {
        const res = await fetch('/api/files/token', { credentials: 'same-origin' });
        if (!res.ok) return;
        _ft = await res.json();
        clearTimeout(_ftTimer);
        const refreshIn = (_ft.exp - Math.floor(Date.now() / 1000) - _FT_MARGIN) * 1000;
        if (refreshIn > 0) _ftTimer = setTimeout(_fetchFileToken, refreshIn);
    } catch { /* cookie auth fallback */ }
}

export function initFileToken() {
    return _fetchFileToken();
}

export function fileTokenQuery() {
    if (!_ft) return '';
    if (Date.now() / 1000 > _ft.exp) {
        _ft = null;
        _fetchFileToken();
        return '';
    }
    return `token=${encodeURIComponent(_ft.token)}`;
}

// ---- URL builders ---------------------------------------------------------

/**
 * Build the thumbnail URL for a gallery row at the requested width.
 * Returns null when the row has no id (sticker / document / placeholder
 * tile) — caller falls back to an icon placeholder in that case.
 */
export function getThumbUrl(file, width) {
    if (!file || file.id == null) return null;
    if (file.peer_id && file.peer_id !== 'self') {
        return `/api/cluster/thumbs/${encodeURIComponent(file.peer_id)}/${encodeURIComponent(
            file.id,
        )}?w=${width}`;
    }
    return `/api/thumbs/${encodeURIComponent(file.id)}?w=${width}`;
}

/**
 * Build the full-media URL (image src / video src / direct download).
 * `opts.inline` (default true) maps to `?inline=1` so the browser renders
 * the file in place instead of triggering a download.
 */
export function getMediaUrl(file, opts = {}) {
    if (!file || !file.fullPath) return null;
    const inline = opts.inline !== false;
    const params = [];
    if (inline) params.push('inline=1');
    if (file.peer_id && file.peer_id !== 'self') {
        params.push(`peer=${encodeURIComponent(file.peer_id)}`);
    }
    const ftq = fileTokenQuery();
    if (ftq) params.push(ftq);
    const query = params.length ? `?${params.join('&')}` : '';
    return `/files/${encodeURIComponent(file.fullPath)}${query}`;
}

/**
 * Convenience wrapper for the explicit "download this file" flow (no
 * inline=1). Same routing as getMediaUrl, just without the inline flag.
 */
export function getDownloadUrl(file) {
    return getMediaUrl(file, { inline: false });
}

/**
 * Helper for the share-link / context-menu surfaces — returns true when a
 * row is owned by a remote peer (the SPA disables some actions for these,
 * e.g., delete, since the operator doesn't own the file).
 */
export function isPeerRow(file) {
    return !!(file && file.peer_id && file.peer_id !== 'self');
}
