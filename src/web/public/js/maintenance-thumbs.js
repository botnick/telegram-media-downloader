// Maintenance — Thumbnails (admin page).
//
// Actions surfaced on this page:
//   - Build all / Build images / Build videos / Build audio — fire-and-forget
//     sweeps that walk catalogued files and generate a WebP thumb where one's
//     missing. Live `thumbs_progress` WS events drive the bar.
//   - Cancel — aborts an in-flight build via JobTracker.cancel().
//   - Wipe cache — deletes every cached thumb so the next gallery scroll
//     regenerates them. Confirm sheet shows the real count + bytes.
//
// Preview gallery:
//   Cursor-paginated, IntersectionObserver-driven, sliding-window virtualised.
//   New downloads land at the top; scrolling pulls older rows. Each tile
//   knows its own cached-or-not state from the list payload so the operator
//   can spot gaps before clicking. Failed tiles expose a per-tile retry.

import { ws } from './ws.js';
import { api } from './api.js';
import { escapeHtml, formatBytes, showToast } from './utils.js';
import { confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { loadAdvanced, setupAutoSave } from './settings.js';
import { openMediaViewerSingle } from './viewer.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;

// ----- Thumbnail preview gallery -----------------------------------------

const GALLERY_PAGE_SIZE = 60;
// Window cap matches the duplicates/queue pages. Sliding-window trims the
// head when scrolling appends past this; "Back to newest" jumps the user
// home cheaply rather than scroll-restoring across evicted tiles.
const GALLERY_MAX_TILES = 2000;
// Per-image bail-out — if neither `load` nor `error` fires within this
// window, mark the tile failed so the retry button can offer a way out.
const IMG_LOAD_TIMEOUT_MS = 15_000;
const SKELETON_INITIAL_COUNT = 18;

let _galleryKind = 'all';
let _galleryCursor = null;
let _galleryHasMore = true;
let _galleryLoading = false;
let _galleryTotal = 0;
let _galleryLoaded = 0; // cumulative — does not reset when window slides
// Cache-bust suffix appended to `/api/thumbs/:id` URLs after a build /
// rebuild finishes. While 0, the URL stays clean so the first page-load
// pulls from the immutable browser cache.
let _imgVersion = 0;
let _imgObs = null;
let _scrollObs = null;
let _galleryWired = false;
// Bumped on every kind switch / reset. Late responses from before the
// bump get dropped instead of repainting a stale grid.
let _gallerySeq = 0;
// Toast dedup — flooded `thumbs_list` errors should not spam the user.
const _toastBucket = new Map(); // key → lastShownMs
const TOAST_DEDUP_MS = 5_000;

function _dedupToast(key, text, kind = 'error') {
    const now = Date.now();
    const last = _toastBucket.get(key) || 0;
    if (now - last < TOAST_DEDUP_MS) return;
    _toastBucket.set(key, now);
    showToast(text, kind);
}

// Use the shared `formatBytes` so every surface (Build thumbnails Wipe-
// confirm, stat tiles, Recent files row) speaks the same units. The
// shared helper picks B / KB / MB / GB / TB based on the value's
// magnitude with 2-decimal precision — the previous local copy stopped
// at GB and rendered 100 KB as "0.1 MB", which the operator flagged as
// imprecise. Kept as a one-line wrapper so call sites don't have to
// change.
const _formatBytes = (bytes) => formatBytes(Number(bytes) || 0);

function _formatRelative(unixMs) {
    const t = Number(unixMs) || 0;
    if (!t) return '';
    const diff = Math.max(0, Date.now() - t);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return i18nT('maintenance.duplicates.stats.just_now', 'just now');
    const min = Math.floor(sec / 60);
    if (min < 60)
        return i18nTf('maintenance.duplicates.stats.minutes_ago', { n: min }, `${min} min ago`);
    const hr = Math.floor(min / 60);
    if (hr < 24) return i18nTf('maintenance.duplicates.stats.hours_ago', { n: hr }, `${hr} h ago`);
    const days = Math.floor(hr / 24);
    return i18nTf('maintenance.duplicates.stats.days_ago', { n: days }, `${days} d ago`);
}

// Pull the persisted last-build summary from /api/maintenance/thumbs/build/stats.
// Survives server restart via kv so a fresh visit sees "Last build: 3 h ago".
async function _refreshLastBuild() {
    const lastEl = $('thumbs-stat-last');
    const summaryEl = $('thumbs-stat-summary');
    try {
        const r = await api.get('/api/maintenance/thumbs/build/stats');
        const last = r?.lastRun;
        if (lastEl) {
            if (last && last.finishedAt) {
                lastEl.textContent = _formatRelative(last.finishedAt);
                lastEl.title = new Date(last.finishedAt).toLocaleString();
            } else {
                lastEl.textContent = i18nT('maintenance.duplicates.stats.last_scan_never', 'Never');
                lastEl.title = '';
            }
        }
        if (summaryEl) {
            if (last && last.finishedAt) {
                summaryEl.textContent = i18nTf(
                    'maintenance.thumbs.last_build_result',
                    {
                        built: (last.built || 0).toLocaleString(),
                        skipped: (last.skipped || 0).toLocaleString(),
                        errored: (last.errored || 0).toLocaleString(),
                        scanned: (last.scanned || 0).toLocaleString(),
                    },
                    `Last build: ${last.built || 0} built · ${last.skipped || 0} skipped · ${last.errored || 0} errored (scanned ${last.scanned || 0})`,
                );
                summaryEl.classList.remove('hidden');
            } else {
                summaryEl.classList.add('hidden');
            }
        }
    } catch {
        /* non-fatal */
    }
}

// Latest stats snapshot — used by the Wipe confirm sheet to surface real
// numbers ("Wipe 14,200 thumbs (850 MB)?") instead of a generic prompt.
let _lastStats = { count: 0, bytes: 0 };

async function _refreshStats() {
    const countEl = $('thumbs-stat-count');
    const bytesEl = $('thumbs-stat-bytes');
    const ffmpegChip = $('thumbs-no-ffmpeg');
    const widthsEl = $('thumbs-stat-widths');
    const breakdownEl = $('thumbs-breakdown');
    _refreshLastBuild();
    try {
        const r = await api.get('/api/maintenance/thumbs/stats');
        _lastStats = { count: r?.count || 0, bytes: r?.bytes || 0 };
        if (countEl) countEl.textContent = String(r.count ?? 0);
        if (bytesEl) bytesEl.textContent = _formatBytes(r.bytes);
        if (widthsEl && Array.isArray(r.allowedWidths)) {
            widthsEl.innerHTML = r.allowedWidths
                .map(
                    (w) =>
                        `<span class="inline-flex items-center px-1.5 py-0.5 rounded-md bg-tg-blue/15 text-tg-blue text-[11px] font-medium tabular-nums">${Number(w) || 0}<span class="text-tg-blue/70 ml-0.5">px</span></span>`,
                )
                .join('');
        }
        if (ffmpegChip) {
            ffmpegChip.classList.toggle('hidden', r.ffmpegAvailable !== false);
        }
        if (breakdownEl) {
            const byKind = r.byKind || r.kinds || null;
            if (byKind && typeof byKind === 'object') {
                const order = ['image', 'photo', 'video', 'audio', 'other'];
                const entries = Object.entries(byKind).sort(
                    (a, b) => order.indexOf(a[0]) - order.indexOf(b[0]),
                );
                breakdownEl.innerHTML = entries
                    .map(
                        ([k, v]) => `
                    <div class="bg-tg-bg/40 rounded-lg p-2 text-center">
                        <div class="text-xs text-tg-textSecondary uppercase tracking-wide">${k}</div>
                        <div class="text-lg font-semibold text-tg-text tabular-nums">${Number(v) || 0}</div>
                    </div>`,
                    )
                    .join('');
            } else {
                breakdownEl.innerHTML = '';
            }
        }
    } catch {
        // leave stale values; non-fatal
    }
}

function _setBuildUi(running) {
    const btn = $('thumbs-build-btn');
    const kindMenuBtn = $('thumbs-build-kind-btn');
    const cancelBtn = $('thumbs-cancel-btn');
    const progress = $('thumbs-progress');
    const bar = $('thumbs-progress-bar');
    const pct = $('thumbs-progress-pct');
    if (btn) {
        btn.disabled = !!running;
        const labelSpan = btn.querySelector('span[data-i18n]');
        if (labelSpan) {
            labelSpan.textContent = running
                ? i18nT('maintenance.thumbs.building', 'Building…')
                : i18nT('maintenance.thumbs.build_all', 'Build all');
        }
    }
    if (kindMenuBtn) kindMenuBtn.disabled = !!running;
    if (cancelBtn) cancelBtn.classList.toggle('hidden', !running);
    if (progress) progress.classList.toggle('hidden', !running);
    if (!running) {
        if (bar) bar.style.width = '0%';
        if (pct) pct.textContent = '';
    }
}

// Kick off the build sweep. `kind` is one of 'all' | 'image' | 'video' | 'audio'.
async function _buildAll(kind = 'all') {
    _setBuildUi(true);
    try {
        const r = await api.post('/api/maintenance/thumbs/build-all', { kind });
        if (r?.error) {
            showToast(r.error, 'error');
            _setBuildUi(false);
            return;
        }
        // Final toast lands from the WS `thumbs_done` event with real numbers.
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        _setBuildUi(false);
    }
}

async function _cancelBuild() {
    try {
        await api.post('/api/maintenance/thumbs/build/cancel', {});
        showToast(i18nT('maintenance.thumbs.cancelling', 'Cancelling…'), 'info');
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Cancel failed', 'error');
    }
}

async function _wipeCache() {
    const count = Number(_lastStats.count) || 0;
    const bytesPretty = _formatBytes(_lastStats.bytes || 0);
    // Confirm sheet shows the actual numbers so the operator knows what they
    // are about to throw away — generic "wipe cache?" prompts are too easy
    // to nod through on autopilot.
    const ok = await confirmSheet({
        title: i18nT('maintenance.thumbs.rebuild_title', 'Rebuild thumbnail cache?'),
        message:
            count > 0
                ? i18nTf(
                      'maintenance.thumbs.rebuild_body_n',
                      { count: count.toLocaleString(), size: bytesPretty },
                      `Wipes ${count.toLocaleString()} cached thumbnails (${bytesPretty}). The next gallery scroll regenerates them on demand.`,
                  )
                : i18nT(
                      'maintenance.thumbs.rebuild_body',
                      'Wipes every cached thumbnail. The next gallery scroll regenerates them on demand. Useful when previews look stale or after a quality tweak.',
                  ),
        confirmLabel: i18nT('maintenance.thumbs.rebuild_confirm', 'Wipe cache'),
        danger: true,
    });
    if (!ok) return;
    const btn = $('thumbs-wipe-btn');
    if (btn) btn.disabled = true;
    try {
        const r = await api.post('/api/maintenance/thumbs/rebuild', {});
        if (!r?.started && !r?.success) throw new Error('Failed to start');
    } catch (e) {
        if (e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT(
                    'jobs.already_running',
                    'Already running on another tab — waiting for it to finish.',
                ),
                'info',
            );
            return;
        }
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        if (btn) btn.disabled = false;
    }
}

function _setWipeUi(running) {
    const btn = $('thumbs-wipe-btn');
    if (btn) btn.disabled = !!running;
}

// Force-reload one tile after a successful retry / rebuild — bumps src
// with the latest version suffix and resets the loaded/failed flags so
// the IntersectionObserver path repaints cleanly.
function _refreshTile(tile) {
    if (!tile) return;
    const id = parseInt(tile.dataset.id, 10);
    if (!Number.isFinite(id) || id <= 0) return;
    tile.removeAttribute('data-loaded');
    tile.removeAttribute('data-failed');
    tile.dataset.src = _tileImgUrl(id);
    const img = tile.querySelector('img');
    if (img) {
        img.removeAttribute('src');
        img.alt = tile.title || '';
    }
    // Re-observe so the next viewport entry assigns src + restarts the
    // load timeout. _imgObs.observe is idempotent.
    if (_imgObs) _imgObs.observe(tile);
}

function _bumpImgVersion() {
    _imgVersion = Date.now();
}

// Repaint failed / not-yet-loaded tiles after a build completes — the new
// thumbs should be on disk now. Skip tiles that already painted to avoid
// flicker; the user can hard-refresh if they want a full repaint.
function _repaintMissingTiles() {
    const grid = $('thumbs-gallery-grid');
    if (!grid) return;
    const tiles = grid.querySelectorAll('.thumbs-gallery-tile');
    let n = 0;
    for (const tile of tiles) {
        const loaded = tile.getAttribute('data-loaded') === 'true';
        const failed = tile.getAttribute('data-failed') === 'true';
        if (!loaded || failed) {
            _refreshTile(tile);
            n++;
        }
    }
    return n;
}

// Repaint every tile after a wipe — the cache is gone, every existing
// `data-loaded=true` is now pointing at a stale browser-cached image.
function _repaintAllTiles() {
    const grid = $('thumbs-gallery-grid');
    if (!grid) return;
    for (const tile of grid.querySelectorAll('.thumbs-gallery-tile')) {
        _refreshTile(tile);
    }
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('thumbs_progress', (m) => {
        const bar = $('thumbs-progress-bar');
        const status = $('thumbs-progress-status');
        const pctEl = $('thumbs-progress-pct');
        const progress = $('thumbs-progress');
        if (progress) progress.classList.remove('hidden');
        const cancelBtn = $('thumbs-cancel-btn');
        if (cancelBtn) cancelBtn.classList.remove('hidden');
        if (!bar) return;
        const total = Math.max(1, m.total || 1);
        const pct = Math.min(100, Math.round(((m.processed || 0) / total) * 100));
        bar.style.width = pct + '%';
        if (status) {
            status.textContent = i18nTf(
                'maintenance.thumbs.progress',
                { processed: m.processed || 0, total: m.total || 0, built: m.built || 0 },
                `${m.processed || 0} / ${m.total || 0} · ${m.built || 0} built`,
            );
        }
        if (pctEl) {
            pctEl.textContent =
                m.total > 0
                    ? `${pct}% · ${(m.processed || 0).toLocaleString()} / ${(m.total || 0).toLocaleString()}`
                    : '';
        }
    });
    ws.on('thumbs_done', (m) => {
        _setBuildUi(false);
        if (m?.error) {
            showToast(m.error, 'error');
        } else if (m?.cancelled) {
            showToast(i18nT('maintenance.thumbs.cancelled', 'Build cancelled'), 'info');
        } else {
            showToast(
                i18nTf(
                    'maintenance.thumbs.done',
                    { built: m?.built || 0, skipped: m?.skipped || 0, scanned: m?.scanned || 0 },
                    `Built ${m?.built || 0}, ${m?.skipped || 0} already cached out of ${m?.scanned || 0}`,
                ),
                'success',
            );
        }
        _refreshStats().catch(() => {});
        _bumpImgVersion();
        _repaintMissingTiles();
    });
    ws.on('thumbs_rebuild_progress', () => _setWipeUi(true));
    ws.on('thumbs_rebuild_done', (m) => {
        _setWipeUi(false);
        if (m?.error) {
            showToast(m.error, 'error');
        } else {
            showToast(
                i18nTf(
                    'maintenance.thumbs.rebuilt',
                    { removed: m?.removed || 0 },
                    `Wiped ${m?.removed || 0} cached thumbnails`,
                ),
                'success',
            );
        }
        _refreshStats().catch(() => {});
        _bumpImgVersion();
        _repaintAllTiles();
    });
}

async function _recoverBuildState() {
    try {
        const r = await api.get('/api/maintenance/thumbs/build/status');
        if (r?.running) _setBuildUi(true);
    } catch {
        /* non-fatal */
    }
    try {
        const r = await api.get('/api/maintenance/thumbs/rebuild/status');
        if (r?.running) _setWipeUi(true);
    } catch {}
}

// ---- Gallery rendering --------------------------------------------------

function _kindBadge(fileType) {
    if (fileType === 'video') return '<i class="ri-play-circle-fill"></i>';
    if (fileType === 'audio') return '<i class="ri-music-2-line"></i>';
    return '<i class="ri-image-line"></i>';
}

function _tileImgUrl(id) {
    const base = `/api/thumbs/${id}?w=320`;
    return _imgVersion ? `${base}&v=${_imgVersion}` : base;
}
function _tileHref(id) {
    // v2.x collapsed the cache to a single canonical width; the
    // "open in new tab" link now opens the same WebP the tile
    // already shows. Inspection at the original resolution is via
    // the gallery / lightbox, not this admin grid.
    const base = `/api/thumbs/${id}?w=320`;
    return _imgVersion ? `${base}&v=${_imgVersion}` : base;
}

function _tileHtml(row) {
    const id = Number(row.id) || 0;
    const safe = escapeHtml(row.file_name || `#${id}`);
    const src = _tileImgUrl(id);
    const badge = _kindBadge(row.file_type);
    const cachedAttr = row.cached === false ? ' data-cached="false"' : '';
    // Stash the full row on the tile so the click handler can hand a
    // viewer-compatible object to `openMediaViewerSingle` without
    // round-tripping back to the server. file_path / file_size /
    // file_type / file_name are all that the viewer's `_classifyFile`
    // + `getMediaUrl` need.
    const fileType = String(row.file_type || '');
    const filePath = String(row.file_path || '').replace(/\\/g, '/');
    const fileSize = Number(row.file_size) || 0;
    const meta = encodeURIComponent(
        JSON.stringify({
            id,
            file_name: row.file_name || '',
            file_type: fileType,
            file_path: filePath,
            file_size: fileSize,
        }),
    );
    // Switched from `<a target=_blank>` (window.open path) to a
    // `<div role=button>` so the click opens the in-app lightbox like
    // every other maintenance page. Keyboard activation is preserved
    // via the existing keydown handler in `_wireGallery`.
    return (
        `<div class="thumbs-gallery-tile" role="button"` +
        ` data-id="${id}" data-src="${src}" data-meta="${meta}"${cachedAttr}` +
        ` title="${safe}" tabindex="0">` +
        '<div class="thumbs-tile-skeleton" aria-hidden="true"></div>' +
        `<img alt="${safe}" loading="lazy" decoding="async" />` +
        `<span class="thumbs-tile-badge" aria-hidden="true">${badge}</span>` +
        (row.cached === false
            ? `<span class="thumbs-tile-pending" aria-label="${i18nT('maintenance.thumbs.gallery.not_built_aria', 'Not yet built')}" title="${i18nT('maintenance.thumbs.gallery.not_built_aria', 'Not yet built')}"><i class="ri-time-line"></i></span>`
            : '') +
        `<div class="thumbs-tile-name">${safe}</div>` +
        `<button type="button" class="thumbs-tile-retry hidden" data-action="retry"` +
        ` aria-label="${i18nT('maintenance.thumbs.gallery.retry_aria', 'Rebuild this thumbnail')}"` +
        ` title="${i18nT('maintenance.thumbs.gallery.retry_title', 'Rebuild')}"><i class="ri-refresh-line"></i></button>` +
        `<div class="thumbs-tile-failed-icon" aria-hidden="true"><i class="ri-image-off-line"></i></div>` +
        '</div>'
    );
}

// Decode the `data-meta` blob baked into each tile by `_tileHtml` and
// shape it into the file object `openMediaViewerSingle` expects.
// `file_type` from the downloads table is 'photo' / 'video' / 'audio' /
// 'document'; the viewer's classifier reads `type` (plural: 'images' /
// 'videos' / 'audio' / 'files') OR the file extension on `name`. Map
// the two so both classification paths see the same answer.
function _tileToViewerFile(tile) {
    let meta = {};
    try {
        meta = JSON.parse(decodeURIComponent(tile.dataset.meta || '%7B%7D'));
    } catch {
        return null;
    }
    const filePath = String(meta.file_path || '').replace(/\\/g, '/');
    const fileType = String(meta.file_type || '');
    const type =
        fileType === 'photo' || fileType === 'image' || fileType === 'sticker'
            ? 'images'
            : fileType === 'video'
              ? 'videos'
              : fileType === 'audio'
                ? 'audio'
                : 'files';
    return {
        id: Number(meta.id) || 0,
        name: meta.file_name || '',
        path: filePath,
        fullPath: filePath,
        type,
        file_type: fileType,
        size: Number(meta.file_size) || 0,
        sizeFormatted: formatBytes(Number(meta.file_size) || 0),
        modified: null,
        peer_id: 'self',
    };
}

// Pre-paint skeleton placeholders so the operator sees motion immediately
// rather than an empty card while the first page is in flight.
function _paintSkeletons(n = SKELETON_INITIAL_COUNT) {
    const grid = $('thumbs-gallery-grid');
    if (!grid) return;
    const html = Array.from({ length: n })
        .map(
            () =>
                '<div class="thumbs-gallery-tile is-skeleton" aria-hidden="true">' +
                '<div class="thumbs-tile-skeleton"></div></div>',
        )
        .join('');
    grid.innerHTML = html;
}

function _clearSkeletons() {
    const grid = $('thumbs-gallery-grid');
    if (!grid) return;
    grid.querySelectorAll('.thumbs-gallery-tile.is-skeleton').forEach((n) => n.remove());
}

function _ensureObservers() {
    if (!_imgObs) {
        _imgObs = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const tile = e.target;
                    const img = tile.querySelector('img');
                    const src = tile.getAttribute('data-src');
                    if (!img || !src) {
                        _imgObs.unobserve(tile);
                        continue;
                    }
                    _imgObs.unobserve(tile);
                    // Bail-out timer — IO fired, src was assigned, but the
                    // network might silently stall. Mark failed after the
                    // grace window so the retry button surfaces.
                    const timeout = setTimeout(() => {
                        if (tile.getAttribute('data-loaded') !== 'true') {
                            tile.setAttribute('data-failed', 'true');
                            tile.setAttribute('data-loaded', 'true');
                        }
                    }, IMG_LOAD_TIMEOUT_MS);
                    img.addEventListener(
                        'load',
                        () => {
                            clearTimeout(timeout);
                            tile.setAttribute('data-loaded', 'true');
                        },
                        { once: true },
                    );
                    img.addEventListener(
                        'error',
                        () => {
                            clearTimeout(timeout);
                            tile.setAttribute('data-failed', 'true');
                            tile.setAttribute('data-loaded', 'true');
                        },
                        { once: true },
                    );
                    img.src = src;
                }
            },
            { root: null, rootMargin: '200% 0px 200% 0px', threshold: 0.01 },
        );
    }
    if (!_scrollObs) {
        _scrollObs = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    if (_galleryLoading || !_galleryHasMore) continue;
                    _loadGalleryPage().catch(() => {});
                }
            },
            { root: null, rootMargin: '600px 0px', threshold: 0.01 },
        );
    }
}

function _updateGalleryMeta() {
    const el = $('thumbs-gallery-meta');
    if (!el) return;
    if (!_galleryTotal && !_galleryLoaded) {
        el.textContent = '';
        return;
    }
    el.textContent = i18nTf(
        'maintenance.thumbs.gallery.count',
        { loaded: _galleryLoaded.toLocaleString(), total: _galleryTotal.toLocaleString() },
        `Loaded ${_galleryLoaded.toLocaleString()} of ${_galleryTotal.toLocaleString()}`,
    );
}

function _setSentinelVisible(active) {
    const s = $('thumbs-gallery-sentinel');
    if (!s) return;
    s.classList.toggle('is-idle', !active);
}

async function _loadGalleryPage() {
    if (_galleryLoading || !_galleryHasMore) return;
    _galleryLoading = true;
    _setSentinelVisible(true);
    const seq = _gallerySeq;
    try {
        const qs = new URLSearchParams({ limit: String(GALLERY_PAGE_SIZE), kind: _galleryKind });
        if (_galleryCursor !== null) qs.set('cursor', String(_galleryCursor));
        const r = await api.get(`/api/maintenance/thumbs/list?${qs.toString()}`);
        if (seq !== _gallerySeq) return;
        const grid = $('thumbs-gallery-grid');
        if (!grid) return;
        const rows = Array.isArray(r?.rows) ? r.rows : [];
        // First page carries the total; later pages return total=null and
        // we keep the prior value rather than re-COUNT(*) on the server.
        if (r && r.total !== null && r.total !== undefined) {
            _galleryTotal = Number(r.total) || 0;
        }
        // Drop the placeholder skeletons the moment real data arrives.
        if (_galleryCursor === null) _clearSkeletons();
        if (rows.length) {
            const html = rows.map(_tileHtml).join('');
            grid.insertAdjacentHTML('beforeend', html);
            const tiles = grid.children;
            const startIdx = Math.max(0, tiles.length - rows.length);
            for (let i = startIdx; i < tiles.length; i++) {
                _imgObs.observe(tiles[i]);
            }
            _galleryLoaded += rows.length;
            // Sliding window — drop the head past the cap. The "Back to
            // newest" button lets the user jump home without paying for a
            // scroll-up across the evicted region.
            while (grid.children.length > GALLERY_MAX_TILES) {
                const head = grid.firstElementChild;
                if (_imgObs && head) _imgObs.unobserve(head);
                grid.removeChild(head);
            }
        }
        _galleryCursor = r?.nextCursor ?? null;
        _galleryHasMore = !!r?.hasMore;
        _updateGalleryMeta();
        const emptyEl = $('thumbs-gallery-empty');
        const endEl = $('thumbs-gallery-end');
        const visibleCount = grid.querySelectorAll('.thumbs-gallery-tile:not(.is-skeleton)').length;
        if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0);
        if (endEl) endEl.classList.toggle('hidden', _galleryHasMore || visibleCount === 0);
        if (!_galleryHasMore) {
            // Stop polling the sentinel — IO would otherwise keep firing
            // no-op callbacks on every scroll past the end.
            const sentinel = $('thumbs-gallery-sentinel');
            if (sentinel && _scrollObs) _scrollObs.unobserve(sentinel);
        }
    } catch (e) {
        if (seq !== _gallerySeq) return;
        _dedupToast(
            'gallery-load',
            i18nTf(
                'maintenance.thumbs.gallery.failed',
                { msg: e?.data?.error || e?.message || 'Failed' },
                `Could not load: ${e?.data?.error || e?.message || 'Failed'}`,
            ),
            'error',
        );
    } finally {
        if (seq === _gallerySeq) {
            _galleryLoading = false;
            _setSentinelVisible(_galleryHasMore);
        }
    }
}

function _resetGallery(kind) {
    _gallerySeq++;
    _galleryKind = kind;
    _galleryCursor = null;
    _galleryHasMore = true;
    _galleryLoading = false;
    _galleryLoaded = 0;
    _galleryTotal = 0;
    _paintSkeletons();
    const emptyEl = $('thumbs-gallery-empty');
    const endEl = $('thumbs-gallery-end');
    if (emptyEl) emptyEl.classList.add('hidden');
    if (endEl) endEl.classList.add('hidden');
    _updateGalleryMeta();
    const sentinel = $('thumbs-gallery-sentinel');
    if (sentinel && _scrollObs) _scrollObs.observe(sentinel);
    _loadGalleryPage().catch(() => {});
}

async function _retryTile(tile) {
    if (!tile) return;
    const id = parseInt(tile.dataset.id, 10);
    if (!Number.isFinite(id) || id <= 0) return;
    const retryBtn = tile.querySelector('.thumbs-tile-retry');
    if (retryBtn) retryBtn.disabled = true;
    try {
        await api.post(`/api/maintenance/thumbs/rebuild-one/${id}`, {});
        _bumpImgVersion();
        _refreshTile(tile);
    } catch (e) {
        _dedupToast('retry-fail', e?.data?.error || e?.message || 'Rebuild failed', 'error');
        if (retryBtn) retryBtn.disabled = false;
    }
}

function _wireGallery() {
    if (_galleryWired) return;
    _galleryWired = true;
    _ensureObservers();
    const chips = Array.from(document.querySelectorAll('.thumbs-gallery-kind'));
    chips.forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = btn.dataset.kind || 'all';
            if (kind === _galleryKind) return;
            chips.forEach((c) => {
                c.setAttribute('aria-pressed', c === btn ? 'true' : 'false');
            });
            _resetGallery(kind);
        });
    });
    const grid = $('thumbs-gallery-grid');
    if (grid) {
        // Per-tile retry takes precedence over the wrapping anchor — the
        // retry button stops propagation so the surface click still opens
        // the lightbox. Failed tiles route the click to retry instead of
        // serving a broken image to the viewer.
        grid.addEventListener('click', (e) => {
            const retryBtn = e.target.closest('[data-action="retry"]');
            if (retryBtn) {
                e.preventDefault();
                e.stopPropagation();
                const tile = retryBtn.closest('.thumbs-gallery-tile');
                _retryTile(tile);
                return;
            }
            const tile = e.target.closest('.thumbs-gallery-tile');
            if (!tile) return;
            if (tile.getAttribute('data-failed') === 'true') {
                e.preventDefault();
                _retryTile(tile);
                return;
            }
            // Open in the in-app lightbox (same widget the NSFW review
            // and gallery viewer share) instead of `window.open()`. The
            // viewer handles images / videos / future preview kinds; the
            // file shape it expects is built by `_tileToViewerFile`.
            const file = _tileToViewerFile(tile);
            if (file) openMediaViewerSingle(file);
        });
        // Keyboard activation — Space and Enter both open the lightbox so
        // operators driving with a screen reader get the same affordance.
        grid.addEventListener('keydown', (e) => {
            if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
            const tile = e.target.closest('.thumbs-gallery-tile');
            if (!tile) return;
            e.preventDefault();
            if (tile.getAttribute('data-failed') === 'true') {
                _retryTile(tile);
                return;
            }
            const file = _tileToViewerFile(tile);
            if (file) openMediaViewerSingle(file);
        });
    }
    // Empty-state CTA — start a build right from the empty placeholder so
    // the operator doesn't have to scroll back up to the action row.
    const emptyCta = $('thumbs-gallery-empty-cta');
    if (emptyCta) {
        emptyCta.addEventListener('click', () => _buildAll('all'));
    }
    // Build-by-kind menu — split-button: main button is "Build all", caret
    // opens a small popover for image/video/audio. Click outside to close.
    const kindMenuBtn = $('thumbs-build-kind-btn');
    const kindMenu = $('thumbs-build-kind-menu');
    if (kindMenuBtn && kindMenu) {
        const close = () => kindMenu.classList.add('hidden');
        kindMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            kindMenu.classList.toggle('hidden');
        });
        kindMenu.addEventListener('click', (e) => {
            const it = e.target.closest('[data-kind]');
            if (!it) return;
            close();
            _buildAll(it.dataset.kind || 'all');
        });
        document.addEventListener('click', (e) => {
            if (!kindMenu.contains(e.target) && e.target !== kindMenuBtn) close();
        });
        // Escape closes the menu so keyboard users aren't trapped.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });
    }
    // Cancel button
    const cancelBtn = $('thumbs-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', _cancelBuild);
}

export function init() {
    _wireWs();
    if (!_pageWired) {
        _pageWired = true;
        $('thumbs-build-btn')?.addEventListener('click', () => _buildAll('all'));
        $('thumbs-wipe-btn')?.addEventListener('click', _wipeCache);
    }
    (async () => {
        try {
            const cfg = await api.get('/api/config');
            loadAdvanced(cfg);
        } catch {}
        try {
            setupAutoSave();
        } catch {}
    })();
    _refreshStats();
    _recoverBuildState();
    _wireGallery();
    _resetGallery('all');
}
