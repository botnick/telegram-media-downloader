// AI search result viewer — lightweight modal that previews a single
// result row with "More like this" / tag chips / "Open in original
// location" actions wired in.
//
// Falls back to opening the file URL in a new tab when this isn't a photo.
// The main media viewer (viewer.js) is gallery-driven and expects the
// caller to pre-load `state.files`; rather than reach into that pipeline
// for a single search result we render our own minimal sheet so the
// search experience stays fast + self-contained.

import { escapeHtml } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

let _modalEl = null;
let _ctx = null;

function _ensureModal() {
    if (_modalEl) return _modalEl;
    const el = document.createElement('div');
    el.id = 'ai-result-viewer';
    el.className = 'ai-rv-backdrop hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'ai-rv-title');
    el.innerHTML = `
        <div class="ai-rv-sheet" role="document">
            <button type="button" class="ai-rv-close" data-action="close"
                    aria-label="Close" data-i18n-aria-label="common.close">
                <i class="ri-close-line"></i>
            </button>
            <div class="ai-rv-media-wrap">
                <img class="ai-rv-media" alt="" data-rv-img/>
                <div class="ai-rv-media-fallback hidden" data-rv-fallback>
                    <i class="ri-file-line text-5xl"></i>
                    <p class="text-xs text-tg-textSecondary mt-2" data-rv-fallback-msg></p>
                </div>
            </div>
            <div class="ai-rv-body">
                <h4 id="ai-rv-title" class="ai-rv-title" data-rv-title></h4>
                <p class="ai-rv-group" data-rv-group></p>
                <div class="ai-rv-tags" data-rv-tags></div>
                <div class="ai-rv-actions">
                    <button type="button" class="tg-btn-primary text-xs px-3 py-1.5" data-action="similar">
                        <i class="ri-magic-line"></i>
                        <span data-i18n="maintenance.ai.search.action.similar">More like this</span>
                    </button>
                    <a class="tg-btn-secondary text-xs px-3 py-1.5" data-rv-open target="_blank" rel="noopener">
                        <i class="ri-external-link-line"></i>
                        <span data-i18n="maintenance.ai.search.action.open_original">Open original</span>
                    </a>
                    <button type="button" class="tg-btn-secondary text-xs px-3 py-1.5" data-action="goto-group">
                        <i class="ri-folder-3-line"></i>
                        <span data-i18n="maintenance.ai.search.action.open_in_location">Open in location</span>
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(el);
    _modalEl = el;

    el.addEventListener('click', (e) => {
        // Click on backdrop closes; clicks inside the sheet are handled
        // by their data-action attributes.
        if (e.target === el) { closeResultViewer(); return; }
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'close') { closeResultViewer(); return; }
        if (action === 'similar' && _ctx?.row) {
            const row = _ctx.row;
            closeResultViewer();
            _ctx.onSimilar?.(row);
        } else if (action === 'goto-group' && _ctx?.row) {
            const row = _ctx.row;
            closeResultViewer();
            // Navigate to the group page; gallery scrolls to the row's
            // download id when it picks up the hash fragment.
            try {
                location.hash = `#/viewer/${encodeURIComponent(row.group_id)}?did=${row.download_id}`;
            } catch {}
        }
    });
    document.addEventListener('keydown', (e) => {
        if (_modalEl && !_modalEl.classList.contains('hidden') && e.key === 'Escape') {
            closeResultViewer();
        }
    });
    return el;
}

async function _loadTagsFor(_downloadId) {
    // Per-download tag endpoint is not exposed yet (tags live on the
    // download row server-side but only the global aggregate is wired
    // through to the dashboard). Returning an empty list keeps the row
    // hidden until that endpoint exists, rather than 404-spamming the
    // server on every viewer open.
    return [];
}

function _renderTags(tags) {
    if (!tags?.length) return '';
    return tags.slice(0, 8).map((t) => `
        <button type="button" class="ai-rv-tag" data-tag="${escapeHtml(t.tag || t)}">${escapeHtml(t.tag || t)}</button>
    `).join('');
}

/**
 * Open the result viewer for a single search-result row.
 * @param {object} row  search result shape from /api/ai/search
 * @param {object} ctx
 * @param {(row:object) => void} [ctx.onSimilar]  called when "More like this" is clicked
 * @param {(tag:string) => void} [ctx.onTagClick]
 */
export function openResultViewer(row, ctx = {}) {
    if (!row) return;
    const el = _ensureModal();
    _ctx = { row, ...ctx };

    el.querySelector('[data-rv-title]').textContent = row.file_name || `#${row.download_id}`;
    el.querySelector('[data-rv-group]').textContent = row.group_name || row.group_id || '';
    const img = el.querySelector('[data-rv-img]');
    const fallback = el.querySelector('[data-rv-fallback]');
    const fallbackMsg = el.querySelector('[data-rv-fallback-msg]');
    fallback.classList.add('hidden');
    img.style.display = '';

    const fileType = String(row.file_type || '').toLowerCase();
    if (fileType === 'photo' || fileType === 'image' || fileType === 'images') {
        img.src = `/api/thumbs/${row.download_id}?w=720`;
        img.onerror = () => {
            img.style.display = 'none';
            fallback.classList.remove('hidden');
            fallbackMsg.textContent = i18nT('maintenance.ai.search.preview_unavailable', 'Preview unavailable');
        };
    } else {
        // Show fallback for videos / documents — clicking "Open original"
        // takes the operator to the file in a new tab.
        img.src = `/api/thumbs/${row.download_id}?w=720`;
        img.onerror = () => {
            img.style.display = 'none';
            fallback.classList.remove('hidden');
            fallbackMsg.textContent = i18nTf('maintenance.ai.search.no_image_preview',
                { type: fileType }, `${fileType} — open original to view`);
        };
    }

    const openLink = el.querySelector('[data-rv-open]');
    if (row.file_path) {
        // Strip the data/downloads/ prefix the way /files/ expects it.
        let p = String(row.file_path).replace(/\\/g, '/').replace(/^data\/downloads\//, '');
        openLink.href = `/files/${encodeURIComponent(p)}?inline=1`;
    } else {
        openLink.removeAttribute('href');
    }

    // Tags row — wired to onTagClick.
    const tagsEl = el.querySelector('[data-rv-tags]');
    tagsEl.innerHTML = '';
    _loadTagsFor(row.download_id).then((tags) => {
        const html = _renderTags(tags);
        if (html) tagsEl.innerHTML = html;
        tagsEl.querySelectorAll('.ai-rv-tag').forEach((b) => {
            b.addEventListener('click', () => {
                const tag = b.dataset.tag;
                closeResultViewer();
                ctx.onTagClick?.(tag);
            });
        });
    }).catch(() => {});

    el.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // Move focus into the sheet so keyboard users land on the close btn.
    setTimeout(() => el.querySelector('.ai-rv-close')?.focus(), 30);
}

export function closeResultViewer() {
    if (!_modalEl) return;
    _modalEl.classList.add('hidden');
    document.body.style.overflow = '';
    _ctx = null;
}
