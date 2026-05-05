/**
 * Account Manager - Multi-Account Telegram Client Management
 * Supports dynamic account assignment per group for monitoring & forwarding
 */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { SecureSession } from './security.js';
import { getOrGenerateSecret } from './secret.js';
import { colorize } from '../cli/colors.js';
import { suppressNoise } from './logger.js';
import { buildProxy } from './proxy.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '../../data/sessions');
const CONFIG_PATH = path.join(__dirname, '../../data/config.json');
const SESSION_PASSWORD = getOrGenerateSecret();

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Custom logger factory for Telegram clients (suppress noise)
 */
function createLogger(label) {
    return {
        canSend: () => true,
        warn: (msg) => {
            if (suppressNoise(msg, label)) return;
            console.log(colorize(`⚠️  [${label}] ${msg}`, 'yellow'));
        },
        info: (msg) => {
            // Info-level gramJS chatter is always demoted; nothing user-actionable.
            suppressNoise(msg, label);
        },
        debug: () => {},
        error: (msg) => {
            const str = typeof msg === 'object' ? (msg.message || String(msg)) : String(msg);
            if (suppressNoise(str, label)) return;
            console.error(colorize(`❌ [${label}] ${str}`, 'red'));
        },
        setLevel: () => {},
    };
}

export class AccountManager {
    /**
     * @param {object} config - Full app config (must have telegram.apiId, telegram.apiHash)
     */
    constructor(config) {
        this.config = config;
        this.secure = new SecureSession(SESSION_PASSWORD);
        this.clients = new Map();   // accountId -> TelegramClient
        this.metadata = new Map();  // accountId -> { id, name, phone, userId }
        this._authFlows = new Map(); // sessionId -> PhoneAuthFlow (for web wizard)
    }

    /**
     * Load all saved account sessions from data/sessions/ and connect them
     * @returns {Promise<number>} number of accounts loaded
     */
    async loadAll() {
        // Migrate legacy single session if it exists and no multi-account sessions yet
        await this.migrateLegacy();

        // Load all .enc session files, sorted by mtime (oldest first = default)
        const files = fs.readdirSync(SESSIONS_DIR)
            .filter(f => f.endsWith('.enc'))
            .sort((a, b) => {
                const statA = fs.statSync(path.join(SESSIONS_DIR, a));
                const statB = fs.statSync(path.join(SESSIONS_DIR, b));
                return statA.mtimeMs - statB.mtimeMs;
            });
        
        if (files.length === 0) {
            return 0;
        }

        let loaded = 0;
        for (const file of files) {
            const accountId = path.basename(file, '.enc');
            try {
                const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8');
                const encrypted = JSON.parse(raw);
                const sessionString = this.secure.decrypt(encrypted);

                const client = await this.createClient(accountId, sessionString);
                await client.connect();

                const isAuthorized = await client.checkAuthorization();
                if (!isAuthorized) {
                    console.log(colorize(`⚠️  Account "${accountId}" session expired, skipping`, 'yellow'));
                    await client.disconnect().catch(() => {});
                    continue;
                }

                const me = await client.getMe();
                this.clients.set(accountId, client);
                this.metadata.set(accountId, {
                    id: accountId,
                    name: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
                    phone: me.phone || '',
                    userId: String(me.id),
                    username: me.username || ''
                });

                loaded++;
                console.log(colorize(`  ✅ ${accountId}: ${me.firstName || 'Unknown'} (@${me.username || 'N/A'})`, 'green'));
            } catch (e) {
                console.log(colorize(`  ❌ Failed to load "${accountId}": ${e.message}`, 'red'));
            }
        }

        // Sync metadata to config for Web API
        await this.syncToConfig();

        // Start the keep-alive pinger so the main DC sender doesn't idle
        // out and reconnect every 30-90 s during downloads. gramJS's media
        // DC senders are still per-download (we can't pin those without
        // forking gramJS) but every keep-alive on the main client also
        // refreshes the session, which prevents the cascading reconnects
        // we used to see in network.log.
        this._startKeepAlive();

        return loaded;
    }

    /**
     * Background ping loop that keeps every connected client's main DC
     * session warm. Telegram drops idle MTProto connections after ~75 s;
     * Api.PingDelayDisconnect tells the server to extend that window so
     * we don't lose the session between user actions / file downloads.
     *
     * Idempotent — calling twice is a no-op (the second call resets the
     * interval to the freshest set of clients).
     */
    _startKeepAlive() {
        if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
        // Coalesce repeated FloodWait warnings so a throttled DC doesn't log
        // a wall of identical lines. Cleared once a successful ping lands.
        const lastWarnAt = new Map(); // accountId → ts
        // Per-account "skip until" timestamps so a FloodWait pauses the
        // next N ticks for that DC instead of pinging right back into the
        // throttle. Reset on first clean ping (in the success path).
        const skipUntil = new Map(); // accountId → ts
        const FLOOD_WARN_INTERVAL_MS = 5 * 60 * 1000;
        const FLOOD_BACKOFF_MS = 10 * 60 * 1000;
        const tick = async () => {
            const now = Date.now();
            for (const [id, client] of this.clients) {
                if (!client?.connected) continue;
                if ((skipUntil.get(id) || 0) > now) continue;   // serving FloodWait penalty
                try {
                    // 90 s extension — keeps the connection past the next
                    // tick (60 s) with comfortable headroom.
                    await client.invoke(new Api.PingDelayDisconnect({
                        pingId: BigInt(Date.now()),
                        disconnectDelay: 90,
                    }));
                    lastWarnAt.delete(id);
                    skipUntil.delete(id);
                } catch (e) {
                    // FloodWait is the one signal worth surfacing — keep
                    // pinging an already-throttled DC and we just dig the
                    // hole deeper. Back off for 10 min and let the
                    // throttle decay. Other failures (network blips,
                    // half-closed sockets) stay silent; gramJS will
                    // reconnect.
                    const text = e?.errorMessage || e?.message || String(e || '');
                    if (/FLOOD/i.test(text) || /flood_wait/i.test(text)) {
                        skipUntil.set(id, Date.now() + FLOOD_BACKOFF_MS);
                        const prev = lastWarnAt.get(id) || 0;
                        if (Date.now() - prev > FLOOD_WARN_INTERVAL_MS) {
                            lastWarnAt.set(id, Date.now());
                            console.warn(`[keep-alive] FloodWait on account ${id}, pausing pings for 10m: ${text}`);
                        }
                    }
                }
            }
        };
        // First ping fires fast so a freshly-loaded set of clients gets
        // their disconnect-delay extended before the gramJS default expires.
        setTimeout(tick, 5 * 1000);
        this._keepAliveTimer = setInterval(tick, 60 * 1000);
        this._keepAliveTimer.unref?.();
    }

    stopKeepAlive() {
        if (this._keepAliveTimer) {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
    }

    /**
     * Migrate single legacy session (data/session.enc) to multi-account format
     */
    async migrateLegacy() {
        const legacyPath = path.join(__dirname, '../../data/session.enc');
        
        // Only migrate if legacy file exists AND no sessions exist yet
        if (!fs.existsSync(legacyPath)) return;
        
        const existingFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.enc'));
        if (existingFiles.length > 0) return; // Already migrated

        try {
            const raw = fs.readFileSync(legacyPath, 'utf8');
            const encrypted = JSON.parse(raw);
            const sessionString = this.secure.decrypt(encrypted);

            // Create a temporary client to get user info for naming
            const client = await this.createClient('legacy', sessionString);
            await client.connect();
            const me = await client.getMe();
            await client.disconnect().catch(() => {});

            // Save with a friendly account ID
            const accountId = me.username || `acc_${me.phone || '1'}`;
            const newEncrypted = this.secure.encrypt(sessionString);
            fs.writeFileSync(
                path.join(SESSIONS_DIR, `${accountId}.enc`),
                JSON.stringify(newEncrypted, null, 2)
            );

            console.log(colorize(`🔄 Migrated legacy session → "${accountId}"`, 'cyan'));
        } catch (e) {
            console.log(colorize(`⚠️  Could not migrate legacy session: ${e.message}`, 'yellow'));
        }
    }

    /**
     * Create a new TelegramClient instance
     */
    async createClient(label, sessionString = '') {
        const opts = {
            // Capped + jittered retry policy. The previous 100 with no backoff
            // hammered Telegram during outages.
            connectionRetries: 5,
            retryDelay: 2000,
            deviceModel: `TG-DL [${label}]`,
            systemVersion: 'Windows 10',
            appVersion: '1.0.0',
            useWSS: false,
            baseLogger: createLogger(label),
        };
        try {
            const proxy = buildProxy(this.config);
            if (proxy) opts.proxy = proxy;
        } catch (e) {
            console.log(colorize(`⚠️  Proxy config invalid (${e.message}) — connecting direct`, 'yellow'));
        }
        return new TelegramClient(
            new StringSession(sessionString),
            parseInt(this.config.telegram.apiId),
            this.config.telegram.apiHash,
            opts,
        );
    }

    /**
     * Interactive login for a new account
     * @param {Function} questionFn - async function(prompt) => answer
     * @returns {string|null} accountId if successful
     */
    async addAccount(questionFn) {
        console.log();
        console.log(colorize('╭──────────────────────────────────────────────╮', 'cyan'));
        console.log(colorize('│', 'cyan') + colorize('           ➕ ADD NEW TELEGRAM ACCOUNT          ', 'white', 'bold') + colorize('│', 'cyan'));
        console.log(colorize('╰──────────────────────────────────────────────╯', 'cyan'));
        console.log();

        // Get account label
        console.log(colorize('Give this account a short name (e.g. "main", "bot2", "viewer")', 'dim'));
        console.log(colorize('Leave blank to auto-use Telegram username/phone', 'dim'));
        const label = await questionFn(colorize('📝 Account Name: ', 'cyan'));
        
        let isTempId = false;
        let accountId = label.trim().replace(/\s+/g, '_').toLowerCase();
        
        if (!accountId) {
            accountId = `temp_${Date.now()}`;
            isTempId = true;
        }

        // Check duplicate if custom name provided
        if (!isTempId && this.clients.has(accountId)) {
            console.log(colorize(`❌ Account "${accountId}" already exists`, 'red'));
            return null;
        }

        // Create client and start login
        const client = await this.createClient(isTempId ? 'New Account' : accountId);
        
        try {
            await client.connect();
            
            console.log();
            console.log(colorize('🔐 Starting Telegram login...', 'cyan'));
            console.log();

            await client.start({
                phoneNumber: async () => {
                    console.log(colorize('Enter phone with country code (e.g. +66812345678)', 'dim'));
                    const phone = await questionFn(colorize('📞 Phone: ', 'cyan'));
                    return phone.trim();
                },
                phoneCode: async () => {
                    console.log();
                    console.log(colorize('Check your Telegram app for the code', 'dim'));
                    const code = await questionFn(colorize('📝 OTP Code: ', 'cyan'));
                    return code.trim();
                },
                password: async () => {
                    console.log();
                    console.log(colorize('2FA Password (leave empty if not set)', 'dim'));
                    const pass = await questionFn(colorize('🔑 Password: ', 'cyan'));
                    return pass.trim();
                },
                onError: (err) => {
                    console.log(colorize(`❌ Error: ${err.message}`, 'red'));
                }
            });

            // Get user info and determine final ID
            const me = await client.getMe();
            
            let finalAccountId = accountId;
            if (isTempId) {
                finalAccountId = (me.username || `acc_${me.phone || Date.now()}`).toLowerCase();
                // Ensure unique auto-generated ID
                let base = finalAccountId;
                let counter = 1;
                while (this.clients.has(finalAccountId)) {
                    finalAccountId = `${base}_${counter}`;
                    counter++;
                }
                
                // Update client logger label now that we have a real ID
                client.baseLogger = createLogger(finalAccountId);
            }

            // Save session with final ID
            const sessionStr = client.session.save();
            const encrypted = this.secure.encrypt(sessionStr);
            fs.writeFileSync(
                path.join(SESSIONS_DIR, `${finalAccountId}.enc`),
                JSON.stringify(encrypted, null, 2)
            );

            this.clients.set(finalAccountId, client);
            this.metadata.set(finalAccountId, {
                id: finalAccountId,
                name: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
                phone: me.phone || '',
                userId: String(me.id),
                username: me.username || ''
            });
            // Re-arm the keep-alive sweep so the freshly-added client gets
            // pinged on the next tick instead of waiting up to 60 s.
            this._startKeepAlive();

            console.log();
            console.log(colorize('═══════════════════════════════════════', 'green'));
            console.log(colorize(`   ✅ Account "${finalAccountId}" added!`, 'green', 'bold'));
            console.log(colorize(`   👤 ${me.firstName || ''} @${me.username || 'N/A'}`, 'green'));
            console.log(colorize('═══════════════════════════════════════', 'green'));

            // Sync metadata to config for Web API
            await this.syncToConfig();

            return finalAccountId;

        } catch (e) {
            console.log(colorize(`❌ Login failed: ${e.message}`, 'red'));
            await client.disconnect().catch(() => {});
            return null;
        }
    }

    /**
     * Remove an account
     */
    removeAccount(accountId) {
        const client = this.clients.get(accountId);
        if (client) {
            client.disconnect().catch(() => {});
            this.clients.delete(accountId);
            this.metadata.delete(accountId);
        }

        const sessionFile = path.join(SESSIONS_DIR, `${accountId}.enc`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
        }

        // Sync metadata to config
        this.syncToConfig().catch(() => {});
    }

    /**
     * Persist account metadata to config.json for Web API access
     */
    async syncToConfig() {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const config = JSON.parse(raw);
            config.accounts = this.getList();
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
        } catch (e) {
            // Config file may not exist yet during first run
        }
    }

    /**
     * Get a specific client by account ID
     * @param {string} accountId
     * @returns {TelegramClient|null}
     */
    getClient(accountId) {
        if (!accountId) return this.getDefaultClient();
        return this.clients.get(accountId) || this.getDefaultClient();
    }

    /**
     * Get the first available client (default/fallback)
     * @returns {TelegramClient|null}
     */
    getDefaultClient() {
        const first = this.clients.values().next();
        return first.done ? null : first.value;
    }

    /**
     * Get default account ID
     * @returns {string|null}
     */
    getDefaultId() {
        const first = this.clients.keys().next();
        return first.done ? null : first.value;
    }

    /**
     * Get list of all accounts (for UI display)
     * @returns {Array<{id, name, phone, userId, username}>}
     */
    getList() {
        return Array.from(this.metadata.values());
    }

    /**
     * Get total number of loaded accounts
     */
    get count() {
        return this.clients.size;
    }

    /**
     * Disconnect all clients gracefully
     */
    async disconnectAll() {
        for (const [_id, client] of this.clients) {
            try {
                await client.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }
        }
        this.clients.clear();
        this.metadata.clear();
    }

    // ====== Web phone-auth wizard ===========================================
    //
    // The CLI's addAccount() drives client.start() with synchronous-feeling
    // questionFn callbacks. The web flow needs the same end result but split
    // across HTTP round-trips (phone → OTP → 2FA). We park gramJS's callbacks
    // on deferred Promises and resolve them as each HTTP call arrives.
    //
    // Flow:
    //   beginPhoneAuth(label?)         → { sessionId, state: 'phone' }
    //   submitPhone(sessionId, phone)   → { state: 'code' | 'error' }
    //   submitCode(sessionId, code)     → { state: 'password' | 'done' | 'error' }
    //   submit2fa(sessionId, password)  → { state: 'done' | 'error', accountId }
    //   cancelAuth(sessionId)           → { ok: true }
    //   getAuthStatus(sessionId)        → { state, error, accountId }

    async beginPhoneAuth(label) {
        if (!this.config.telegram?.apiId || !this.config.telegram?.apiHash) {
            throw new Error('Telegram API credentials not configured. Set telegram.apiId and telegram.apiHash in config first.');
        }
        const requestedLabel = (label || '').trim().replace(/\s+/g, '_').toLowerCase();
        const isTempId = !requestedLabel;
        const accountId = isTempId ? `temp_${Date.now()}` : requestedLabel;
        if (!isTempId && this.clients.has(accountId)) {
            throw new Error(`Account "${accountId}" already exists`);
        }

        const sessionId = crypto.randomBytes(8).toString('hex');
        const flow = {
            sessionId,
            requestedLabel: isTempId ? null : accountId,
            isTempId,
            state: 'phone', // phone | code | password | done | error | cancelled
            error: null,
            accountId: null,
            phoneDeferred: deferred(),
            codeDeferred: deferred(),
            passwordDeferred: deferred(),
            stateWaiters: new Set(),
            createdAt: Date.now(),
        };
        this._authFlows.set(sessionId, flow);

        // Build the client and start the login in the background. Each
        // gramJS callback parks on its corresponding deferred until the
        // matching HTTP submit*() resolves it. State transitions notify any
        // pending stateWaiters so the HTTP handler can return promptly.
        const client = await this.createClient(isTempId ? 'New Account' : accountId);
        flow.client = client;
        await client.connect();

        const setState = (s) => {
            flow.state = s;
            for (const fn of flow.stateWaiters) try { fn(s); } catch {}
        };

        client.start({
            phoneNumber: () => {
                setState('phone');
                return flow.phoneDeferred.promise;
            },
            phoneCode: () => {
                setState('code');
                return flow.codeDeferred.promise;
            },
            password: () => {
                setState('password');
                return flow.passwordDeferred.promise;
            },
            onError: (err) => {
                flow.error = err?.message || String(err);
            },
        }).then(async () => {
            // Login succeeded — promote the temp client to a saved session.
            try {
                const me = await client.getMe();
                let finalId = isTempId
                    ? (me.username || `acc_${me.phone || Date.now()}`).toLowerCase()
                    : accountId;
                let base = finalId, n = 1;
                while (this.clients.has(finalId)) finalId = `${base}_${n++}`;

                const sessionStr = client.session.save();
                const encrypted = this.secure.encrypt(sessionStr);
                fs.writeFileSync(
                    path.join(SESSIONS_DIR, `${finalId}.enc`),
                    JSON.stringify(encrypted, null, 2),
                );
                this.clients.set(finalId, client);
                this.metadata.set(finalId, {
                    id: finalId,
                    name: `${me.firstName || ''} ${me.lastName || ''}`.trim(),
                    phone: me.phone || '',
                    userId: String(me.id),
                    username: me.username || '',
                });
                await this.syncToConfig().catch(() => {});
                this._startKeepAlive();
                flow.accountId = finalId;
                setState('done');
            } catch (e) {
                flow.error = e?.message || String(e);
                setState('error');
            }
            // Auth flows are short-lived; clean up after a grace period so the
            // SPA can poll one last time and read the final state.
            setTimeout(() => this._authFlows.delete(sessionId), 60000);
        }).catch((err) => {
            flow.error = err?.message || String(err);
            setState('error');
            try { client.disconnect().catch(() => {}); } catch {}
            setTimeout(() => this._authFlows.delete(sessionId), 60000);
        });

        return { sessionId, state: 'phone' };
    }

    /** Wait for the next state transition (or timeout). */
    _waitNextState(flow, timeoutMs = 30000) {
        const cur = flow.state;
        return new Promise((resolve) => {
            const t = setTimeout(() => {
                flow.stateWaiters.delete(notify);
                resolve(flow.state);
            }, timeoutMs);
            const notify = (s) => {
                if (s === cur) return;
                clearTimeout(t);
                flow.stateWaiters.delete(notify);
                resolve(s);
            };
            flow.stateWaiters.add(notify);
        });
    }

    async submitPhone(sessionId, phone) {
        const flow = this._authFlows.get(sessionId);
        if (!flow) throw new Error('Auth session not found');
        if (flow.state !== 'phone') throw new Error(`Wrong state: ${flow.state}`);
        const trimmed = String(phone || '').trim();
        if (!trimmed) throw new Error('Phone required');
        flow.phoneDeferred.resolve(trimmed);
        await this._waitNextState(flow);
        return { state: flow.state, error: flow.error };
    }

    async submitCode(sessionId, code) {
        const flow = this._authFlows.get(sessionId);
        if (!flow) throw new Error('Auth session not found');
        if (flow.state !== 'code') throw new Error(`Wrong state: ${flow.state}`);
        const trimmed = String(code || '').trim();
        if (!trimmed) throw new Error('Code required');
        flow.codeDeferred.resolve(trimmed);
        await this._waitNextState(flow);
        return { state: flow.state, error: flow.error, accountId: flow.accountId };
    }

    async submit2fa(sessionId, password) {
        const flow = this._authFlows.get(sessionId);
        if (!flow) throw new Error('Auth session not found');
        if (flow.state !== 'password') throw new Error(`Wrong state: ${flow.state}`);
        flow.passwordDeferred.resolve(String(password || ''));
        await this._waitNextState(flow);
        return { state: flow.state, error: flow.error, accountId: flow.accountId };
    }

    async cancelAuth(sessionId) {
        const flow = this._authFlows.get(sessionId);
        if (!flow) return { ok: false, reason: 'not_found' };
        flow.state = 'cancelled';
        // Reject all deferreds to unblock client.start()
        try { flow.phoneDeferred.reject(new Error('cancelled')); } catch {}
        try { flow.codeDeferred.reject(new Error('cancelled')); } catch {}
        try { flow.passwordDeferred.reject(new Error('cancelled')); } catch {}
        if (flow.client) {
            try { await flow.client.disconnect(); } catch {}
        }
        this._authFlows.delete(sessionId);
        return { ok: true };
    }

    getAuthStatus(sessionId) {
        const flow = this._authFlows.get(sessionId);
        if (!flow) return null;
        return { state: flow.state, error: flow.error, accountId: flow.accountId };
    }
}
