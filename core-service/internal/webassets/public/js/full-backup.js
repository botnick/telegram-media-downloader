// Whole-app backup & restore card on Maintenance → Backup.
//
// "Download full backup" builds one encrypted file with the database,
// settings and Telegram accounts (no media) — POST /api/backup/full, then
// the browser downloads GET /api/backup/full/:id natively, so a large file
// never sits in page memory. "Restore from a file" uploads the file
// (/restore/upload, with progress), verifies it with its password
// (/restore/verify) and swaps it in at the next start
// (/restore/restart). Both ask for the dashboard password again.

import { api } from './api.js';
import { showToast, escapeHtml, formatBytes } from './utils.js';
import { openSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const MIN_PASS = 8;
let card = null;
let status = null;

function fmtDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return String(iso);
    }
}

function errMsg(e) {
    const code = e?.data?.code || e?.code || '';
    if (code === 'BAD_PASSWORD') {
        return i18nT('fullbackup.err.dashboard_password', 'Wrong dashboard password.');
    }
    if (code === 'WRONG_BACKUP_PASSWORD') {
        return i18nT('fullbackup.err.backup_password', 'Wrong backup password, or the file is damaged.');
    }
    if (code === 'NOT_A_BACKUP') {
        return i18nT('fullbackup.err.not_backup', 'This file is not a whole-app backup (.tgdl-backup).');
    }
    if (code === 'NEWER_BACKUP') {
        return i18nT('fullbackup.err.newer', 'This backup was made by a newer version. Update the app first, then restore.');
    }
    if (code === 'NO_SPACE') {
        return i18nTf('fullbackup.err.space', { msg: e?.data?.error || '' }, `Not enough free disk space: ${e?.data?.error || ''}`);
    }
    return e?.data?.error || e?.error || e?.message || i18nT('fullbackup.err.failed', 'Something went wrong.');
}

function field(id, label, type = 'password', help = '') {
    return `<label class="cd-label" for="${id}">${escapeHtml(label)}</label>
        <input id="${id}" type="${type}" class="tg-input aw-input" autocomplete="${type === 'password' ? 'new-password' : 'off'}">
        ${help ? `<p class="cd-help">${escapeHtml(help)}</p>` : ''}`;
}

function render() {
    if (!card) return;
    const pending = status?.pending;
    const last = status?.last;
    let banner = '';
    if (pending) {
        banner = `<div class="fb-banner fb-banner--pending" role="status">
            <i class="ri-time-line" aria-hidden="true"></i>
            <div class="min-w-0">
                <div class="font-semibold">${escapeHtml(i18nT('fullbackup.pending.title', 'A restore is ready'))}</div>
                <div class="text-xs">${escapeHtml(i18nTf('fullbackup.pending.body', { date: fmtDate(pending.manifest?.createdAt), version: pending.manifest?.appVersion || '?' }, `The backup from ${fmtDate(pending.manifest?.createdAt)} (version ${pending.manifest?.appVersion || '?'}) replaces the current data at the next start.`))}</div>
                <div class="flex gap-2 mt-2 flex-wrap">
                    ${status.canRestart ? `<button type="button" class="tg-btn text-xs px-3 py-1.5" data-fb-restart>${escapeHtml(i18nT('fullbackup.restart', 'Restart now and restore'))}</button>` : `<span class="text-xs">${escapeHtml(i18nT('fullbackup.restart_manual', 'Stop and start the server to finish the restore.'))}</span>`}
                    <button type="button" class="cr-link text-xs" data-fb-cancel>${escapeHtml(i18nT('fullbackup.cancel_restore', 'Cancel the restore'))}</button>
                </div>
            </div>
        </div>`;
    } else if (last) {
        banner = last.ok
            ? `<div class="fb-banner fb-banner--ok" role="status"><i class="ri-checkbox-circle-line" aria-hidden="true"></i><div class="text-xs">${escapeHtml(i18nTf('fullbackup.last.ok', { date: fmtDate(last.at), backup: fmtDate(last.manifest?.createdAt), previous: last.previous || '' }, `Restored on ${fmtDate(last.at)} from the backup of ${fmtDate(last.manifest?.createdAt)}. The data from before is kept in data/restore/${last.previous || ''}.`))}</div></div>`
            : `<div class="fb-banner fb-banner--error" role="alert"><i class="ri-error-warning-line" aria-hidden="true"></i><div class="text-xs">${escapeHtml(i18nTf('fullbackup.last.failed', { date: fmtDate(last.at), error: last.error || '' }, `The restore on ${fmtDate(last.at)} did not complete, so the app kept its previous data: ${last.error || ''}`))}</div></div>`;
    }
    card.innerHTML = `
        <div class="flex items-start justify-between gap-3 flex-wrap">
            <div class="min-w-0">
                <h2 class="text-tg-text text-base font-semibold">${escapeHtml(i18nT('fullbackup.title', 'Whole-app backup'))}</h2>
                <p class="text-xs text-tg-textSecondary mt-0.5">${escapeHtml(i18nT('fullbackup.subtitle', 'One encrypted file with the database, settings and Telegram accounts — not the media files. Use it to move to a new machine or to go back after a mistake.'))}</p>
            </div>
            <div class="flex items-center gap-2 flex-wrap justify-end">
                <button type="button" class="tg-btn text-xs px-3 py-1.5 inline-flex items-center gap-1.5" data-fb-download>
                    <i class="ri-download-2-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('fullbackup.download', 'Download full backup'))}</span>
                </button>
                <button type="button" class="tg-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5" data-fb-restore>
                    <i class="ri-upload-2-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('fullbackup.restore', 'Restore from a file'))}</span>
                </button>
            </div>
        </div>
        ${banner ? `<div class="mt-3">${banner}</div>` : ''}`;
}

async function refresh() {
    try {
        status = await api.get('/api/backup/full/restore/status');
    } catch {
        status = null;
    }
    render();
}

// ---- download ---------------------------------------------------------------

function openDownload() {
    const box = document.createElement('form');
    box.className = 'aw-form';
    box.noValidate = true;
    box.innerHTML = `
        <p class="cd-help">${escapeHtml(i18nT('fullbackup.dl.help', 'Choose a password for this file. Without it the backup cannot be restored — nobody can recover it for you.'))}</p>
        ${field('fb-pass', i18nT('fullbackup.dl.pass', 'Backup password (at least 8 characters)'))}
        ${field('fb-pass2', i18nT('fullbackup.dl.pass2', 'Repeat the backup password'))}
        ${field('fb-admin', i18nT('fullbackup.dashboard_password', 'Dashboard password'), 'password', i18nT('fullbackup.dashboard_password_help', 'The backup holds your Telegram logins, so the dashboard password is asked again.'))}
        <div class="aw-error hidden" role="alert" data-fb-error></div>
        <div class="aw-footer">
            <button type="button" class="aw-cancel" data-fb-close>${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>
            <button type="submit" class="tg-btn aw-primary" data-fb-submit>${escapeHtml(i18nT('fullbackup.dl.submit', 'Make the backup'))}</button>
        </div>`;
    const handle = openSheet({ title: i18nT('fullbackup.download', 'Download full backup'), content: box, size: 'sm' });
    const error = (msg) => {
        const el = box.querySelector('[data-fb-error]');
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    };
    box.querySelector('[data-fb-close]').addEventListener('click', () => handle.close());
    box.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pass = box.querySelector('#fb-pass').value;
        const pass2 = box.querySelector('#fb-pass2').value;
        const admin = box.querySelector('#fb-admin').value;
        if ([...pass].length < MIN_PASS) return error(i18nT('fullbackup.err.short', 'The backup password needs at least 8 characters.'));
        if (pass !== pass2) return error(i18nT('fullbackup.err.mismatch', 'The two backup passwords are different.'));
        if (!admin) return error(i18nT('fullbackup.err.dashboard_empty', 'Enter the dashboard password.'));
        const btn = box.querySelector('[data-fb-submit]');
        btn.disabled = true;
        btn.textContent = i18nT('fullbackup.dl.working', 'Making the backup…');
        error('');
        try {
            const r = await api.post('/api/backup/full', { passphrase: pass, password: admin }, { timeoutMs: 30 * 60_000 });
            const a = document.createElement('a');
            a.href = `/api/backup/full/${encodeURIComponent(r.id)}`;
            a.download = r.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            handle.close();
            showToast(i18nTf('fullbackup.dl.done', { size: formatBytes(r.size) }, `Backup ready (${formatBytes(r.size)}). Keep the file and its password safe.`), 'success', 6000);
        } catch (err) {
            btn.disabled = false;
            btn.textContent = i18nT('fullbackup.dl.submit', 'Make the backup');
            error(errMsg(err));
        }
    });
    setTimeout(() => box.querySelector('#fb-pass')?.focus(), 30);
}

// ---- restore ----------------------------------------------------------------

function upload(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/backup/full/restore/upload');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
            let body = {};
            try {
                body = JSON.parse(xhr.responseText || '{}');
            } catch {
                /* keep empty */
            }
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject({ data: body, message: body.error || `HTTP ${xhr.status}` });
        };
        xhr.onerror = () => reject({ message: i18nT('fullbackup.err.network', 'The upload was interrupted.') });
        xhr.send(file);
    });
}

function openRestore() {
    let uploadId = null;
    let uploadedFile = null;
    const box = document.createElement('form');
    box.className = 'aw-form';
    box.noValidate = true;
    box.innerHTML = `
        <p class="cd-help">${escapeHtml(i18nT('fullbackup.rs.help', 'Restoring replaces the database, settings, Telegram accounts and the dashboard password with the ones in the backup. Media files are not touched. The current data is kept aside, and nothing changes until the app restarts.'))}</p>
        <label class="cd-label" for="fb-file">${escapeHtml(i18nT('fullbackup.rs.file', 'Backup file (.tgdl-backup)'))}</label>
        <input id="fb-file" type="file" accept=".tgdl-backup,application/octet-stream" class="tg-input aw-input">
        ${field('fb-rpass', i18nT('fullbackup.rs.pass', 'Backup password'))}
        ${field('fb-radmin', i18nT('fullbackup.dashboard_password', 'Dashboard password'))}
        <div class="fb-progress hidden" data-fb-progress><div class="fb-progress-bar" data-fb-bar></div></div>
        <div class="cd-help" data-fb-step role="status" aria-live="polite"></div>
        <div class="aw-error hidden" role="alert" data-fb-error></div>
        <div class="aw-footer">
            <button type="button" class="aw-cancel" data-fb-close>${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>
            <button type="submit" class="tg-btn aw-primary" data-fb-submit>${escapeHtml(i18nT('fullbackup.rs.submit', 'Check the backup'))}</button>
        </div>`;
    const handle = openSheet({ title: i18nT('fullbackup.restore', 'Restore from a file'), content: box, size: 'sm' });
    const $ = (s) => box.querySelector(s);
    const error = (msg) => {
        $('[data-fb-error]').textContent = msg || '';
        $('[data-fb-error]').classList.toggle('hidden', !msg);
    };
    const step = (msg) => {
        $('[data-fb-step]').textContent = msg || '';
    };
    $('[data-fb-close]').addEventListener('click', () => handle.close());
    $('#fb-file').addEventListener('change', () => {
        uploadId = null;
    });
    box.addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = $('#fb-file').files?.[0];
        const pass = $('#fb-rpass').value;
        const admin = $('#fb-radmin').value;
        if (!file) return error(i18nT('fullbackup.err.no_file', 'Choose the backup file.'));
        if (!pass) return error(i18nT('fullbackup.err.no_pass', 'Enter the backup password.'));
        if (!admin) return error(i18nT('fullbackup.err.dashboard_empty', 'Enter the dashboard password.'));
        const btn = $('[data-fb-submit]');
        btn.disabled = true;
        error('');
        try {
            // A wrong password keeps the upload, so a retry skips sending it again.
            if (!uploadId || uploadedFile !== file) {
                $('[data-fb-progress]').classList.remove('hidden');
                step(i18nT('fullbackup.rs.uploading', 'Uploading…'));
                const r = await upload(file, (p) => {
                    $('[data-fb-bar]').style.width = `${Math.round(p * 100)}%`;
                    step(i18nTf('fullbackup.rs.uploading_pct', { pct: Math.round(p * 100) }, `Uploading… ${Math.round(p * 100)}%`));
                });
                uploadId = r.uploadId;
                uploadedFile = file;
            }
            step(i18nT('fullbackup.rs.verifying', 'Checking the password and every file in the backup…'));
            const v = await api.post(
                '/api/backup/full/restore/verify',
                { uploadId, passphrase: pass, password: admin },
                { timeoutMs: 30 * 60_000 },
            );
            status = v;
            render();
            handle.close();
            confirmRestart(v);
        } catch (err) {
            btn.disabled = false;
            step('');
            if (/gone/i.test(err?.data?.error || '')) uploadId = null;
            error(errMsg(err));
        }
    });
}

function confirmRestart(v) {
    const p = v.verified || v.pending;
    const box = document.createElement('div');
    box.className = 'aw-form';
    box.innerHTML = `
        <div class="aw-done" role="status">
            <i class="ri-shield-check-fill" aria-hidden="true"></i>
            <div>
                <div class="aw-done-title">${escapeHtml(i18nT('fullbackup.ok.title', 'The backup is valid'))}</div>
                <div class="cd-help">${escapeHtml(i18nTf('fullbackup.ok.body', { date: fmtDate(p?.manifest?.createdAt), version: p?.manifest?.appVersion || '?', files: p?.files ?? 0, size: formatBytes(p?.bytes || 0) }, `Made ${fmtDate(p?.manifest?.createdAt)} by version ${p?.manifest?.appVersion || '?'} — ${p?.files ?? 0} files, ${formatBytes(p?.bytes || 0)}.`))}</div>
            </div>
        </div>
        <p class="cd-help">${escapeHtml(v.canRestart ? i18nT('fullbackup.ok.restart_help', 'Restart now to switch to it. The page comes back by itself; sign in with the dashboard password from the backup.') : i18nT('fullbackup.restart_manual', 'Stop and start the server to finish the restore.'))}</p>
        <div class="aw-footer">
            <button type="button" class="aw-cancel" data-fb-later>${escapeHtml(i18nT('fullbackup.ok.later', 'Later'))}</button>
            ${v.canRestart ? `<button type="button" class="tg-btn aw-primary" data-fb-restart>${escapeHtml(i18nT('fullbackup.restart', 'Restart now and restore'))}</button>` : ''}
        </div>`;
    const handle = openSheet({ title: i18nT('fullbackup.restore', 'Restore from a file'), content: box, size: 'sm' });
    box.querySelector('[data-fb-later]').addEventListener('click', () => handle.close());
    box.querySelector('[data-fb-restart]')?.addEventListener('click', async () => {
        handle.close();
        await restartNow();
    });
}

async function restartNow() {
    let before = '';
    try {
        before = (await api.post('/api/backup/full/restore/restart', {}))?.bootId || '';
    } catch (err) {
        showToast(errMsg(err), 'error', 6000);
        return;
    }
    showToast(i18nT('fullbackup.restarting', 'Restarting to restore… the page reloads by itself.'), 'info', 60_000);
    // The new process answers with another boot id — or 401, because the
    // restored data has its own sign-ins. Network errors mean "not yet".
    const started = Date.now();
    const tick = async () => {
        try {
            const r = await fetch('/api/backup/full/restore/status', { cache: 'no-store', credentials: 'same-origin' });
            if (r.status === 401 || r.status === 403) return location.reload();
            if (r.ok) {
                const j = await r.json();
                if (j.bootId && j.bootId !== before) return location.reload();
            }
        } catch {
            /* server still restarting */
        }
        if (Date.now() - started > 5 * 60_000) return location.reload();
        setTimeout(tick, 1500);
    };
    setTimeout(tick, 1500);
}

async function cancelRestore() {
    try {
        await api.post('/api/backup/full/restore/cancel', {});
        showToast(i18nT('fullbackup.cancelled', 'Restore cancelled. The current data stays.'), 'success');
    } catch (err) {
        showToast(errMsg(err), 'error');
    }
    refresh();
}

export async function init() {
    card = document.getElementById('full-backup-card');
    if (!card) return;
    if (!card.dataset.wired) {
        card.dataset.wired = '1';
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-fb-download]')) openDownload();
            else if (e.target.closest('[data-fb-restore]')) openRestore();
            else if (e.target.closest('[data-fb-restart]')) restartNow();
            else if (e.target.closest('[data-fb-cancel]')) cancelRestore();
        });
    }
    render();
    await refresh();
}
