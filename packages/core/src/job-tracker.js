// Standardised lifecycle for "fire-and-forget admin job" endpoints.
//
// Every long-running admin action (verify files, db vacuum, refresh
// every group's name, purge a group's files, etc.) follows the same
// pattern in v2.4+: the POST returns 200 in <500 ms with `{started:true}`,
// the actual work runs in the background, progress + result land via
// WebSocket, and a sibling `GET .../status` endpoint lets a re-mounted
// page recover live state. This module is the boilerplate.
//
// One instance per logical job kind (one tracker = one single-flight
// slot). The endpoint asks the tracker to start; the tracker enforces
// single-flight via an internal flag, owns the canonical state shape,
// broadcasts WS progress + done events to every connected client, and
// exposes a snapshot for the status endpoint.
//
// Public API:
//   const tracker = createJobTracker({ kind, broadcast, log });
//   tracker.tryStart(runFn)   // see below — returns a 200/409 contract
//   tracker.cancel()          // aborts the in-flight run via AbortController
//   tracker.getStatus()       // current snapshot — feed into /status JSON
//   tracker.isRunning()
//
// runFn is `async ({ onProgress, signal }) => result`. Whatever the
// function returns lands as `result` in the snapshot and gets merged
// into the `${kind}_done` WS payload. Errors thrown by runFn are
// caught — state goes to `running:false / error: <msg>`, the tracker
// emits `${kind}_done` with `{error}`, and the next tryStart succeeds.
//
// Persistence note: `running:true` lives in process memory. A hard
// crash / restart resets it to false; we treat that as acceptable
// because the endpoints this fronts are not money-critical (file
// integrity, dedup, thumbnail cache rebuilds). The next click will
// just start fresh, which is the right behaviour after a crash.

const PROGRESS_LOG_INTERVAL_MS = 5000;

/**
 * Create a JobTracker.
 *
 * @param {object} opts
 * @param {string} opts.kind          Logical job name (e.g. 'dbVacuum').
 *                                    Used for log source + default WS event prefix.
 * @param {(msg:object) => void} opts.broadcast  WS broadcast fn from server.js.
 * @param {(entry:object) => void} [opts.log]    Structured log fn.
 * @param {string} [opts.eventPrefix] Override WS event prefix (default = kind).
 *                                    Emits `${prefix}_progress` / `${prefix}_done`.
 */
export function createJobTracker({ kind, broadcast, log, eventPrefix } = {}) {
    if (!kind) throw new Error('createJobTracker: kind is required');
    const _broadcast = typeof broadcast === 'function' ? broadcast : () => {};
    const _log = typeof log === 'function' ? log : () => {};
    const _prefix = eventPrefix || kind;

    let _running = false;
    let _abort = null;
    let _lastProgressLogAt = 0;
    let _state = _initialState();

    function _initialState() {
        return {
            kind,
            running: false,
            stage: 'idle',
            progress: {},
            startedAt: 0,
            finishedAt: 0,
            durationMs: 0,
            result: null,
            error: null,
            attempts: 0,
            successes: 0,
            failures: 0,
        };
    }

    function _safeBroadcast(payload) {
        try { _broadcast(payload); } catch { /* swallow */ }
    }
    function _safeLog(entry) {
        try { _log(entry); } catch { /* swallow */ }
    }

    function getStatus() {
        // Defensive copy so callers can't mutate our state object.
        return {
            ..._state,
            running: _running,
            progress: { ..._state.progress },
        };
    }

    function isRunning() { return _running; }

    /**
     * Attempt to start a new run. If a run is already in flight, returns
     * `{ started:false, code:'ALREADY_RUNNING', snapshot }` so the
     * endpoint can return 409 with the snapshot for the client to hydrate.
     *
     * On success, returns `{ started:true, snapshot }` immediately while
     * the runFn executes in the background.
     */
    function tryStart(runFn) {
        if (_running) {
            return { started: false, code: 'ALREADY_RUNNING', snapshot: getStatus() };
        }
        if (typeof runFn !== 'function') {
            throw new Error('tryStart: runFn must be a function');
        }
        _running = true;
        _abort = new AbortController();
        const startedAt = Date.now();
        _state = {
            ..._state,
            running: true,
            stage: 'starting',
            progress: {},
            startedAt,
            finishedAt: 0,
            durationMs: 0,
            error: null,
            attempts: (_state.attempts || 0) + 1,
        };
        _lastProgressLogAt = startedAt;
        _safeBroadcast({ type: `${_prefix}_progress`, ...getStatus() });
        _safeLog({ source: kind, level: 'info', msg: `${kind} starting` });

        // Detached — caller already got the synchronous { started: true }
        // contract. Errors are captured into state, never thrown out here.
        (async () => {
            try {
                const onProgress = (p) => {
                    if (!_running) return; // post-cancel suppress
                    const merged = (p && typeof p === 'object') ? p : {};
                    _state = {
                        ..._state,
                        running: true,
                        stage: merged.stage || _state.stage || 'running',
                        progress: { ..._state.progress, ...merged },
                    };
                    _safeBroadcast({
                        type: `${_prefix}_progress`,
                        ...getStatus(),
                        ...merged,   // expose flat fields for legacy WS subs
                    });
                    const now = Date.now();
                    if (now - _lastProgressLogAt > PROGRESS_LOG_INTERVAL_MS) {
                        _lastProgressLogAt = now;
                        const desc = _shortProgress(merged);
                        _safeLog({ source: kind, level: 'info', msg: `${kind} progress${desc ? ' — ' + desc : ''}` });
                    }
                };
                const result = await runFn({ onProgress, signal: _abort.signal });
                const finishedAt = Date.now();
                _state = {
                    ..._state,
                    running: false,
                    stage: 'done',
                    finishedAt,
                    durationMs: finishedAt - startedAt,
                    result: (result && typeof result === 'object') ? result : (result ?? null),
                    error: null,
                    successes: (_state.successes || 0) + 1,
                };
                _safeBroadcast({
                    type: `${_prefix}_done`,
                    ...(result && typeof result === 'object' ? result : {}),
                    durationMs: _state.durationMs,
                    kind,
                });
                _safeLog({ source: kind, level: 'info', msg: `${kind} done in ${_state.durationMs} ms` });
            } catch (e) {
                const finishedAt = Date.now();
                const msg = e?.message || String(e);
                _state = {
                    ..._state,
                    running: false,
                    stage: 'error',
                    finishedAt,
                    durationMs: finishedAt - startedAt,
                    error: msg,
                    failures: (_state.failures || 0) + 1,
                };
                _safeBroadcast({
                    type: `${_prefix}_done`,
                    error: msg,
                    durationMs: _state.durationMs,
                    kind,
                });
                _safeLog({ source: kind, level: 'error', msg: `${kind} failed: ${msg}` });
            } finally {
                _running = false;
                _abort = null;
            }
        })();

        return { started: true, snapshot: getStatus() };
    }

    /**
     * Abort the in-flight run. The runFn is expected to honour the
     * AbortSignal — we trigger it and let the runFn settle naturally.
     * Returns true if a run was in flight, false otherwise.
     */
    function cancel() {
        if (!_running || !_abort) return false;
        try { _abort.abort(); } catch { /* swallow */ }
        _safeLog({ source: kind, level: 'warn', msg: `${kind} cancel requested` });
        return true;
    }

    return { tryStart, cancel, getStatus, isRunning };
}

function _shortProgress(p) {
    if (!p || typeof p !== 'object') return '';
    const parts = [];
    if (Number.isFinite(p.processed) || Number.isFinite(p.total)) {
        parts.push(`${p.processed ?? 0}/${p.total ?? 0}`);
    }
    if (p.stage) parts.push(p.stage);
    return parts.join(' ');
}
