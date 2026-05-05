// Share-link UI module.
//
// Two entry points:
//   - openShareSheet({ downloadId, fileName }) — per-file Share button
//     (viewer modal). Mints + lists + revokes for one file.
//   - openAllSharesSheet() — Maintenance "Active share links" sheet.
//     Audit + bulk-revoke across the whole library.
//
// Both rely on /api/share/links* (admin-only via the chokepoint) and
// share the same row renderer so behavior stays consistent.

import { api } from './api.js';
import { showToast } from './utils.js';
import { openSheet, confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const TTL_OPTIONS = [
    { sec: 3600,             key: 'share.ttl.1h',    label: '1 hour'   },
    { sec: 24 * 3600,        key: 'share.ttl.24h',   label: '24 hours' },
    { sec: 7 * 24 * 3600,    key: 'share.ttl.7d',    label: '7 days'   },
    { sec: 30 * 24 * 3600,   key: 'share.ttl.30d',   label: '30 days'  },
    { sec: 90 * 24 * 3600,   key: 'share.ttl.90d',   label: '90 days'  },
    // 0 = sentinel for "never expires". Revocation still works — the
    // admin can kill the link any time from the Active links list.
    { sec: 0,                key: 'share.ttl.never', label: 'Never'    },
];
const DEFAULT_TTL_SEC = 7 * 24 * 3600;

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function _fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function _relTime(epochMs) {
    if (!epochMs) return i18nT('share.never_opened', 'Never opened');
    const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (diffSec < 60) return i18nT('share.just_now', 'just now');
    if (diffSec < 3600) return i18nTf('share.mins_ago', { n: Math.floor(diffSec / 60) }, `${Math.floor(diffSec / 60)}m ago`);
    if (diffSec < 86400) return i18nTf('share.hours_ago', { n: Math.floor(diffSec / 3600) }, `${Math.floor(diffSec / 3600)}h ago`);
    return i18nTf('share.days_ago', { n: Math.floor(diffSec / 86400) }, `${Math.floor(diffSec / 86400)}d ago`);
}

function _expiryHint(expSec, revokedAt) {
    if (revokedAt) return `<span class="text-red-400">${escapeHtml(i18nT('share.row.revoked', 'Revoked'))}</span>`;
    // expSec === 0 is the sentinel for "never expires" — the link only
    // dies if the admin revokes it (or the underlying file is deleted).
    if (expSec === 0) return `<span class="text-tg-blue">${escapeHtml(i18nT('share.row.never_expires', 'Never expires'))}</span>`;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expSec <= nowSec) return `<span class="text-red-400">${escapeHtml(i18nT('share.row.expired', 'Expired'))}</span>`;
    const remainSec = expSec - nowSec;
    const when = new Date(expSec * 1000).toLocaleString();
    let label;
    if (remainSec < 3600) label = i18nTf('share.expires_in_min', { n: Math.floor(remainSec / 60) }, `Expires in ${Math.floor(remainSec / 60)} min`);
    else if (remainSec < 86400) label = i18nTf('share.expires_in_hr', { n: Math.floor(remainSec / 3600) }, `Expires in ${Math.floor(remainSec / 3600)} hr`);
    else label = i18nTf('share.expires_in_d', { n: Math.floor(remainSec / 86400) }, `Expires in ${Math.floor(remainSec / 86400)} days`);
    return `<span title="${escapeHtml(when)}">${escapeHtml(label)}</span>`;
}

async function _copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback for non-HTTPS contexts where Clipboard API isn't allowed.
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch { return false; }
    }
}

function _renderRow(link, { showFile = false } = {}) {
    // expiresAt === 0 means "never expires" — only revocation can make
    // such a row inactive. Without this short-circuit the row would render
    // as expired immediately (since 0 < Date.now()).
    const isExpired = link.expiresAt !== 0 && (link.expiresAt * 1000) <= Date.now();
    const inactive = !!link.revokedAt || isExpired;
    // Visual status pill — three discrete states (active / expired /
    // revoked). Each gets its own colour so the eye picks out which links
    // still work without parsing the expiry timestamp.
    const stateInfo = link.revokedAt
        ? { cls: 'bg-red-500/15 text-red-400 border-red-500/30',
            iconCls: 'ri-close-circle-line',
            labelKey: 'share.state.revoked', labelFb: 'Revoked' }
        : isExpired
        ? { cls: 'bg-tg-textSecondary/15 text-tg-textSecondary border-tg-border',
            iconCls: 'ri-time-line',
            labelKey: 'share.state.expired', labelFb: 'Expired' }
        : { cls: 'bg-tg-green/15 text-tg-green border-tg-green/30',
            iconCls: 'ri-shield-check-line',
            labelKey: 'share.state.active', labelFb: 'Active' };
    const statePill = `<span class="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${stateInfo.cls}"><i class="${stateInfo.iconCls}"></i>${escapeHtml(i18nT(stateInfo.labelKey, stateInfo.labelFb))}</span>`;
    const labelHtml = link.label
        ? `<span class="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-tg-bg/60 text-tg-textSecondary"><i class="ri-price-tag-3-line"></i>${escapeHtml(link.label)}</span>`
        : '';
    const fileLine = showFile
        ? `<div class="text-sm text-tg-text font-medium truncate" title="${escapeHtml(link.fileName || '')}">${escapeHtml(link.fileName || '(unnamed)')}</div>
           <div class="text-[11px] text-tg-textSecondary truncate flex items-center gap-1"><i class="ri-folder-3-line"></i>${escapeHtml(link.groupName || link.groupId || '—')}</div>`
        : '';
    const accesses = link.accessCount > 0
        ? i18nTf('share.access_count', { n: link.accessCount }, `${link.accessCount} opens`)
        : i18nT('share.never_opened', 'Never opened');
    const lastOpened = link.lastAccessedAt
        ? i18nTf('share.last_opened', { when: _relTime(link.lastAccessedAt) }, `last ${_relTime(link.lastAccessedAt)}`)
        : '';
    const expiryStr = inactive ? '' : _expiryHint(link.expiresAt, link.revokedAt);
    const revokeBtn = inactive
        ? `<button class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-tg-border/50 text-tg-textSecondary opacity-40 cursor-not-allowed" disabled aria-label="${escapeHtml(i18nT('share.revoke', 'Revoke'))}">
              <i class="ri-eraser-line"></i>
           </button>`
        : `<button data-revoke="${link.id}" class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-tg-border text-tg-textSecondary hover:text-red-400 hover:border-red-400/60 hover:bg-red-500/5 transition-colors"
                   title="${escapeHtml(i18nT('share.revoke', 'Revoke'))}" aria-label="${escapeHtml(i18nT('share.revoke', 'Revoke'))}">
              <i class="ri-eraser-line"></i>
           </button>`;
    return `
        <div class="bg-tg-panel/60 hover:bg-tg-panel rounded-lg p-3 border border-tg-border/40 ${inactive ? 'opacity-70' : ''} transition-colors" data-share-row="${link.id}">
            <div class="flex items-start gap-3 mb-2">
                <div class="min-w-0 flex-1">
                    ${fileLine}
                    <div class="flex flex-wrap items-center gap-1.5 mt-1.5">
                        ${statePill}
                        ${labelHtml}
                        ${expiryStr ? `<span class="text-[11px] text-tg-textSecondary inline-flex items-center gap-1"><i class="ri-time-line"></i>${expiryStr}</span>` : ''}
                        <span class="text-[11px] text-tg-textSecondary inline-flex items-center gap-1" title="${escapeHtml(lastOpened)}"><i class="ri-eye-line"></i>${escapeHtml(accesses)}</span>
                    </div>
                </div>
            </div>
            <div class="flex items-center gap-1.5">
                <input type="text" readonly class="tg-input text-[11px] flex-1 min-w-0 font-mono py-1 px-2" value="${escapeHtml(link.url)}" data-url="${link.id}" onfocus="this.select()" onclick="this.select()">
                <button data-copy="${link.id}" class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue/60 hover:bg-tg-blue/5 transition-colors flex-shrink-0"
                        title="${escapeHtml(i18nT('share.copy', 'Copy link'))}" aria-label="${escapeHtml(i18nT('share.copy', 'Copy link'))}">
                    <i class="ri-clipboard-line"></i>
                </button>
                <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue/60 hover:bg-tg-blue/5 transition-colors flex-shrink-0"
                   title="${escapeHtml(i18nT('share.open', 'Open in new tab'))}" aria-label="${escapeHtml(i18nT('share.open', 'Open in new tab'))}">
                    <i class="ri-external-link-line"></i>
                </a>
                ${revokeBtn}
            </div>
        </div>`;
}

function _wireRowActions(root, { onRevoked }) {
    root.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.copy;
            const inp = root.querySelector(`input[data-url="${id}"]`);
            if (!inp) return;
            const ok = await _copyToClipboard(inp.value);
            showToast(ok
                ? i18nT('share.copied', 'Link copied')
                : i18nT('share.copy_failed', 'Could not copy — select the link manually'),
                ok ? 'success' : 'error');
        });
    });
    root.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.revoke;
            const ok = await confirmSheet({
                title: i18nT('share.revoke_title', 'Revoke this link?'),
                body: i18nT('share.revoke_body', 'Anyone holding the link will immediately stop being able to open the file. This cannot be undone — you can issue a new link if you change your mind.'),
                confirmText: i18nT('share.revoke', 'Revoke'),
                destructive: true,
            });
            if (!ok) return;
            try {
                await api.delete(`/api/share/links/${encodeURIComponent(id)}`);
                showToast(i18nT('share.revoked_toast', 'Link revoked'), 'success');
                onRevoked?.(id);
            } catch (e) {
                showToast(e?.data?.error || e.message || 'Failed', 'error');
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────
// Per-file Share sheet (Viewer "Share" button)
// ─────────────────────────────────────────────────────────────────────

export async function openShareSheet({ downloadId, fileName }) {
    if (!downloadId) {
        showToast(i18nT('share.error.no_id', 'No file selected'), 'error');
        return;
    }
    let links = [];
    try {
        const r = await api.get(`/api/share/links?downloadId=${encodeURIComponent(downloadId)}`);
        links = r?.links || [];
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        return;
    }

    const ttlOptionsHtml = TTL_OPTIONS.map((o) => `
        <label class="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border border-tg-border cursor-pointer hover:border-tg-blue/60">
            <input type="radio" name="share-ttl" value="${o.sec}" ${o.sec === DEFAULT_TTL_SEC ? 'checked' : ''}>
            <span data-i18n="${o.key}">${escapeHtml(o.label)}</span>
        </label>`).join('');

    const html = `
        <div class="text-xs text-tg-textSecondary mb-3" data-i18n="share.help">Anyone with the link can open this file without logging in. The link expires automatically and can be revoked at any time.</div>
        <div class="bg-tg-panel rounded-lg p-3 mb-3">
            <div class="text-sm text-tg-text font-medium mb-2 truncate">${escapeHtml(fileName || '')}</div>
            <div class="text-xs text-tg-textSecondary mb-1.5" data-i18n="share.ttl">Link expires in</div>
            <div class="flex flex-wrap gap-1.5 mb-3" id="share-ttl-row">${ttlOptionsHtml}</div>
            <div class="text-xs text-tg-textSecondary mb-1" data-i18n="share.label">Note (optional)</div>
            <input id="share-label-input" type="text" maxlength="80" class="tg-input text-sm w-full mb-3"
                   data-i18n-placeholder="share.label_placeholder" placeholder="e.g. for John">
            <button id="share-mint-btn" class="tg-btn w-full text-sm">
                <i class="ri-link-m mr-1"></i><span data-i18n="share.create">Create share link</span>
            </button>
        </div>
        <div class="text-xs text-tg-textSecondary mb-2" data-i18n="share.existing">Active links</div>
        <div id="share-list" class="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
            ${links.length ? links.map(l => _renderRow(l)).join('')
                : `<div class="text-xs text-tg-textSecondary text-center py-3" data-i18n="share.no_links">No share links yet.</div>`}
        </div>`;

    const sheet = openSheet({
        title: i18nT('share.title', 'Share this file'),
        content: html,
        size: 'lg',
    });
    const root = sheet?.body;
    if (!root) return;

    const refreshList = (newLinks) => {
        const list = root.querySelector('#share-list');
        if (!list) return;
        list.innerHTML = newLinks.length
            ? newLinks.map(l => _renderRow(l)).join('')
            : `<div class="text-xs text-tg-textSecondary text-center py-3">${escapeHtml(i18nT('share.no_links', 'No share links yet.'))}</div>`;
        _wireRowActions(list, {
            onRevoked: (id) => {
                links = links.map(l => String(l.id) === String(id) ? { ...l, revokedAt: Date.now() } : l);
                refreshList(links);
            },
        });
    };
    refreshList(links);

    root.querySelector('#share-mint-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const ttlInput = root.querySelector('input[name="share-ttl"]:checked');
        const ttlSec = parseInt(ttlInput?.value || DEFAULT_TTL_SEC, 10);
        const label = root.querySelector('#share-label-input')?.value?.trim() || null;
        btn.disabled = true;
        try {
            const r = await api.post('/api/share/links', { downloadId, ttlSeconds: ttlSec, label });
            if (r?.link) {
                links = [r.link, ...links];
                refreshList(links);
                // Auto-copy the freshly minted link — most common next action.
                const ok = await _copyToClipboard(r.link.url);
                showToast(ok
                    ? i18nT('share.created_copied', 'Link created and copied')
                    : i18nT('share.created', 'Link created'),
                    'success');
                const labelEl = root.querySelector('#share-label-input');
                if (labelEl) labelEl.value = '';
            }
        } catch (e2) {
            showToast(e2?.data?.error || e2.message || 'Failed', 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

// ─────────────────────────────────────────────────────────────────────
// Maintenance — Active share links across the whole library
// ─────────────────────────────────────────────────────────────────────

export async function openAllSharesSheet() {
    let links = [];
    try {
        const r = await api.get('/api/share/links');
        links = r?.links || [];
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
        return;
    }

    // Tally each link into one of four buckets so the stats strip + the
    // filter chip counts stay in lockstep.
    const tally = () => {
        const now = Date.now();
        let active = 0, expired = 0, revoked = 0;
        for (const l of links) {
            if (l.revokedAt) revoked += 1;
            else if (l.expiresAt !== 0 && l.expiresAt * 1000 <= now) expired += 1;
            else active += 1;
        }
        return { total: links.length, active, expired, revoked };
    };

    const renderList = (filtered) => filtered.length
        ? filtered.map(l => _renderRow(l, { showFile: true })).join('')
        : `<div class="py-10 text-center">
              <i class="ri-link-unlink-m text-4xl text-tg-textSecondary/40"></i>
              <div class="text-sm text-tg-textSecondary mt-2" data-i18n="share.maint.empty_filter">No links match the current filter.</div>
           </div>`;

    const renderStats = (t) => `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <div class="bg-tg-bg/40 rounded-lg p-2.5 text-center">
                <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="share.maint.stat.total">Total</div>
                <div class="text-lg font-semibold text-tg-text tabular-nums">${t.total}</div>
            </div>
            <div class="bg-tg-green/10 border border-tg-green/30 rounded-lg p-2.5 text-center">
                <div class="text-[10px] uppercase text-tg-green/80 tracking-wide" data-i18n="share.maint.stat.active">Active</div>
                <div class="text-lg font-semibold text-tg-green tabular-nums">${t.active}</div>
            </div>
            <div class="bg-tg-bg/40 rounded-lg p-2.5 text-center">
                <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="share.maint.stat.expired">Expired</div>
                <div class="text-lg font-semibold text-tg-textSecondary tabular-nums">${t.expired}</div>
            </div>
            <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-2.5 text-center">
                <div class="text-[10px] uppercase text-red-400/80 tracking-wide" data-i18n="share.maint.stat.revoked">Revoked</div>
                <div class="text-lg font-semibold text-red-400 tabular-nums">${t.revoked}</div>
            </div>
        </div>`;

    const renderFilterChips = (active, t) => {
        const chip = (id, labelKey, labelFb, n, accentCls) => {
            const isOn = active === id;
            const baseCls = 'inline-flex items-center gap-1.5 px-3 h-7 rounded-full text-xs font-medium transition-colors border cursor-pointer';
            const onCls = isOn ? accentCls : 'border-tg-border text-tg-textSecondary hover:text-tg-text hover:bg-tg-hover';
            return `<button type="button" data-share-filter="${id}" class="${baseCls} ${onCls}" aria-pressed="${isOn}">
                <span data-i18n="${labelKey}">${escapeHtml(labelFb)}</span>
                <span class="text-[10px] tabular-nums opacity-80">${n}</span>
            </button>`;
        };
        return `
            <div class="flex flex-wrap items-center gap-1.5">
                ${chip('all',     'share.maint.filter.all',     'All',     t.total,   'bg-tg-blue/15 text-tg-blue border-tg-blue/40')}
                ${chip('active',  'share.maint.filter.active',  'Active',  t.active,  'bg-tg-green/15 text-tg-green border-tg-green/40')}
                ${chip('expired', 'share.maint.filter.expired', 'Expired', t.expired, 'bg-tg-textSecondary/15 text-tg-text border-tg-border')}
                ${chip('revoked', 'share.maint.filter.revoked', 'Revoked', t.revoked, 'bg-red-500/15 text-red-400 border-red-500/40')}
            </div>`;
    };

    let activeFilter = 'active';
    const t0 = tally();

    const html = `
        <div class="share-maint-wrap">
            <!-- Hero strip: brief description so the operator doesn't have
                 to read it on the settings page first; contains the same
                 wording as the settings card help text. -->
            <div class="share-maint-hero">
                <i class="ri-share-forward-2-line share-maint-hero-icon" aria-hidden="true"></i>
                <p class="text-[11px] text-tg-textSecondary leading-relaxed" data-i18n="maintenance.shares.help">View, search, and revoke every shareable media link issued from this dashboard.</p>
            </div>

            <div id="share-maint-stats">${renderStats(t0)}</div>

            <!-- Sticky toolbar so the operator can keep filtering while
                 scrolling a long list. The sheet body itself scrolls; we
                 sticky-position the toolbar to its top. -->
            <div class="share-maint-toolbar">
                <div class="flex items-center gap-2 flex-wrap">
                    <div class="relative flex-1 min-w-[180px]">
                        <i class="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-tg-textSecondary text-sm" aria-hidden="true"></i>
                        <input id="share-maint-search" type="text" class="tg-input text-sm w-full pl-9"
                               data-i18n-placeholder="share.maint.search_placeholder" placeholder="Search filename, group, or note…">
                    </div>
                    <button id="share-maint-revoke-expired" type="button"
                            class="text-xs px-3 h-9 rounded-md border border-tg-border text-tg-textSecondary hover:text-red-400 hover:border-red-400/60 hover:bg-red-500/5 transition-colors inline-flex items-center gap-1.5 ${t0.expired === 0 ? 'opacity-50 cursor-not-allowed' : ''}"
                            ${t0.expired === 0 ? 'disabled' : ''}
                            title="${escapeHtml(i18nT('share.maint.cleanup_help', 'Revoke every link that already expired — keeps the list tidy.'))}">
                        <i class="ri-broom-line" aria-hidden="true"></i>
                        <span data-i18n="share.maint.cleanup">Cleanup expired</span>
                    </button>
                </div>
                <div id="share-maint-filters" class="mt-2">${renderFilterChips(activeFilter, t0)}</div>
            </div>

            <div id="share-maint-list" class="space-y-2 mt-3"></div>
        </div>`;

    const sheet = openSheet({
        title: i18nT('share.maint.sheet_title', 'Active share links'),
        content: html,
        size: 'lg',
    });
    const root = sheet?.body;
    if (!root) return;

    const list = root.querySelector('#share-maint-list');
    const searchEl = root.querySelector('#share-maint-search');
    const filtersEl = root.querySelector('#share-maint-filters');
    const statsEl = root.querySelector('#share-maint-stats');
    const cleanupBtn = root.querySelector('#share-maint-revoke-expired');

    const apply = () => {
        const q = (searchEl?.value || '').trim().toLowerCase();
        const now = Date.now();
        const t = tally();
        if (statsEl) statsEl.innerHTML = renderStats(t);
        if (filtersEl) filtersEl.innerHTML = renderFilterChips(activeFilter, t);
        if (cleanupBtn) {
            const has = t.expired > 0;
            cleanupBtn.classList.toggle('opacity-50', !has);
            cleanupBtn.classList.toggle('cursor-not-allowed', !has);
            cleanupBtn.disabled = !has;
        }
        const filtered = links.filter(l => {
            const isRevoked = !!l.revokedAt;
            const isExpired = !isRevoked && l.expiresAt !== 0 && l.expiresAt * 1000 <= now;
            if (activeFilter === 'active'  && (isRevoked || isExpired)) return false;
            if (activeFilter === 'expired' && !isExpired)               return false;
            if (activeFilter === 'revoked' && !isRevoked)               return false;
            if (!q) return true;
            return [l.fileName, l.groupName, l.label].filter(Boolean)
                .some(s => String(s).toLowerCase().includes(q));
        });
        list.innerHTML = renderList(filtered);
        _wireRowActions(list, {
            onRevoked: (id) => {
                links = links.map(l => String(l.id) === String(id) ? { ...l, revokedAt: Date.now() } : l);
                apply();
            },
        });
    };
    apply();
    searchEl?.addEventListener('input', apply);
    // Filter chip clicks — delegated from the wrapper so re-rendering on
    // tally change doesn't drop bindings.
    filtersEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-share-filter]');
        if (!btn) return;
        activeFilter = btn.dataset.shareFilter;
        apply();
    });
    // Cleanup expired — bulk-revoke every link whose expiry passed. Each
    // call hits its own DELETE so individual failures don't poison the
    // whole batch (network blip / row already revoked from another tab).
    cleanupBtn?.addEventListener('click', async () => {
        const now = Date.now();
        const expired = links.filter(l => !l.revokedAt && l.expiresAt !== 0 && l.expiresAt * 1000 <= now);
        if (!expired.length) return;
        const ok = await import('./sheet.js').then(m => m.confirmSheet({
            title: i18nT('share.maint.cleanup_confirm_title', 'Revoke all expired links?'),
            message: i18nTf('share.maint.cleanup_confirm_body',
                { n: expired.length },
                `Permanently revoke ${expired.length} expired link(s)? Anyone holding them already can't open the file — this just removes them from the list.`),
            confirmLabel: i18nT('share.maint.cleanup', 'Cleanup expired'),
            danger: true,
        }));
        if (!ok) return;
        cleanupBtn.disabled = true;
        const orig = cleanupBtn.innerHTML;
        cleanupBtn.innerHTML = `<i class="ri-loader-4-line animate-spin"></i><span>${escapeHtml(i18nT('common.loading', 'Loading…'))}</span>`;
        let cleaned = 0;
        for (const l of expired) {
            try {
                await api.delete(`/api/share/links/${encodeURIComponent(l.id)}`);
                links = links.map(x => String(x.id) === String(l.id) ? { ...x, revokedAt: Date.now() } : x);
                cleaned += 1;
            } catch { /* keep going; partial cleanup still useful */ }
        }
        cleanupBtn.innerHTML = orig;
        showToast(i18nTf('share.maint.cleanup_done',
            { n: cleaned },
            `Revoked ${cleaned} expired link(s).`),
            cleaned > 0 ? 'success' : 'info');
        apply();
    });
}
