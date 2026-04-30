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
    const rowCls = inactive ? 'opacity-60' : '';
    const labelHtml = link.label
        ? `<span class="text-xs px-1.5 py-0.5 rounded bg-tg-bg/60 text-tg-textSecondary">${escapeHtml(link.label)}</span>`
        : '';
    const fileLine = showFile
        ? `<div class="text-xs text-tg-textSecondary truncate">${escapeHtml(link.fileName || '')} · ${escapeHtml(link.groupName || link.groupId || '')}</div>`
        : '';
    const accesses = link.accessCount > 0
        ? i18nTf('share.access_count', { n: link.accessCount }, `${link.accessCount} opens`)
        : i18nT('share.never_opened', 'Never opened');
    const lastOpened = link.lastAccessedAt
        ? i18nTf('share.last_opened', { when: _relTime(link.lastAccessedAt) }, `last ${_relTime(link.lastAccessedAt)}`)
        : '';
    const revokeBtn = inactive
        ? `<button class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary opacity-50" disabled>
              <i class="ri-eraser-line"></i>
           </button>`
        : `<button data-revoke="${link.id}" class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-red-400 hover:border-red-400/60 transition-colors"
                   title="${escapeHtml(i18nT('share.revoke', 'Revoke'))}" aria-label="${escapeHtml(i18nT('share.revoke', 'Revoke'))}">
              <i class="ri-eraser-line"></i>
           </button>`;
    return `
        <div class="bg-tg-bg/40 rounded-lg p-2 border border-tg-border/40 ${rowCls}" data-share-row="${link.id}">
            <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                    ${fileLine}
                    <div class="text-xs text-tg-textSecondary flex flex-wrap gap-x-2 gap-y-0.5 items-center">
                        ${labelHtml}
                        <span>${_expiryHint(link.expiresAt, link.revokedAt)}</span>
                        <span>·</span>
                        <span>${escapeHtml(accesses)}</span>
                        ${lastOpened ? `<span>·</span><span>${escapeHtml(lastOpened)}</span>` : ''}
                    </div>
                    <div class="mt-1.5 flex gap-1">
                        <input type="text" readonly class="tg-input text-xs flex-1 min-w-0 font-mono" value="${escapeHtml(link.url)}" data-url="${link.id}">
                        <button data-copy="${link.id}" class="text-xs px-2 py-1 rounded-md border border-tg-border text-tg-textSecondary hover:text-tg-blue hover:border-tg-blue transition-colors flex-shrink-0"
                                title="${escapeHtml(i18nT('share.copy', 'Copy link'))}">
                            <i class="ri-clipboard-line"></i>
                        </button>
                        ${revokeBtn}
                    </div>
                </div>
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

    const summary = i18nTf('share.maint.summary',
        { total: links.length },
        `${links.length} share link(s) issued.`);

    const renderList = (filtered) => filtered.length
        ? filtered.map(l => _renderRow(l, { showFile: true })).join('')
        : `<div class="text-xs text-tg-textSecondary text-center py-3" data-i18n="share.no_links">No share links yet.</div>`;

    const html = `
        <div class="text-xs text-tg-textSecondary mb-2">${escapeHtml(summary)}</div>
        <div class="flex items-center gap-2 mb-3">
            <input id="share-maint-search" type="text" class="tg-input text-sm flex-1"
                   data-i18n-placeholder="share.maint.search_placeholder" placeholder="Search filename, group, or note…">
            <label class="text-xs text-tg-textSecondary inline-flex items-center gap-1">
                <input type="checkbox" id="share-maint-active-only" checked>
                <span data-i18n="share.maint.active_only">Active only</span>
            </label>
        </div>
        <div id="share-maint-list" class="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            ${renderList(links.filter(l => !l.revokedAt && (l.expiresAt === 0 || l.expiresAt * 1000 > Date.now())))}
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
    const activeOnly = root.querySelector('#share-maint-active-only');

    const apply = () => {
        const q = (searchEl?.value || '').trim().toLowerCase();
        const onlyActive = !!activeOnly?.checked;
        const now = Date.now();
        const filtered = links.filter(l => {
            if (onlyActive) {
                // Same "never expires" exception as _renderRow — a row
                // with expiresAt=0 is active until explicitly revoked.
                const expired = l.expiresAt !== 0 && l.expiresAt * 1000 <= now;
                if (l.revokedAt || expired) return false;
            }
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
    activeOnly?.addEventListener('change', apply);
}
