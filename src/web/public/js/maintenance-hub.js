// Maintenance hub — single landing page for every admin tool.
//
// The sidebar collapsed from 5+ separate Maintenance entries into one,
// to keep both the desktop sidebar and the mobile bottom-nav from being
// cluttered. This page makes the tools discoverable as a card grid:
// each card has icon + title + 1-line description + "Open" button + a
// live status pill so the operator can spot at-a-glance which tools
// have something running.
//
// Cards link to the existing per-feature deep routes, so power users
// keep their muscle memory: /maintenance/duplicates, /maintenance/nsfw,
// etc. all still resolve directly to those pages.

import { ws } from './ws.js';
import { api } from './api.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { escapeHtml } from './utils.js';

let _wired = false;
let _wsWired = false;
const _live = new Map(); // tool slug → { running, label }

const TOOLS = [
    {
        slug: 'duplicates',
        i18nTitle: 'maintenance.hub.duplicates.title',
        defaultTitle: 'Find duplicate files',
        i18nBody: 'maintenance.hub.duplicates.body',
        defaultBody: 'Hash every file and reclaim space from byte-identical copies.',
        icon: 'ri-file-copy-2-line',
        accent: 'orange',
        statusUrl: '/api/maintenance/dedup/status',
        wsEvents: ['dedup_progress', 'dedup_done'],
    },
    {
        slug: 'thumbs',
        i18nTitle: 'maintenance.hub.thumbs.title',
        defaultTitle: 'Build thumbnails',
        i18nBody: 'maintenance.hub.thumbs.body',
        defaultBody: 'Generate WebP previews for every catalogued file.',
        icon: 'ri-image-2-line',
        accent: 'blue',
        statusUrl: '/api/maintenance/thumbs/build/status',
        wsEvents: ['thumbs_progress', 'thumbs_done'],
    },
    {
        slug: 'seekbar',
        i18nTitle: 'maintenance.hub.seekbar.title',
        defaultTitle: 'Seekbar previews',
        i18nBody: 'maintenance.hub.seekbar.body',
        defaultBody:
            'WebP sprite-sheet hover previews on the video player seek bar. Auto-spawns a Go sidecar; falls back to in-process ffmpeg.',
        icon: 'ri-movie-line',
        accent: 'blue',
        statusUrl: '/api/maintenance/seekbar/build/status',
        wsEvents: ['seekbar_progress', 'seekbar_done'],
    },
    {
        slug: 'video',
        i18nTitle: 'maintenance.hub.video.title',
        defaultTitle: 'Optimise videos for streaming',
        i18nBody: 'maintenance.hub.video.body',
        defaultBody:
            'Rewrite MP4s with `+faststart` so the player can seek + play audio without buffering the whole file.',
        icon: 'ri-film-line',
        accent: 'blue',
        statusUrl: '/api/maintenance/faststart/status',
        wsEvents: ['faststart_progress', 'faststart_done'],
    },
    {
        slug: 'nsfw',
        i18nTitle: 'maintenance.hub.nsfw.title',
        defaultTitle: 'NSFW review',
        i18nBody: 'maintenance.hub.nsfw.body',
        defaultBody: 'Five-tier classifier — keep what is confidently 18+, delete what is not.',
        icon: 'ri-alarm-warning-line',
        accent: 'red',
        statusUrl: '/api/maintenance/nsfw/status',
        wsEvents: ['nsfw_progress', 'nsfw_done'],
    },
    {
        slug: 'ai',
        i18nTitle: 'maintenance.hub.ai.title',
        defaultTitle: 'AI face clustering',
        i18nBody: 'maintenance.hub.ai.body',
        defaultBody:
            'Face clustering via a local Python sidecar (insightface buffalo_l) — opt-in, no upload.',
        icon: 'ri-sparkling-2-line',
        accent: 'blue',
        statusUrl: '/api/ai/status',
        wsEvents: ['ai_people_progress', 'ai_people_done'],
    },
    {
        slug: 'logs',
        i18nTitle: 'maintenance.hub.logs.title',
        defaultTitle: 'Log viewer',
        i18nBody: 'maintenance.hub.logs.body',
        defaultBody: 'Realtime tail of every backend log source — no docker logs needed.',
        icon: 'ri-terminal-box-line',
        accent: 'purple',
        statusUrl: null, // logs is read-only; no running state
        wsEvents: [],
    },
    {
        slug: 'backup',
        i18nTitle: 'maintenance.hub.backup.title',
        defaultTitle: 'Backup destinations',
        i18nBody: 'maintenance.hub.backup.body',
        defaultBody: 'NAS / S3 / SFTP / Google Drive / Dropbox mirror + scheduled snapshots.',
        icon: 'ri-cloud-line',
        accent: 'green',
        statusUrl: null, // multi-destination — hub card just opens the page
        wsEvents: ['backup_progress', 'backup_done', 'backup_error'],
    },
    {
        slug: 'cluster',
        i18nTitle: 'maintenance.hub.cluster.title',
        defaultTitle: 'Cluster mode',
        i18nBody: 'maintenance.hub.cluster.body',
        defaultBody:
            'Pair multiple instances so they federate downloads, gallery, and dedup. Each peer keeps its own data; the dashboard sees them as one library.',
        icon: 'ri-broadcast-line',
        accent: 'blue',
        statusUrl: null, // peer list — hub card just opens the page
        wsEvents: ['peer_added', 'peer_removed', 'peer_status'],
    },
    {
        slug: 'recovery',
        i18nTitle: 'maintenance.hub.recovery.title',
        defaultTitle: 'Recovery cleanup',
        i18nBody: 'maintenance.hub.recovery.body',
        defaultBody:
            'Resolve, disable, or delete groups that no loaded Telegram account can access — typically residue from npm run recover.',
        icon: 'ri-first-aid-kit-line',
        accent: 'pink',
        // Special status URL with countOnly=1 so the hub paints a red badge
        // with the unresolved count + auto-hides the tile when clean.
        statusUrl: '/api/maintenance/recovery/list?countOnly=1',
        statusIsCount: true,
        hideWhenZero: true,
        wsEvents: ['recovery_bulk_progress', 'recovery_bulk_done'],
    },
    {
        slug: 'updates',
        i18nTitle: 'maintenance.hub.updates.title',
        defaultTitle: 'Updates',
        i18nBody: 'maintenance.hub.updates.body',
        defaultBody:
            'Install the latest release in one click and audit every past attempt — what failed, when, and why.',
        icon: 'ri-download-cloud-2-line',
        accent: 'blue',
        statusUrl: '/api/auto-update/status',
        wsEvents: ['update_progress', 'update_done', 'update_started'],
    },
];

const ACCENT_BG = {
    orange: 'bg-tg-orange/15 text-tg-orange',
    blue: 'bg-tg-blue/15 text-tg-blue',
    red: 'bg-red-500/15 text-red-300',
    purple: 'bg-purple-500/15 text-purple-300',
    green: 'bg-green-500/15 text-green-300',
    violet: 'bg-violet-500/15 text-violet-300',
    pink: 'bg-pink-500/15 text-pink-300',
};

function _renderCard(tool) {
    const live = _live.get(tool.slug);
    // Tools that use a count-based status (Recovery cleanup) hide the
    // tile entirely when the count is zero — keeps the maintenance hub
    // clean for the common case where there's nothing to clean up.
    if (tool.hideWhenZero && live && (live.count || 0) === 0) return '';
    const running = !!live?.running;
    const accent = ACCENT_BG[tool.accent] || ACCENT_BG.blue;
    let pill;
    if (tool.statusIsCount && live && live.count > 0) {
        pill = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-red-500/15 text-red-300 font-medium tabular-nums">
                <i class="ri-error-warning-line"></i>
                ${escapeHtml(String(live.count))}
            </span>`;
    } else if (running) {
        pill = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-tg-blue/15 text-tg-blue">
                <span class="w-1.5 h-1.5 rounded-full bg-tg-blue animate-pulse"></span>
                ${escapeHtml(i18nT('maintenance.hub.state.running', 'Running'))}
            </span>`;
    } else {
        pill = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-tg-bg/40 text-tg-textSecondary">
                ${escapeHtml(i18nT('maintenance.hub.state.idle', 'Idle'))}
            </span>`;
    }
    return `
        <a href="#/maintenance/${tool.slug}" class="hub-card group bg-tg-panel rounded-xl p-4 border border-tg-border/40 hover:border-tg-blue/40 transition-colors flex flex-col gap-3" data-tool="${tool.slug}">
            <div class="flex items-center justify-between gap-2">
                <div class="w-10 h-10 rounded-xl ${accent} flex items-center justify-center text-xl shrink-0">
                    <i class="${tool.icon}"></i>
                </div>
                ${pill}
            </div>
            <div class="flex-1 min-w-0">
                <h3 class="text-tg-text text-base font-semibold mb-1 truncate" data-i18n="${tool.i18nTitle}">${escapeHtml(tool.defaultTitle)}</h3>
                <p class="text-xs text-tg-textSecondary leading-relaxed line-clamp-3" data-i18n="${tool.i18nBody}">${escapeHtml(tool.defaultBody)}</p>
            </div>
            <div class="flex items-center justify-end gap-1 text-xs text-tg-blue group-hover:translate-x-0.5 transition-transform">
                <span data-i18n="maintenance.hub.open">Open</span>
                <i class="ri-arrow-right-s-line"></i>
            </div>
        </a>`;
}

function _renderGrid() {
    const grid = document.getElementById('hub-grid');
    if (!grid) return;
    grid.innerHTML = TOOLS.map(_renderCard).join('');
}

async function _refreshLive() {
    await Promise.all(
        TOOLS.filter((t) => t.statusUrl).map(async (t) => {
            try {
                const r = await api.get(t.statusUrl);
                if (t.statusIsCount) {
                    // The recovery tile uses the response's `total` as a
                    // count badge instead of a running flag.
                    _live.set(t.slug, {
                        running: false,
                        count: Number(r?.total) || 0,
                    });
                } else {
                    _live.set(t.slug, { running: !!(r && r.running) });
                }
            } catch {
                /* status endpoint failures are non-fatal */
            }
        }),
    );
    _renderGrid();
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    // A single coarse listener: any progress / done event from any of
    // the wired tools refreshes the matching card's pill.
    for (const tool of TOOLS) {
        for (const evt of tool.wsEvents) {
            ws.on(evt, (m) => {
                const running = evt.endsWith('_progress') ? true : m?.running === true;
                _live.set(tool.slug, { running });
                // Throttle re-render so a chatty progress stream doesn't
                // re-paint the grid 60×/second. Use a coalescing timer.
                if (!_wireWs._t) {
                    _wireWs._t = setTimeout(() => {
                        _wireWs._t = null;
                        _renderGrid();
                    }, 200);
                }
            });
        }
    }
}

export function init() {
    if (!_wired) {
        _wired = true;
        _wireWs();
    }
    _renderGrid();
    _refreshLive();
}
