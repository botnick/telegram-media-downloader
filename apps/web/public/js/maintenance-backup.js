// Maintenance — Backup destinations (admin page).
//
// Renders one card per configured destination with state, totals, and
// per-destination action buttons (Run / Pause / Test / Edit / Remove).
// The Add-destination wizard is a multi-step sheet that walks through
// provider pick → provider-specific form → mode + schedule →
// optional encryption → connection test + save.
//
// Live updates arrive via WebSocket: backup_progress, backup_done,
// backup_error, backup_queue_drained, backup_destination_*. State
// recovery on (re-)entry: GET /api/backup/destinations + a
// /status fetch per destination.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml, formatBytes, formatRelativeTime } from './utils.js';
import { openSheet, confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;
let _destinations = [];
let _statuses = new Map();      // id → status payload
let _providersCache = null;     // [{ name, displayName, configSchema }]

// ---- Helpers --------------------------------------------------------------

function _fmtBytes(n) { return formatBytes(Number(n) || 0); }

function _statePill(status) {
    if (!status) return { label: '—', cls: 'bg-tg-bg/50 text-tg-textSecondary' };
    if (!status.enabled) return { label: i18nT('maintenance.backup.state.disabled', 'Disabled'), cls: 'bg-tg-bg/50 text-tg-textSecondary' };
    if (status.paused) return { label: i18nT('maintenance.backup.state.paused', 'Paused'), cls: 'bg-yellow-500/15 text-yellow-300' };
    if (status.encryption && !status.encryptionUnlocked) return { label: i18nT('maintenance.backup.state.locked', 'Locked'), cls: 'bg-tg-orange/15 text-tg-orange' };
    if (status.processing > 0) return { label: i18nT('maintenance.backup.state.running', 'Running'), cls: 'bg-tg-blue/15 text-tg-blue' };
    if (status.lastError) return { label: i18nT('maintenance.backup.state.error', 'Error'), cls: 'bg-red-500/15 text-red-300' };
    if (status.queued > 0) return { label: i18nT('maintenance.backup.state.queued', 'Queued'), cls: 'bg-tg-blue/10 text-tg-blue' };
    return { label: i18nT('maintenance.backup.state.idle', 'Idle'), cls: 'bg-green-500/15 text-green-300' };
}

function _providerBadge(provider) {
    const map = {
        s3: { icon: 'ri-cloud-line', label: 'S3' },
        local: { icon: 'ri-hard-drive-2-line', label: 'Local' },
        sftp: { icon: 'ri-server-line', label: 'SFTP' },
        ftp: { icon: 'ri-folder-transfer-line', label: 'FTP' },
        gdrive: { icon: 'ri-google-line', label: 'GDrive' },
        dropbox: { icon: 'ri-dropbox-line', label: 'Dropbox' },
    };
    return map[provider] || { icon: 'ri-cloud-line', label: provider };
}

// ---- Card rendering -------------------------------------------------------

function _renderCard(dest) {
    const status = _statuses.get(dest.id);
    const pill = _statePill(status || dest);
    const badge = _providerBadge(dest.provider);
    const last = dest.lastSuccessAt ? formatRelativeTime(dest.lastSuccessAt) : '—';
    const queued = status?.queued ?? 0;
    const processing = status?.processing ?? 0;
    const lockHint = (dest.encryption && status && !status.encryptionUnlocked)
        ? `<button data-act="unlock" class="ml-2 text-[10px] px-2 py-0.5 rounded bg-tg-orange/15 text-tg-orange hover:bg-tg-orange/25">${escapeHtml(i18nT('maintenance.backup.unlock', 'Unlock'))}</button>` : '';
    const errBlock = (status?.lastError && !(status.encryption && !status.encryptionUnlocked))
        ? `<div class="mt-2 text-[11px] text-red-300 break-words">${escapeHtml(String(status.lastError).slice(0, 200))}</div>` : '';
    const pauseBtn = status?.paused
        ? `<button data-act="resume" class="tg-btn-secondary text-xs px-2 py-1"><i class="ri-play-line mr-0.5"></i><span data-i18n="maintenance.backup.resume">Resume</span></button>`
        : `<button data-act="pause" class="tg-btn-secondary text-xs px-2 py-1"><i class="ri-pause-line mr-0.5"></i><span data-i18n="maintenance.backup.pause">Pause</span></button>`;
    const progressBar = (processing > 0)
        ? `<div class="mt-2 h-1 bg-tg-bg/60 rounded overflow-hidden"><div class="bg-tg-blue h-full transition-all animate-pulse" style="width:35%"></div></div>` : '';

    return `
        <div class="bg-tg-panel rounded-xl p-4 flex flex-col gap-2 border border-tg-border/30" data-dest-id="${dest.id}">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-tg-bg/40 text-tg-textSecondary text-[11px]">
                            <i class="${badge.icon}"></i> ${escapeHtml(badge.label)}
                        </span>
                        ${dest.encryption ? `<span class="inline-flex items-center gap-1 text-[11px] text-tg-textSecondary" title="${escapeHtml(i18nT('maintenance.backup.encrypted', 'Client-side encrypted'))}"><i class="ri-lock-line"></i></span>` : ''}
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] ${pill.cls}">${escapeHtml(pill.label)}</span>
                        ${lockHint}
                    </div>
                    <h3 class="text-tg-text text-sm font-semibold mt-1 truncate">${escapeHtml(dest.name)}</h3>
                    <div class="text-[11px] text-tg-textSecondary capitalize">${escapeHtml(dest.mode)}${dest.cron ? ' · ' + escapeHtml(dest.cron) : ''}</div>
                </div>
            </div>
            <div class="grid grid-cols-3 gap-2 mt-1">
                <div class="bg-tg-bg/30 rounded-md p-2 text-center">
                    <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.backup.files">Files</div>
                    <div class="text-sm text-tg-text tabular-nums">${dest.totalFiles ?? 0}</div>
                </div>
                <div class="bg-tg-bg/30 rounded-md p-2 text-center">
                    <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.backup.size">Size</div>
                    <div class="text-sm text-tg-text tabular-nums">${escapeHtml(_fmtBytes(dest.totalBytes))}</div>
                </div>
                <div class="bg-tg-bg/30 rounded-md p-2 text-center">
                    <div class="text-[10px] uppercase text-tg-textSecondary tracking-wide" data-i18n="maintenance.backup.last">Last</div>
                    <div class="text-sm text-tg-text">${escapeHtml(last)}</div>
                </div>
            </div>
            <div class="flex items-center gap-1 text-[11px] text-tg-textSecondary mt-1">
                <span><i class="ri-stack-line"></i> ${escapeHtml(i18nTf('maintenance.backup.queued_count', { n: queued }, `${queued} queued`))}</span>
                <span class="opacity-50">·</span>
                <span><i class="ri-loader-4-line"></i> ${escapeHtml(i18nTf('maintenance.backup.active_count', { n: processing }, `${processing} active`))}</span>
            </div>
            ${progressBar}
            ${errBlock}
            <div class="flex items-center justify-end gap-1 mt-2 flex-wrap">
                <button data-act="run" class="tg-btn text-xs px-2 py-1"><i class="ri-play-circle-line mr-0.5"></i><span data-i18n="maintenance.backup.run_now">Run now</span></button>
                ${pauseBtn}
                <button data-act="test" class="tg-btn-secondary text-xs px-2 py-1"><i class="ri-plug-line mr-0.5"></i><span data-i18n="maintenance.backup.test">Test</span></button>
                <button data-act="edit" class="tg-btn-secondary text-xs px-2 py-1"><i class="ri-pencil-line mr-0.5"></i><span data-i18n="common.edit">Edit</span></button>
                <button data-act="remove" class="px-2 py-1 rounded-md bg-red-500/15 text-red-300 hover:bg-red-500/25 text-xs"><i class="ri-delete-bin-line mr-0.5"></i><span data-i18n="common.remove">Remove</span></button>
            </div>
        </div>`;
}

function _renderRecentRow(j) {
    const when = j.finished_at || j.started_at;
    const ts = when ? formatRelativeTime(when) : '—';
    let icon, cls, label;
    switch (j.status) {
        case 'done':
            icon = 'ri-check-line'; cls = 'text-green-400';
            label = i18nT('maintenance.backup.job.done', 'done');
            break;
        case 'failed':
            icon = 'ri-close-line'; cls = 'text-red-400';
            label = i18nT('maintenance.backup.job.failed', 'failed');
            break;
        case 'uploading':
            icon = 'ri-loader-4-line'; cls = 'text-tg-blue animate-spin';
            label = i18nT('maintenance.backup.job.uploading', 'uploading');
            break;
        default:
            icon = 'ri-time-line'; cls = 'text-tg-textSecondary';
            label = j.status;
    }
    const target = j.remote_path || j.snapshot_path || `download #${j.download_id}`;
    const retryBtn = j.status === 'failed'
        ? `<button data-job-id="${j.id}" data-act="retry-job" class="text-[11px] px-2 py-0.5 rounded bg-tg-blue/15 text-tg-blue hover:bg-tg-blue/25"><i class="ri-refresh-line mr-0.5"></i>${escapeHtml(i18nT('maintenance.backup.retry', 'Retry'))}</button>` : '';
    const errSpan = j.status === 'failed' && j.error
        ? `<span class="text-[11px] text-red-300 truncate" title="${escapeHtml(j.error)}">${escapeHtml(String(j.error).slice(0, 80))}</span>` : '';
    return `
        <div class="flex items-center gap-2 py-1 px-2 rounded hover:bg-tg-bg/30 text-[12px]">
            <i class="${icon} ${cls}"></i>
            <span class="text-tg-textSecondary tabular-nums w-12 shrink-0">${escapeHtml(ts)}</span>
            <span class="text-tg-text font-medium w-20 shrink-0">${escapeHtml(label)}</span>
            <span class="text-tg-textSecondary truncate flex-1" title="${escapeHtml(target)}">${escapeHtml(j.destination_name || ('#' + j.destination_id))} · ${escapeHtml(target)}</span>
            ${errSpan}
            ${retryBtn}
        </div>`;
}

function _renderAll() {
    const cards = $('backup-cards');
    const empty = $('backup-empty');
    if (!cards) return;
    if (!_destinations.length) {
        empty?.classList.remove('hidden');
        cards.innerHTML = '';
        return;
    }
    empty?.classList.add('hidden');
    cards.innerHTML = _destinations.map(_renderCard).join('');
}

async function _refreshStatuses() {
    await Promise.all(_destinations.map(async (d) => {
        try {
            const r = await api.get(`/api/backup/destinations/${d.id}/status`);
            _statuses.set(d.id, r);
        } catch { /* leave stale */ }
    }));
    _renderAll();
}

async function _refreshDestinations() {
    try {
        const r = await api.get('/api/backup/destinations');
        _destinations = Array.isArray(r.destinations) ? r.destinations : [];
        await _refreshStatuses();
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    }
}

async function _refreshRecent() {
    const root = $('backup-recent');
    const empty = $('backup-recent-empty');
    if (!root) return;
    try {
        const r = await api.get('/api/backup/jobs/recent?limit=20');
        const jobs = r.jobs || [];
        if (!jobs.length) {
            empty?.classList.remove('hidden');
            root.innerHTML = '';
            return;
        }
        empty?.classList.add('hidden');
        root.innerHTML = jobs.map(_renderRecentRow).join('');
    } catch { /* non-fatal */ }
}

// ---- Card actions ---------------------------------------------------------

async function _onCardAction(destId, act) {
    const dest = _destinations.find((d) => d.id === destId);
    if (!dest) return;
    try {
        if (act === 'run') {
            await api.post(`/api/backup/destinations/${destId}/run`, {});
            showToast(i18nT('maintenance.backup.run_started', 'Backup run started'), 'success');
        } else if (act === 'pause') {
            await api.post(`/api/backup/destinations/${destId}/pause`, {});
        } else if (act === 'resume') {
            await api.post(`/api/backup/destinations/${destId}/resume`, {});
        } else if (act === 'test') {
            const r = await api.post(`/api/backup/destinations/${destId}/test`, {});
            showToast(r.detail || (r.ok ? 'OK' : 'Failed'), r.ok ? 'success' : 'error');
        } else if (act === 'edit') {
            await _openWizard(dest);
        } else if (act === 'remove') {
            const ok = await confirmSheet({
                title: i18nT('maintenance.backup.remove_title', 'Remove backup destination?'),
                message: i18nTf('maintenance.backup.remove_body',
                    { name: dest.name },
                    `Stop syncing to "${dest.name}"? Existing remote files stay put — this only deletes the local pointer.`),
                confirmLabel: i18nT('common.remove', 'Remove'),
                danger: true,
            });
            if (!ok) return;
            await api.delete(`/api/backup/destinations/${destId}`);
            showToast(i18nT('maintenance.backup.removed', 'Destination removed'), 'success');
        } else if (act === 'unlock') {
            await _promptUnlock(dest);
        }
    } catch (e) {
        showToast(e?.data?.error || e.message || 'Failed', 'error');
    }
    await _refreshDestinations();
}

async function _promptUnlock(dest) {
    let resolveFn;
    const done = new Promise((r) => { resolveFn = r; });
    const sheet = openSheet({
        title: i18nTf('maintenance.backup.unlock_title', { name: dest.name }, `Unlock ${dest.name}`),
        size: 'sm',
        content: `
            <p class="text-xs text-tg-textSecondary mb-3" data-i18n="maintenance.backup.unlock_help">Re-enter the encryption passphrase you set for this destination. The key is held in memory only — server restart prompts again.</p>
            <input id="bk-unlock-pass" type="password" class="tg-input w-full text-sm" placeholder="${escapeHtml(i18nT('maintenance.backup.passphrase', 'Passphrase'))}" />
            <div class="flex items-center justify-end gap-2 mt-4">
                <button id="bk-unlock-cancel" class="px-3 py-1.5 rounded-lg text-tg-textSecondary hover:bg-tg-hover text-sm">${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>
                <button id="bk-unlock-ok" class="px-3 py-1.5 rounded-lg bg-tg-blue text-white hover:bg-opacity-90 font-medium text-sm">${escapeHtml(i18nT('maintenance.backup.unlock', 'Unlock'))}</button>
            </div>`,
        onClose: () => resolveFn(false),
    });
    setTimeout(() => {
        const input = document.getElementById('bk-unlock-pass');
        const ok = document.getElementById('bk-unlock-ok');
        const cancel = document.getElementById('bk-unlock-cancel');
        const submit = async () => {
            const pass = input?.value || '';
            if (!pass) { showToast(i18nT('maintenance.backup.passphrase_required', 'Passphrase required'), 'error'); return; }
            try {
                await api.post(`/api/backup/destinations/${dest.id}/unlock`, { passphrase: pass });
                showToast(i18nT('maintenance.backup.unlocked', 'Unlocked'), 'success');
                resolveFn(true); sheet.close();
            } catch (e) {
                showToast(e?.data?.error || e.message || 'Failed', 'error');
            }
        };
        ok?.addEventListener('click', submit);
        cancel?.addEventListener('click', () => sheet.close());
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        input?.focus();
    }, 80);
    return done;
}

// ---- Add / Edit wizard ---------------------------------------------------

async function _loadProviders() {
    if (_providersCache) return _providersCache;
    const r = await api.get('/api/backup/providers');
    _providersCache = r.providers || [];
    return _providersCache;
}

// Per-provider OAuth / setup walkthroughs rendered as a collapsed
// `<details>` below the field grid. Keeps non-technical operators from
// having to leave the dashboard to figure out how to grab a refresh
// token. Mirrors the docs/BACKUP.md walkthroughs verbatim.
function _renderProviderHelp(providerName) {
    if (providerName === 'gdrive') {
        const title = escapeHtml(i18nT('maintenance.backup.help.gdrive.title', 'How do I get clientId / clientSecret / refreshToken?'));
        const consoleUrl = 'https://console.cloud.google.com/';
        const playgroundUrl = 'https://developers.google.com/oauthplayground/';
        const consoleLabel = escapeHtml(i18nT('maintenance.backup.help.gdrive.console', 'Open Google Cloud Console'));
        const playgroundLabel = escapeHtml(i18nT('maintenance.backup.help.gdrive.playground', 'Open OAuth Playground'));
        return `
            <details class="mt-3 rounded-md border border-tg-border/40 bg-tg-bg/30 overflow-hidden">
                <summary class="px-3 py-2 cursor-pointer text-[12px] text-tg-textSecondary hover:text-tg-text">
                    <i class="ri-question-line mr-1"></i>${title}
                </summary>
                <div class="px-3 pb-3 pt-1 text-[11px] text-tg-textSecondary leading-relaxed space-y-2">
                    <ol class="list-decimal pl-4 space-y-1.5">
                        <li>${escapeHtml(i18nT('maintenance.backup.help.gdrive.step1', 'Open Google Cloud Console → "New project" (any name).'))}</li>
                        <li>${escapeHtml(i18nT('maintenance.backup.help.gdrive.step2', 'APIs & Services → Library → search "Google Drive API" → click Enable.'))}</li>
                        <li>${escapeHtml(i18nT('maintenance.backup.help.gdrive.step3', 'APIs & Services → Credentials → Create Credentials → OAuth client ID → application type "Desktop app". Save the client ID + client secret into the fields above.'))}</li>
                        <li>${escapeHtml(i18nT('maintenance.backup.help.gdrive.step4', 'Open the OAuth Playground → gear icon → "Use your own OAuth credentials" → paste client ID + secret. Pick scope https://www.googleapis.com/auth/drive.file → Authorize → Exchange authorization code for tokens → copy the refresh_token into the field above.'))}</li>
                    </ol>
                    <div class="flex flex-wrap gap-2 pt-1">
                        <a href="${consoleUrl}" target="_blank" rel="noopener" class="tg-btn-secondary text-[11px] px-2 py-1"><i class="ri-external-link-line mr-1"></i>${consoleLabel}</a>
                        <a href="${playgroundUrl}" target="_blank" rel="noopener" class="tg-btn-secondary text-[11px] px-2 py-1"><i class="ri-external-link-line mr-1"></i>${playgroundLabel}</a>
                    </div>
                </div>
            </details>`;
    }
    if (providerName === 'dropbox') {
        const title = escapeHtml(i18nT('maintenance.backup.help.dropbox.title', 'How do I get appKey / appSecret / refreshToken?'));
        const consoleUrl = 'https://www.dropbox.com/developers/apps';
        const consoleLabel = escapeHtml(i18nT('maintenance.backup.help.dropbox.console', 'Open Dropbox developer console'));
        return `
            <details class="mt-3 rounded-md border border-tg-border/40 bg-tg-bg/30 overflow-hidden">
                <summary class="px-3 py-2 cursor-pointer text-[12px] text-tg-textSecondary hover:text-tg-text">
                    <i class="ri-question-line mr-1"></i>${title}
                </summary>
                <div class="px-3 pb-3 pt-1 text-[11px] text-tg-textSecondary leading-relaxed space-y-2">
                    <ol class="list-decimal pl-4 space-y-1.5">
                        <li>${escapeHtml(i18nT('maintenance.backup.help.dropbox.step1', 'Open the Dropbox developer console → Create app → "Scoped access" → "App folder" (recommended) or "Full Dropbox" → name your app.'))}</li>
                        <li>${escapeHtml(i18nT('maintenance.backup.help.dropbox.step2', 'Permissions tab → enable files.content.write, files.content.read, account_info.read → click Submit.'))}</li>
                        <li>${escapeHtml(i18nT('maintenance.backup.help.dropbox.step3', 'Settings tab → copy App key + App secret into the fields above. Generate a refresh token via the OAuth flow documented at dropbox.com/developers/documentation/http/documentation#authorization, or run scripts/setup-dropbox.js for a guided CLI walkthrough.'))}</li>
                    </ol>
                    <div class="flex flex-wrap gap-2 pt-1">
                        <a href="${consoleUrl}" target="_blank" rel="noopener" class="tg-btn-secondary text-[11px] px-2 py-1"><i class="ri-external-link-line mr-1"></i>${consoleLabel}</a>
                    </div>
                </div>
            </details>`;
    }
    return '';
}

function _renderField(field, currentValue) {
    const val = currentValue == null ? '' : String(currentValue);
    const id = `bk-field-${field.name}`;
    const label = `<label for="${id}" class="block text-xs text-tg-textSecondary mb-1">${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>`;
    const help = field.help ? `<div class="text-[11px] text-tg-textSecondary mt-1">${escapeHtml(field.help)}</div>` : '';
    if (field.type === 'textarea') {
        return `<div class="mb-3">${label}<textarea id="${id}" data-field="${escapeHtml(field.name)}" class="tg-input w-full text-sm font-mono" rows="4" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(val)}</textarea>${help}</div>`;
    }
    if (field.type === 'select') {
        const opts = (field.options || []).map((o) =>
            `<option value="${escapeHtml(o.value)}"${o.value === val ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        return `<div class="mb-3">${label}<select id="${id}" data-field="${escapeHtml(field.name)}" class="tg-input w-full text-sm">${opts}</select>${help}</div>`;
    }
    const inputType = field.type === 'password' ? 'password' : (field.type === 'number' ? 'number' : 'text');
    return `<div class="mb-3">${label}<input type="${inputType}" id="${id}" data-field="${escapeHtml(field.name)}" class="tg-input w-full text-sm" placeholder="${escapeHtml(field.placeholder || '')}" value="${escapeHtml(val)}" autocomplete="off" />${help}</div>`;
}

function _collectFields(root) {
    const out = {};
    root.querySelectorAll('[data-field]').forEach((el) => {
        const name = el.dataset.field;
        if (name) out[name] = el.value;
    });
    return out;
}

async function _openWizard(existing) {
    const providers = await _loadProviders();
    const isEdit = !!existing;
    let chosenProvider = isEdit ? existing.provider : providers[0]?.name;

    const renderBody = () => {
        const provider = providers.find((p) => p.name === chosenProvider) || providers[0];
        const schema = provider?.configSchema || [];
        const config = {};   // edit mode never echoes secrets back — operator re-enters
        const fieldsHtml = schema.map((f) => _renderField(f, config[f.name])).join('');
        const helpHtml = _renderProviderHelp(provider?.name);
        return `
            <div class="space-y-4">
                <div>
                    <label class="block text-xs text-tg-textSecondary mb-1" data-i18n="maintenance.backup.field.name">Display name</label>
                    <input id="bk-name" class="tg-input w-full text-sm" value="${escapeHtml(existing?.name || '')}" placeholder="${escapeHtml(i18nT('maintenance.backup.field.name_placeholder', 'e.g. Off-site R2'))}">
                </div>

                <div>
                    <label class="block text-xs text-tg-textSecondary mb-1" data-i18n="maintenance.backup.field.provider">Provider</label>
                    <select id="bk-provider" class="tg-input w-full text-sm" ${isEdit ? 'disabled' : ''}>
                        ${providers.map((p) =>
                            `<option value="${escapeHtml(p.name)}"${p.name === chosenProvider ? ' selected' : ''}>${escapeHtml(p.displayName)}</option>`).join('')}
                    </select>
                    ${isEdit ? `<div class="text-[11px] text-tg-textSecondary mt-1" data-i18n="maintenance.backup.provider_locked">Provider can't be changed after creation — remove + re-add to switch.</div>` : ''}
                </div>

                <div class="border-t border-tg-border pt-3">
                    <h4 class="text-xs uppercase tracking-wide text-tg-textSecondary mb-2" data-i18n="maintenance.backup.section.connection">Connection</h4>
                    <div id="bk-fields">${fieldsHtml}</div>
                    ${isEdit ? `<div class="text-[11px] text-yellow-300 -mt-1 mb-2"><i class="ri-information-line"></i> ${escapeHtml(i18nT('maintenance.backup.edit_secret_hint', 'Saved secrets are not shown — leave blank to keep, fill in to replace.'))}</div>` : ''}
                    ${helpHtml}
                </div>

                <div class="border-t border-tg-border pt-3">
                    <h4 class="text-xs uppercase tracking-wide text-tg-textSecondary mb-2" data-i18n="maintenance.backup.section.mode">Mode + schedule</h4>
                    <label class="flex items-start gap-2 mb-2 cursor-pointer">
                        <input type="radio" name="bk-mode" value="mirror" ${(existing?.mode || 'mirror') === 'mirror' ? 'checked' : ''}>
                        <span><span class="text-tg-text text-sm" data-i18n="maintenance.backup.mode.mirror">Continuous mirror</span><br><span class="text-[11px] text-tg-textSecondary" data-i18n="maintenance.backup.mode.mirror_help">Every newly-downloaded file is queued for upload right away.</span></span>
                    </label>
                    <label class="flex items-start gap-2 mb-2 cursor-pointer">
                        <input type="radio" name="bk-mode" value="snapshot" ${existing?.mode === 'snapshot' ? 'checked' : ''}>
                        <span><span class="text-tg-text text-sm" data-i18n="maintenance.backup.mode.snapshot">Scheduled snapshot</span><br><span class="text-[11px] text-tg-textSecondary" data-i18n="maintenance.backup.mode.snapshot_help">Periodic full archive of db.sqlite + config + sessions, retained N copies.</span></span>
                    </label>
                    <label class="flex items-start gap-2 mb-3 cursor-pointer">
                        <input type="radio" name="bk-mode" value="manual" ${existing?.mode === 'manual' ? 'checked' : ''}>
                        <span><span class="text-tg-text text-sm" data-i18n="maintenance.backup.mode.manual">Manual only</span><br><span class="text-[11px] text-tg-textSecondary" data-i18n="maintenance.backup.mode.manual_help">No auto-uploads — fires only when you click "Run now".</span></span>
                    </label>
                    <div id="bk-cron-row" class="flex gap-2 items-center" style="display:none">
                        <label class="text-xs text-tg-textSecondary w-24">Cron</label>
                        <input id="bk-cron" class="tg-input w-full text-sm font-mono" value="${escapeHtml(existing?.cron || '0 3 * * *')}" placeholder="0 3 * * *">
                    </div>
                    <div id="bk-retain-row" class="flex gap-2 items-center mt-2" style="display:none">
                        <label class="text-xs text-tg-textSecondary w-24" data-i18n="maintenance.backup.field.retain">Retain copies</label>
                        <input id="bk-retain" type="number" class="tg-input w-32 text-sm" min="1" max="365" value="${existing?.retainCount || 7}">
                    </div>
                </div>

                <div class="border-t border-tg-border pt-3">
                    <h4 class="text-xs uppercase tracking-wide text-tg-textSecondary mb-2" data-i18n="maintenance.backup.section.encryption">Encryption</h4>
                    <label class="flex items-center gap-2 mb-2 cursor-pointer">
                        <input id="bk-enc" type="checkbox" ${existing?.encryption ? 'checked' : ''}>
                        <span class="text-tg-text text-sm" data-i18n="maintenance.backup.enc.label">Encrypt uploads (AES-256-GCM)</span>
                    </label>
                    <p class="text-[11px] text-tg-textSecondary mb-2" data-i18n="maintenance.backup.enc.help">Files are encrypted on this host before upload — the remote sees only ciphertext. The passphrase derives the key (PBKDF2 200k iters); we do NOT store it. Lose the passphrase = lose the data.</p>
                    <div id="bk-pass-row" class="grid grid-cols-2 gap-2" style="display:none">
                        <input id="bk-pass" type="password" class="tg-input text-sm" placeholder="${escapeHtml(i18nT('maintenance.backup.passphrase', 'Passphrase'))}">
                        <input id="bk-pass2" type="password" class="tg-input text-sm" placeholder="${escapeHtml(i18nT('maintenance.backup.passphrase_confirm', 'Confirm'))}">
                    </div>
                </div>

                <div class="border-t border-tg-border pt-3 flex items-center justify-end gap-2 flex-wrap">
                    <button id="bk-test" class="tg-btn-secondary text-xs px-3 py-1.5"><i class="ri-plug-line mr-1"></i><span data-i18n="maintenance.backup.test_connection">Test connection</span></button>
                    <button id="bk-cancel" class="tg-btn-secondary text-xs px-3 py-1.5" data-i18n="common.cancel">Cancel</button>
                    <button id="bk-save" class="tg-btn text-xs px-3 py-1.5"><i class="ri-save-line mr-1"></i><span data-i18n="common.save">Save</span></button>
                </div>
            </div>`;
    };

    const sheet = openSheet({
        title: isEdit ? i18nT('maintenance.backup.edit_title', 'Edit destination') : i18nT('maintenance.backup.add_title', 'Add backup destination'),
        size: 'lg',
        content: renderBody(),
    });

    setTimeout(() => {
        const root = document.querySelector('.sheet-root:last-of-type');
        if (!root) return;
        // Provider switcher rebuilds the form. Bug fix v2.6: the original
        // version attached the change listener once, OUTSIDE _wireWizard.
        // The first switch re-rendered the body and the new <select>
        // landed without the listener — subsequent provider changes
        // silently no-op'd. Use event delegation on the sheet root so the
        // listener survives every re-render of body.innerHTML.
        const onProviderChange = (e) => {
            const sel = e.target;
            if (!sel || sel.id !== 'bk-provider') return;
            chosenProvider = sel.value;
            const body = root.querySelector('.sheet-body');
            if (body) {
                body.innerHTML = renderBody();
                _wireWizard(root, sheet, providers, existing);
            }
        };
        root.addEventListener('change', onProviderChange);
        _wireWizard(root, sheet, providers, existing);
    }, 60);
}

function _wireWizard(root, sheet, providers, existing) {
    const isEdit = !!existing;
    // Mode-radio drives the cron / retain visibility.
    function syncModeUi() {
        const mode = root.querySelector('input[name="bk-mode"]:checked')?.value || 'mirror';
        root.querySelector('#bk-cron-row').style.display = mode === 'snapshot' ? '' : 'none';
        root.querySelector('#bk-retain-row').style.display = mode === 'snapshot' ? '' : 'none';
    }
    root.querySelectorAll('input[name="bk-mode"]').forEach((el) => el.addEventListener('change', syncModeUi));
    syncModeUi();

    function syncEncUi() {
        const checked = root.querySelector('#bk-enc')?.checked;
        const pass = root.querySelector('#bk-pass-row');
        if (pass) pass.style.display = checked ? '' : 'none';
    }
    root.querySelector('#bk-enc')?.addEventListener('change', syncEncUi);
    syncEncUi();

    async function collectAndValidate() {
        const name = root.querySelector('#bk-name')?.value.trim();
        if (!name) { showToast(i18nT('maintenance.backup.name_required', 'Name required'), 'error'); return null; }
        const provider = root.querySelector('#bk-provider')?.value;
        const mode = root.querySelector('input[name="bk-mode"]:checked')?.value || 'mirror';
        const cron = root.querySelector('#bk-cron')?.value.trim();
        const retainCount = Number(root.querySelector('#bk-retain')?.value) || 7;
        const encryption = !!root.querySelector('#bk-enc')?.checked;
        const passphrase = root.querySelector('#bk-pass')?.value || '';
        const passphrase2 = root.querySelector('#bk-pass2')?.value || '';
        if (encryption) {
            // For a brand-new destination we always require a passphrase.
            // On edit, allow leaving blank as long as the destination
            // already had encryption enabled (server keeps the cached key).
            if (!isEdit && !passphrase) {
                showToast(i18nT('maintenance.backup.passphrase_required', 'Passphrase required'), 'error');
                return null;
            }
            if (passphrase && passphrase !== passphrase2) {
                showToast(i18nT('maintenance.backup.passphrase_mismatch', 'Passphrases do not match'), 'error');
                return null;
            }
        }
        if (mode === 'snapshot' && !cron) {
            showToast(i18nT('maintenance.backup.cron_required', 'Cron expression required for snapshot mode'), 'error');
            return null;
        }
        const fields = _collectFields(root);
        // Strip blank secret fields on edit so the server keeps the
        // existing encrypted blob field instead of overwriting it with
        // an empty string.
        const schema = providers.find((p) => p.name === provider)?.configSchema || [];
        if (isEdit) {
            for (const f of schema) {
                if (f.secret && fields[f.name] === '') delete fields[f.name];
            }
        }
        return { name, provider, config: fields, mode, cron: cron || null, retainCount, encryption, passphrase: passphrase || undefined };
    }

    root.querySelector('#bk-cancel')?.addEventListener('click', () => sheet.close());

    root.querySelector('#bk-test')?.addEventListener('click', async () => {
        const data = await collectAndValidate();
        if (!data) return;
        // Test path: temp-add → test → temp-remove. Cheap enough for a
        // test connection, and avoids having to teach the test endpoint
        // about anonymous configs.
        const btn = root.querySelector('#bk-test');
        btn.disabled = true;
        try {
            if (isEdit) {
                // Save the current edits first (so the test reflects what
                // the user just typed), then probe.
                await api.put(`/api/backup/destinations/${existing.id}`, {
                    config: data.config, mode: data.mode, cron: data.cron, retainCount: data.retainCount,
                });
                const r = await api.post(`/api/backup/destinations/${existing.id}/test`, {});
                showToast(r.detail || (r.ok ? 'OK' : 'Failed'), r.ok ? 'success' : 'error');
            } else {
                const created = await api.post('/api/backup/destinations', { ...data, enabled: false });
                try {
                    const r = await api.post(`/api/backup/destinations/${created.id}/test`, {});
                    showToast(r.detail || (r.ok ? 'OK' : 'Failed'), r.ok ? 'success' : 'error');
                } finally {
                    await api.delete(`/api/backup/destinations/${created.id}`).catch(() => {});
                }
            }
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        } finally {
            btn.disabled = false;
        }
    });

    root.querySelector('#bk-save')?.addEventListener('click', async () => {
        const data = await collectAndValidate();
        if (!data) return;
        try {
            if (isEdit) {
                await api.put(`/api/backup/destinations/${existing.id}`, {
                    name: data.name, mode: data.mode, cron: data.cron, retainCount: data.retainCount,
                    config: Object.keys(data.config).length ? data.config : undefined,
                });
                if (data.encryption !== existing.encryption || data.passphrase) {
                    await api.post(`/api/backup/destinations/${existing.id}/encryption`, {
                        enabled: data.encryption, passphrase: data.passphrase,
                    });
                }
            } else {
                await api.post('/api/backup/destinations', { ...data, enabled: true });
            }
            showToast(i18nT('maintenance.backup.saved', 'Destination saved'), 'success');
            sheet.close();
            await _refreshDestinations();
        } catch (e) {
            showToast(e?.data?.error || e.message || 'Failed', 'error');
        }
    });
}

// ---- WS wiring + page init -----------------------------------------------

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('backup_destination_added', () => { _refreshDestinations().catch(() => {}); });
    ws.on('backup_destination_updated', () => { _refreshDestinations().catch(() => {}); });
    ws.on('backup_destination_removed', () => { _refreshDestinations().catch(() => {}); });
    ws.on('backup_progress', (m) => {
        // Bump the per-destination progress feedback. We don't know the
        // total bytes per upload at this layer, so render the progress
        // strip in indeterminate mode (CSS pulse) and refresh status.
        const card = document.querySelector(`[data-dest-id="${m.destinationId}"]`);
        if (!card) return;
        const status = _statuses.get(m.destinationId);
        if (status && status.processing === 0) {
            // First progress event after idle — flip the count locally so
            // the pill updates without waiting for the next status poll.
            status.processing = 1;
            _renderAll();
        }
    });
    ws.on('backup_done', () => { _refreshStatuses().catch(() => {}); _refreshRecent().catch(() => {}); });
    ws.on('backup_error', () => { _refreshStatuses().catch(() => {}); _refreshRecent().catch(() => {}); });
    ws.on('backup_queue_drained', () => { _refreshStatuses().catch(() => {}); _refreshRecent().catch(() => {}); });
}

function _wirePage() {
    if (_pageWired) return;
    _pageWired = true;

    $('backup-add-btn')?.addEventListener('click', () => _openWizard(null));

    // Event delegation — card buttons + retry-job buttons in the recent strip.
    $('backup-cards')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const card = btn.closest('[data-dest-id]');
        if (!card) return;
        const id = Number(card.dataset.destId);
        _onCardAction(id, btn.dataset.act);
    });
    $('backup-recent')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act="retry-job"]');
        if (!btn) return;
        const id = Number(btn.dataset.jobId);
        try {
            await api.post(`/api/backup/jobs/${id}/retry`, {});
            showToast(i18nT('maintenance.backup.retry_queued', 'Retry queued'), 'success');
            await _refreshRecent();
        } catch (err) {
            showToast(err?.data?.error || err.message || 'Failed', 'error');
        }
    });
}

export async function init() {
    _wireWs();
    _wirePage();
    await _refreshDestinations();
    await _refreshRecent();
}
