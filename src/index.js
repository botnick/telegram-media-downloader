/**
 * Telegram Auto-Downloader CLI
 * Multi-Account Support
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { loadConfig, saveConfig, addGroup } from './config/manager.js';
import { hashPassword } from './core/web-auth.js';
import { suppressNoise, wrapConsoleMethod } from './core/logger.js';
import { RateLimiter, SecureSession } from './core/security.js';
import { ConnectionManager } from './core/connection.js';
import { AccountManager } from './core/accounts.js';
import { colorize, clearScreen, formatBytes } from './cli/colors.js';
import { resilience } from './core/resilience.js';
import { getOrGenerateSecret } from './core/secret.js';
import { getDb, getStats as getDbStats, deleteGroupDownloads, deleteAllDownloads, backfillGroupNames } from './core/db.js';
import { sanitizeName, migrateFolders } from './core/downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../data/config.json');

// gramJS surfaces a steady trickle of recoverable internal errors during
// reconnects (TIMEOUT, "Not connected", "Connection closed", etc). The
// noise classifier in core/logger.js sends those to data/logs/network.log
// at debug level instead of dropping them silently — a previous version
// of this file used a regex-string-includes filter that swallowed real
// errors that happened to contain the same words.
// Same native-binary-load guard the web server uses — keeps a CLI run
// from dying on `Error loading shared library ld-linux-…` when an
// optional dep (most often `onnxruntime-node`, transitively from the
// optional NSFW classifier) ships glibc-only prebuilds on a musl image.
const _NATIVE_LOAD_FAIL_CLI = /(ld-linux|ld-musl|libonnxruntime|GLIBC_|NODE_MODULE_VERSION|cannot open shared object|Error loading shared library)/i;
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (suppressNoise(msg, 'unhandledRejection')) return;
    if (_NATIVE_LOAD_FAIL_CLI.test(msg)) {
        console.warn('[startup] An optional native module failed to load:', msg.slice(0, 200));
        return;
    }
    console.error('Unhandled rejection:', reason);
});

console.error = wrapConsoleMethod(console.error, 'console.error');

// Transient Readline Interface
function question(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => {
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

function checkPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            const inUse = err && (err.code === 'EADDRINUSE' || err.code === 'EACCES');
            resolve({ ok: !inUse, detail: err?.message || String(err) });
        });
        server.once('listening', () => {
            server.close(() => resolve({ ok: true, detail: 'available' }));
        });
        server.listen(port, '0.0.0.0');
    });
}

function checkFfmpeg() {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
        return { ok: true, detail: r.stdout.trim().split(/\r?\n/)[0] };
    }
    return { ok: false, detail: 'not on PATH (video thumbs will use bundled @ffmpeg-installer fallback)' };
}

async function runDoctor() {
    const checks = [];

    const major = Number(String(process.versions.node || '').split('.')[0]);
    checks.push({
        name: 'Node runtime',
        level: major >= 22 ? 'ok' : 'fail',
        detail: `v${process.versions.node} (ABI ${process.versions.modules}, ${process.platform}/${process.arch}) — engines requires >=22`,
    });

    try {
        const cfg = loadConfig();
        const hasTelegram = Boolean(cfg?.telegram && typeof cfg.telegram === 'object');
        const hasWeb = Boolean(cfg?.web && typeof cfg.web === 'object');
        checks.push({
            name: 'Config load',
            level: hasTelegram && hasWeb ? 'ok' : 'fail',
            detail: hasTelegram && hasWeb
                ? `loaded ${CONFIG_PATH}`
                : 'config.json missing telegram/web sections — run the dashboard once to bootstrap',
        });
    } catch (e) {
        checks.push({
            name: 'Config load',
            level: 'fail',
            detail: e?.message || String(e),
        });
    }

    try {
        const db = getDb();
        const row = db.prepare('SELECT COUNT(1) AS n FROM downloads').get();
        checks.push({
            name: 'SQLite (better-sqlite3)',
            level: 'ok',
            detail: `opened db.sqlite — downloads rows: ${row?.n ?? 0}`,
        });
    } catch (e) {
        const msg = e?.message || String(e);
        const abiHint = msg.includes('NODE_MODULE_VERSION')
            ? ' — run `npm rebuild better-sqlite3` after a Node version change'
            : '';
        checks.push({
            name: 'SQLite (better-sqlite3)',
            level: 'fail',
            detail: msg + abiHint,
        });
    }

    const dataDir = path.join(__dirname, '../data');
    try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        const probe = path.join(dataDir, '.doctor-write-probe');
        fs.writeFileSync(probe, String(Date.now()));
        fs.unlinkSync(probe);
        checks.push({ name: 'data/ writable', level: 'ok', detail: dataDir });
    } catch (e) {
        checks.push({
            name: 'data/ writable',
            level: 'fail',
            detail: `${dataDir}: ${e?.message || e}`,
        });
    }

    const port = Number(process.env.PORT || 3000);
    const portCheck = await checkPortAvailable(port);
    checks.push({
        name: `Port ${port}`,
        level: portCheck.ok ? 'ok' : 'warn',
        detail: portCheck.ok ? 'available' : `busy (${portCheck.detail}) — set PORT=<other> to override`,
    });

    const ff = checkFfmpeg();
    checks.push({
        name: 'ffmpeg',
        level: ff.ok ? 'ok' : 'warn',
        detail: ff.detail,
    });

    // Optional NSFW classifier — moved to optionalDependencies in v2.4.0
    // because `onnxruntime-node` (transitively pulled in) ships glibc-only
    // prebuilt binaries that explode on musl-based Linux. We surface the
    // availability as a `warn` (not `fail`) when missing — most operators
    // never enable the NSFW review feature, so its absence is fine.
    try {
        await import('@huggingface/transformers');
        checks.push({ name: 'NSFW classifier (optional)', level: 'ok', detail: '@huggingface/transformers loaded' });
    } catch (e) {
        const msg = e?.message || String(e);
        const native = /(ld-linux|libonnxruntime|GLIBC_|NODE_MODULE_VERSION|cannot open shared object)/i.test(msg);
        checks.push({
            name: 'NSFW classifier (optional)',
            level: 'warn',
            detail: native
                ? 'native binary missing (' + msg.slice(0, 120) + ') — reinstall on a glibc image or `npm uninstall @huggingface/transformers` to silence'
                : 'not installed — `npm install @huggingface/transformers` if you want the NSFW review feature',
        });
    }

    console.log();
    console.log(colorize('🩺 Telegram Downloader — Doctor', 'cyan', 'bold'));
    console.log(colorize(`   host=${os.hostname()} platform=${process.platform} arch=${process.arch}`, 'dim'));
    console.log();
    let failed = 0;
    let warned = 0;
    checks.forEach((c) => {
        let icon, tone;
        if (c.level === 'ok') { icon = '✅'; tone = 'green'; }
        else if (c.level === 'warn') { icon = '⚠️ '; tone = 'yellow'; warned++; }
        else { icon = '❌'; tone = 'red'; failed++; }
        console.log(colorize(`${icon} ${c.name}: ${c.detail}`, tone));
    });
    console.log();
    if (failed) {
        console.log(colorize(`Doctor found ${failed} blocking issue(s)${warned ? `, ${warned} warning(s)` : ''}.`, 'red', 'bold'));
        process.exitCode = 1;
        return;
    }
    if (warned) {
        console.log(colorize(`Doctor passed with ${warned} warning(s).`, 'yellow', 'bold'));
        return;
    }
    console.log(colorize('All doctor checks passed.', 'green', 'bold'));
}

async function main() {
    resilience.init();

    const command = process.argv[2];

    // Default behaviour with no subcommand: launch the web dashboard.
    // Everything (accounts, groups, history, monitor, settings, link
    // downloads, stories) is reachable from the browser. The interactive
    // CLI is still available via `node src/index.js menu` (or `help`) for
    // headless / power-user workflows.
    if (!command) {
        const port = process.env.PORT || 3000;
        const url = `http://localhost:${port}`;
        console.log(colorize('\n🚀 Telegram Downloader', 'cyan', 'bold'));
        console.log(colorize(`   Dashboard: ${url}`, 'green'));
        console.log(colorize('   First run? Open the URL and follow the setup wizard.', 'dim'));
        console.log(colorize('   Power-user CLI: `node src/index.js menu`\n', 'dim'));
        await import('./web/server.js');
        return new Promise(() => {}); // keep alive
    }

    // Help / menu output never needs a terminal.
    if (command === 'menu' || command === 'help' || command === '--help' || command === '-h') {
        showMenu();
        return;
    }

    // Diagnostics — non-interactive, safe to run in headless / CI / Docker.
    if (command === 'doctor') {
        await runDoctor();
        return;
    }

    // Other subcommands beyond this point are interactive — they need a TTY.
    if (!process.stdin.isTTY && command !== 'web' && command !== 'monitor' && command !== 'history' && command !== 'doctor') {
        console.error(colorize('❌ This subcommand needs an interactive terminal.', 'red', 'bold'));
        process.exit(1);
    }

    clearScreen();
    console.log(colorize('╔════════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║   📱 TELEGRAM DOWNLOADER — CLI              ║', 'cyan', 'bold'));
    console.log(colorize('╚════════════════════════════════════════════╝', 'cyan'));
    console.log();

    // Load config
    const config = loadConfig();

    // Backfill group_name for existing DB records
    try {
        const updated = backfillGroupNames(config.groups || []);
        if (updated > 0) console.log(colorize(`\u{1f4dd} Backfilled group names for ${updated} records`, 'dim'));
    } catch (e) { /* ignore */ }

    // Check for auth command (Bypass API credentials check)
    if (process.argv[2] === 'auth') {
        await setupWebAuth(config);
        process.exit(0);
    }

    if (!config.telegram.apiId || !config.telegram.apiHash) {
        console.log();
        console.log(colorize('⚙️  FIRST RUN SETUP', 'cyan', 'bold'));
        console.log(colorize('Please enter your Telegram API credentials.', 'dim'));
        console.log(colorize('Get them from: https://my.telegram.org', 'dim'));
        console.log();

        while (!config.telegram.apiId) {
            const input = await question(colorize('📦 API ID: ', 'cyan'));
            config.telegram.apiId = input.trim();
        }
        while (!config.telegram.apiHash) {
            const input = await question(colorize('🔑 API Hash: ', 'cyan'));
            config.telegram.apiHash = input.trim();
        }

        saveConfig(config);
        console.log(colorize('✅ Setup complete! Continuing...', 'green'));
        console.log();
    }

    // Don't echo the apiId — it's not strictly secret but there's no
    // operational reason to log it on every CLI start.
    console.log();

    // ============ MULTI-ACCOUNT SYSTEM ============
    const accountManager = new AccountManager(config);

    console.log(colorize('🔌 Loading accounts...', 'cyan'));
    const loaded = await accountManager.loadAll();

    // If no accounts, prompt to add one
    if (loaded === 0) {
        console.log();
        console.log(colorize('═══════════════════════════════════════', 'yellow'));
        console.log(colorize('   🔐 NO ACCOUNTS FOUND', 'yellow', 'bold'));
        console.log(colorize('   Please add your first Telegram account', 'yellow'));
        console.log(colorize('═══════════════════════════════════════', 'yellow'));

        const added = await accountManager.addAccount(question);
        if (!added) {
            console.log(colorize('❌ Cannot continue without an account', 'red'));
            process.exit(1);
        }
    }

    // Show loaded accounts summary
    const accounts = accountManager.getList();
    const defaultId = accountManager.getDefaultId();
    console.log();
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log(colorize(`   👥 ${accounts.length} Account(s) Ready`, 'green', 'bold'));
    accounts.forEach(acc => {
        const star = acc.id === defaultId ? ' ⭐' : '';
        console.log(colorize(`   • ${acc.id}: ${acc.name} @${acc.username || 'N/A'}${star}`, 'green'));
    });
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log();

    // Use default client for backward compatibility
    const client = accountManager.getDefaultClient();

    // Start Connection Manager on default client
    const connManager = new ConnectionManager(client);
    connManager.start();

    // The no-args / 'menu' / 'help' branches are handled earlier in main();
    // anything that reaches the switch is a real subcommand.
    switch (command) {
        case 'dialogs':
        case 'groups':
            await listDialogs(client);
            break;
        case 'monitor':
            await startMonitor(accountManager, config);
            break;
        case 'test':
            console.log(colorize('✅ Connection test passed!', 'green'));
            break;
        case 'config':
            await configureGroups(accountManager, config);
            break;
        case 'history':
            await startHistory(accountManager, config, connManager);
            break;
        case 'viewer':
            await viewDownloads();
            break;
        case 'settings':
            await configureGlobalSettings(config);
            break;
        case 'accounts':
            await manageAccounts(accountManager, config);
            break;
        case 'web':
            await import('./web/server.js');
            await new Promise(() => {}); // keep alive
            break;
        case 'purge':
            await purgeData(client, config);
            break;
        default:
            console.log(colorize(`Unknown command: ${command}`, 'red'));
            console.log(colorize('Run with no arguments to start the dashboard, or `node src/index.js menu` for help.', 'dim'));
            process.exitCode = 1;
    }

    // Graceful disconnect all accounts
    await accountManager.disconnectAll();

    console.log(colorize('\n👋 Disconnected. Goodbye!', 'cyan'));
}


async function listDialogs(client) {
    clearScreen();
    console.log(colorize('╔════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║    📋 ALL DIALOGS                      ║', 'cyan', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'cyan'));
    console.log();
    console.log(colorize('Fetching dialogs...', 'dim'));

    const dialogs = await client.getDialogs({ limit: 200 });

    console.log(colorize(`\n${'Type'.padEnd(10)} | ${'ID'.padEnd(20)} | ${'Name'.padEnd(35)} | Members`, 'white', 'bold'));
    console.log('─'.repeat(85));

    for (const d of dialogs) {
        const type = d.isChannel ? 'Channel' : d.isGroup ? 'Group' : d.isUser ? 'User' : 'Other';
        const id = String(d.id).padEnd(20);
        const name = (d.title || d.name || 'Unknown').slice(0, 35).padEnd(35);
        const members = d.entity?.participantsCount || '';
        const color = d.isChannel || d.isGroup ? 'green' : 'dim';
        console.log(colorize(`${type.padEnd(10)} | ${id} | ${name} | ${members}`, color));
    }

    console.log('─'.repeat(85));
    console.log(colorize(`Total: ${dialogs.length} dialogs`, 'cyan', 'bold'));
}

async function selectOption(title, options, headerOutput = '') {
    let cursor = 0;

    // Manual Raw Mode - No Readline Interface
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume(); 
    }

    // Try to enable keypress events
    try {
        readline.emitKeypressEvents(process.stdin);
    } catch (e) {
        // Already emitted
    }

    return new Promise(resolve => {
        const render = () => {
            clearScreen();
            
            if (headerOutput) {
                console.log(headerOutput);
            } else {
                console.log(colorize('╔════════════════════════════════════════╗', 'cyan'));
                console.log(colorize(`║ ${title.padEnd(38)} ║`, 'cyan', 'bold'));
                console.log(colorize('╚════════════════════════════════════════╝', 'cyan'));
            }
            
            console.log(colorize('Use Arrow Keys or Numbers (1-9), Enter to confirm', 'dim'));
            console.log('─'.repeat(40));

            options.forEach((opt, i) => {
                const isSelected = i === cursor;
                const pointer = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
                const label = isSelected ? colorize(opt.label, 'white', 'bold') : opt.label;
                const desc = opt.desc ? colorize(` (${opt.desc})`, 'dim') : '';

                const numPrefix = i < 9 ? colorize(`${i+1}. `, 'dim') : '   ';
                console.log(`${pointer} ${numPrefix}${label}${desc}`);
            });
            console.log('─'.repeat(40));
        };

        const cleanup = () => {
            process.stdin.removeListener('keypress', onKey);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
        };

        const onKey = (str, key) => {
            if (!key) return;

            // Arrow Keys
            if (key.name === 'up') {
                cursor = Math.max(0, cursor - 1);
            } else if (key.name === 'down') {
                cursor = Math.min(options.length - 1, cursor + 1);
            } 
            // Confirm
            else if (key.name === 'return') {
                cleanup();
                resolve(options[cursor].value);
            } 
            // Exit
            else if (key.ctrl && key.name === 'c') {
                cleanup();
                process.exit(0);
            }
            // Number Keys
            else if (key.name && key.name >= '1' && key.name <= '9') {
                const idx = parseInt(key.name) - 1;
                if (idx >= 0 && idx < options.length) {
                    cursor = idx;
                }
            } else if (key.name === '0') {
                 const backIdx = options.findIndex(o => o.value === '0');
                 if (backIdx !== -1) cursor = backIdx;
            }
            render();
        };

        process.stdin.on('keypress', onKey);
        render();
    });
}

async function configureGlobalSettings(config) {
    while (true) {
        // Use selectOption for the main menu too, instead of mixing 'question'
        const mainOptions = [
            { label: 'Max Disk Usage', value: '1', desc: `Current: ${config.diskManagement?.maxTotalSize || 'Unlimited'}` },
            { label: 'Max Download Speed', value: '2', desc: `Current: ${config.download?.maxSpeed ? (config.download.maxSpeed / 1024 / 1024).toFixed(1) + ' MB/s' : 'Unlimited'}` },
            { label: 'Concurrent Downloads', value: '3', desc: `Current: ${config.download?.concurrent || 3}` },
            { label: 'Download Path', value: '4', desc: `Current: ${config.download?.path || './data/downloads'}` },
            { label: 'Rate Limit (Req/Min)', value: '5', desc: `Current: ${config.rateLimits?.requestsPerMinute || 15}` },
            { label: 'Back to Menu', value: '0', desc: 'Exit settings' }
        ];

        const choice = await selectOption('    ⚙️  SYSTEM SETTINGS', mainOptions);

        if (choice === '0') break;

        if (choice === '1') {
            const val = await selectOption('SELECT MAX DISK USAGE', [
                { label: 'Unlimited', value: '0', desc: 'No limit' },
                { label: '10 GB', value: '10GB' },
                { label: '50 GB', value: '50GB' },
                { label: '100 GB', value: '100GB' },
                { label: '500 GB', value: '500GB' },
                { label: '1 TB', value: '1TB' },
                { label: '✏️ Custom...', value: 'custom', desc: 'Enter manually' },
                { label: '⬅️ Back', value: 'back', desc: 'Cancel' }
            ]);

            if (val === 'back') continue;

            let finalVal = val;
            if (val === 'custom') {
                console.log();
                const input = await question(colorize('Enter max size (e.g. 250GB, 2TB): ', 'cyan'));
                if (!input.trim()) continue;
                finalVal = input.trim();
            }

            if (!config.diskManagement) config.diskManagement = {};
            config.diskManagement.maxTotalSize = finalVal;
        } 
        else if (choice === '2') {
            const val = await selectOption('SELECT MAX SPEED', [
                { label: 'Unlimited', value: 0, desc: 'Full speed' },
                { label: '1 MB/s', value: 1024 * 1024 },
                { label: '5 MB/s', value: 5 * 1024 * 1024 },
                { label: '10 MB/s', value: 10 * 1024 * 1024 },
                { label: '20 MB/s', value: 20 * 1024 * 1024 },
                { label: '✏️ Custom...', value: 'custom', desc: 'Enter manually (MB/s)' },
                { label: '⬅️ Back', value: 'back', desc: 'Cancel' }
            ]);

            if (val === 'back') continue;

            let finalVal = val;
            if (val === 'custom') {
                console.log();
                const input = await question(colorize('Enter max speed in MB/s (e.g. 2.5): ', 'cyan'));
                const num = parseFloat(input);
                if (isNaN(num)) {
                    console.log(colorize('Invalid number!', 'red'));
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                finalVal = Math.floor(num * 1024 * 1024);
            }
            config.download.maxSpeed = finalVal;
        }
        else if (choice === '3') {
            const val = await selectOption('SELECT CONCURRENT DOWNLOADS', [
                { label: '1 Worker', value: 1, desc: 'Slow, less memory' },
                { label: '3 Workers', value: 3, desc: 'Balanced (Default)' },
                { label: '5 Workers', value: 5, desc: 'Fast' },
                { label: '10 Workers', value: 10, desc: 'Very Fast (High CPU)' },
                { label: '✏️ Custom...', value: 'custom', desc: 'Enter manually' },
                { label: '⬅️ Back', value: 'back', desc: 'Cancel' }
            ]);

            if (val === 'back') continue;

            let finalVal = val;
            if (val === 'custom') {
                console.log();
                const input = await question(colorize('Enter number of workers (1-20): ', 'cyan'));
                const num = parseInt(input);
                if (isNaN(num) || num < 1 || num > 20) {
                     console.log(colorize('Invalid number (1-20)!', 'red'));
                     await new Promise(r => setTimeout(r, 1000));
                     continue;
                }
                finalVal = num;
            }
            config.download.concurrent = finalVal;
        }
        else if (choice === '4') {
            // Path selection
            console.log();
            console.log(colorize('Current Path: ', 'yellow') + (config.download.path || './data/downloads'));
            const val = await question(colorize('Enter new path (or Enter to keep current): ', 'cyan'));
            if (val.trim()) config.download.path = val.trim();
        }
        else if (choice === '5') {
            const val = await selectOption('SELECT RATE LIMIT (REQ/MIN)', [
                { label: 'Safe (15)', value: 15, desc: 'Recommended' },
                { label: 'Moderate (30)', value: 30, desc: 'Medium speed' },
                { label: 'Fast (60)', value: 60, desc: 'Risk of FloodWait' },
                { label: '✏️ Custom...', value: 'custom', desc: 'Enter manually' },
                { label: '⬅️ Back', value: 'back', desc: 'Cancel' }
            ]);

            if (val === 'back') continue;

            let finalVal = val;
            if (val === 'custom') {
                console.log();
                const input = await question(colorize('Enter requests per minute: ', 'cyan'));
                const num = parseInt(input);
                if (isNaN(num) || num < 1) {
                    console.log(colorize('Invalid number!', 'red'));
                    continue;
                }
                finalVal = num;
            }
            config.rateLimits.requestsPerMinute = finalVal;
        }

        // Save immediately
        saveConfig(config);
        console.log(colorize('✅ Settings saved!', 'green'));
        await new Promise(r => setTimeout(r, 500));
    }
}

async function viewDownloads() {
    clearScreen();
    console.log(colorize('╔════════════════════════════════════════╗', 'green'));
    console.log(colorize('║      📊 DOWNLOAD STATS (SQLite)        ║', 'green', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'green'));
    console.log();

    try {
        const db = getDb();
        const dbStats = getDbStats();

        // Per-group breakdown
        const rows = db.prepare(`
            SELECT group_id, COUNT(*) as count, SUM(file_size) as size
            FROM downloads GROUP BY group_id ORDER BY size DESC
        `).all();

        const config = loadConfig();

        if (rows.length === 0) {
            console.log(colorize('No downloads recorded yet.', 'yellow'));
            return;
        }

        console.log(colorize(`${'Group Name'.padEnd(40)} | ${'Files'.padEnd(10)} | ${'Size'.padEnd(15)}`, 'white', 'bold'));
        console.log('─'.repeat(70));

        for (const row of rows) {
            const cfg = config.groups.find(g => String(g.id) === row.group_id);
            const name = cfg ? cfg.name : `Group ${row.group_id}`;
            const sizeStr = formatBytes(row.size || 0);
            console.log(`${name.slice(0, 40).padEnd(40)} | ${String(row.count).padEnd(10)} | ${sizeStr.padEnd(15)}`);
        }

        console.log('─'.repeat(70));
        console.log(colorize(`TOTAL: ${dbStats.totalFiles} files | ${formatBytes(dbStats.totalSize)}`, 'green', 'bold'));
    } catch (e) {
        console.log(colorize(`Error reading database: ${e.message}`, 'red'));
    }
}

async function configureGroups(accountManager, config) {
    const client = accountManager.getDefaultClient();
    clearScreen();
    console.log(colorize('╔════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║    📋 GROUP CONFIG                     ║', 'cyan', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'cyan'));
    console.log();
    console.log(colorize('Fetching dialogs...', 'dim'));

    // Get all dialogs
    const dialogs = await client.getDialogs({ limit: 100 });
    const groups = dialogs.filter(d => d.isGroup || d.isChannel);

    if (groups.length === 0) {
        console.log(colorize('❌ No groups found!', 'red'));
        return;
    }

    // Initialize selection state
    const selection = groups.map(group => ({
        id: group.id,
        name: group.title || group.name || 'Unknown',
        type: group.isChannel ? '📢' : '👥',
        enabled: config.groups.some(g => String(g.id) === String(group.id) && g.enabled),
        filters: config.groups.find(g => String(g.id) === String(group.id))?.filters || {
            photos: true, videos: true, files: true, links: true, voice: false, gifs: false
        }
    }));

    let cursor = 0;
    const pageSize = 15;
    let editingFiltersFor = null; // { index, mode: 'filters' | 'fwd' } or null

    // Enable raw mode for keypress
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const render = () => {
        clearScreen();

        if (editingFiltersFor !== null) {
            // Render Filter Menu
            const item = selection[editingFiltersFor.index];
            const isFwdMode = editingFiltersFor.mode === 'fwd';

            if (isFwdMode) {
                // AUTO FORWARD MENU - Simplified like Web UI
                const af = item.autoForward || { enabled: false, destination: null, deleteAfterForward: false };
                if (!item.autoForward) item.autoForward = af;

                console.log(colorize(`➡️  AUTO FORWARD: ${item.name.slice(0, 25)}`, 'cyan', 'bold'));
                console.log('─'.repeat(50));

                // Status bar
                const enabledText = af.enabled ? colorize('✓ ENABLED', 'green', 'bold') : colorize('✗ DISABLED', 'dim');
                const destText = af.destination === 'me' ? colorize('Saved Messages', 'yellow') : 
                                 af.destination ? colorize(af.destination, 'yellow') : colorize('Storage Channel', 'cyan');
                const deleteText = af.deleteAfterForward ? colorize('✓ Delete after', 'red') : colorize('Keep files', 'dim');

                console.log();
                console.log(`  Status:      ${enabledText}`);
                console.log(`  Destination: ${destText}`);
                console.log(`  After FWD:   ${deleteText}`);
                console.log();
                console.log('─'.repeat(50));
                console.log(colorize('🚀 Quick Actions:', 'white', 'bold'));
                console.log(`  ${colorize('1', 'cyan', 'bold')} = Toggle ON/OFF`);
                console.log(`  ${colorize('2', 'cyan', 'bold')} = Set → Saved Messages (me)`);
                console.log(`  ${colorize('3', 'cyan', 'bold')} = Set → Storage Channel`);
                console.log(`  ${colorize('4', 'cyan', 'bold')} = Pick from list 📋`);
                console.log(`  ${colorize('D', 'cyan', 'bold')} = Toggle Delete after forward`);
                console.log('─'.repeat(50));
                console.log(colorize('[Esc/Enter] Back to list', 'dim'));

            } else {
                // FILTERS MENU
                console.log(colorize(`⚙️  FILTERS: ${item.name}`, 'cyan', 'bold'));
                console.log(colorize('Toggle Allowed Media Types', 'yellow'));
                console.log('─'.repeat(40));

                const filters = [
                    { key: 'photos', label: '📷 Photos' },
                    { key: 'videos', label: '🎬 Videos' },
                    { key: 'files', label: '📁 Files' },
                    { key: 'links', label: '🔗 Links' },
                    { key: 'voice', label: '🎤 Voice' },
                    { key: 'gifs', label: '🎞️ GIFs' },
                    { key: 'stickers', label: '😊 Stickers' }
                ];

                filters.forEach((f, i) => {
                    const isSelected = i === cursor;
                    const isEnabled = item.filters[f.key] !== false;
                    const cursorChar = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
                    const checkChar = isEnabled ? colorize('[✓]', 'green') : colorize('[ ]', 'dim');
                    const label = isSelected ? colorize(f.label, 'white', 'bold') : f.label;
                    console.log(`${cursorChar} ${checkChar} ${label}`);
                });

                console.log('─'.repeat(40));
                console.log(colorize('ENTER to Done', 'dim'));
            }
            return;
        }

        // Render Group List
        console.log(colorize('⚙️  CONFIGURE MONITOR GROUPS', 'cyan', 'bold'));
        console.log(colorize('↑/↓: move  SPACE: toggle  F: ➡️Forward  →: Filters  Enter: Save', 'yellow'));
        console.log(colorize('Shortcuts: [A] Select All  [U] Unselect All', 'cyan'));
        console.log('─'.repeat(60));

        const start = Math.floor(cursor / pageSize) * pageSize;
        const end = Math.min(start + pageSize, groups.length);

        for (let i = start; i < end; i++) {
            const item = selection[i];
            const isSelected = i === cursor;

            const cursorChar = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
            const checkChar = item.enabled ? colorize('[✓]', 'green') : colorize('[ ]', 'dim');
            const name = isSelected ? colorize(item.name.slice(0, 30), 'white', 'bold') : item.name.slice(0, 30);

            let tags = '';
            if (item.enabled) {
                // Filters check
                const f = item.filters;
                const active = [];
                if (f.photos !== false) active.push('📷');
                if (f.videos !== false) active.push('🎬');

                // Auto Forward check
                if (item.autoForward?.enabled) active.push(colorize('➡️ FWD', 'green'));

                tags = colorize(`  ${active.join(' ')}`, 'dim');
            }

            console.log(`${cursorChar} ${checkChar} ${item.type} ${name.padEnd(30)}${tags}`);
        }

        console.log('─'.repeat(60));
        console.log(colorize(`Page ${Math.floor(cursor/pageSize) + 1}/${Math.ceil(groups.length/pageSize)}`, 'dim'));
        console.log(colorize(`Selected: ${selection.filter(s => s.enabled).length} groups`, 'cyan'));
    };

    // Main loop
    await new Promise(resolve => {
        const onKeypress = async (str, key) => {
            if (!key) return;

            // === AUTO FORWARD MENU HANDLING ===
            if (editingFiltersFor !== null && editingFiltersFor.mode === 'fwd') {
                const item = selection[editingFiltersFor.index];
                // Ensure struct exists
                if (!item.autoForward) item.autoForward = { enabled: false, destination: null, deleteAfterForward: false };

                // Quick Actions - No navigation needed, just press key!
                if (key.name === 'escape' || key.name === 'return' || key.name === 'left') {
                    // Back to list
                    editingFiltersFor = null;
                    cursor = 0;
                } else if (str === '1') {
                    // Toggle ON/OFF
                    item.autoForward.enabled = !item.autoForward.enabled;
                } else if (str === '2') {
                    // Set → Saved Messages
                    item.autoForward.destination = 'me';
                    item.autoForward.enabled = true; // Auto-enable
                } else if (str === '3') {
                    // Set → Storage Channel
                    item.autoForward.destination = null;
                    item.autoForward.enabled = true; // Auto-enable
                } else if (str === '4') {
                    // Pick from list - เหมือน Web!
                    cleanup();
                    console.log();
                    console.log(colorize('📋 Select Destination:', 'cyan', 'bold'));
                    console.log(colorize('Loading dialogs...', 'dim'));

                    try {
                        // Get dialogs
                        const allDialogs = await client.getDialogs({ limit: 50 });
                        const dialogs = allDialogs.filter(d => d.isGroup || d.isChannel || d.isUser);

                        if (dialogs.length === 0) {
                            console.log(colorize('No dialogs found!', 'red'));
                        } else {
                            console.log();
                            dialogs.forEach((d, i) => {
                                const icon = d.isChannel ? '📢' : d.isGroup ? '👥' : '👤';
                                const name = (d.title || d.name || 'Unknown').slice(0, 35);
                                console.log(`  ${colorize(String(i + 1).padStart(2), 'cyan')}. ${icon} ${name}`);
                            });
                            console.log();
                            console.log(colorize('  0. Cancel', 'dim'));
                            console.log();

                            const choice = await question(colorize('Enter number: ', 'yellow'));
                            const num = parseInt(choice);

                            if (num > 0 && num <= dialogs.length) {
                                const selected = dialogs[num - 1];
                                item.autoForward.destination = String(selected.id);
                                item.autoForward.enabled = true;
                                console.log(colorize(`✓ Selected: ${selected.title || selected.name}`, 'green'));
                            }
                        }
                    } catch (err) {
                        console.log(colorize(`Error: ${err.message}`, 'red'));
                    }

                    await new Promise(r => setTimeout(r, 800));
                    resume();
                } else if (key.name === 'd' || str === 'd' || str === 'D') {
                    // Toggle Delete
                    item.autoForward.deleteAfterForward = !item.autoForward.deleteAfterForward;
                }
                render();
                return;
            }

            // ... Existing Filter Menu Logic ...
            if (editingFiltersFor !== null && editingFiltersFor.mode === 'filters') {
                // Filter Menu Handling
                const filterKeys = ['photos', 'videos', 'files', 'links', 'voice', 'gifs', 'stickers'];
                if (key.name === 'up') {
                    cursor = Math.max(0, cursor - 1);
                } else if (key.name === 'down') {
                    cursor = Math.min(filterKeys.length - 1, cursor + 1);
                } else if (key.name === 'space') {
                    const fKey = filterKeys[cursor];
                    const item = selection[editingFiltersFor.index];
                    item.filters[fKey] = !item.filters[fKey];
                } else if (key.name === 'return' || key.name === 'left' || key.name === 'escape') {
                    editingFiltersFor = null;
                    cursor = 0;
                }
                render();
                return;
            }

            // Main Menu Handling
            if (key.name === 'up') {
                cursor = Math.max(0, cursor - 1);
            } else if (key.name === 'down') {
                cursor = Math.min(groups.length - 1, cursor + 1);
            } else if (key.name === 'space') {
                selection[cursor].enabled = !selection[cursor].enabled;
            } else if (key.name === 'right') {
                // Edit Filters
                editingFiltersFor = { index: cursor, mode: 'filters' };
                cursor = 0;
            } else if (key.name === 'f') {
                // Edit Auto Forward
                editingFiltersFor = { index: cursor, mode: 'fwd' };
                cursor = 0;
            } else if (key.name === 'a') {
                selection.forEach(s => s.enabled = true);
            } else if (key.name === 'u' || key.name === 'n') {
                selection.forEach(s => s.enabled = false);
            } else if (key.name === 'return') {
                process.stdin.removeListener('keypress', onKeypress);
                if (process.stdin.isTTY) process.stdin.setRawMode(false);
                resolve();
                return;
            }

            if (key.ctrl && key.name === 'c') {
                process.exit(0);
            }
            render();
        };

        const cleanup = () => {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
        };

        const resume = () => {
            process.stdin.resume();
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            render();
        };

        process.stdin.on('keypress', onKeypress);
        render();
    });

    // Update config
    let toggledCount = 0;
    for (const item of selection) {
        const configIndex = config.groups.findIndex(g => String(g.id) === String(item.id));

        if (configIndex >= 0) {
            // Update existing
            config.groups[configIndex].enabled = item.enabled;
            config.groups[configIndex].filters = item.filters;
            // Update Auto Forward
            if (item.autoForward) {
                config.groups[configIndex].autoForward = item.autoForward;
            }
            toggledCount++;
        } else if (item.enabled) {
            // Add new enabled group
            config.groups.push({
                id: item.id,
                name: item.name,
                enabled: true,
                filters: item.filters,
                autoForward: item.autoForward, // Save Auto Forward
                trackUsers: { enabled: false, users: [] },
                topics: { enabled: false, ids: [] }
            });
            toggledCount++;
        }
    }

    saveConfig(config);

    console.log();
    console.log(colorize(`✅ Config saved!`, 'green', 'bold'));
    console.log(colorize(`Total monitoring: ${selection.filter(s => s.enabled).length} groups`, 'cyan'));
    console.log();

    // Resume normal input for confirmation
    const startNow = await question(colorize('Start monitor now? (y/n): ', 'yellow'));
    if (startNow.toLowerCase() === 'y') {
        console.log();
        await startMonitor(accountManager, config);
    }
}

async function startMonitor(accountManager, config) {
    const client = accountManager.getDefaultClient();
    client.setLogLevel('none');
    clearScreen();
    console.log(colorize('╔════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║    📡 REAL-TIME MONITOR                ║', 'cyan', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'cyan'));
    console.log();

    const { DownloadManager } = await import('./core/downloader.js');
    const { RealtimeMonitor } = await import('./core/monitor.js');
    const { RateLimiter } = await import('./core/security.js');
    const { AutoForwarder } = await import('./core/forwarder.js');

    // Migrate old folder names
    await migrateFolders(config.download?.path);

    const rateLimiter = new RateLimiter(config.rateLimits);
    const downloader = new DownloadManager(client, config, rateLimiter);
    const forwarder = new AutoForwarder(client, config, accountManager);
    const monitor = new RealtimeMonitor(client, downloader, config, path.join(__dirname, '../data/config.json'), accountManager);

    // --- Event Listeners ---
    rateLimiter.on('wait', (seconds) => {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(colorize(`⏳ Rate limit: waiting ${seconds}s...`, 'yellow'));
    });

    rateLimiter.on('flood', (seconds) => {
        console.log(colorize(`🛑 FloodWait: pausing ${seconds}s...`, 'red'));
    });

    downloader.on('start', (job) => {
        console.log(colorize(`⬇️  Downloading: `, 'blue') + `${job.mediaType} [${job.message.id}]`);
    });

    downloader.on('complete', (job) => {
        console.log(colorize(`✅ Saved: `, 'green') + path.basename(job.filePath));
    });

    // Auto-Forward after download completes
    downloader.on('download_complete', async (info) => {
        try {
            await forwarder.process(info);
        } catch (e) {
            console.log(colorize(`⚠️ Forward error: ${e.message}`, 'yellow'));
        }
    });

    downloader.on('error', ({ job, error }) => {
        console.log(colorize(`❌ Error: `, 'red') + error);
    });

    // Sync forwarder config when monitor reloads config from disk
    monitor.on('configReloaded', (newConfig) => {
        forwarder.config = newConfig;
    });

    downloader.on('scale', ({ direction, workers, queue, reason }) => {
        if (direction === 'up') {
            console.log(colorize(`⚡ Scale UP: ${workers} workers (queue: ${queue})`, 'cyan'));
        } else {
            console.log(colorize(`🔽 Scale DOWN: ${workers} workers${reason ? ` (${reason})` : ''}`, 'yellow'));
        }
    });

    monitor.on('started', ({ groupCount, groups }) => {
        console.log(colorize(`📡 Monitoring ${groupCount} groups:`, 'green'));
        groups.forEach(g => console.log(colorize(`   • ${g}`, 'dim')));
        console.log();
        console.log(colorize('Press Ctrl+C to stop', 'dim'));
    });

    monitor.on('download', ({ group, type, messageId }) => {
        console.log(colorize(`📥 [${group}] `, 'magenta') + `${type} #${messageId}`);
    });

    monitor.on('urls', ({ group, count }) => {
        console.log(colorize(`🔗 [${group}] `, 'blue') + `${count} URL(s) saved`);
    });

    monitor.on('error', ({ error }) => {
        console.log(colorize(`⚠️ ${error}`, 'yellow'));
    });

    // Start
    await monitor.start();

    // Keep alive until Ctrl+C
    await new Promise((resolve) => {
        const shutdown = async () => {
            console.log();
            console.log(colorize('🛑 Stopping monitor...', 'yellow'));
            await monitor.stop();
            const s = monitor.stats;
            console.log();
            console.log(colorize('═══════════════════════════════════════', 'green'));
            console.log(colorize('   📊 MONITOR SESSION STATS', 'green', 'bold'));
            console.log(colorize('═══════════════════════════════════════', 'green'));
            console.log(`   Messages seen: ${s.messages}`);
            console.log(`   Media found:   ${s.media}`);
            console.log(`   Downloaded:    ${s.downloaded}`);
            console.log(`   Skipped:       ${s.skipped}`);
            console.log(`   URLs saved:    ${s.urls}`);
            console.log(colorize('═══════════════════════════════════════', 'green'));
            resolve();
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    });
}

async function startHistory(accountManager, config, connManager) {
    const startTime = Date.now();
    clearScreen();
    console.log(colorize('╔════════════════════════════════════════╗', 'magenta'));
    console.log(colorize('║    📚 HISTORY DOWNLOAD                 ║', 'magenta', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'magenta'));
    console.log();

    // --- Account Picker (Arrow-key navigation) ---
    let client;
    const accounts = accountManager.getList();
    if (accounts.length > 1) {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);

        let accCursor = 0;
        client = await new Promise(resolve => {
            const renderAccounts = () => {
                clearScreen();
                console.log(colorize('� HISTORY DOWNLOADER', 'cyan', 'bold'));
                console.log(colorize('�👤 Select account to use', 'yellow'));
                console.log(colorize('Use ↑/↓ to move, ENTER to select', 'dim'));
                console.log('─'.repeat(50));
                accounts.forEach((acc, i) => {
                    const isSelected = i === accCursor;
                    const cursorChar = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
                    const name = acc.name || acc.id;
                    const user = acc.username ? colorize(` @${acc.username}`, 'dim') : '';
                    const def = (i === 0) ? colorize(' ⭐', 'yellow') : '';
                    const label = isSelected ? colorize(name, 'white', 'bold') : name;
                    console.log(`${cursorChar} ${label}${user}${def}`);
                });
                console.log('─'.repeat(50));
            };

            const onKey = (str, key) => {
                if (key.name === 'up') accCursor = Math.max(0, accCursor - 1);
                else if (key.name === 'down') accCursor = Math.min(accounts.length - 1, accCursor + 1);
                else if (key.name === 'return') {
                    process.stdin.removeListener('keypress', onKey);
                    if (process.stdin.isTTY) process.stdin.setRawMode(false);
                    resolve(accountManager.getClient(accounts[accCursor].id));
                    return;
                } else if (key.ctrl && key.name === 'c') {
                    process.exit(0);
                }
                renderAccounts();
            };

            process.stdin.on('keypress', onKey);
            renderAccounts();
        });
    } else {
        client = accountManager.getDefaultClient();
    }
    client.setLogLevel('none');

    // Import dynamically
    const { DownloadManager } = await import('./core/downloader.js');
    const { HistoryDownloader } = await import('./core/history.js');
    const { RateLimiter } = await import('./core/security.js');
    const { AutoForwarder } = await import('./core/forwarder.js');

    // Migrate old folder names (space → underscore) before downloading
    await migrateFolders(config.download?.path);

    // Get dialogs using selected client
    console.log(colorize('Fetching dialogs...', 'dim'));
    const dialogs = await client.getDialogs({ limit: 100 });
    const groups = dialogs.filter(d => d.isGroup || d.isChannel);

    if (groups.length === 0) {
        console.log(colorize('❌ No groups found for this account!', 'red'));
        return;
    }

    // Select group
    console.log();
    console.log(colorize('Select a group to download history:', 'yellow'));
    console.log('─'.repeat(60));

    let cursor = 0;
    const pageSize = 15;

    // Enable raw mode
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    let selectedGroup = null;

    const render = () => {
        clearScreen();
        console.log(colorize('📚 HISTORY DOWNLOADER', 'cyan', 'bold'));
        console.log(colorize('Use ↑/↓ to move, ENTER to select', 'yellow'));
        console.log('─'.repeat(60));

        const start = Math.floor(cursor / pageSize) * pageSize;
        const end = Math.min(start + pageSize, groups.length);

        for (let i = start; i < end; i++) {
            const group = groups[i];
            const isSelected = i === cursor;

            const cursorChar = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
            const type = group.isGroup ? '👥' : '📢';
            const name = isSelected ? colorize((group.title || group.name).slice(0, 40), 'white', 'bold') : (group.title || group.name).slice(0, 40);

            console.log(`${cursorChar} ${type} ${name}`);
        }

        console.log('─'.repeat(60));
        console.log(colorize(`Page ${Math.floor(cursor/pageSize) + 1}/${Math.ceil(groups.length/pageSize)}`, 'dim'));
    };

    await new Promise(resolve => {
        const onKeypress = (str, key) => {
            if (key.name === 'up') {
                cursor = Math.max(0, cursor - 1);
            } else if (key.name === 'down') {
                cursor = Math.min(groups.length - 1, cursor + 1);
            } else if (key.name === 'return') {
                selectedGroup = groups[cursor];
                process.stdin.removeListener('keypress', onKeypress);
                if (process.stdin.isTTY) process.stdin.setRawMode(false);
                resolve();
                return;
            } else if (key.ctrl && key.name === 'c') {
                process.exit(0);
            }
            render();
        };

        process.stdin.on('keypress', onKeypress);
        render();
    });

    if (!selectedGroup) return;

    // Select Filters (New Feature)
    console.log();
    console.log(colorize('⚙️  SELECT FILE TYPES TO DOWNLOAD', 'cyan', 'bold'));
    console.log(colorize('Space to toggle, Enter to confirm', 'dim'));

    // Default filters
    const filters = {
        photos: true,
        videos: true,
        files: true,
        links: true,
        voice: false,
        gifs: false
    };

    const filterKeys = [
        { key: 'photos', label: '📷 Photos' },
        { key: 'videos', label: '🎬 Videos' },
        { key: 'files', label: '📁 Files' },
        { key: 'links', label: '🔗 Links' },
        { key: 'voice', label: '🎤 Voice' },
        { key: 'gifs', label: '🎞️ GIFs' }
    ];
    let fCursor = 0;

    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    await new Promise(resolve => {
        const renderFilters = () => {
             clearScreen();
             console.log(colorize(`Selected: ${selectedGroup.title || selectedGroup.name}`, 'green', 'bold'));
             console.log('─'.repeat(40));
             console.log(colorize('⚙️  SELECT FILE TYPES', 'cyan', 'bold'));
             console.log('─'.repeat(40));

             filterKeys.forEach((item, i) => {
                 const isSelected = i === fCursor;
                 const isEnabled = filters[item.key];
                 const cursorChar = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
                 const checkChar = isEnabled ? colorize('[✓]', 'green') : colorize('[ ]', 'dim');
                 const label = isSelected ? colorize(item.label, 'white', 'bold') : item.label;
                 console.log(`${cursorChar} ${checkChar} ${label}`);
             });

             console.log('─'.repeat(40));
             console.log(colorize('ENTER to Continue', 'yellow'));
        };

        const onKey = (str, key) => {
            if (key.name === 'up') {
                fCursor = Math.max(0, fCursor - 1);
            } else if (key.name === 'down') {
                fCursor = Math.min(filterKeys.length - 1, fCursor + 1);
            } else if (key.name === 'space') {
                const k = filterKeys[fCursor].key;
                filters[k] = !filters[k];
            } else if (key.name === 'return') {
                process.stdin.removeListener('keypress', onKey);
                if (process.stdin.isTTY) process.stdin.setRawMode(false);
                resolve();
                return;
            } else if (key.ctrl && key.name === 'c') {
                process.exit(0);
            }
            renderFilters();
        };

        process.stdin.on('keypress', onKey);
        renderFilters();
    });

    // History Options Menu
    clearScreen();
    console.log(colorize(`Selected: ${selectedGroup.title || selectedGroup.name}`, 'green', 'bold'));
    console.log(colorize('Active Filters: ', 'dim') + Object.keys(filters).filter(k => filters[k]).join(', '));
    console.log('─'.repeat(40));
    console.log(colorize('1. Last 100 Messages', 'cyan'));
    console.log(colorize('2. Last 1,000 Messages', 'cyan'));
    console.log(colorize('3. Download ALL History (Warning: Slow)', 'red'));
    console.log(colorize('4. Custom Date Range', 'yellow'));
    console.log('─'.repeat(40));

    const choiceStr = await question(colorize('Select option (1-4): ', 'yellow'));
    const choice = choiceStr.trim();

    let limit = 100;
    let offsetId = 0;
    let offsetDate = 0;

    // Setup Downloader (Early init for scanning)
    const rateLimiter = new RateLimiter(config.rateLimits);
    const downloader = new DownloadManager(client, config, rateLimiter);
    await downloader.init();

    const history = new HistoryDownloader(client, downloader, config, accountManager);

    if (choice === '2') limit = 1000;
    else if (choice === '3') limit = Number.MAX_SAFE_INTEGER;
    else if (choice === '4') {
        const dateStr = await question(colorize('Start from date (YYYY-MM-DD): ', 'cyan'));
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            console.log(colorize('Invalid date!', 'red'));
            return;
        }
        offsetDate = Math.floor(date.getTime() / 1000);
        limit = Number.MAX_SAFE_INTEGER;
    }

    // --- Media Scan Phase ---
    console.log();
    console.log(colorize('🔍 Scanning group for media counts...', 'cyan'));
    const counts = await history.scan(selectedGroup.id, limit);

    // --- Filter Selection Phase ---
    const historyFilters = {
        photos: counts.photos > 0,
        videos: counts.videos > 0,
        files: counts.files > 0,
        links: counts.links > 0,
        voice: counts.voice > 0,
        gifs: counts.gifs > 0
    };

    const historyFilterKeys = [
        { key: 'photos', label: '📷 Photos', count: counts.photos },
        { key: 'videos', label: '🎬 Videos', count: counts.videos },
        { key: 'files', label: '📁 Files', count: counts.files },
        { key: 'links', label: '🔗 Links', count: counts.links },
        { key: 'voice', label: '🎤 Voice', count: counts.voice },
        { key: 'gifs', label: '🎞️ GIFs', count: counts.gifs }
    ];

    let filterCursor = 0;

    // Manual selection UI
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
    }

    await new Promise(resolve => {
        const renderFilters = () => {
            clearScreen();
            console.log(colorize('🛠️  SELECT MEDIA TO DOWNLOAD', 'cyan', 'bold'));
            console.log(colorize(`Target: ${selectedGroup.title || selectedGroup.name}`, 'white'));
            console.log(colorize('Use SPACE to toggle, ENTER to start download', 'yellow'));
            console.log('─'.repeat(50));

            historyFilterKeys.forEach((item, i) => {
                const isSelected = i === filterCursor;
                const isEnabled = historyFilters[item.key];

                const cursorChar = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
                const checkChar = isEnabled ? colorize('[✓]', 'green') : colorize('[ ]', 'dim');
                const label = isSelected ? colorize(item.label, 'white', 'bold') : item.label;

                // Show count
                const countStr = item.count > 0 ? colorize(` (${item.count})`, 'white') : colorize(' (0)', 'dim');

                console.log(`${cursorChar} ${checkChar} ${label}${countStr}`);
            });
            console.log('─'.repeat(50));

            const totalSelected = historyFilterKeys.reduce((acc, k) => acc + (historyFilters[k.key] ? k.count : 0), 0);
            console.log(colorize(`Total selected: ~${totalSelected} items`, 'cyan'));
        };

        const onKey = (str, key) => {
            if (key.name === 'up') {
                filterCursor = Math.max(0, filterCursor - 1);
            } else if (key.name === 'down') {
                filterCursor = Math.min(historyFilterKeys.length - 1, filterCursor + 1);
            } else if (key.name === 'space') {
                const k = historyFilterKeys[filterCursor].key;
                historyFilters[k] = !historyFilters[k];
            } else if (key.name === 'return') {
                cleanup();
                resolve();
            } else if (key.ctrl && key.name === 'c') {
                cleanup();
                process.exit(0);
            }
            renderFilters();
        };

        const cleanup = () => {
            process.stdin.removeListener('keypress', onKey);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
        };

        process.stdin.on('keypress', onKey);
        renderFilters();
    });

    console.log();

    // Override config filters temporarily for this session
    // We create a temporary config object just for this history run
    config.groups = config.groups.map(g => {
        if (String(g.id) === String(selectedGroup.id)) {
            return { ...g, filters: historyFilters };
        }
        return g;
    });

    // Ensure current selected group has these filters even if it wasn't in config
    const existingIdx = config.groups.findIndex(g => String(g.id) === String(selectedGroup.id));
    if (existingIdx === -1) {
         config.groups.push({
            id: selectedGroup.id,
            name: selectedGroup.title || selectedGroup.name,
            enabled: true,
            filters: historyFilters
        });
    } else {
        config.groups[existingIdx].filters = historyFilters;
    }

    // Pass options based on choice
    const options = {};
    if (limit) options.limit = limit;
    if (offsetDate) options.offsetDate = offsetDate;

    // --- UI State ---
    let successCount = 0;
    let errorCount = 0;

    // --- Event Listeners ---

    rateLimiter.on('wait', (seconds) => {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(colorize(`⏳ Rate limit: waiting ${seconds}s...`, 'yellow'));
    });

    rateLimiter.on('flood', (seconds) => {
        console.log(colorize(`🛑 FloodWait: pausing ${seconds}s...`, 'red'));
    });

    downloader.on('start', (job) => {
        console.log(colorize(`⬇️  Downloading: `, 'blue') + `${job.mediaType} [${job.message.id}]`);
    });

    downloader.on('complete', (job) => {
        successCount++;
        console.log(colorize(`✅ Saved: `, 'green') + path.basename(job.filePath));
    });

    downloader.on('error', ({ job, error }) => {
        errorCount++;
        console.log(colorize(`❌ Error: `, 'red') + error);
    });

    downloader.on('skipped', ({ job, reason }) => {
        console.log(colorize(`⏭️ Skipped: `, 'dim') + `[${job.message.id}] ${reason}`);
    });

    downloader.on('scale', ({ direction, workers, queue, reason }) => {
        if (direction === 'up') {
            console.log(colorize(`⚡ Scale UP: ${workers} workers (queue: ${queue})`, 'cyan'));
        } else {
            console.log(colorize(`🔽 Scale DOWN: ${workers} workers${reason ? ` (${reason})` : ''}`, 'yellow'));
        }
    });

    history.on('progress', (stats) => {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(colorize(`📊 Progress: ${stats.processed} processed | ${stats.downloaded} queued | ${stats.skipped} skipped`, 'cyan'));
    });

    history.on('log', (msg) => {
        console.log(colorize(`\n${msg}`, 'yellow'));
    });

    // Start download
    console.log();
    console.log(colorize('╔════════════════════════════════════════╗', 'magenta'));
    console.log(colorize('║    📚 DOWNLOADING HISTORY...            ║', 'magenta', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'magenta'));
    console.log(colorize(`Target: ${selectedGroup.title || selectedGroup.name}`, 'white'));
    console.log(colorize(`Filters: ${Object.keys(historyFilters).filter(k => historyFilters[k]).join(', ')}`, 'dim'));
    console.log(colorize('Press Ctrl+C to stop', 'dim'));
    console.log('─'.repeat(50));
    console.log();

    try {
        await history.downloadHistory(selectedGroup.id, options);
    } catch (error) {
        console.log(colorize(`\n❌ History error: ${error.message}`, 'red'));
    }

    // Wait for remaining downloads to finish
    console.log();
    console.log(colorize('⏳ Waiting for remaining downloads to finish...', 'yellow'));
    while (downloader.pendingCount > 0 || downloader.active.size > 0) {
        await new Promise(r => setTimeout(r, 1000));
    }
    await downloader.stop();

    // Final Stats
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const historyStats = history.stats;
    console.log();
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log(colorize('   📊 HISTORY DOWNLOAD COMPLETE', 'green', 'bold'));
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log(`   Messages scanned: ${historyStats.processed}`);
    console.log(`   Downloaded:       ${successCount}`);
    console.log(`   Skipped:          ${historyStats.skipped}`);
    console.log(`   Errors:           ${errorCount}`);
    console.log(`   URLs saved:       ${historyStats.urls}`);
    console.log(`   Time elapsed:     ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    console.log(colorize('═══════════════════════════════════════', 'green'));
}

function showMenu() {
    const port = process.env.PORT || 3000;
    console.log();
    console.log(colorize('Telegram Downloader — most things are easier in the dashboard', 'cyan', 'bold'));
    console.log(colorize(`  npm start                       → open dashboard at http://localhost:${port}`, 'green'));
    console.log();
    console.log(colorize('Power-user CLI subcommands (when you really want a terminal):', 'dim'));
    console.log(colorize('  monitor    history    dialogs    accounts    config    settings    viewer    auth    purge    doctor', 'white'));
    console.log();
    console.log(colorize('Examples:', 'dim'));
    console.log('  ' + colorize('node src/index.js monitor', 'white') + '   headless real-time monitor (servers)');
    console.log('  ' + colorize('node src/index.js history', 'white') + '   bulk-backfill an existing group');
    console.log('  ' + colorize('node src/index.js auth', 'white') + '      reset the dashboard password');
    console.log('  ' + colorize('node src/index.js doctor', 'white') + '    diagnose Node/DB/port/ffmpeg issues');
    console.log();
}

// ============ Manage Accounts ============
async function manageAccounts(accountManager, config) {
    while (true) {
        
        let headerStr = colorize('╭──────────────────────────────────────────────╮\n', 'cyan') +
                        colorize('│', 'cyan') + colorize('            👥 MANAGE TELEGRAM ACCOUNTS          ', 'white', 'bold') + colorize('│\n', 'cyan') +
                        colorize('╰──────────────────────────────────────────────╯\n\n', 'cyan');

        // Display current accounts
        const accounts = accountManager.getList();
        if (accounts.length === 0) {
            headerStr += colorize('   No accounts configured.\n', 'yellow');
        } else {
            headerStr += colorize(`   📱 ${accounts.length} Account(s):\n`, 'dim');
            accounts.forEach((acc, i) => {
                headerStr += colorize(`   ${i + 1}. `, 'white') + colorize(acc.id, 'cyan', 'bold') + colorize(` — ${acc.name} @${acc.username || 'N/A'}\n`, 'dim');
            });
        }
        headerStr += '\n' + colorize('─'.repeat(48), 'dim') + '\n';

        const choice = await selectOption('SELECT ACTION', [
            { label: '➕ Add Account', value: 'add', desc: 'Login with a new phone number' },
            { label: '❌ Remove Account', value: 'remove', desc: 'Delete a saved account' },
            { label: '⬅️ Back to Main Menu', value: 'back' }
        ], headerStr);

        if (choice === 'add') {
            await accountManager.addAccount(question);
            await new Promise(r => setTimeout(r, 1500));
        } else if (choice === 'remove') {
            if (accounts.length === 0) {
                console.log(colorize('\nNo accounts to remove.', 'yellow'));
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            if (accounts.length === 1) {
                console.log(colorize('\n⚠️  Cannot remove the last account!', 'red'));
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const removeChoice = await selectOption('SELECT ACCOUNT TO REMOVE', 
                accounts.map(acc => ({ 
                    label: `${acc.id} (${acc.name})`, 
                    value: acc.id, 
                    desc: `@${acc.username || 'N/A'}` 
                })).concat([{ label: '⬅️ Cancel', value: 'cancel' }])
            );

            if (removeChoice !== 'cancel') {
                const confirm = await question(colorize(`\n⚠️  Permanently remove "${removeChoice}"? (y/N): `, 'yellow'));
                if (confirm.trim().toLowerCase() === 'y') {
                    accountManager.removeAccount(removeChoice);
                    // Also clean up any group assignments referencing this account
                    for (const group of config.groups || []) {
                        if (group.monitorAccount === removeChoice) delete group.monitorAccount;
                        if (group.forwardAccount === removeChoice) delete group.forwardAccount;
                    }
                    saveConfig(config);
                    console.log(colorize(`\n✅ Account "${removeChoice}" removed.`, 'green'));
                } else {
                    console.log(colorize('\nCancelled.', 'dim'));
                }
                await new Promise(r => setTimeout(r, 1000));
            }
        } else {
            break;
        }
    }
}

// ============ Purge Data ============
async function purgeData(client, config) {
    const DOWNLOADS_DIR = path.join(__dirname, '../data/downloads');
    const PHOTOS_DIR = path.join(__dirname, '../data/photos');

    while (true) {
        // Build options from configured groups + download folders
        const groupOptions = (config.groups || []).map(g => ({
            label: `${g.enabled ? '✅' : '⏸'} ${(g.name || 'Unknown').slice(0, 30)}`,
            value: g.id,
            desc: `ID: ${g.id}`
        }));

        const mainOptions = [
            ...groupOptions,
            { label: '─────────────────────', value: 'sep', desc: '' },
            { label: '🗑️ DELETE ALL DATA', value: 'purge-all', desc: 'Factory reset' },
            { label: '⬅️ Back', value: '0', desc: 'Exit' }
        ];

        const choice = await selectOption('    🗑️  PURGE DATA', mainOptions);

        if (choice === '0' || choice === 'sep') break;

        if (choice === 'purge-all') {
            // Purge ALL
            console.log();
            const confirm = await question(colorize('\n⚠️  Delete ALL data? Type YES to confirm: ', 'red', 'bold'));
            if (confirm.trim() !== 'YES') {
                console.log(colorize('Cancelled.', 'dim'));
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            console.log(colorize('\nDeleting all data...', 'yellow'));

            // 1. Delete all download folders
            let totalFiles = 0;
            if (fs.existsSync(DOWNLOADS_DIR)) {
                const dirs = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
                for (const dir of dirs) {
                    if (dir.isDirectory()) {
                        const dirPath = path.join(DOWNLOADS_DIR, dir.name);
                        totalFiles += fs.readdirSync(dirPath, { recursive: true }).length;
                        fs.rmSync(dirPath, { recursive: true, force: true });
                    }
                }
            }

            // 2. Delete all DB records
            const dbResult = deleteAllDownloads();

            // 3. Clear groups from config
            config.groups = [];
            saveConfig(config);

            // 4. Delete all profile photos
            if (fs.existsSync(PHOTOS_DIR)) {
                const photos = fs.readdirSync(PHOTOS_DIR);
                for (const photo of photos) {
                    fs.unlinkSync(path.join(PHOTOS_DIR, photo));
                }
            }

            console.log(colorize(`\n✅ Purged ALL: ${totalFiles} files, ${dbResult.deletedDownloads} DB records`, 'green', 'bold'));
            await new Promise(r => setTimeout(r, 2000));
            break;

        } else {
            // Purge specific group
            const groupId = choice;
            const configGroup = (config.groups || []).find(g => String(g.id) === String(groupId));
            const groupName = configGroup?.name || `Group ${groupId}`;

            console.log();
            const confirm = await question(colorize(`\n⚠️  Delete all data for "${groupName}"? (y/N): `, 'yellow'));
            if (confirm.trim().toLowerCase() !== 'y') {
                console.log(colorize('Cancelled.', 'dim'));
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            console.log(colorize(`\nDeleting ${groupName}...`, 'yellow'));

            // 1. Delete folder
            const folderName = sanitizeName(groupName);
            const folderPath = path.join(DOWNLOADS_DIR, folderName);
            let filesDeleted = 0;
            if (fs.existsSync(folderPath)) {
                filesDeleted = fs.readdirSync(folderPath, { recursive: true }).length;
                fs.rmSync(folderPath, { recursive: true, force: true });
            }

            // 2. Delete DB records
            const dbResult = deleteGroupDownloads(groupId);

            // 3. Remove from config
            config.groups = (config.groups || []).filter(g => String(g.id) !== String(groupId));
            saveConfig(config);

            // 4. Delete profile photo
            const photoPath = path.join(PHOTOS_DIR, `${groupId}.jpg`);
            if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);

            console.log(colorize(`\n✅ Purged "${groupName}": ${filesDeleted} files, ${dbResult.deletedDownloads} DB records`, 'green', 'bold'));
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// Restore the terminal to a sane state on any kind of exit. The interactive
// menus enable raw mode while waiting for arrow-key input; if something throws
// before the explicit `setRawMode(false)` runs, the user is left with a dead
// shell. This catch-all guarantees recovery on SIGINT / SIGTERM / normal exit.
function restoreTerminal() {
    try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch { /* nothing to restore */ }
    try { process.stdout.write('\x1b[?25h'); } catch {} // cursor on
}

process.on('exit', restoreTerminal);
process.on('SIGINT', () => {
    restoreTerminal();
    console.log(colorize('\n🛑 Shutting down...', 'yellow'));
    process.exit(0);
});
process.on('SIGTERM', () => {
    restoreTerminal();
    process.exit(0);
});

async function setupWebAuth(config) {
    // Premium Header
    let headerStr = colorize('╭──────────────────────────────────────────────╮\n', 'cyan') +
                    colorize('│', 'cyan') + colorize('             🔐 WEB DASHBOARD SECURITY          ', 'white', 'bold') + colorize('│\n', 'cyan') +
                    colorize('╰──────────────────────────────────────────────╯\n\n', 'cyan');
    
    // Status Display
    const currentEnabled = config.web?.enabled !== false; // Default true if not set
    const hasPassword = !!(config.web?.passwordHash || config.web?.password);

    const statusText = currentEnabled
        ? colorize('🟢 ENABLED ', 'green', 'bold')
        : colorize('🔴 DISABLED', 'red', 'bold');

    const passText = hasPassword
        ? colorize('******** (scrypt-hashed)', 'green')
        : colorize('Not Set', 'yellow');

    headerStr += colorize('   System Status:  ', 'dim') + statusText + '\n';
    headerStr += colorize('   Web Password:   ', 'dim') + passText + '\n\n';
    headerStr += colorize('─'.repeat(48), 'dim') + '\n';

    const choice = await selectOption('SELECT ACTION', [
        { label: 'Set / Change Password', value: 'password', desc: 'Update your dashboard login' },
        { label: currentEnabled ? 'Disable Security' : 'Enable Security', value: 'toggle', desc: currentEnabled ? 'Open access to everyone' : 'Require password to view' },
        { label: '⬅️ Back to Main Menu', value: 'back' }
    ], headerStr);

    if (!config.web) config.web = {};

    if (choice === 'toggle') {
        config.web.enabled = !currentEnabled;
        if (config.web.enabled) {
            console.log(colorize('\n✅ Security has been ENABLED. A password is now required.', 'green'));
            if (!hasPassword) {
                console.log(colorize('⚠️  WARNING: No password is set! Please set one below.', 'yellow'));
                await new Promise(r => setTimeout(r, 1500));
                return setupWebAuth(config);
            }
        } else {
            console.log(colorize('\n⚠️  Security has been DISABLED. Dashboard is open to anyone.', 'yellow'));
        }
    } else if (choice === 'password') {
        console.log();
        console.log(colorize('🔑 Enter new password for the Web Dashboard', 'cyan'));
        console.log(colorize('   (Leave blank to cancel)', 'dim'));
        const pass = await question(colorize('\n> ', 'white', 'bold'));
        if (pass.trim()) {
            // Store as a scrypt hash. The web server compares with timingSafeEqual.
            config.web.passwordHash = hashPassword(pass.trim());
            delete config.web.password; // drop any legacy plaintext
            config.web.enabled = true;
            console.log(colorize('\n✅ Password updated successfully! Security is ENABLED.', 'green'));
        } else {
            console.log(colorize('\n❌ Cancelled. Password was not changed.', 'red'));
        }
    } else {
        // Exit back to main menu or shell
        return;
    }

    saveConfig(config);
    await new Promise(r => setTimeout(r, 1500));
    // Loop back to show updated status
    await setupWebAuth(config); 
}

// Run
main().catch(error => {
    console.error(colorize(`Fatal error: ${error.message}`, 'red'));
    console.error(error.stack);
    process.exit(1);
});
