// Maintenance — Cluster mode (admin page).
//
// Three sections:
//   1. Identity — own peer_id, editable display name, cluster token
//      (revealable, copyable, rotatable).
//   2. Peers — list of paired remote peers, "Add peer" wizard (paste URL +
//      token), per-peer Test / Edit / Revoke actions.
//   3. Audit log — recent cluster events (handshake, signed-request fail,
//      token rotation, etc).
//
// Live updates arrive via WebSocket: peer_added, peer_removed, peer_status.

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast, escapeHtml, formatRelativeTime } from './utils.js';
import { openSheet, confirmSheet } from './sheet.js';
import { t as i18nT, tf as i18nTf } from './i18n.js';

const $ = (id) => document.getElementById(id);

let _wsWired = false;
let _pageWired = false;
let _peers = [];
let _identity = null;
let _tokenShown = false;
let _lastSweepStats = null;

// ---- Helpers --------------------------------------------------------------

function _statusPill(status) {
    const map = {
        online: { key: 'cluster.peer.status.online', cls: 'bg-green-500/15 text-green-300' },
        offline: { key: 'cluster.peer.status.offline', cls: 'bg-tg-bg/50 text-tg-textSecondary' },
        paired_pending: {
            key: 'cluster.peer.status.paired_pending',
            cls: 'bg-yellow-500/15 text-yellow-300',
        },
        revoked: { key: 'cluster.peer.status.revoked', cls: 'bg-red-500/15 text-red-300' },
    };
    const m = map[status] || map.offline;
    return { label: i18nT(m.key, status), cls: m.cls };
}

function _streamModeLabel(mode) {
    return mode === 'direct'
        ? i18nT('cluster.peer.stream_mode.direct', 'Browser fetches direct')
        : i18nT('cluster.peer.stream_mode.proxy', 'Proxy through this peer');
}

function _renderPeerRow(p) {
    const pill = _statusPill(p.status);
    const lastSeen = p.lastSeenAt
        ? i18nTf('cluster.peer.last_seen', { ago: formatRelativeTime(p.lastSeenAt) })
        : i18nT('cluster.peer.never_seen', 'Never');
    return `
        <div class="rounded-lg border border-tg-border/40 bg-tg-bg/30 p-3" data-peer-id="${escapeHtml(p.peerId)}">
            <div class="flex items-start justify-between gap-2 flex-wrap">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h4 class="text-sm font-semibold text-tg-text">${escapeHtml(p.name)}</h4>
                        <span class="text-[10px] px-1.5 py-0.5 rounded ${pill.cls}">${escapeHtml(pill.label)}</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-tg-bg/50 text-tg-textSecondary">${escapeHtml(_streamModeLabel(p.streamMode))}</span>
                    </div>
                    <div class="text-[11px] text-tg-textSecondary mt-1 truncate">${escapeHtml(p.url)}</div>
                    <div class="text-[10px] text-tg-textSecondary/70 mt-0.5">
                        <code class="break-all">${escapeHtml(p.peerId)}</code> · ${escapeHtml(lastSeen)}
                    </div>
                </div>
                <div class="flex gap-1 shrink-0">
                    <button class="tg-btn-ghost text-xs px-2 py-1" data-act="test">${escapeHtml(i18nT('cluster.peer.test', 'Test'))}</button>
                    <button class="tg-btn-ghost text-xs px-2 py-1" data-act="edit">${escapeHtml(i18nT('cluster.peer.edit', 'Edit'))}</button>
                    <button class="tg-btn-ghost text-xs px-2 py-1 text-red-300" data-act="revoke">${escapeHtml(i18nT('cluster.peer.revoke', 'Revoke'))}</button>
                </div>
            </div>
        </div>`;
}

function _renderPeers() {
    const list = $('cluster-peers-list');
    const empty = $('cluster-peers-empty');
    if (!list || !empty) return;
    if (!_peers.length) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
    } else {
        empty.classList.add('hidden');
        list.innerHTML = _peers.map(_renderPeerRow).join('');
        list.querySelectorAll('[data-peer-id]').forEach((row) => {
            row.querySelector('[data-act="test"]')?.addEventListener('click', () =>
                _testPeer(row.dataset.peerId),
            );
            row.querySelector('[data-act="edit"]')?.addEventListener('click', () =>
                _editPeer(row.dataset.peerId),
            );
            row.querySelector('[data-act="revoke"]')?.addEventListener('click', () =>
                _revokePeer(row.dataset.peerId),
            );
        });
    }
    _renderStats();
}

function _renderStats() {
    const peersEl = $('cluster-stat-peers');
    const onlineEl = $('cluster-stat-online');
    const conflictsEl = $('cluster-stat-conflicts');
    const sweepEl = $('cluster-stat-sweep');
    if (peersEl) peersEl.textContent = String(_peers.length);
    if (onlineEl) {
        const online = _peers.filter((p) => p.status === 'online').length;
        onlineEl.textContent = _peers.length ? `${online} / ${_peers.length}` : '0';
    }
    if (conflictsEl) {
        const n = _lastSweepStats?.conflicts ?? 0;
        conflictsEl.textContent = String(n);
        conflictsEl.classList.toggle('text-tg-orange', n > 0);
        conflictsEl.classList.toggle('text-tg-text', n === 0);
    }
    if (sweepEl) {
        sweepEl.textContent = _lastSweepStats?.lastRunAt
            ? formatRelativeTime(_lastSweepStats.lastRunAt)
            : i18nT('cluster.sweep.never', 'Never');
    }
}

function _renderIdentity() {
    if (!_identity) return;
    const idEl = $('cluster-self-id');
    const nameEl = $('cluster-self-name');
    const nameDisplayEl = $('cluster-self-name-display');
    if (idEl) idEl.textContent = _identity.peerId;
    if (nameEl && document.activeElement !== nameEl) nameEl.value = _identity.name || '';
    if (nameDisplayEl)
        nameDisplayEl.textContent = _identity.name || _identity.peerId.slice(0, 12) || '—';
}

function _showNameEditor(show) {
    const editor = $('cluster-self-name-editor');
    const editBtn = $('cluster-self-name-edit');
    if (!editor) return;
    editor.classList.toggle('hidden', !show);
    editBtn?.classList.toggle('hidden', show);
    if (show) $('cluster-self-name')?.focus();
}

async function _copySelfId() {
    if (!_identity?.peerId) return;
    try {
        await navigator.clipboard.writeText(_identity.peerId);
        showToast(i18nT('cluster.identity.id.copied', 'Peer ID copied'));
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

async function _renderAudit() {
    const list = $('cluster-audit-list');
    const empty = $('cluster-audit-empty');
    if (!list || !empty) return;
    let entries = [];
    try {
        const r = await api.get('/api/cluster/audit?limit=30');
        entries = r?.entries || [];
    } catch {
        entries = [];
    }
    if (!entries.length) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    list.innerHTML = entries
        .map((e) => {
            const ok = e.ok === 1 || e.ok === true;
            const ts = formatRelativeTime(e.ts);
            const cls = ok ? 'text-tg-textSecondary' : 'text-red-300';
            return `<div class="flex items-baseline gap-2 text-xs ${cls}">
                <span class="w-20 shrink-0 truncate">${escapeHtml(ts)}</span>
                <span class="w-20 shrink-0 truncate font-mono">${escapeHtml(e.kind)}</span>
                <span class="truncate">${escapeHtml(e.detail || '')}</span>
            </div>`;
        })
        .join('');
}

// ---- Actions --------------------------------------------------------------

async function _loadIdentity() {
    try {
        const r = await api.get('/api/cluster/identity');
        _identity = r;
        _renderIdentity();
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

async function _loadPeers() {
    try {
        const r = await api.get('/api/cluster/peers');
        _peers = r?.peers || [];
        _renderPeers();
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

async function _saveName() {
    const name = $('cluster-self-name')?.value?.trim();
    if (!name) return;
    try {
        const r = await api.put('/api/cluster/identity', { name });
        _identity = r;
        showToast(i18nT('common.saved', 'Saved'));
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

async function _toggleToken() {
    const code = $('cluster-self-token');
    const btn = $('cluster-token-toggle');
    if (!code || !btn) return;
    if (_tokenShown) {
        code.textContent = '••••••••••••••••';
        btn.textContent = i18nT('cluster.identity.token.reveal', 'Show token');
        _tokenShown = false;
        return;
    }
    try {
        const r = await api.get('/api/cluster/identity/token');
        if (r?.token) {
            code.textContent = r.token;
            btn.textContent = i18nT('cluster.identity.token.hide', 'Hide');
            _tokenShown = true;
        }
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

async function _copyToken() {
    try {
        const r = await api.get('/api/cluster/identity/token');
        if (r?.token && navigator.clipboard) {
            await navigator.clipboard.writeText(r.token);
            showToast(i18nT('cluster.identity.token.copied', 'Token copied'));
        }
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

async function _setToken() {
    const node = document.createElement('div');
    node.innerHTML = `
        <p class="text-xs text-tg-textSecondary mb-3">${escapeHtml(i18nT('cluster.identity.token.set.help', 'Paste the cluster token from any peer already in the cluster. This peer will replace its own token with that value so they match — required before pairing them.'))}</p>
        <label class="block">
            <span class="text-xs text-tg-textSecondary">${escapeHtml(i18nT('cluster.identity.token', 'Cluster token'))}</span>
            <input id="set-token-input" type="text" autocomplete="off" spellcheck="false"
                   class="w-full bg-tg-bg/50 px-2 py-1.5 rounded text-sm mt-1 font-mono"
                   placeholder="${escapeHtml(i18nT('cluster.peer.token.placeholder', '32+ hex chars'))}" />
        </label>
        <div class="flex justify-end gap-2 pt-3">
            <button id="set-token-submit" class="tg-btn text-sm px-3 py-1.5">${escapeHtml(i18nT('cluster.identity.token.set.apply', 'Use this token'))}</button>
        </div>
        <div id="set-token-status" class="text-xs text-red-300 mt-1"></div>`;
    const sheet = openSheet({
        title: i18nT('cluster.identity.token.set', "Use cluster's token"),
        content: node,
        size: 'md',
    });
    const status = node.querySelector('#set-token-status');
    node.querySelector('#set-token-submit').addEventListener('click', async () => {
        const token = node.querySelector('#set-token-input').value.trim();
        if (!/^[0-9a-f]{32,}$/i.test(token)) {
            status.textContent = i18nT('cluster.error.bad_token', 'Token must be 32+ hex chars');
            return;
        }
        try {
            await api.post('/api/cluster/identity/set-token', { token });
            showToast(i18nT('cluster.identity.token.set.applied', 'Cluster token updated'));
            sheet.close?.();
            // Re-reveal the new token if it was already showing.
            if (_tokenShown) {
                _tokenShown = false;
                await _toggleToken();
            }
        } catch (e) {
            status.textContent = e?.message || String(e);
        }
    });
}

async function _rotateToken() {
    const ok = await confirmSheet({
        title: i18nT('cluster.identity.token.rotate', 'Rotate token'),
        message: i18nT(
            'cluster.identity.token.rotate.confirm',
            'Rotate the cluster token? Every paired peer must re-pair against the new value.',
        ),
        confirmLabel: i18nT('cluster.identity.token.rotate', 'Rotate token'),
        confirmKind: 'danger',
    });
    if (!ok) return;
    try {
        await api.post('/api/cluster/identity/rotate-token');
        showToast(
            i18nT(
                'cluster.identity.token.rotated',
                'Token rotated. Re-pair every peer with the new value.',
            ),
        );
        // Re-reveal the new token if it was already showing.
        if (_tokenShown) {
            _tokenShown = false;
            await _toggleToken();
        }
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

async function _issuePairingCode() {
    try {
        const r = await api.post('/api/cluster/identity/pairing-code');
        if (r?.code) {
            const node = document.createElement('div');
            node.innerHTML = `
                <p class="text-xs text-tg-textSecondary mb-3">${escapeHtml(i18nT('cluster.pairing_code.help', 'Show this code to the operator on the other peer. Valid for 5 minutes — single use.'))}</p>
                <div class="bg-tg-bg/50 rounded text-center py-4 font-mono text-2xl tracking-widest select-all">${escapeHtml(r.code)}</div>
                <p class="text-[11px] text-tg-textSecondary mt-2 text-center">${escapeHtml(i18nT('cluster.pairing_code.expires', 'Expires in 5 minutes'))}</p>`;
            openSheet({
                title: i18nT('cluster.pairing_code.title', 'Pairing code'),
                content: node,
                size: 'sm',
            });
        }
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

function _addPeerWizard() {
    const node = document.createElement('div');
    node.innerHTML = `
        <p class="text-xs text-tg-textSecondary mb-3" data-i18n="cluster.peer.add.help">
            ${escapeHtml(i18nT('cluster.peer.add.help', 'Open Settings → Cluster on the remote instance and copy its URL + cluster token here.'))}
        </p>
        <div class="space-y-2">
            <label class="block">
                <span class="text-xs text-tg-textSecondary">${escapeHtml(i18nT('cluster.peer.url', 'Peer URL'))}</span>
                <input id="add-peer-url" type="url" autocomplete="off" autocapitalize="off" spellcheck="false"
                       class="w-full bg-tg-bg/50 px-2 py-1.5 rounded text-sm mt-1"
                       placeholder="${escapeHtml(i18nT('cluster.peer.url.placeholder', 'https://b.example.com'))}" />
            </label>
            <label class="block">
                <span class="text-xs text-tg-textSecondary">${escapeHtml(i18nT('cluster.peer.token', 'Cluster token (from the remote peer)'))}</span>
                <input id="add-peer-token" type="text" autocomplete="off" spellcheck="false"
                       class="w-full bg-tg-bg/50 px-2 py-1.5 rounded text-sm mt-1 font-mono"
                       placeholder="${escapeHtml(i18nT('cluster.peer.token.placeholder', '32+ hex chars'))}" />
            </label>
            <div class="flex justify-end gap-2 pt-1">
                <button id="add-peer-submit" class="tg-btn text-sm px-3 py-1.5">${escapeHtml(i18nT('cluster.peer.pair', 'Pair'))}</button>
            </div>
            <div id="add-peer-status" class="text-xs text-tg-textSecondary"></div>
        </div>`;
    const sheet = openSheet({
        title: i18nT('cluster.peer.add.title', 'Pair a remote peer'),
        content: node,
        size: 'md',
    });
    const status = node.querySelector('#add-peer-status');
    const submit = node.querySelector('#add-peer-submit');
    submit.addEventListener('click', async () => {
        const url = node.querySelector('#add-peer-url').value.trim();
        const tokenOrCode = node.querySelector('#add-peer-token').value.trim();
        if (!url) {
            status.textContent = i18nT(
                'cluster.error.bad_url',
                'URL must start with http:// or https://',
            );
            return;
        }
        // Accept either a per-peer pairing code (6-16 alphanumeric) OR a
        // legacy 32+ hex cluster token.
        let body;
        if (/^[0-9a-f]{32,}$/i.test(tokenOrCode)) {
            body = { url, token: tokenOrCode };
        } else if (/^[A-Z0-9]{6,16}$/i.test(tokenOrCode)) {
            body = { url, pairingCode: tokenOrCode.toUpperCase() };
        } else {
            status.textContent = i18nT(
                'cluster.error.bad_token',
                'Paste either a pairing code (6-16 alphanumeric) or a 32+ hex token',
            );
            return;
        }
        submit.disabled = true;
        const restoreLabel = submit.textContent;
        submit.textContent = i18nT('cluster.peer.pairing', 'Pairing…');
        status.textContent = '';
        try {
            const r = await api.post('/api/cluster/peers', body);
            const peer = r?.peer;
            if (peer) {
                showToast(i18nTf('cluster.peer.paired', { name: peer.name }));
                sheet.close?.();
                await _loadPeers();
                _renderAudit();
            }
        } catch (e) {
            const code = e?.body?.code;
            const map = {
                bad_url: 'cluster.error.bad_url',
                bad_token: 'cluster.error.bad_token',
                unreachable: 'cluster.error.unreachable',
                token_invalid: 'cluster.error.token_invalid',
                self: 'cluster.error.self',
            };
            const i18nKey = map[code];
            status.textContent = i18nKey
                ? i18nT(i18nKey, e?.message || String(e))
                : e?.message || String(e);
        } finally {
            submit.disabled = false;
            submit.textContent = restoreLabel;
        }
    });
}

async function _testPeer(peerId) {
    try {
        const r = await api.post(`/api/cluster/peers/${encodeURIComponent(peerId)}/test`);
        if (r?.ok && r?.payload) {
            showToast(
                i18nTf('cluster.peer.test.ok', {
                    name: r.payload.name || peerId,
                    version: r.payload.version || 'unknown',
                }),
            );
        } else {
            showToast(
                i18nTf('cluster.peer.test.fail', {
                    message: r?.code || r?.message || 'unreachable',
                }),
            );
        }
        _loadPeers();
        _renderAudit();
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

function _editPeer(peerId) {
    const peer = _peers.find((p) => p.peerId === peerId);
    if (!peer) return;
    const node = document.createElement('div');
    node.innerHTML = `
        <div class="space-y-2">
            <label class="block">
                <span class="text-xs text-tg-textSecondary">${escapeHtml(i18nT('cluster.identity.name', 'Display name'))}</span>
                <input id="edit-peer-name" type="text" maxlength="64" class="w-full bg-tg-bg/50 px-2 py-1.5 rounded text-sm mt-1" />
            </label>
            <label class="block">
                <span class="text-xs text-tg-textSecondary">${escapeHtml(i18nT('cluster.peer.stream_mode', 'Stream mode'))}</span>
                <select id="edit-peer-stream-mode" class="w-full bg-tg-bg/50 px-2 py-1.5 rounded text-sm mt-1">
                    <option value="proxy">${escapeHtml(i18nT('cluster.peer.stream_mode.proxy', 'Proxy through this peer'))}</option>
                    <option value="direct">${escapeHtml(i18nT('cluster.peer.stream_mode.direct', 'Browser fetches direct'))}</option>
                </select>
                <p class="text-[11px] text-tg-textSecondary mt-1" id="edit-peer-stream-mode-help"></p>
            </label>
            <label class="block">
                <span class="text-xs text-tg-textSecondary">${escapeHtml(i18nT('cluster.peer.notes', 'Notes'))}</span>
                <textarea id="edit-peer-notes" maxlength="512" rows="2"
                    class="w-full bg-tg-bg/50 px-2 py-1.5 rounded text-sm mt-1"
                    placeholder="${escapeHtml(i18nT('cluster.peer.notes.placeholder', 'Optional reminder — purpose, location, owner'))}"></textarea>
            </label>
            <div class="flex justify-end gap-2 pt-1">
                <button id="edit-peer-save" class="tg-btn text-sm px-3 py-1.5">${escapeHtml(i18nT('cluster.peer.save', 'Save'))}</button>
            </div>
        </div>`;
    const sheet = openSheet({
        title: peer.name,
        content: node,
        size: 'md',
    });
    node.querySelector('#edit-peer-name').value = peer.name || '';
    node.querySelector('#edit-peer-stream-mode').value =
        peer.streamMode === 'direct' ? 'direct' : 'proxy';
    node.querySelector('#edit-peer-notes').value = peer.notes || '';
    const helpEl = node.querySelector('#edit-peer-stream-mode-help');
    const updateHelp = () => {
        const v = node.querySelector('#edit-peer-stream-mode').value;
        helpEl.textContent =
            v === 'direct'
                ? i18nT(
                      'cluster.peer.stream_mode.direct.help',
                      'Browser is redirected to the owner peer. Faster but requires the owner to be browser-reachable.',
                  )
                : i18nT(
                      'cluster.peer.stream_mode.proxy.help',
                      "Browser fetches files from this peer's URL only. Works behind any NAT/firewall.",
                  );
    };
    node.querySelector('#edit-peer-stream-mode').addEventListener('change', updateHelp);
    updateHelp();
    node.querySelector('#edit-peer-save').addEventListener('click', async () => {
        try {
            const patch = {
                name: node.querySelector('#edit-peer-name').value.trim(),
                streamMode: node.querySelector('#edit-peer-stream-mode').value,
                notes: node.querySelector('#edit-peer-notes').value.trim(),
            };
            const r = await api.put(`/api/cluster/peers/${encodeURIComponent(peerId)}`, patch);
            if (r?.peer) {
                showToast(i18nTf('cluster.peer.saved', { name: r.peer.name }));
                sheet.close?.();
                _loadPeers();
            }
        } catch (e) {
            showToast(e?.message || String(e));
        }
    });
}

async function _revokePeer(peerId) {
    const peer = _peers.find((p) => p.peerId === peerId);
    const ok = await confirmSheet({
        title: i18nT('cluster.peer.revoke', 'Revoke'),
        message: i18nTf('cluster.peer.revoke.confirm', { name: peer?.name || peerId }),
        confirmLabel: i18nT('cluster.peer.revoke', 'Revoke'),
        confirmKind: 'danger',
    });
    if (!ok) return;
    try {
        await api.delete(`/api/cluster/peers/${encodeURIComponent(peerId)}`);
        showToast(i18nT('cluster.peer.revoked', 'Peer revoked'));
        _loadPeers();
        _renderAudit();
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

// ---- Wiring ---------------------------------------------------------------

function _wirePage() {
    if (_pageWired) return;
    _pageWired = true;
    $('cluster-self-name-edit')?.addEventListener('click', () => _showNameEditor(true));
    $('cluster-self-name-cancel')?.addEventListener('click', () => {
        _showNameEditor(false);
        _renderIdentity();
    });
    $('cluster-self-name-save')?.addEventListener('click', async () => {
        await _saveName();
        _showNameEditor(false);
        _renderIdentity();
    });
    $('cluster-self-id-copy')?.addEventListener('click', _copySelfId);
    $('cluster-token-toggle')?.addEventListener('click', _toggleToken);
    $('cluster-token-copy')?.addEventListener('click', _copyToken);
    $('cluster-token-rotate')?.addEventListener('click', _rotateToken);
    $('cluster-token-set')?.addEventListener('click', _setToken);
    $('cluster-add-peer-btn')?.addEventListener('click', _addPeerWizard);
    $('cluster-pairing-code-btn')?.addEventListener('click', _issuePairingCode);
    $('cluster-sweep-run')?.addEventListener('click', _runSweep);
}

function _wireWs() {
    if (_wsWired) return;
    _wsWired = true;
    ws.on('peer_added', () => {
        _loadPeers();
        _renderAudit();
    });
    ws.on('peer_removed', () => {
        _loadPeers();
        _renderAudit();
    });
    ws.on('peer_status', (m) => {
        const p = _peers.find((x) => x.peerId === m.peerId);
        if (!p) return;
        p.status = m.status;
        p.lastSeenAt = m.lastSeenAt || p.lastSeenAt;
        _renderPeers();
    });
    ws.on('cluster_sweep_progress', (m) => {
        const el = $('cluster-sweep-state');
        if (el) el.textContent = i18nTf('cluster.sweep.running', { conflicts: m.conflicts ?? 0 });
    });
    ws.on('cluster_sweep_done', () => {
        _loadConflicts();
    });
}

// ---- Sweep + conflicts ---------------------------------------------------

async function _loadConflicts() {
    try {
        const r = await api.get('/api/cluster/conflicts');
        const conflicts = r?.conflicts || [];
        const stats = r?.stats || {};
        _lastSweepStats = stats;
        const empty = $('cluster-conflicts-empty');
        const list = $('cluster-conflicts-list');
        const statsEl = $('cluster-sweep-stats');
        const stateEl = $('cluster-sweep-state');
        if (statsEl && stats.lastRunAt) {
            statsEl.textContent = i18nTf('cluster.sweep.stats', {
                ago: formatRelativeTime(stats.lastRunAt),
                conflicts: stats.conflicts ?? 0,
                wasted: _formatBytes(stats.wastedBytes || 0),
            });
        }
        if (stateEl) {
            stateEl.textContent = '';
            stateEl.classList.add('hidden');
        }
        _renderStats();
        if (!conflicts.length) {
            empty?.classList.remove('hidden');
            if (list) list.innerHTML = '';
            return;
        }
        empty?.classList.add('hidden');
        if (list) list.innerHTML = conflicts.map(_renderConflictRow).join('');
        list?.querySelectorAll('[data-conflict-id]').forEach((row) => {
            row.querySelectorAll('[data-keep]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const id = row.dataset.conflictId;
                    const [peerId, remoteId] = btn.dataset.keep.split('|');
                    try {
                        await api.post(`/api/cluster/conflicts/${encodeURIComponent(id)}/resolve`, {
                            keep: { peerId, remoteId: Number(remoteId) },
                        });
                        showToast(i18nT('cluster.sweep.resolved', 'Conflict resolved'));
                        _loadConflicts();
                    } catch (e) {
                        showToast(e?.message || String(e));
                    }
                });
            });
        });
    } catch (e) {
        showToast(e?.message || String(e));
    }
}

function _formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let x = n;
    while (x >= 1024 && i < u.length - 1) {
        x /= 1024;
        i++;
    }
    return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function _renderConflictRow(c) {
    const owners = (c.owners || [])
        .map(
            (o) =>
                `<button class="tg-btn-ghost text-[11px] px-2 py-0.5 mr-1 mb-1" data-keep="${escapeHtml(o.peerId)}|${o.remoteId}">${escapeHtml(o.peerId === 'self' ? 'this peer' : o.peerId.slice(0, 8))} #${o.remoteId}</button>`,
        )
        .join('');
    return `
        <div class="rounded-lg border border-tg-border/40 bg-tg-bg/30 p-3" data-conflict-id="${escapeHtml(c.id)}">
            <div class="text-xs text-tg-text mb-1">
                <code class="text-[10px]">${escapeHtml(c.fileHash.slice(0, 12))}…</code>
                · ${_formatBytes(c.fileSize)} · ${c.count} ${escapeHtml(i18nT('cluster.sweep.copies', 'copies'))}
            </div>
            <div class="text-[11px] text-tg-textSecondary mb-1">${escapeHtml(i18nT('cluster.sweep.keep_help', 'Click which copy to keep — every other copy is removed.'))}</div>
            <div class="flex flex-wrap">${owners}</div>
        </div>`;
}

async function _runSweep() {
    const btn = $('cluster-sweep-run');
    if (btn) btn.disabled = true;
    try {
        await api.post('/api/cluster/sweep/run');
        const stateEl = $('cluster-sweep-state');
        if (stateEl) {
            stateEl.textContent = i18nT('cluster.sweep.starting', 'Sweep started…');
            stateEl.classList.remove('hidden');
        }
    } catch (e) {
        showToast(e?.message || String(e));
    } finally {
        if (btn) btn.disabled = false;
    }
}

export function init() {
    _wirePage();
    _wireWs();
    _loadIdentity();
    _loadPeers();
    _loadConflicts();
    _renderAudit();
}
