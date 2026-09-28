// Tools — the maintenance tools regrouped under Settings.
//
//   • Settings → Tools card (#settings-tools): what needs attention, then
//     the four groups. The checks are cheap reads of endpoints the tool
//     pages already use (in-memory job trackers, small tables, kv), run
//     once the card is near the viewport and cached for a minute.
//   • Group page (#page-maintenance, #/settings/tools/<group>): one card
//     per tool with its live status, an inline run / stop button and an
//     Open link to the tool's full page (the existing maintenance-* page
//     modules, unchanged, shown with the group's tab strip).

import { api } from './api.js';
import { ws } from './ws.js';
import { t as i18nT, tf as i18nTf, onLanguageChange } from './i18n.js';
import { escapeHtml, formatBytes, showToast } from './utils.js';
import { TOOL_GROUPS, TOOLS, getGroup, groupOfTool, toolHref, groupHref } from './tools-catalog.js';

const $ = (id) => document.getElementById(id);
const tr = (pair) => i18nT(pair[0], pair[1]);

// ------------------------------------------------------------------ helpers

function ago(ts) {
    const t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(t)) return '';
    const lang = document.documentElement.lang || 'en';
    const diff = Math.round((t - Date.now()) / 1000);
    const abs = Math.abs(diff);
    if (abs < 60) return i18nT('tools.status.just_now', 'just now');
    try {
        const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
        if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
        if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
        return rtf.format(Math.round(diff / 86400), 'day');
    } catch {
        return new Date(t).toLocaleString();
    }
}
const num = (n) => Number(n || 0).toLocaleString();
const lastRun = (ts) => i18nTf('tools.status.last_run', { when: ago(ts) }, `Last run ${ago(ts)}`);
const never = () => i18nT('tools.status.never', 'Never run');

// { done, total } out of a job-tracker snapshot or progress event.
function countsOf(m) {
    if (!m) return null;
    const p = m.progress && typeof m.progress === 'object' ? m.progress : {};
    const done = m.processed ?? m.scanned ?? m.done ?? p.processed ?? p.scanned ?? p.done;
    const total = m.total ?? p.total;
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
    return { done: Math.min(done, total), total };
}
function pctOf(m) {
    const c = countsOf(m);
    return c ? Math.max(0, Math.min(100, Math.round((c.done / c.total) * 100))) : null;
}

async function get(url) {
    try {
        return await api.get(url);
    } catch {
        return null;
    }
}

// ------------------------------------------------------------ tool status
//
// Each loader returns { running, pct, line, tone, off, attention?, run?,
// stop? }. `tone` colours the status line ('ok' | 'warn' | 'bad' |
// 'muted'). `attention` is a one-line problem for the Tools card.
// `run` is the inline action ({ label, icon, go() }); without one the
// card's Open link is the primary action.

const RUN = {
    scan: () => i18nT('tools.run.scan', 'Scan'),
    build: () => i18nT('tools.run.build', 'Build'),
    optimise: () => i18nT('tools.run.optimise', 'Optimise'),
    backup: () => i18nT('tools.run.backup', 'Back up now'),
    sync: () => i18nT('tools.run.sync', 'Sync now'),
    check: () => i18nT('tools.run.check', 'Check now'),
    retry: () => i18nT('tools.run.retry', 'Retry'),
};

const LOADERS = {
    async duplicates() {
        const [st, stats] = await Promise.all([
            get('/api/maintenance/dedup/status'),
            get('/api/maintenance/dedup/stats'),
        ]);
        const last = stats?.lastScan;
        let line = never();
        let tone = 'muted';
        if (last?.finishedAt) {
            if (last.extraCopies > 0) {
                line = i18nTf(
                    'tools.dup.found',
                    { n: num(last.extraCopies), size: formatBytes(last.reclaimableBytes || 0) },
                    `${num(last.extraCopies)} duplicate copies · ${formatBytes(last.reclaimableBytes || 0)}`,
                );
                tone = 'warn';
            } else {
                line = `${i18nT('tools.dup.none', 'No duplicates')} · ${lastRun(last.finishedAt)}`;
                tone = 'ok';
            }
        } else if (stats?.missing > 0) {
            line = i18nTf(
                'tools.dup.unchecked',
                { n: num(stats.missing) },
                `${num(stats.missing)} files not checked yet`,
            );
        }
        return {
            running: !!st?.running,
            pct: pctOf(st),
            counts: countsOf(st),
            line,
            tone,
            run: { label: RUN.scan(), icon: 'ri-search-line', url: '/api/maintenance/dedup/scan' },
            stop: '/api/maintenance/dedup/scan/stop',
        };
    },

    async thumbs() {
        const [st, stats] = await Promise.all([
            get('/api/maintenance/thumbs/build/status'),
            get('/api/maintenance/thumbs/build/stats'),
        ]);
        const last = stats?.lastRun;
        let line = never();
        let tone = 'muted';
        let attention = null;
        if (last?.finishedAt) {
            if (last.errored > 0) {
                const failed = i18nTf(
                    'tools.thumbs.failed',
                    { n: num(last.errored) },
                    `${num(last.errored)} failed in the last build`,
                );
                line = `${failed} · ${lastRun(last.finishedAt)}`;
                tone = 'warn';
                attention = {
                    text: i18nTf(
                        'tools.attn.thumbs_failed',
                        { n: num(last.errored) },
                        `${num(last.errored)} thumbnails failed to build`,
                    ),
                    tone: 'warn',
                    run: true,
                    label: RUN.retry(),
                };
            } else {
                line = `${i18nTf('tools.thumbs.built', { n: num(last.built) }, `${num(last.built)} built`)} · ${lastRun(last.finishedAt)}`;
                tone = 'ok';
            }
        }
        return {
            running: !!st?.running,
            pct: pctOf(st),
            counts: countsOf(st),
            line,
            tone,
            attention,
            run: {
                label: RUN.build(),
                icon: 'ri-hammer-line',
                url: '/api/maintenance/thumbs/build-all',
                body: { kind: 'all' },
            },
            stop: '/api/maintenance/thumbs/build/cancel',
        };
    },

    async seekbar() {
        const [st, stats] = await Promise.all([
            get('/api/maintenance/seekbar/build/status'),
            get('/api/maintenance/seekbar/stats'),
        ]);
        const total = Number(stats?.totalVideos || 0);
        const done = Number(stats?.count || 0);
        let line = i18nT('tools.seekbar.no_videos', 'No videos yet');
        let tone = 'muted';
        if (total > 0) {
            line = i18nTf(
                'tools.seekbar.coverage',
                { done: num(Math.min(done, total)), total: num(total) },
                `${num(Math.min(done, total))} of ${num(total)} videos have previews`,
            );
            tone = done >= total ? 'ok' : 'muted';
        }
        return {
            running: !!st?.running,
            pct: pctOf(st),
            counts: countsOf(st),
            line,
            tone,
            run: {
                label: RUN.build(),
                icon: 'ri-hammer-line',
                url: '/api/maintenance/seekbar/build-all',
            },
            stop: '/api/maintenance/seekbar/build/cancel',
        };
    },

    async video() {
        const [st, auto] = await Promise.all([
            get('/api/maintenance/faststart/status'),
            get('/api/maintenance/faststart/auto-stats'),
        ]);
        let line = i18nT('tools.video.auto_on', 'New videos are optimised as they download');
        let tone = 'muted';
        const res = st?.result;
        if (st?.finishedAt && res && typeof res === 'object') {
            line = `${i18nTf('tools.video.optimised', { n: num(res.optimized) }, `${num(res.optimized)} optimised`)} · ${lastRun(st.finishedAt)}`;
            tone = 'ok';
        } else if (auto?.optimized > 0) {
            line = i18nTf(
                'tools.video.auto',
                { n: num(auto.optimized) },
                `${num(auto.optimized)} optimised automatically`,
            );
            tone = 'ok';
        }
        if (auto && auto.ffmpegAvailable === false) {
            line = i18nT('tools.video.no_ffmpeg', 'ffmpeg is missing on this server');
            tone = 'warn';
        }
        return {
            running: !!st?.running,
            pct: pctOf(st),
            counts: countsOf(st),
            line,
            tone,
            run: {
                label: RUN.optimise(),
                icon: 'ri-flashlight-line',
                url: '/api/maintenance/faststart/scan',
            },
        };
    },

    async nsfw() {
        const s = await get('/api/maintenance/nsfw/status');
        if (!s) return { line: '', tone: 'muted' };
        if (!s.enabled) {
            return {
                off: true,
                line: i18nT('tools.status.off', 'Off — open the tool to turn it on'),
                tone: 'muted',
            };
        }
        let line =
            s.finishedAt || s.lastCheckedAt ? lastRun(s.finishedAt || s.lastCheckedAt) : never();
        let tone = 'muted';
        let attention = null;
        if (s.error) {
            line = String(s.error);
            tone = 'bad';
        } else if (s.candidates > 0) {
            line = i18nTf(
                'tools.nsfw.review',
                { n: num(s.candidates) },
                `${num(s.candidates)} to review`,
            );
            tone = 'warn';
            attention = {
                text: i18nTf(
                    'tools.attn.nsfw_review',
                    { n: num(s.candidates) },
                    `${num(s.candidates)} photos may not be 18+`,
                ),
                tone: 'warn',
                label: i18nT('tools.run.review', 'Review'),
            };
        }
        return {
            running: !!s.running,
            pct: pctOf(s),
            counts: countsOf(s),
            line,
            tone,
            attention,
            run: { label: RUN.scan(), icon: 'ri-search-line', url: '/api/maintenance/nsfw/scan' },
            stop: '/api/maintenance/nsfw/scan/cancel',
        };
    },

    async ai() {
        const s = await get('/api/ai/status');
        if (!s) return { line: '', tone: 'muted' };
        const cfg = s.config || {};
        if (!cfg.enabled || cfg.faceClustering === false) {
            return {
                off: true,
                line: i18nT('tools.status.off', 'Off — open the tool to turn it on'),
                tone: 'muted',
            };
        }
        const scan = s.scans?.faces || {};
        // The status endpoint asks the sidecar for /info; no answer → the
        // provider list stays empty.
        const offline = s.models?.faces?.providers == null;
        const c = s.counts || {};
        let line = i18nTf(
            'tools.faces.indexed',
            { done: num(c.indexed), total: num(c.totalEligible) },
            `${num(c.indexed)} of ${num(c.totalEligible)} photos indexed`,
        );
        let tone = 'muted';
        let attention = null;
        if (offline) {
            line = i18nT('tools.faces.offline', 'Faces sidecar is offline');
            tone = 'bad';
            attention = {
                text: line,
                tone: 'bad',
                label: i18nT('maintenance.hub.open', 'Open'),
            };
        }
        return {
            running: !!scan.running,
            pct: pctOf(scan),
            counts: countsOf(scan),
            line,
            tone,
            attention,
            run: offline
                ? null
                : {
                      label: RUN.scan(),
                      icon: 'ri-search-line',
                      url: '/api/ai/scan/start',
                      body: { feature: 'faces' },
                  },
            stop: { url: '/api/ai/scan/cancel', body: { feature: 'faces' } },
        };
    },

    async backup() {
        const r = await get('/api/backup/destinations');
        const dests = Array.isArray(r?.destinations) ? r.destinations : [];
        if (!dests.length) {
            return { line: i18nT('tools.backup.none', 'No destinations yet'), tone: 'muted' };
        }
        const ts = (v) => (v == null ? 0 : typeof v === 'number' ? v : Date.parse(v) || 0);
        const enabled = dests.filter((d) => d.enabled);
        const failed = enabled.filter(
            (d) => ts(d.last_failure_at) > ts(d.last_success_at) && ts(d.last_failure_at) > 0,
        );
        let lastOk = 0;
        for (const d of dests) lastOk = Math.max(lastOk, ts(d.last_success_at));
        let line = i18nTf(
            'tools.backup.count',
            { n: dests.length },
            `${dests.length} destination(s)`,
        );
        let tone = 'muted';
        let attention = null;
        if (failed.length) {
            const name = failed[0].name || `#${failed[0].id}`;
            line = i18nTf('tools.attn.backup_failed', { name }, `Backup to ${name} failed`);
            tone = 'bad';
            attention = { text: line, tone: 'bad', label: i18nT('maintenance.hub.open', 'Open') };
        } else if (lastOk) {
            line = i18nTf('tools.backup.last', { when: ago(lastOk) }, `Last backup ${ago(lastOk)}`);
            tone = 'ok';
        }
        return {
            line,
            tone,
            attention,
            run: enabled.length
                ? {
                      label: RUN.backup(),
                      icon: 'ri-upload-cloud-2-line',
                      go: () =>
                          Promise.all(
                              enabled.map((d) =>
                                  api.post(`/api/backup/destinations/${d.id}/run`, {}),
                              ),
                          ),
                  }
                : null,
        };
    },

    async cluster() {
        const r = await get('/api/cluster/peers');
        const peers = (Array.isArray(r?.peers) ? r.peers : []).filter(
            (p) => p.status !== 'revoked',
        );
        if (!peers.length) {
            return { line: i18nT('tools.cluster.none', 'No peers paired'), tone: 'muted' };
        }
        const seen = (p) =>
            p.lastSeenAt
                ? typeof p.lastSeenAt === 'number'
                    ? p.lastSeenAt
                    : Date.parse(p.lastSeenAt)
                : 0;
        // Same thresholds as the Cluster page: seen in the last 10 min.
        const offline = peers.filter(
            (p) => p.status !== 'paired_pending' && Date.now() - seen(p) > 10 * 60e3,
        );
        const online = peers.length - offline.length;
        const line = i18nTf(
            'tools.cluster.online',
            { online, total: peers.length },
            `${online} of ${peers.length} peers online`,
        );
        let attention = null;
        if (offline.length) {
            const name = offline[0].name || offline[0].peerId || '';
            attention = {
                text: i18nTf('tools.attn.peer_offline', { name }, `Peer ${name} is offline`),
                tone: 'warn',
                label: i18nT('maintenance.hub.open', 'Open'),
            };
        }
        return {
            line,
            tone: offline.length ? 'warn' : 'ok',
            attention,
            run: {
                label: RUN.sync(),
                icon: 'ri-refresh-line',
                url: '/api/cluster/sweep/run',
            },
        };
    },

    async logs() {
        const r = await get('/api/maintenance/logs/recent?level=error&limit=500');
        const hourAgo = Date.now() - 3600e3;
        const n = (Array.isArray(r?.logs) ? r.logs : []).filter(
            (e) => (e.ts || 0) > hourAgo,
        ).length;
        if (!n) {
            return { line: i18nT('tools.logs.clean', 'No errors in the last hour'), tone: 'ok' };
        }
        const line = i18nTf(
            'tools.logs.errors',
            { n: num(n) },
            `${num(n)} errors in the last hour`,
        );
        return {
            line,
            tone: 'warn',
            attention: {
                text: line,
                tone: 'warn',
                label: i18nT('tools.run.view', 'View'),
            },
        };
    },

    async updates(opts = {}) {
        const v = await get(`/api/version/check${opts.force ? '?force=1' : ''}`);
        if (!v) return { line: '', tone: 'muted' };
        let line = i18nTf(
            'tools.updates.current',
            { v: v.current || '' },
            `Up to date · ${v.current || ''}`,
        );
        let tone = 'ok';
        let attention = null;
        if (v.updateAvailable && v.latest) {
            line = i18nTf('tools.updates.available', { v: v.latest }, `${v.latest} is available`);
            tone = 'warn';
            attention = {
                text: line,
                tone: 'info',
                label: i18nT('maintenance.hub.open', 'Open'),
            };
        }
        return {
            line,
            tone,
            attention,
            run: { label: RUN.check(), icon: 'ri-refresh-line', check: true },
        };
    },

    async recovery() {
        const r = await get('/api/maintenance/recovery/list?countOnly=1');
        const n = Number(r?.total || 0);
        if (!n) return { line: i18nT('tools.recovery.clean', 'Nothing to clean up'), tone: 'ok' };
        const line = i18nTf(
            'tools.recovery.count',
            { n: num(n) },
            `${num(n)} chats no account can open`,
        );
        return {
            line,
            tone: 'warn',
            attention: {
                text: line,
                tone: 'warn',
                label: i18nT('tools.run.review', 'Review'),
            },
        };
    },
};

// Tools that run a background job (and so have an Idle / Running state).
const JOB_TOOLS = new Set(['duplicates', 'thumbs', 'seekbar', 'video', 'nsfw', 'ai']);

// Tools whose loaders are cheap enough for the Tools card's checks.
const ATTENTION_TOOLS = [
    'ai',
    'backup',
    'nsfw',
    'cluster',
    'recovery',
    'thumbs',
    'logs',
    'updates',
];

const _info = new Map(); // tool → { at, info }
const CACHE_MS = 60_000;

async function loadInfo(tool, { fresh = false, force = false } = {}) {
    const hit = _info.get(tool);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.info;
    let info;
    try {
        info = (await LOADERS[tool]({ force })) || {};
    } catch {
        info = { line: '', tone: 'muted' };
    }
    info.tool = tool;
    _info.set(tool, { at: Date.now(), info });
    return info;
}

// Live job state from the WS, per tool.
const WS_EVENTS = {
    duplicates: ['dedup_progress', 'dedup_done'],
    thumbs: ['thumbs_progress', 'thumbs_done'],
    seekbar: ['seekbar_progress', 'seekbar_done'],
    video: ['faststart_progress', 'faststart_done'],
    nsfw: ['nsfw_progress', 'nsfw_done'],
    ai: ['ai_people_progress', 'ai_people_done'],
    backup: ['backup_done', 'backup_error'],
    cluster: ['peer_added', 'peer_removed', 'peer_status'],
    updates: ['update_started'],
};

// ------------------------------------------------------------- group page

let _group = null; // slug of the group page on screen
const _pending = new Set(); // tools with a run/stop request in flight

function statusPill(info) {
    if (info.running) {
        return `<span class="tool-pill" data-tone="running"><span class="tool-pill-dot" aria-hidden="true"></span>${escapeHtml(i18nT('maintenance.hub.state.running', 'Running'))}${info.pct != null ? ` · ${info.pct}%` : ''}</span>`;
    }
    if (info.off) {
        return `<span class="tool-pill" data-tone="muted">${escapeHtml(i18nT('tools.status.off_short', 'Off'))}</span>`;
    }
    if (info.tone === 'bad' || info.tone === 'warn') {
        return `<span class="tool-pill" data-tone="${info.tone}"><i class="ri-error-warning-line" aria-hidden="true"></i>${escapeHtml(i18nT('tools.status.check', 'Check'))}</span>`;
    }
    // Idle only means something for tools that run a job.
    if (!JOB_TOOLS.has(info.tool)) return '';
    return `<span class="tool-pill" data-tone="muted">${escapeHtml(i18nT('maintenance.hub.state.idle', 'Idle'))}</span>`;
}

// Screen readers hear "Build · Thumbnails", not three bare "Build"s.
const srName = (tool) => `<span class="sr-only"> · ${escapeHtml(tr(TOOLS[tool].name))}</span>`;

function cardActions(tool, info) {
    const href = toolHref(tool);
    const busy = _pending.has(tool);
    let primary = '';
    if (info.running) {
        primary = info.stop
            ? `<button type="button" class="tool-btn" data-act="stop" data-tool="${tool}"${busy ? ' disabled' : ''}><i class="ri-stop-circle-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('tools.run.stop', 'Stop'))}</span>${srName(tool)}</button>`
            : '';
    } else if (info.run && !info.off) {
        primary = `<button type="button" class="tool-btn is-primary" data-act="run" data-tool="${tool}"${busy ? ' disabled' : ''}><i class="${info.run.icon || 'ri-play-line'}" aria-hidden="true"></i><span>${escapeHtml(info.run.label)}</span>${srName(tool)}</button>`;
    }
    const openLabel = info.off
        ? i18nT('tools.run.setup', 'Set up')
        : i18nT('maintenance.hub.open', 'Open');
    return `${primary}<a class="tool-btn${primary ? '' : ' is-primary'}" href="${href}">${escapeHtml(openLabel)}${srName(tool)}<i class="ri-arrow-right-s-line" aria-hidden="true"></i></a>`;
}

// "43 of 100" while a job runs, when the tracker reports counts.
function runningLine(info) {
    if (!info.running) return '';
    const c = info.counts;
    if (!c) return i18nT('tools.status.working', 'Working…');
    return i18nTf(
        'tools.status.progress',
        { done: num(c.done), total: num(c.total) },
        `${num(c.done)} of ${num(c.total)}`,
    );
}

function cardInner(tool, info) {
    const meta = TOOLS[tool];
    const name = tr(meta.name);
    const loading = info == null;
    const i = info || {};
    const progress =
        i.running && i.pct != null
            ? `<div class="tool-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${i.pct}" aria-label="${escapeHtml(name)}"><div style="width:${i.pct}%"></div></div>`
            : '';
    return `
        <div class="tool-card-head">
            <span class="tool-card-icon" data-accent="${meta.accent}" aria-hidden="true"><i class="${meta.icon}"></i></span>
            <div class="min-w-0 flex-1">
                <h3 class="tool-card-title" id="tool-card-${tool}-title">${escapeHtml(name)}</h3>
                <p class="tool-card-desc">${escapeHtml(tr(meta.desc))}</p>
            </div>
            ${loading ? '' : statusPill(i)}
        </div>
        <p class="tool-card-status" data-tone="${loading ? 'muted' : i.running ? 'ok' : i.tone || 'muted'}">${loading ? `<span class="tool-skel" aria-hidden="true"></span><span class="sr-only">${escapeHtml(i18nT('common.loading', 'Loading…'))}</span>` : escapeHtml(runningLine(i) || i.line || '')}</p>
        ${progress}
        <div class="tool-card-actions">${loading ? '' : cardActions(tool, i)}</div>`;
}

function paintCard(tool) {
    const card = $(`tool-card-${tool}`);
    if (!card) return;
    const hit = _info.get(tool);
    // Keep focus on the button the user just pressed across a repaint.
    const focused = card.contains(document.activeElement)
        ? document.activeElement.dataset?.act ||
          (document.activeElement.tagName === 'A' ? 'open' : null)
        : null;
    card.innerHTML = cardInner(tool, hit ? hit.info : null);
    if (focused) {
        const next =
            focused === 'open'
                ? card.querySelector('a.tool-btn')
                : card.querySelector(`[data-act]`) || card.querySelector('a.tool-btn');
        next?.focus();
    }
}

async function refreshCard(tool, opts) {
    await loadInfo(tool, { fresh: true, ...opts });
    if (_group && groupOfTool(tool) === _group) paintCard(tool);
}

async function runTool(tool, act) {
    const info = _info.get(tool)?.info;
    if (!info || _pending.has(tool)) return;
    _pending.add(tool);
    paintCard(tool);
    try {
        if (act === 'stop') {
            const s = typeof info.stop === 'string' ? { url: info.stop } : info.stop;
            if (s?.url) await api.post(s.url, s.body || {});
        } else if (info.run?.check) {
            _pending.delete(tool);
            await refreshCard(tool, { force: true });
            showToast(i18nT('tools.run.checked', 'Checked'), 'success');
            return;
        } else if (info.run?.go) {
            await info.run.go();
            showToast(i18nT('tools.run.started', 'Started'), 'success');
        } else if (info.run?.url) {
            await api.post(info.run.url, info.run.body || {});
            // Paint "running" straight away; the WS progress takes over.
            info.running = true;
            info.pct = null;
            info.counts = null;
            showToast(i18nT('tools.run.started', 'Started'), 'success');
        }
    } catch (e) {
        if (e?.status === 409 || e?.data?.code === 'ALREADY_RUNNING') {
            showToast(
                i18nT(
                    'jobs.already_running',
                    'Already running on another tab — waiting for it to finish.',
                ),
                'info',
            );
        } else {
            showToast(e?.data?.error || e?.message || i18nT('common.error', 'Error'), 'error');
        }
    } finally {
        _pending.delete(tool);
    }
    // Re-read shortly after: the job may be quick, or refused.
    setTimeout(() => refreshCard(tool), act === 'stop' ? 600 : 1500);
    paintCard(tool);
}

let _gridWired = false;
function wireGrid(grid) {
    if (_gridWired) return;
    _gridWired = true;
    grid.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn || btn.disabled) return;
        runTool(btn.dataset.tool, btn.dataset.act);
    });
}

/** Render one Tools group into #page-maintenance. `focus` = tool slug to scroll to. */
export function showGroupPage({ group, focus } = {}) {
    const g = getGroup(group);
    const grid = $('hub-grid');
    if (!g || !grid) return;
    _group = g.slug;
    wireWs();
    wireGrid(grid);
    const title = $('tools-group-title');
    const desc = $('tools-group-desc');
    const icon = $('tools-group-icon');
    if (title) {
        title.dataset.i18n = g.title[0];
        title.textContent = tr(g.title);
    }
    if (desc) {
        desc.dataset.i18n = g.desc[0];
        desc.textContent = tr(g.desc);
    }
    if (icon) icon.className = g.icon;
    grid.setAttribute('aria-label', tr(g.title));
    grid.innerHTML = g.tools
        .map(
            (tool) =>
                `<article class="tool-card" id="tool-card-${tool}" data-tool="${tool}" tabindex="-1" aria-labelledby="tool-card-${tool}-title"></article>`,
        )
        .join('');
    for (const tool of g.tools) {
        paintCard(tool);
        refreshCard(tool);
    }
    if (focus && g.tools.includes(focus)) {
        const card = $(`tool-card-${focus}`);
        requestAnimationFrame(() => {
            card?.scrollIntoView({ block: 'center', behavior: 'auto' });
            card?.classList.add('is-focus');
            card?.focus({ preventScroll: true });
            setTimeout(() => card?.classList.remove('is-focus'), 2400);
        });
    }
}

// ----------------------------------------------------- Settings Tools card

let _attnAt = 0;
let _attnRunning = null;
let _cardObserver = null;
const _running = new Map(); // tool → pct|null while a job runs
let _lastAttention = null;

function renderGroupRows() {
    const box = $('tools-groups');
    if (!box) return;
    box.innerHTML = TOOL_GROUPS.map((g) => {
        const tools = g.tools
            .map(
                (t) =>
                    `<span data-i18n="${TOOLS[t].name[0]}">${escapeHtml(tr(TOOLS[t].name))}</span>`,
            )
            .join('<span aria-hidden="true"> · </span>');
        return `
            <a class="tools-group-row" href="${groupHref(g.slug)}" data-group="${g.slug}">
                <span class="tools-group-icon" aria-hidden="true"><i class="${g.icon}"></i></span>
                <span class="min-w-0 flex-1">
                    <span class="tools-group-name" data-i18n="${g.title[0]}">${escapeHtml(tr(g.title))}</span>
                    <span class="tools-group-tools">${tools}</span>
                </span>
                <span class="tools-group-state" data-group-state="${g.slug}"></span>
                <i class="ri-arrow-right-s-line tools-group-chevron" aria-hidden="true"></i>
            </a>`;
    }).join('');
    paintGroupStates();
}

function paintGroupStates(items = _lastAttention) {
    for (const g of TOOL_GROUPS) {
        const el = document.querySelector(`[data-group-state="${g.slug}"]`);
        if (!el) continue;
        const running = g.tools.filter((t) => _running.has(t));
        const issues = (items || []).filter((a) => groupOfTool(a.tool) === g.slug).length;
        if (running.length) {
            el.innerHTML = `<span class="tool-pill" data-tone="running"><span class="tool-pill-dot" aria-hidden="true"></span>${escapeHtml(i18nT('maintenance.hub.state.running', 'Running'))}</span>`;
        } else if (issues) {
            el.innerHTML = `<span class="tools-group-badge" title="${escapeHtml(i18nTf('tools.attention.count', { n: issues }, `${issues} need attention`))}">${issues}<span class="sr-only"> ${escapeHtml(i18nTf('tools.attention.count', { n: issues }, `${issues} need attention`))}</span></span>`;
        } else {
            el.innerHTML = '';
        }
    }
}

function renderAttention(items) {
    const box = $('tools-attention');
    if (!box) return;
    if (items == null) {
        box.innerHTML = `<p class="tools-attn-note"><i class="ri-loader-4-line animate-spin" aria-hidden="true"></i>${escapeHtml(i18nT('tools.attention.checking', 'Checking…'))}</p>`;
        return;
    }
    if (!items.length) {
        box.innerHTML = `<p class="tools-attn-note is-ok"><i class="ri-checkbox-circle-line" aria-hidden="true"></i>${escapeHtml(i18nT('tools.attention.none', 'Nothing needs attention'))}</p>`;
        return;
    }
    box.innerHTML = `
        <h4 class="tools-attn-title">${escapeHtml(i18nT('tools.attention.title', 'Needs attention'))}</h4>
        <ul class="tools-attn-list">${items
            .map((a) => {
                const icon =
                    a.tone === 'bad'
                        ? 'ri-error-warning-fill'
                        : a.tone === 'info'
                          ? 'ri-information-fill'
                          : 'ri-alert-fill';
                const action = a.run
                    ? `<button type="button" class="tool-btn" data-attn-run="${a.tool}">${escapeHtml(a.label)}${srName(a.tool)}</button>`
                    : `<a class="tool-btn" href="${toolHref(a.tool)}">${escapeHtml(a.label)}${srName(a.tool)}<i class="ri-arrow-right-s-line" aria-hidden="true"></i></a>`;
                return `<li class="tools-attn" data-tone="${a.tone}">
                    <i class="${icon} tools-attn-icon" aria-hidden="true"></i>
                    <span class="tools-attn-text"><span class="tools-attn-tool">${escapeHtml(tr(TOOLS[a.tool].name))}</span>${escapeHtml(a.text)}</span>
                    ${action}
                </li>`;
            })
            .join('')}</ul>`;
}

async function checkAttention({ fresh = false } = {}) {
    if (_attnRunning) return _attnRunning;
    if (!fresh && _lastAttention && Date.now() - _attnAt < CACHE_MS) {
        renderAttention(_lastAttention);
        paintGroupStates();
        return _lastAttention;
    }
    if (!_lastAttention) renderAttention(null);
    _attnRunning = (async () => {
        const infos = await Promise.all(ATTENTION_TOOLS.map((t) => loadInfo(t, { fresh })));
        const items = [];
        ATTENTION_TOOLS.forEach((tool, i) => {
            const info = infos[i];
            if (info.running) _running.set(tool, info.pct);
            if (info.attention) items.push({ tool, ...info.attention });
        });
        const order = { bad: 0, warn: 1, info: 2 };
        items.sort((a, b) => (order[a.tone] ?? 3) - (order[b.tone] ?? 3));
        _lastAttention = items;
        _attnAt = Date.now();
        renderAttention(items);
        paintGroupStates(items);
        return items;
    })().finally(() => {
        _attnRunning = null;
    });
    return _attnRunning;
}

let _cardWired = false;
/** Settings page: fill the Tools card; checks run once it's near the viewport. */
export function initToolsCard() {
    const card = $('settings-tools');
    if (!card) return;
    wireWs();
    renderGroupRows();
    if (!_cardWired) {
        _cardWired = true;
        card.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-attn-run]');
            if (!btn) return;
            const tool = btn.dataset.attnRun;
            btn.disabled = true;
            const info = await loadInfo(tool);
            try {
                if (info.run?.url) await api.post(info.run.url, info.run.body || {});
                showToast(i18nT('tools.run.started', 'Started'), 'success');
                _running.set(tool, null);
                paintGroupStates();
            } catch (err) {
                showToast(err?.data?.error || err?.message || 'Error', 'error');
            } finally {
                btn.disabled = false;
            }
        });
        onLanguageChange(() => {
            _info.clear();
            _lastAttention = null;
            if (!$('page-settings')?.classList.contains('hidden')) {
                renderGroupRows();
                checkAttention();
            }
        });
    }
    if (_lastAttention) {
        renderAttention(_lastAttention);
        paintGroupStates();
    } else {
        renderAttention(null);
    }
    _cardObserver?.disconnect();
    if (typeof IntersectionObserver !== 'function') {
        checkAttention();
        return;
    }
    _cardObserver = new IntersectionObserver(
        (entries) => {
            if (!entries.some((en) => en.isIntersecting)) return;
            _cardObserver?.disconnect();
            _cardObserver = null;
            checkAttention();
        },
        { root: $('content-area'), rootMargin: '400px 0px' },
    );
    _cardObserver.observe(card);
}

// -------------------------------------------------------------- live state

let _wsWired = false;
const _paintTimers = new Map(); // tool → timeout, so a progress stream repaints ≤4×/s
function wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    for (const [tool, events] of Object.entries(WS_EVENTS)) {
        for (const evt of events) {
            ws.on(evt, (m) => {
                const progress = evt.endsWith('_progress');
                const hit = _info.get(tool);
                if (progress) {
                    _running.set(tool, pctOf(m));
                    if (hit) {
                        hit.info.running = true;
                        hit.info.pct = pctOf(m);
                        hit.info.counts = countsOf(m);
                    }
                } else if (evt.endsWith('_done')) {
                    _running.delete(tool);
                    if (hit) hit.info.running = false;
                }
                clearTimeout(_paintTimers.get(tool));
                _paintTimers.set(
                    tool,
                    setTimeout(() => {
                        _paintTimers.delete(tool);
                        const onGroup =
                            _group &&
                            groupOfTool(tool) === _group &&
                            !$('page-maintenance')?.classList.contains('hidden');
                        if (onGroup) {
                            if (progress) paintCard(tool);
                            else refreshCard(tool);
                        }
                        paintGroupStates();
                    }, 250),
                );
            });
        }
    }
}
