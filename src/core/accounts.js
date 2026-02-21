/**
 * Account Manager - Multi-Account Telegram Client Management
 * Supports dynamic account assignment per group for monitoring & forwarding
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SecureSession } from './security.js';
import { getOrGenerateSecret } from './secret.js';
import { colorize } from '../cli/colors.js';

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
            if (msg?.includes('Disconnecting') || msg?.includes('Connection closed')) return;
            if (msg?.includes('Reconnect') || msg?.includes('reconnect')) return;
            if (msg?.includes('Not connected') || msg?.includes('TIMEOUT')) return;
            if (msg?.includes('Closing current connection')) return;
            console.log(colorize(`⚠️  [${label}] ${msg}`, 'yellow'));
        },
        info: (msg) => {
            if (msg?.includes('Connecting to')) return;
            if (msg?.includes('Disconnecting')) return;
            if (msg?.includes('connection closed')) return;
            if (msg?.includes('Running gramJS')) return;
            if (msg?.includes('Reconnect') || msg?.includes('reconnect')) return;
        },
        debug: () => {},
        error: (msg) => {
            const str = typeof msg === 'object' ? (msg.message || String(msg)) : String(msg);
            if (str.includes('Not connected')) return;
            if (str.includes('TIMEOUT')) return;
            if (str.includes('WebSocket connection failed')) return;
            if (str.includes('Connection closed')) return;
            if (str.includes('disconnect')) return;
            console.error(colorize(`❌ [${label}] ${str}`, 'red'));
        },
        setLevel: () => {}
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

        return loaded;
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
        return new TelegramClient(
            new StringSession(sessionString),
            parseInt(this.config.telegram.apiId),
            this.config.telegram.apiHash,
            {
                connectionRetries: 100,
                deviceModel: `TG-DL [${label}]`,
                systemVersion: 'Windows 10',
                appVersion: '1.0.0',
                useWSS: false,
                baseLogger: createLogger(label)
            }
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
        for (const [id, client] of this.clients) {
            try {
                await client.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }
        }
        this.clients.clear();
        this.metadata.clear();
    }
}
