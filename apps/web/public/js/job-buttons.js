// Reusable wiring for "fire-and-forget admin job" buttons.
//
// Every Settings → Maintenance button that triggers a background job
// (verify files, db vacuum, db integrity, restart monitor, resync
// dialogs, auto-update, etc.) shares the same UX contract:
//
//   1. On page mount, GET <statusUrl>; disable the button if a job
//      started by another client / earlier session is still running.
//   2. POST <runUrl> on click; backend returns 200 with `{started:true}`
//      in <500 ms and runs the work in the background.
//   3. Subscribe to `${eventPrefix}_progress` and `${eventPrefix}_done`
//      so the button stays disabled until the job finishes — across
//      every connected tab + device.
//   4. 409 ALREADY_RUNNING means a sibling client started the same job;
//      we hydrate from <statusUrl> instead of toasting "failed".
//
// One pattern, one helper, six invocations from settings.js. The same
// helper works for a button on any page that follows the contract.
//
// Usage:
//   wireJobButton({
//       btn: document.getElementById('maint-verify-btn'),
//       statusEl: document.getElementById('maint-verify-status'),  // optional
//       statusUrl: '/api/maintenance/files/verify/status',
//       eventPrefix: 'files_verify',
//       runUrl: '/api/maintenance/files/verify',
//       runBody: {},
//       runningLabel: 'Verifying…',
//       idleLabel: 'Verify files',
//       onDone: (msg) => showToast(...),
//   });

import { ws } from './ws.js';
import { api } from './api.js';
import { showToast } from './utils.js';
import { t as i18nT } from './i18n.js';

// Registry so we can hydrate every wired button on init / WS reconnect
// without each caller having to remember to do it. Idempotent — wiring a
// button twice is safe (the existing entry's WS subscription is reused).
const _wired = new Map();      // btn → entry
let _wsSubscribed = new Set(); // `${prefix}_progress` / `${prefix}_done`

function _formatStage(snap) {
    if (!snap) return '';
    if (snap.error) return snap.error;
    const p = snap.progress || {};
    const pieces = [];
    if (Number.isFinite(p.processed) || Number.isFinite(p.total)) {
        pieces.push(`${p.processed ?? 0}/${p.total ?? 0}`);
    }
    if (p.stage) pieces.push(p.stage);
    return pieces.join(' · ');
}

/**
 * Wire one button to one job kind.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.btn
 * @param {HTMLElement} [opts.statusEl]   Sibling text node for live progress
 * @param {string} opts.statusUrl
 * @param {string} opts.eventPrefix       WS event prefix (e.g. 'db_vacuum')
 * @param {string} opts.runUrl
 * @param {object} [opts.runBody={}]
 * @param {string} opts.runningLabel
 * @param {string} opts.idleLabel
 * @param {(snapOrPayload:object)=>void} [opts.onDone]
 *        Receives the WS done payload (or the hydrated snapshot if a
 *        running job finishes between init and the click handler).
 * @param {(err:Error)=>boolean} [opts.preflightFail]
 *        Optional — callback gets the API error before any toast; return
 *        true to suppress the default error toast (e.g. you've already
 *        shown a more specific one).
 * @param {boolean} [opts.attachClick=true]
 *        Set to false when another module owns the click handler
 *        (e.g. the Settings card buttons go through `maintDbVacuum` to
 *        show a confirm dialog first). The button still hydrates from
 *        /status and reflects WS state, just without a duplicate POST.
 */
export function wireJobButton(opts) {
    const { btn, statusEl, statusUrl, eventPrefix, runUrl,
        runBody, runningLabel, idleLabel, onDone, preflightFail,
        attachClick = true } = opts || {};
    if (!btn || !statusUrl || !eventPrefix || !runUrl) {
        // Element may legitimately be absent on a route the user hasn't
        // visited yet — skip silently rather than throwing into init().
        return;
    }
    if (_wired.has(btn)) return;

    const entry = {
        btn, statusEl, statusUrl, eventPrefix, runUrl,
        runBody: runBody || {}, runningLabel, idleLabel, onDone, preflightFail,
    };
    _wired.set(btn, entry);

    const setUi = (running, snap) => {
        btn.disabled = !!running;
        if (running && runningLabel) btn.textContent = runningLabel;
        else if (!running && idleLabel) btn.textContent = idleLabel;
        if (statusEl) {
            if (running) {
                statusEl.textContent = _formatStage(snap) || '';
            } else if (snap?.error) {
                statusEl.textContent = snap.error;
            } else {
                statusEl.textContent = '';
            }
        }
    };

    // Subscribe to WS — once per prefix, not once per button. The
    // dispatch loop iterates _wired and updates every button matching
    // the same prefix.
    if (!_wsSubscribed.has(eventPrefix)) {
        _wsSubscribed.add(eventPrefix);
        ws.on(`${eventPrefix}_progress`, (m) => {
            for (const e of _wired.values()) {
                if (e.eventPrefix !== eventPrefix) continue;
                e._lastSnap = { running: true, progress: m, error: null };
                if (e.btn) {
                    e.btn.disabled = true;
                    if (e.runningLabel) e.btn.textContent = e.runningLabel;
                }
                if (e.statusEl) e.statusEl.textContent = _formatStage(e._lastSnap);
            }
        });
        ws.on(`${eventPrefix}_done`, (m) => {
            for (const e of _wired.values()) {
                if (e.eventPrefix !== eventPrefix) continue;
                e._lastSnap = {
                    running: false,
                    progress: {},
                    error: m?.error || null,
                    result: m,
                };
                if (e.btn) {
                    e.btn.disabled = false;
                    if (e.idleLabel) e.btn.textContent = e.idleLabel;
                }
                if (e.statusEl) e.statusEl.textContent = m?.error || '';
                if (typeof e.onDone === 'function') {
                    try { e.onDone(m); } catch (err) { console.warn('job onDone:', err); }
                }
            }
        });
    }

    // Initial hydrate.
    _hydrate(entry).catch(() => {});

    if (!attachClick) return;

    // Click handler — only attached when the button isn't already wired
    // by the page's own click logic (e.g. confirm-dialog wrappers).
    btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        setUi(true, null);
        try {
            const r = await api.post(runUrl, entry.runBody);
            // 200 path: backend has already started the job. WS will
            // drive the rest. r is `{success, started}` for the new
            // contract or whatever the legacy endpoint returned.
            if (r?.error) throw Object.assign(new Error(r.error), { data: r });
        } catch (e) {
            if (e?.data?.code === 'ALREADY_RUNNING') {
                showToast(i18nT('jobs.already_running',
                    'Already running on another tab — waiting for it to finish.'),
                    'info');
                await _hydrate(entry).catch(() => {});
                return;
            }
            const suppressed = typeof preflightFail === 'function' ? preflightFail(e) : false;
            if (!suppressed) {
                showToast(e?.data?.error || e?.message || 'Failed', 'error');
            }
            setUi(false, null);
        }
    });
}

async function _hydrate(entry) {
    try {
        const snap = await api.get(entry.statusUrl);
        entry._lastSnap = snap || null;
        if (snap?.running) {
            entry.btn.disabled = true;
            if (entry.runningLabel) entry.btn.textContent = entry.runningLabel;
            if (entry.statusEl) entry.statusEl.textContent = _formatStage(snap);
        } else {
            entry.btn.disabled = false;
            if (entry.idleLabel) entry.btn.textContent = entry.idleLabel;
            if (entry.statusEl) entry.statusEl.textContent = snap?.error || '';
        }
    } catch { /* status endpoint failure = leave UI alone */ }
}

/**
 * Re-hydrate every wired button. Useful after a WS reconnect (the
 * server may have completed a job during the disconnect window).
 */
export function rehydrateAll() {
    for (const entry of _wired.values()) {
        _hydrate(entry).catch(() => {});
    }
}

// Re-hydrate after every WS open — covers the laptop-wakes-from-sleep
// case where the page sat dormant through a full job lifecycle.
ws.on('__ws_open', () => rehydrateAll());
