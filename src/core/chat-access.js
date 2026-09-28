/**
 * Chat access state — one standard answer to "can we still use this chat?".
 *
 * A configured chat can stop being usable: it was deleted, Telegram banned
 * or restricted it, our account left / was kicked, a private channel shut
 * us out, or a basic group was upgraded to a supergroup (a new id). Before
 * this module every caller reacted on its own — polling swallowed the
 * error and asked again every cycle, the downloader retried each queued
 * file five times, avatars re-resolved the chat every few minutes, and the
 * boot probe auto-disabled on *any* error (a FLOOD_WAIT included). All of
 * that spends Telegram quota on chats that can't answer.
 *
 * Now there is:
 *   • one classifier — `classifyAccessError(err)`, `classifyEntity(entity)`
 *     and `classifyMessage(msg)` map gramJS errors, entity shapes and the
 *     "migrated to" service message to one of ACCESS_STATES;
 *   • one registry — a row per chat that some account couldn't open (DB
 *     table `chat_access`, cached in memory). A chat without a row is fine.
 *     `isBlocked(id)` is the cheap, local check every Telegram caller makes
 *     before spending a call;
 *   • one probe — `probeChatAccess()` asks each account once (in order,
 *     stopping at the first that can read), records the answer and returns
 *     the working client. Re-checks back off 1 h → 6 h → daily.
 *
 * Multi-account: every answer is kept per account; the chat only counts as
 * blocked when no account can read it. Transient errors (flood waits,
 * timeouts, dropped connections, a revoked session) say nothing about the
 * chat and never mark it.
 */

import { EventEmitter } from 'events';
import { getDb } from './db.js';

export const ACCESS_STATES = Object.freeze([
    'ok',
    'left',
    'banned',
    'private',
    'deleted',
    'restricted',
    'migrated',
    'unknown',
]);

// States that pause a chat. `unknown` means "couldn't tell" (transient) and
// never pauses anything.
const BLOCKING = new Set(['left', 'banned', 'private', 'deleted', 'restricted', 'migrated']);

// When no account can read a chat and they disagree why, the most specific
// / chat-wide answer wins (a deleted chat is deleted for everyone; "this
// account never saw it" is the weakest).
const PRIORITY = {
    migrated: 7,
    deleted: 6,
    banned: 5,
    restricted: 4,
    private: 3,
    left: 2,
    unknown: 1,
    ok: 0,
};

const HOUR = 60 * 60 * 1000;
/** Re-check delays after the 1st, 2nd, 3rd+ failed check. */
export const RECHECK_SCHEDULE_MS = Object.freeze([1 * HOUR, 6 * HOUR, 24 * HOUR]);
/** First re-check when some account only answered with a transient error. */
export const TRANSIENT_RECHECK_MS = 15 * 60 * 1000;

// ---- Classifier --------------------------------------------------------------

// Telegram error names → state. Reads (getMessages / getHistory /
// iterMessages / downloads) raise the first block; the write-side ones only
// come from the auto-forwarder posting into a destination chat.
const CODE_STATES = new Map([
    ['CHANNEL_PRIVATE', 'private'],
    ['CHANNEL_INVALID', 'deleted'],
    ['CHAT_ID_INVALID', 'deleted'],
    ['PEER_ID_INVALID', 'deleted'],
    ['USERNAME_INVALID', 'deleted'],
    ['USERNAME_NOT_OCCUPIED', 'deleted'],
    ['CHAT_FORBIDDEN', 'banned'],
    ['USER_BANNED_IN_CHANNEL', 'banned'],
    ['USER_KICKED', 'banned'],
    ['USER_NOT_PARTICIPANT', 'left'],
    ['CHANNEL_PUBLIC_GROUP_NA', 'restricted'],
    ['CHAT_RESTRICTED', 'restricted'],
    ['CHAT_WRITE_FORBIDDEN', 'restricted'],
    ['CHAT_SEND_MEDIA_FORBIDDEN', 'restricted'],
    ['CHAT_ADMIN_REQUIRED', 'restricted'],
]);
const CHAT_CODE_RE = new RegExp(`\\b(${[...CODE_STATES.keys()].join('|')})\\b`);

// Problems with our own session — nothing to do with the chat.
const ACCOUNT_CODE_RE =
    /\b(AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED(?:_BAN)?|AUTH_RESTART)\b/;

// gramJS' own "this account has never seen that peer" errors (no RPC was
// even possible) — the chat isn't in any dialog of this account.
const NOT_FOUND_RE = /could not find the input entity|cannot find any entity|no user has/i;

const FLOOD_RE = /FLOOD|SLOWMODE_WAIT|A wait of \d+ seconds is required/i;
const TRANSIENT_RE =
    /\b(TIMEOUT|TIMED OUT|Not connected|disconnected|Connection closed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|RPC_CALL_FAIL|RPC_MCGET_FAIL|INTERNAL_SERVER_ERROR|MSG_WAIT_FAILED|WORKER_BUSY_TOO_LONG_RETRY|Cannot send requests while disconnected)\b/i;

function errText(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    const em = typeof err.errorMessage === 'string' ? err.errorMessage : '';
    const msg = typeof err.message === 'string' ? err.message : '';
    return `${em} ${msg}`.trim() || String(err);
}

/**
 * Map an error from any Telegram call to an access verdict:
 *   { state, code, definite, transient?, account?, seconds? }
 * `definite` is true only when the error says something about the chat
 * itself (then `state` is one of the blocking states).
 */
export function classifyAccessError(err) {
    if (err == null) return { state: 'unknown', code: null, definite: false };
    const text = errText(err);
    const acct = text.match(ACCOUNT_CODE_RE);
    if (acct) return { state: 'unknown', code: acct[1], definite: false, account: true };
    if (FLOOD_RE.test(text) || err?.errorMessage === 'FLOOD') {
        const seconds = Number(err?.seconds) || null;
        return { state: 'unknown', code: 'FLOOD_WAIT', definite: false, transient: true, seconds };
    }
    const chat = text.match(CHAT_CODE_RE);
    if (chat) return { state: CODE_STATES.get(chat[1]), code: chat[1], definite: true };
    if (NOT_FOUND_RE.test(text)) return { state: 'left', code: 'ENTITY_NOT_FOUND', definite: true };
    const status = Number(err?.code);
    if (TRANSIENT_RE.test(text) || (Number.isFinite(status) && Math.abs(status) >= 500)) {
        const m = text.match(TRANSIENT_RE);
        return {
            state: 'unknown',
            code: m ? m[1].toUpperCase().replace(/\s+/g, '_') : 'SERVER_ERROR',
            definite: false,
            transient: true,
        };
    }
    const named = text.match(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/);
    return { state: 'unknown', code: named ? named[1] : 'ERROR', definite: false };
}

/** `-100<channelId>` for an `InputChannel` (Chat.migratedTo), else null. */
function migratedIdOf(migratedTo) {
    const cid = migratedTo?.channelId;
    if (cid == null) return null;
    const s = String(cid).replace(/^-100/, '').replace(/^-/, '');
    return /^\d+$/.test(s) ? `-100${s}` : null;
}

/** Text of a Telegram restriction that applies to us (platform "all"). */
function restrictionOf(entity) {
    if (!entity?.restricted) return null;
    const reasons = Array.isArray(entity.restrictionReason) ? entity.restrictionReason : [];
    if (!reasons.length) return 'restricted';
    // Restrictions for one platform (ios / android) don't apply to API use.
    const all = reasons.find((r) => !r?.platform || r.platform === 'all');
    if (!all) return null;
    return String(all.text || all.reason || 'restricted').slice(0, 300);
}

/**
 * Read an entity (from a dialog list, getEntity, an update) — returns
 * `{ state, code, definite, detail?, migratedTo? }`, `{ state: 'ok' }`, or
 * null when it isn't an entity. Callers decide how much an entity-only
 * answer weighs: a Channel with `left` can still be read when it's public,
 * so the monitor never pauses a chat on `left` / `restricted` from an
 * entity alone.
 */
export function classifyEntity(entity) {
    if (!entity || typeof entity !== 'object') return null;
    const cls = entity.className || '';
    if (cls === 'ChannelForbidden') {
        const until = Number(entity.untilDate) || 0;
        return {
            state: 'banned',
            code: 'CHANNEL_FORBIDDEN',
            definite: true,
            detail: until ? `until:${until}` : null,
        };
    }
    if (cls === 'ChatForbidden') return { state: 'banned', code: 'CHAT_FORBIDDEN', definite: true };
    if (cls === 'ChatEmpty') return { state: 'deleted', code: 'CHAT_EMPTY', definite: true };
    const migratedTo = migratedIdOf(entity.migratedTo);
    if (migratedTo) {
        return { state: 'migrated', code: 'CHAT_MIGRATED', definite: true, migratedTo };
    }
    if (entity.deactivated) return { state: 'deleted', code: 'CHAT_DEACTIVATED', definite: true };
    if (entity.kicked) return { state: 'banned', code: 'USER_KICKED', definite: true };
    const restriction = restrictionOf(entity);
    if (restriction) {
        return {
            state: 'restricted',
            code: 'CHAT_RESTRICTED',
            definite: true,
            detail: restriction,
        };
    }
    if (cls === 'User' && entity.deleted) {
        return { state: 'deleted', code: 'USER_DELETED', definite: true };
    }
    if (entity.left) {
        return {
            state: 'left',
            code: cls === 'Channel' ? 'CHANNEL_LEFT' : 'CHAT_LEFT',
            definite: true,
        };
    }
    return { state: 'ok', code: null, definite: true };
}

/**
 * A basic group upgraded to a supergroup ends with a
 * `MessageActionChatMigrateTo` service message — the newest message a
 * probe / poll sees. Returns the migrated verdict or null.
 */
export function classifyMessage(msg) {
    const action = msg?.action;
    if (!action || action.className !== 'MessageActionChatMigrateTo') return null;
    const migratedTo = migratedIdOf({ channelId: action.channelId });
    return { state: 'migrated', code: 'CHAT_MIGRATED', definite: true, migratedTo };
}

export function isBlockingState(state) {
    return BLOCKING.has(state);
}

// ---- Registry ------------------------------------------------------------------

export const accessEvents = new EventEmitter();
accessEvents.setMaxListeners(50);

const _rows = new Map(); // chatId → record
// Restriction texts seen on dialog entities. A restricted chat that can
// still be read isn't paused; when a read *does* fail, this turns a vague
// CHANNEL_PRIVATE into "restricted by Telegram: <reason>".
const _restrictionHints = new Map();
const HINTS_MAX = 5000;
let _loaded = false;
let _dbOk = true;

const key = (id) => String(id ?? '').trim();

function _db() {
    if (!_dbOk) return null;
    try {
        return getDb();
    } catch {
        _dbOk = false;
        return null;
    }
}

function _parseAccounts(raw) {
    if (!raw) return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

function _load() {
    if (_loaded) return;
    _loaded = true;
    const db = _db();
    if (!db) return;
    try {
        const rows = db
            .prepare(
                'SELECT chat_id, state, code, detail, migrated_to, first_seen_at, checked_at, next_check_at, checks, accounts FROM chat_access LIMIT 50000',
            )
            .all();
        for (const r of rows) {
            if (!ACCESS_STATES.includes(r.state)) continue;
            _rows.set(String(r.chat_id), {
                state: r.state,
                code: r.code || null,
                detail: r.detail || null,
                migratedTo: r.migrated_to || null,
                firstSeenAt: r.first_seen_at || null,
                checkedAt: r.checked_at || null,
                nextCheckAt: r.next_check_at ?? null,
                checks: Number(r.checks) || 0,
                accounts: _parseAccounts(r.accounts),
            });
        }
    } catch {
        // Table missing (an odd DB) — keep working from memory.
        _dbOk = false;
    }
}

function _persist(id, rec) {
    const db = _db();
    if (!db) return;
    try {
        if (!rec) {
            db.prepare('DELETE FROM chat_access WHERE chat_id = ?').run(id);
            return;
        }
        db.prepare(
            `INSERT INTO chat_access (chat_id, state, code, detail, migrated_to, first_seen_at, checked_at, next_check_at, checks, accounts, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET
                state = excluded.state, code = excluded.code, detail = excluded.detail,
                migrated_to = excluded.migrated_to, first_seen_at = excluded.first_seen_at,
                checked_at = excluded.checked_at, next_check_at = excluded.next_check_at,
                checks = excluded.checks, accounts = excluded.accounts, updated_at = excluded.updated_at`,
        ).run(
            id,
            rec.state,
            rec.code || null,
            rec.detail || null,
            rec.migratedTo || null,
            rec.firstSeenAt || null,
            rec.checkedAt || Date.now(),
            rec.nextCheckAt ?? null,
            rec.checks || 0,
            JSON.stringify(rec.accounts || {}),
            Date.now(),
        );
    } catch {
        /* DB busy / read-only — the in-memory row still steers this run */
    }
}

function _emit(id, prevState, rec) {
    const state = rec ? rec.state : 'ok';
    if (prevState === state) return;
    try {
        accessEvents.emit('change', { id, prev: prevState, state, access: publicAccess(rec) });
    } catch {
        /* a listener threw — never break the caller */
    }
}

/** Delay before the next re-check after `checks` failed ones (±10 % jitter). */
export function recheckDelay(checks, { transient = false, random = Math.random } = {}) {
    if (transient && checks === 0) return TRANSIENT_RECHECK_MS;
    const base = RECHECK_SCHEDULE_MS[Math.min(checks, RECHECK_SCHEDULE_MS.length - 1)];
    return Math.round(base * (0.9 + 0.2 * random()));
}

/** API shape of a record (`{ state: 'ok' }` for a chat with no row). */
export function publicAccess(rec) {
    if (!rec) return { state: 'ok' };
    return {
        state: rec.state,
        code: rec.code || null,
        detail: rec.detail || null,
        migratedTo: rec.migratedTo || null,
        firstSeenAt: rec.firstSeenAt || null,
        checkedAt: rec.checkedAt || null,
        nextCheckAt: BLOCKING.has(rec.state) ? (rec.nextCheckAt ?? null) : null,
        checks: rec.checks || 0,
        accounts: Object.entries(rec.accounts || {})
            .filter(([id]) => id !== '_')
            .map(([id, a]) => ({ id, state: a.state, code: a.code || null, at: a.at || null })),
    };
}

/** The raw record for a chat, or null when nothing is known against it. */
export function getAccess(chatId) {
    _load();
    const rec = _rows.get(key(chatId));
    return rec ? { ...rec, accounts: { ...rec.accounts } } : null;
}

export function accessOf(chatId) {
    _load();
    return publicAccess(_rows.get(key(chatId)) || null);
}

/** The cheap local check every Telegram caller makes first. */
export function isBlocked(chatId) {
    _load();
    const rec = _rows.get(key(chatId));
    return !!rec && BLOCKING.has(rec.state);
}

/** Blocked and its scheduled re-check time has come. */
export function isDue(chatId, now = Date.now()) {
    _load();
    const rec = _rows.get(key(chatId));
    return !!rec && BLOCKING.has(rec.state) && rec.nextCheckAt != null && rec.nextCheckAt <= now;
}

/**
 * Record the answers of one check (one entry per account asked):
 *   results = [{ accountId, cls }]   — cls from the classifiers above
 * Returns the chat's public access after the update.
 *
 * `isRecheck` marks a scheduled / manual re-check (it advances the
 * back-off); a failure seen while polling or downloading doesn't.
 */
export function recordCheck(chatId, results, { now = Date.now(), isRecheck = false } = {}) {
    _load();
    const id = key(chatId);
    if (!id || !Array.isArray(results) || !results.length) return accessOf(id);
    const prev = _rows.get(id) || null;
    const prevState = prev ? prev.state : 'ok';
    const accounts = prev ? { ...prev.accounts } : {};
    let transient = false;
    let migratedTo = null;
    let detail = null;
    for (const r of results) {
        const cls = r?.cls || {};
        const acct = r?.accountId != null && r.accountId !== '' ? String(r.accountId) : '_';
        if (cls.state === 'ok') {
            accounts[acct] = { state: 'ok', code: null, at: now };
        } else if (cls.definite && BLOCKING.has(cls.state)) {
            let state = cls.state;
            let code = cls.code || null;
            // A read refused on a chat Telegram restricts: say so.
            if ((state === 'private' || state === 'deleted') && _restrictionHints.has(id)) {
                detail = _restrictionHints.get(id);
                state = 'restricted';
                code = code || 'CHAT_RESTRICTED';
            }
            accounts[acct] = { state, code, at: now };
            if (cls.migratedTo) migratedTo = cls.migratedTo;
            if (cls.detail) detail = cls.detail;
        } else {
            transient = true;
        }
    }

    // Chat-level verdict: any account that reads it → ok — except a
    // migration, which is chat-wide (the old group still reads fine, it
    // just never gets a new message again).
    let verdict = null;
    let anyOk = false;
    for (const a of Object.values(accounts)) {
        if (a.state === 'ok') anyOk = true;
        else if (BLOCKING.has(a.state) && (!verdict || PRIORITY[a.state] > PRIORITY[verdict.state]))
            verdict = a;
    }
    if (verdict?.state === 'migrated') anyOk = false;

    if (anyOk || !verdict) {
        if (!anyOk) {
            // Only transient answers — nothing learned about the chat. A
            // re-check of a blocked chat tries again later, not in a loop.
            if (prev && BLOCKING.has(prev.state) && isRecheck) {
                const rec = { ...prev, checkedAt: now, nextCheckAt: now + TRANSIENT_RECHECK_MS };
                _rows.set(id, rec);
                _persist(id, rec);
            }
            return accessOf(id);
        }
        const failing = Object.values(accounts).some((a) => BLOCKING.has(a.state));
        if (!failing) {
            if (prev) {
                _rows.delete(id);
                _persist(id, null);
                _emit(id, prevState, null);
            }
            return { state: 'ok' };
        }
        // Readable through another account — keep the per-account note.
        const rec = {
            state: 'ok',
            code: null,
            detail: null,
            migratedTo: null,
            firstSeenAt: null,
            checkedAt: now,
            nextCheckAt: null,
            checks: 0,
            accounts,
        };
        _rows.set(id, rec);
        _persist(id, rec);
        _emit(id, prevState, rec);
        return publicAccess(rec);
    }

    const wasBlocked = !!prev && BLOCKING.has(prev.state);
    const sameState = wasBlocked && prev.state === verdict.state;
    const checks = wasBlocked ? (prev.checks || 0) + (isRecheck ? 1 : 0) : 0;
    let nextCheckAt;
    if (verdict.state === 'migrated')
        nextCheckAt = null; // permanent — nothing to re-check
    else if (!wasBlocked) nextCheckAt = now + recheckDelay(0, { transient });
    else if (isRecheck) nextCheckAt = now + recheckDelay(checks);
    else nextCheckAt = prev.nextCheckAt ?? now + recheckDelay(checks);
    const rec = {
        state: verdict.state,
        code: verdict.code || null,
        detail: detail ?? (sameState ? prev.detail : null),
        migratedTo: migratedTo ?? (verdict.state === 'migrated' ? prev?.migratedTo || null : null),
        firstSeenAt: wasBlocked ? prev.firstSeenAt || now : now,
        checkedAt: now,
        nextCheckAt,
        checks,
        accounts,
    };
    _rows.set(id, rec);
    _persist(id, rec);
    _emit(id, prevState, rec);
    return publicAccess(rec);
}

/** One account's answer — see recordCheck. */
export function recordResult(chatId, accountId, cls, opts = {}) {
    return recordCheck(chatId, [{ accountId, cls }], opts);
}

/** An account read the chat. Clears the row once no account is failing. */
export function markReachable(chatId, accountId = null, opts = {}) {
    _load();
    if (!_rows.has(key(chatId))) return { state: 'ok' };
    return recordCheck(chatId, [{ accountId, cls: { state: 'ok' } }], opts);
}

/** Forget everything about a chat (removed from the list). */
export function clearAccess(chatId) {
    _load();
    const id = key(chatId);
    const prev = _rows.get(id);
    if (!prev) return false;
    _rows.delete(id);
    _persist(id, null);
    _emit(id, prev.state, null);
    return true;
}

/** Blocked chats (or every row with `blockedOnly: false`). */
export function listAccess({ blockedOnly = true } = {}) {
    _load();
    const out = [];
    for (const [id, rec] of _rows) {
        if (blockedOnly && !BLOCKING.has(rec.state)) continue;
        out.push({ id, ...publicAccess(rec) });
    }
    return out;
}

/** `{ total, byState }` over the given ids (blocked ones only). */
export function summarize(ids) {
    _load();
    const byState = {};
    let total = 0;
    for (const raw of ids || []) {
        const rec = _rows.get(key(raw));
        if (!rec || !BLOCKING.has(rec.state)) continue;
        total += 1;
        byState[rec.state] = (byState[rec.state] || 0) + 1;
    }
    return { total, byState };
}

/**
 * The blocked chat among `candidateIds` whose re-check is most overdue, or
 * null. Returns the id exactly as passed in (config ids can be numbers).
 */
export function nextDueId(candidateIds, now = Date.now()) {
    _load();
    let best = null;
    let bestAt = Infinity;
    for (const raw of candidateIds || []) {
        const rec = _rows.get(key(raw));
        if (!rec || !BLOCKING.has(rec.state) || rec.nextCheckAt == null) continue;
        const at = rec.nextCheckAt;
        if (at <= now && at < bestAt) {
            best = raw;
            bestAt = at;
        }
    }
    return best;
}

/**
 * The account set changed. Answers from accounts that are gone are
 * dropped; when an account was added, every blocked chat becomes due so
 * the (one-per-tick) re-checker gives the new account a chance.
 */
export function accountsChanged(liveAccountIds, { added = false, now = Date.now() } = {}) {
    _load();
    const live = new Set([...(liveAccountIds || [])].map(String));
    for (const [id, rec] of _rows) {
        const accounts = {};
        for (const [acct, a] of Object.entries(rec.accounts || {})) {
            if (acct === '_' || live.has(acct)) accounts[acct] = a;
        }
        let next = { ...rec, accounts };
        if (!BLOCKING.has(rec.state)) {
            if (!Object.values(accounts).some((a) => BLOCKING.has(a.state))) {
                _rows.delete(id);
                _persist(id, null);
                continue;
            }
        } else if ((added || !Object.keys(accounts).length) && rec.state !== 'migrated') {
            next = { ...next, nextCheckAt: Math.min(rec.nextCheckAt ?? now, now) };
        }
        _rows.set(id, next);
        _persist(id, next);
    }
}

/**
 * Free information from a dialog list (the app fetches them anyway for
 * names). For one account's dialogs:
 *   • a chat that shows up as a normal member → that account can read it
 *     again (flips a blocked chat back to ok);
 *   • a configured chat that shows up forbidden / deactivated / migrated
 *     → recorded without spending a call.
 * `left` / `restricted` read off an entity alone never pause a chat.
 * Returns how many chats changed.
 */
export function syncFromDialogs(accountId, dialogs, { configIds = null, now = Date.now() } = {}) {
    _load();
    let changed = 0;
    for (const d of dialogs || []) {
        let id;
        try {
            id = key(d?.id);
        } catch {
            continue;
        }
        if (!id) continue;
        const cls = classifyEntity(d.entity);
        if (!cls) continue;
        if (cls.state === 'restricted') {
            if (_restrictionHints.size >= HINTS_MAX && !_restrictionHints.has(id)) {
                _restrictionHints.delete(_restrictionHints.keys().next().value);
            }
            _restrictionHints.set(id, cls.detail || 'restricted');
        } else {
            _restrictionHints.delete(id);
        }
        const row = _rows.get(id);
        if (cls.state === 'ok') {
            if (!row) continue;
            const mine = row.accounts?.[String(accountId)];
            if (BLOCKING.has(row.state) || (mine && mine.state !== 'ok')) {
                recordCheck(id, [{ accountId, cls }], { now });
                changed += 1;
            }
            continue;
        }
        if (cls.state === 'restricted' || cls.state === 'left') continue;
        if (!configIds || !configIds.has(id)) continue;
        const mine = row?.accounts?.[String(accountId)];
        if (mine && mine.state === cls.state) continue;
        recordCheck(id, [{ accountId, cls }], { now });
        changed += 1;
    }
    return changed;
}

/** A read error for this chat → verdict (uses the restriction hint). */
export function classifyChatError(chatId, err) {
    const cls = classifyAccessError(err);
    const hint = _restrictionHints.get(key(chatId));
    if (hint && cls.definite && (cls.state === 'private' || cls.state === 'deleted')) {
        return { ...cls, state: 'restricted', detail: hint };
    }
    return cls;
}

/**
 * Ask the accounts, in order, whether they can read the chat — one
 * `getMessages(limit 1)` each, stopping at the first that can. Records
 * the answers and returns:
 *   { state, access, client, accountId, topId, results }
 * `client` / `accountId` / `topId` are set when an account can read it.
 *
 * @param {string|number} chatId   the id as stored in the config
 * @param {Array<{accountId: string|null, client: object}>} pairs
 */
export async function probeChatAccess(chatId, pairs, { isRecheck = false, now = null } = {}) {
    const results = [];
    let winner = null;
    for (const p of pairs || []) {
        const client = p?.client;
        if (!client) continue;
        if (client.connected === false) {
            results.push({
                accountId: p.accountId,
                cls: { state: 'unknown', code: 'NOT_CONNECTED', definite: false, transient: true },
            });
            continue;
        }
        try {
            const msgs = await client.getMessages(chatId, { limit: 1 });
            const top = msgs && msgs.length ? msgs[0] : null;
            const migrated = classifyMessage(top);
            if (migrated) {
                // Chat-wide: every account would say the same.
                results.push({ accountId: p.accountId, cls: migrated });
                break;
            }
            results.push({ accountId: p.accountId, cls: { state: 'ok' } });
            winner = { client, accountId: p.accountId ?? null, topId: top?.id ?? null };
            break;
        } catch (e) {
            results.push({ accountId: p.accountId, cls: classifyChatError(chatId, e) });
        }
    }
    const access = results.length
        ? recordCheck(chatId, results, { isRecheck, now: now ?? Date.now() })
        : accessOf(chatId);
    return {
        state: winner ? 'ok' : access.state,
        access,
        client: winner?.client || null,
        accountId: winner?.accountId ?? null,
        topId: winner?.topId ?? null,
        results: results.map((r) => ({
            accountId: r.accountId ?? null,
            state: r.cls.state,
            code: r.cls.code || null,
            transient: !!r.cls.transient,
            seconds: r.cls.seconds || null,
        })),
    };
}

/**
 * What the config of an older version says about a chat, for installs
 * upgraded with chats it auto-disabled (`suspended`, `_resolveFailedAt`).
 * Those entries are already switched off, so they cost no quota; this only
 * lets the UI show them with the same badge. Null when nothing's recorded.
 */
export function legacyAccess(group) {
    if (!group || String(group.id).startsWith('unknown:')) return null;
    if (group.suspended !== true && !group._resolveFailedAt) return null;
    const reason = String(group._resolveFailedReason || '');
    const code = reason.includes(':') ? reason.slice(reason.indexOf(':') + 1) : null;
    const cls = code ? classifyAccessError({ errorMessage: code }) : null;
    let state = cls?.definite ? cls.state : null;
    if (!state && group.suspended === true) state = 'banned';
    if (!state) return null;
    return {
        state,
        code: cls?.code || code || null,
        detail: null,
        migratedTo: null,
        firstSeenAt: group._resolveFailedAt || null,
        checkedAt: group._resolveFailedAt || null,
        nextCheckAt: null,
        checks: 0,
        accounts: [],
        legacy: true,
    };
}

/** Registry answer, else the legacy config flags, else ok. */
export function effectiveAccess(group) {
    if (!group) return { state: 'ok' };
    _load();
    const rec = _rows.get(key(group.id));
    if (rec) return publicAccess(rec);
    return legacyAccess(group) || { state: 'ok' };
}

/** Tests only: forget the in-memory state (and the table rows). */
export function _resetForTests({ clearDb = true } = {}) {
    _rows.clear();
    _restrictionHints.clear();
    _loaded = false;
    _dbOk = true;
    if (clearDb) {
        try {
            getDb().prepare('DELETE FROM chat_access').run();
        } catch {
            /* no table / no DB */
        }
    }
}
