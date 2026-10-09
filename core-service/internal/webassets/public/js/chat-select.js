// Chats page select mode — tick chats (or Select all on the current tab and
// search), then leave them from one Telegram account in one go.
//
// The leave sheet offers two outcomes: leave only (downloaded files stay) or
// leave and delete what was downloaded from those chats. The server runs the
// job one chat at a time (POST /api/chats/leave-batch) and deletes files only
// for chats Telegram confirmed removed; this module polls its status.

import { api } from './api.js';
import { state } from './store.js';
import { openSheet } from './sheet.js';
import { escapeHtml, showToast } from './utils.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';
import { accessFor, refreshDialogs } from './chat-access.js';

const sel = { on: false, ids: new Set(), visible: [] };
let rerender = () => {};
let onFinished = () => {};

export function initChatSelect(opts = {}) {
    rerender = opts.rerender || rerender;
    onFinished = opts.onFinished || onFinished;
}

export function isSelecting() {
    return sel.on;
}

export function isSelected(id) {
    return sel.ids.has(String(id));
}

export function setSelected(id, on) {
    if (on) sel.ids.add(String(id));
    else sel.ids.delete(String(id));
    paintBar();
}

function exitSelect() {
    sel.on = false;
    sel.ids.clear();
    rerender();
}

/** Called after each list render with the chats currently shown. */
export function paintSelectBar(visibleChats) {
    sel.visible = visibleChats.map((c) => ({ ...c, id: String(c.id) }));
    const shown = new Set(sel.visible.map((c) => c.id));
    // Selection never reaches chats hidden by the tab or the search.
    for (const id of [...sel.ids]) if (!shown.has(id)) sel.ids.delete(id);
    paintBar();
}

function bar() {
    let el = document.getElementById('groups-select-bar');
    if (el) return el;
    const list = document.getElementById('groups-config-list');
    if (!list) return null;
    el = document.createElement('div');
    el.id = 'groups-select-bar';
    el.className = 'chat-select-bar';
    el.setAttribute('data-admin-only', '');
    list.before(el);
    el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-sel]');
        if (!b || b.disabled) return;
        const kind = b.dataset.sel;
        if (kind === 'start') {
            sel.on = true;
            rerender();
        } else if (kind === 'cancel') {
            exitSelect();
        } else if (kind === 'all') {
            const all = sel.visible.length > 0 && sel.visible.every((c) => sel.ids.has(c.id));
            if (all) sel.ids.clear();
            else for (const c of sel.visible) sel.ids.add(c.id);
            rerender();
        } else if (kind === 'leave') {
            openBatchLeaveSheet(sel.visible.filter((c) => sel.ids.has(c.id)));
        }
    });
    return el;
}

function paintBar() {
    const el = bar();
    if (!el) return;
    if (!sel.visible.length && !sel.on) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    if (!sel.on) {
        el.innerHTML = `<button type="button" class="tg-btn-secondary chat-select-start" data-sel="start">
            <i class="ri-checkbox-multiple-line" aria-hidden="true"></i><span>${escapeHtml(i18nT('chats.select.start', 'Select'))}</span></button>`;
        return;
    }
    const n = sel.ids.size;
    const all = sel.visible.length > 0 && sel.visible.every((c) => sel.ids.has(c.id));
    el.innerHTML = `
        <span class="chat-select-count" role="status" aria-live="polite">${escapeHtml(i18nTf('chats.select.count', { n }, `${n} selected`))}</span>
        <button type="button" class="tg-btn-secondary" data-sel="all" ${sel.visible.length ? '' : 'disabled'}>
            <i class="${all ? 'ri-checkbox-indeterminate-line' : 'ri-checkbox-multiple-line'}" aria-hidden="true"></i>
            <span>${escapeHtml(all ? i18nT('chats.select.none', 'Clear selection') : i18nTf('chats.select.all', { n: sel.visible.length }, `Select all (${sel.visible.length})`))}</span></button>
        <button type="button" class="tg-btn chat-select-leave" data-sel="leave" ${n ? '' : 'disabled'}>
            <i class="ri-logout-box-r-line" aria-hidden="true"></i><span>${escapeHtml(i18nTf('chats.select.leave', { n }, `Leave from Telegram (${n})`))}</span></button>
        <button type="button" class="tg-btn-secondary" data-sel="cancel">${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>`;
}

function accountLabel(a) {
    return a.username ? `@${a.username}` : a.name || a.phone || a.id;
}

/** Accounts that hold the chat, from fresh dialog metadata. */
function chatAccounts(chat) {
    const d = (state.allDialogs || []).find((x) => String(x.id) === chat.id) || chat;
    const access = accessFor(chat.id, d);
    return [...new Set((d.accountIds || access.accounts?.map((a) => a.id) || []).map(String))];
}

function openBatchLeaveSheet(chats) {
    if (!chats.length) return;
    const accounts = state.dialogsAccounts || [];
    const counts = new Map();
    for (const c of chats) for (const id of chatAccounts(c)) counts.set(id, (counts.get(id) || 0) + 1);
    const ids = [...counts.keys()];
    const names = new Map(chats.map((c) => [c.id, c.name || c.id]));
    const preview = chats.slice(0, 8).map((c) => `<li>${escapeHtml(c.name || c.id)}</li>`).join('');
    const more = chats.length > 8 ? `<li>${escapeHtml(i18nTf('chats.leave_batch.more', { n: chats.length - 8 }, `…and ${chats.length - 8} more`))}</li>` : '';
    const box = document.createElement('div');
    box.className = 'chat-leave-sheet';
    box.innerHTML = `
        <p class="chat-leave-name">${escapeHtml(i18nTf('chats.leave_batch.heading', { n: chats.length }, `${chats.length} chats`))}</p>
        <ul class="chat-leave-list">${preview}${more}</ul>
        <label class="cd-label" for="chat-batch-account">${escapeHtml(i18nT('access.leave.account', 'Telegram account'))}</label>
        <select id="chat-batch-account" class="tg-input" data-batch-account>
            ${ids.length === 1 ? '' : `<option value="">${escapeHtml(i18nT('access.leave.choose_account', 'Choose an account…'))}</option>`}
            ${ids.map((id) => {
                const a = accounts.find((x) => String(x.id) === id);
                const label = a ? accountLabel(a) : id;
                return `<option value="${escapeHtml(id)}">${escapeHtml(label)} — ${escapeHtml(i18nTf('chats.leave_batch.account_has', { n: counts.get(id), total: chats.length }, `in ${counts.get(id)} of ${chats.length}`))}</option>`;
            }).join('')}
        </select>
        <p class="cd-help" data-batch-skip></p>
        <fieldset class="chat-leave-mode">
            <legend class="cd-label">${escapeHtml(i18nT('chats.leave_batch.mode', 'Downloaded files'))}</legend>
            <label class="chat-leave-option"><input type="radio" name="chat-batch-mode" value="keep" checked>
                <span><strong>${escapeHtml(i18nT('chats.leave_batch.keep', 'Leave only — keep files'))}</strong>
                <span class="cd-help">${escapeHtml(i18nT('chats.leave_batch.keep_help', 'Everything already downloaded stays in your library.'))}</span></span></label>
            <label class="chat-leave-option"><input type="radio" name="chat-batch-mode" value="delete">
                <span><strong>${escapeHtml(i18nT('chats.leave_batch.delete', 'Leave and delete their files'))}</strong>
                <span class="cd-help">${escapeHtml(i18nT('chats.leave_batch.delete_help', 'Deletes the files, download history and settings of each chat Telegram confirms you left. This cannot be undone.'))}</span></span></label>
        </fieldset>
        <div class="chat-leave-typed hidden" data-batch-typed>
            <label class="cd-label" for="chat-batch-confirm">${escapeHtml(i18nTf('chats.leave_batch.type', { n: chats.length }, `Type ${chats.length} to confirm deleting files`))}</label>
            <input id="chat-batch-confirm" class="tg-input" inputmode="numeric" autocomplete="off" data-batch-confirm>
        </div>
        <p class="chat-leave-status" data-batch-status role="status" aria-live="polite"></p>
        <div class="cd-access-actions">
            <button type="button" class="tg-btn-secondary" data-batch-cancel>${escapeHtml(i18nT('common.cancel', 'Cancel'))}</button>
            <button type="button" class="tg-btn" data-batch-go disabled>${escapeHtml(i18nT('chats.leave_batch.go', 'Leave chats'))}</button>
        </div>`;
    const handle = openSheet({ title: i18nT('chats.leave_batch.title', 'Leave chats from Telegram?'), content: box });
    const select = box.querySelector('[data-batch-account]');
    const skip = box.querySelector('[data-batch-skip]');
    const typedBox = box.querySelector('[data-batch-typed]');
    const typed = box.querySelector('[data-batch-confirm]');
    const status = box.querySelector('[data-batch-status]');
    const go = box.querySelector('[data-batch-go]');
    const cancel = box.querySelector('[data-batch-cancel]');
    let started = false;
    const mode = () => box.querySelector('input[name="chat-batch-mode"]:checked')?.value || 'keep';
    const targets = () => chats.filter((c) => chatAccounts(c).includes(select.value));
    const check = () => {
        const n = select.value ? targets().length : 0;
        skip.textContent = select.value && n < chats.length
            ? i18nTf('chats.leave_batch.skipped', { n: chats.length - n }, `${chats.length - n} selected chats are not in this account and will be skipped.`)
            : '';
        typedBox.classList.toggle('hidden', mode() !== 'delete');
        go.textContent = mode() === 'delete'
            ? i18nTf('chats.leave_batch.go_delete', { n }, `Leave ${n} and delete files`)
            : i18nTf('chats.leave_batch.go_keep', { n }, `Leave ${n} chats`);
        go.classList.toggle('chat-leave-danger', mode() === 'delete');
        go.disabled = started || !n || (mode() === 'delete' && typed.value.trim() !== String(chats.length));
    };
    select.addEventListener('change', check);
    typed.addEventListener('input', check);
    box.querySelectorAll('input[name="chat-batch-mode"]').forEach((r) => r.addEventListener('change', check));
    cancel.addEventListener('click', () => handle.close());
    check();
    go.addEventListener('click', async () => {
        const list = targets();
        if (started || go.disabled || !list.length) return;
        started = true;
        go.disabled = true;
        select.disabled = true;
        box.querySelectorAll('input').forEach((i) => { i.disabled = true; });
        cancel.textContent = i18nT('access.leave.close_running', 'Close — request continues');
        status.dataset.kind = '';
        status.textContent = i18nT('chats.leave_batch.starting', 'Connecting to Telegram…');
        try {
            const body = { accountId: select.value, ids: list.map((c) => c.id), deleteFiles: mode() === 'delete', confirm: String(list.length) };
            await api.post('/api/chats/leave-batch', body);
            const final = await follow((s) => { status.textContent = progressText(s); });
            const text = resultText(final, names);
            status.textContent = text;
            status.dataset.kind = final.error || jobCount(final.failed) || final.stopped ? 'warning' : '';
            showToast(text, status.dataset.kind ? 'warning' : 'success', 8000);
            if (jobCount(final.removed) > 0) {
                state.groups = (state.groups || []).filter((g) => g.peerId || !removedIds(final).has(String(g.id)));
            }
            cancel.textContent = i18nT('common.close', 'Close');
            sel.on = false;
            sel.ids.clear();
            await refreshDialogs().catch(() => {});
            onFinished(final);
        } catch (e) {
            started = false;
            status.textContent = e?.data?.message || e?.data?.error || e?.message || i18nT('access.leave.failed', 'Telegram did not confirm removal.');
            status.dataset.kind = 'error';
            showToast(status.textContent, 'error', 7000);
            cancel.textContent = i18nT('common.cancel', 'Cancel');
            select.disabled = false;
            box.querySelectorAll('input').forEach((i) => { i.disabled = false; });
            check();
        }
    });
    return handle;
}

function jobCount(v) {
    return Number(v) || 0;
}

function removedIds(s) {
    return new Set((s.results || []).filter((r) => r.ok).map((r) => String(r.id)));
}

async function follow(onProgress) {
    for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await api.get('/api/chats/leave-batch/status');
        if (s?.running !== true) return s || {};
        onProgress(s);
    }
}

function progressText(s) {
    if (s.stage === 'deleting_files') {
        return i18nTf('chats.leave_batch.deleting', { n: jobCount(s.filesProcessed), total: jobCount(s.removed) }, `Deleting files… ${jobCount(s.filesProcessed)} / ${jobCount(s.removed)} chats`);
    }
    if (s.stage === 'leaving') {
        return i18nTf('chats.leave_batch.leaving', { n: jobCount(s.processed), total: jobCount(s.total) }, `Leaving… ${jobCount(s.processed)} / ${jobCount(s.total)}`);
    }
    return i18nT('chats.leave_batch.starting', 'Connecting to Telegram…');
}

function resultText(s, names) {
    if (s.stage === 'error' && !jobCount(s.removed)) {
        return s.error || i18nT('access.leave.failed', 'Telegram did not confirm removal.');
    }
    const parts = [i18nTf('chats.leave_batch.done', { n: jobCount(s.removed), total: jobCount(s.total) }, `Left ${jobCount(s.removed)} of ${jobCount(s.total)} chats.`)];
    if (s.deleteFiles) {
        parts.push(i18nTf('chats.leave_batch.files_deleted', { n: jobCount(s.filesDeleted) }, `${jobCount(s.filesDeleted)} files deleted.`));
    } else {
        parts.push(i18nT('access.leave.files_kept_short', 'Downloaded files kept.'));
    }
    if (s.stopped) {
        const left = jobCount(s.total) - jobCount(s.processed);
        parts.push(i18nTf('chats.leave_batch.flood', { n: left, sec: jobCount(s.waitSeconds) }, `Telegram asked to wait ${jobCount(s.waitSeconds)} s, so ${left} chats were not tried. Try them again later.`));
    }
    const failed = (s.results || []).filter((r) => !r.ok);
    if (failed.length) {
        const list = failed.slice(0, 5).map((r) => names.get(String(r.id)) || r.id).join(', ');
        parts.push(i18nTf('chats.leave_batch.failed', { n: failed.length, list }, `${failed.length} failed: ${list}`));
    }
    if (jobCount(s.localFailed)) {
        parts.push(i18nT('chats.leave_batch.local_failed', 'Some local files or settings could not be cleaned up — check Maintenance.'));
    }
    return parts.join(' ');
}
