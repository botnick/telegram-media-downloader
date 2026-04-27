// Shared SPA components — small builder helpers that produce the same
// row / empty-state / skeleton markup used in multiple places. Keeping
// these in one module means the sidebar, the dialogs picker, the
// accounts list and the engine's "live downloads" list all stay in sync
// when we change the look.

import { createAvatar, escapeHtml, formatRelativeTime } from './utils.js';

/**
 * Telegram-style chat row.
 *
 *   renderChatRow({
 *       id, name, subtitle, time,
 *       avatarType,                 // 'channel' | 'group' | 'user' | 'bot'
 *       avatarRing,                 // 'downloading' | 'active' | null
 *       avatarDot,                  // 'monitor' | 'queue' | 'error' | null
 *       avatarSize,                 // 'sm' | 'md' | 'lg' | 'xl'
 *       unread,                     // number | string | null
 *       statusPill,                 // { label, kind: 'active'|'paused'|'add' } | null
 *       selected,                   // bool — Telegram "selected chat" highlight
 *       lastDownloadAt,             // ISO/ms — used to derive `time` if not given
 *       data,                       // extra dataset attributes ({ key: val, ... })
 *       cog,                        // bool — render a cog button on the right
 *                                   // (action="settings" data attr) for one-tap
 *                                   // access to per-group settings
 *   })
 *
 * Returns an HTML string. The caller is responsible for attaching click
 * handlers (event delegation against `.chat-row[data-id]` is the usual
 * pattern).
 */
export function renderChatRow(opts) {
    const {
        id, name, subtitle = '',
        avatarType, avatarRing = null, avatarDot = null, avatarSize = 'lg',
        unread = null, unreadMuted = false,
        statusPill = null,
        selected = false,
        time, lastDownloadAt,
        data = {},
        cog = false,
    } = opts;

    const avatar = createAvatar({
        id, name, type: avatarType,
        ring: avatarRing, dot: avatarDot, size: avatarSize,
    });

    const t = time || (lastDownloadAt ? formatRelativeTime(lastDownloadAt) : '');

    const datasetAttrs = Object.entries({ id, ...data })
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `data-${k}="${escapeHtml(String(v))}"`)
        .join(' ');

    const meta = [];
    if (t) meta.push(`<span>${escapeHtml(t)}</span>`);
    if (statusPill) {
        const cls = `status-pill status-pill-${statusPill.kind || 'add'}`;
        meta.push(`<span class="${cls}">${escapeHtml(statusPill.label)}</span>`);
    }
    if (unread != null && unread !== 0) {
        const muted = unreadMuted ? ' muted' : '';
        meta.push(`<span class="unread-pill${muted}">${escapeHtml(String(unread))}</span>`);
    }

    const cogBtn = cog
        ? `<button class="chat-row-cog ml-2 w-8 h-8 inline-flex items-center justify-center rounded-full text-tg-textSecondary hover:bg-tg-hover hover:text-tg-text transition shrink-0"
                  data-action="settings" aria-label="Group settings" title="Group settings"
                  type="button">
              <i class="ri-settings-3-line text-base" aria-hidden="true"></i>
          </button>`
        : '';

    return `
        <div class="chat-row${selected ? ' is-selected' : ''}" ${datasetAttrs} role="button" tabindex="0">
            ${avatar}
            <div class="row-text">
                <div class="row-title">
                    <span class="row-title-name">${escapeHtml(String(name || id))}</span>
                </div>
                ${subtitle ? `<div class="row-subtitle">${escapeHtml(subtitle)}</div>` : ''}
            </div>
            ${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}
            ${cogBtn}
        </div>`;
}

/**
 * A friendly empty-state with an icon, heading, optional body and a primary
 * call-to-action.
 *
 *   renderEmptyState({
 *       icon: 'ri-image-line',
 *       title: 'No media yet',
 *       body: 'Pick a chat in the sidebar to start downloading.',
 *       actionLabel: 'Browse chats',
 *       actionHref: '#/groups',  // or actionOnClick
 *   })
 */
export function renderEmptyState({ icon = 'ri-information-line', title, body = '', actionLabel, actionHref, actionId } = {}) {
    const action = actionLabel
        ? (actionHref
            ? `<a href="${escapeHtml(actionHref)}" class="tg-btn inline-flex items-center gap-2 mt-4 px-4 py-2"><i class="ri-arrow-right-line"></i>${escapeHtml(actionLabel)}</a>`
            : `<button id="${escapeHtml(actionId || 'empty-cta')}" class="tg-btn inline-flex items-center gap-2 mt-4 px-4 py-2" type="button"><i class="ri-arrow-right-line"></i>${escapeHtml(actionLabel)}</button>`)
        : '';
    return `
        <div class="flex flex-col items-center justify-center text-center px-6 py-12 text-tg-textSecondary">
            <i class="${escapeHtml(icon)} text-5xl mb-3" aria-hidden="true"></i>
            <h3 class="text-tg-text font-medium text-base">${escapeHtml(title || '')}</h3>
            ${body ? `<p class="text-sm mt-1 max-w-sm">${escapeHtml(body)}</p>` : ''}
            ${action}
        </div>`;
}

/** Square skeleton tile for the gallery first-paint. */
export function renderGallerySkeletons(count = 12) {
    return new Array(count).fill(0).map(() =>
        `<div class="aspect-square bg-tg-panel rounded skeleton" aria-hidden="true"></div>`
    ).join('');
}

/** Chat-row sized skeleton for the sidebar / dialog list. */
export function renderRowSkeletons(count = 6) {
    return new Array(count).fill(0).map(() => `
        <div class="chat-row" aria-hidden="true">
            <div class="rounded-full skeleton" style="width:48px;height:48px;flex-shrink:0"></div>
            <div class="row-text">
                <div class="skeleton" style="height:14px;width:60%;border-radius:4px;margin-bottom:6px"></div>
                <div class="skeleton" style="height:11px;width:40%;border-radius:4px"></div>
            </div>
        </div>`).join('');
}
