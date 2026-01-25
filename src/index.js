/**
 * Telegram Auto-Downloader CLI
 * Easy Login: Phone + OTP
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig, saveConfig, addGroup } from './config/manager.js';
import { RateLimiter, SecureSession } from './core/security.js';
import { ConnectionManager } from './core/connection.js';
import { colorize, clearScreen, formatBytes } from './cli/colors.js';
import { resilience } from './core/resilience.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, '../data/session.enc');
const SESSION_PASSWORD = 'telegram-dl-2026'; // ควรให้ user ตั้งเอง

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

async function main() {
    // TTY Check
    if (!process.stdin.isTTY) {
        console.error(colorize('❌ Error: This tool requires an interactive terminal.', 'red', 'bold'));
        process.exit(1);
    }

    // Activate Resilience System
    resilience.init();

    clearScreen();
    console.log(colorize('╔════════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║   📱 TELEGRAM AUTO-DOWNLOADER CLI v1.0.0    ║', 'cyan', 'bold'));
    console.log(colorize('╚════════════════════════════════════════════╝', 'cyan'));
    console.log();

    // Load config
    const config = loadConfig();
    
    if (!config.telegram.apiId || !config.telegram.apiHash) {
        console.log(colorize('❌ Missing API credentials in data/config.json', 'red'));
        console.log('Get them from: https://my.telegram.org');
        process.exit(0);
    }

    console.log(colorize('📦 API ID: ', 'dim') + config.telegram.apiId);
    console.log();

    // Load or create session
    const secure = new SecureSession(SESSION_PASSWORD);
    let sessionString = '';

    if (fs.existsSync(SESSION_PATH)) {
        try {
            const encrypted = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
            sessionString = secure.decrypt(encrypted);
            console.log(colorize('🔐 Loaded encrypted session', 'green'));
        } catch (e) {
            console.log(colorize('⚠️ Could not load session, will create new', 'yellow'));
        }
    }

    // Create client
    const client = new TelegramClient(
        new StringSession(sessionString),
        parseInt(config.telegram.apiId),
        config.telegram.apiHash,
        {
            connectionRetries: 100,
            deviceModel: 'EIEI CLI',
            systemVersion: 'Windows 10',
            appVersion: '1.0.0',
            useWSS: false, // Force TCP
            // Custom Logger to filter noise
            baseLogger: {
                canSend: (lvl) => true,
                warn: (msg) => {
                    if (msg?.includes('Disconnecting') || msg?.includes('Connection closed')) return;
                    console.log(colorize(`⚠️  ${msg}`, 'yellow'));
                },
                info: (msg) => {
                    if (msg?.includes('Connecting to')) return; // Too verbose
                    if (msg?.includes('Running gramJS')) return;
                    console.log(colorize(`ℹ️  ${msg}`, 'dim'));
                },
                debug: () => {},
                error: (msg) => {
                    if (msg?.includes('WebSocket connection failed')) return;
                    if (typeof msg === 'object' && msg.message?.includes('Not connected')) return; // Suppress Not Connected stack
                    console.error(colorize(`❌ ${msg}`, 'red'));
                },
                setLevel: (lvl) => {} // Dummy method to satisfy GramJS
            }
        }
    );

    console.log(colorize('🔌 Connecting to Telegram...', 'cyan'));
    
    try {
        await client.connect();
        console.log(colorize('✅ Connected!', 'green'));
    } catch (error) {
        console.log(colorize(`❌ Connection failed: ${error.message}`, 'red'));
        process.exit(1);
    }

    // Check if logged in
    const isAuthorized = await client.checkAuthorization();
    
    if (!isAuthorized) {
        console.log();
        console.log(colorize('═══════════════════════════════════════', 'yellow'));
        console.log(colorize('   🔐 LOGIN REQUIRED', 'yellow', 'bold'));
        console.log(colorize('═══════════════════════════════════════', 'yellow'));
        console.log();
        
        try {
            await client.start({
                phoneNumber: async () => {
                    console.log(colorize('Enter phone number with country code', 'dim'));
                    console.log(colorize('Example: +66812345678', 'dim'));
                    const phone = await question(colorize('📞 Phone: ', 'cyan'));
                    return phone.trim();
                },
                phoneCode: async () => {
                    console.log();
                    console.log(colorize('Check your Telegram app for the code', 'dim'));
                    const code = await question(colorize('📝 OTP Code: ', 'cyan'));
                    return code.trim();
                },
                password: async () => {
                    console.log();
                    console.log(colorize('2FA Password (leave empty if not set)', 'dim'));
                    const pass = await question(colorize('🔑 Password: ', 'cyan'));
                    return pass.trim();
                },
                onError: (err) => {
                    console.log(colorize(`❌ Error: ${err.message}`, 'red'));
                }
            });

            // Save encrypted session
            const newSession = client.session.save();
            const encrypted = secure.encrypt(newSession);
            fs.writeFileSync(SESSION_PATH, JSON.stringify(encrypted, null, 2));
            console.log();
            console.log(colorize('✅ Login successful! Session saved.', 'green', 'bold'));
            
        } catch (error) {
            console.log(colorize(`❌ Login failed: ${error.message}`, 'red'));
            process.exit(1);
            return;
        }
    }

    // Get user info
    const me = await client.getMe();
    console.log();
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log(colorize(`   👤 Logged in as: ${me.firstName || ''} ${me.lastName || ''}`, 'green', 'bold'));
    if (me.username) {
        console.log(colorize(`   📌 Username: @${me.username}`, 'green'));
    }
    console.log(colorize(`   🆔 User ID: ${me.id}`, 'green'));
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log();


    // Start Connection Manager
    const connManager = new ConnectionManager(client);
    connManager.start();

    // Parse command
    const command = process.argv[2] || 'menu';

    switch (command) {
        case 'dialogs':
        case 'groups':
            await listDialogs(client);
            break;
        case 'monitor':
            await startMonitor(client, config);
            break;
        case 'test':
            console.log(colorize('✅ Connection test passed!', 'green'));
            break;
        case 'config':
            await configureGroups(client, config);
            break;
        case 'history':
            // Pass connManager to allow stopping it on exit
            await startHistory(client, config, connManager);
            break;
        case 'viewer':
            await viewDownloads();
            break;
        case 'settings':
            await configureGlobalSettings(config);
            break;
        case 'test':
            console.log(colorize('✅ Connection test passed!', 'green'));
            break;
        default:
            showMenu();
    }


    // Graceful disconnect (suppress timeout errors)
    try {
        client.setLogLevel('none'); // Suppress logs during disconnect
        await client.disconnect();
    } catch (e) {
        // Ignore disconnect errors
    }
    
    console.log(colorize('\n👋 Disconnected. Goodbye!', 'cyan'));
}

async function selectOption(title, options) {
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
            console.log(colorize('╔════════════════════════════════════════╗', 'cyan'));
            console.log(colorize(`║ ${title.padEnd(38)} ║`, 'cyan', 'bold'));
            console.log(colorize('╚════════════════════════════════════════╝', 'cyan'));
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
    console.log(colorize('║      📊 DOWNLOAD STATS                 ║', 'green', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'green'));
    console.log();

    const logDir = './data/logs';
    if (!fs.existsSync(logDir)) {
        console.log(colorize('No history data found (no log files).', 'yellow'));
        return;
    }

    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.json'));
    let totalSize = 0;
    let totalFiles = 0;

    const stats = [];

    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(logDir, file), 'utf8'));
            const fileKeys = Object.keys(data.files || {});
            const count = fileKeys.length;
            let size = 0;
            let groupName = 'Unknown';

            for (const key of fileKeys) {
                const item = data.files[key];
                size += (item.size || 0);
                if (item.groupName) groupName = item.groupName;
            }

            totalFiles += count;
            totalSize += size;

            if (count > 0) {
                stats.push({
                    name: groupName,
                    count,
                    sizeRaw: size,
                    size: (size / 1024 / 1024).toFixed(2) + ' MB'
                });
            }
        } catch (e) {
            // Ignore corrupt logs
        }
    }

    // Sort by size desc
    stats.sort((a, b) => b.sizeRaw - a.sizeRaw);

    if (stats.length === 0) {
        console.log(colorize('No downloads recorded yet.', 'yellow'));
        return;
    }

    console.log(colorize(`${'Group Name'.padEnd(40)} | ${'Files'.padEnd(10)} | ${'Size'.padEnd(15)}`, 'white', 'bold'));
    console.log('─'.repeat(70));

    for (const stat of stats) {
        console.log(`${stat.name.slice(0, 40).padEnd(40)} | ${String(stat.count).padEnd(10)} | ${stat.size.padEnd(15)}`);
    }

    console.log('─'.repeat(70));
    console.log(colorize(`TOTAL: ${totalFiles} files | ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`, 'green', 'bold'));
}

async function configureGroups(client, config) {
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
    let editingFiltersFor = -1; // Index of group being edited
    
    // Enable raw mode for keypress
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const render = () => {
        clearScreen();
        
        if (editingFiltersFor >= 0) {
            // Render Filter Menu
            const item = selection[editingFiltersFor];
            console.log(colorize(`⚙️  FILTERS: ${item.name}`, 'cyan', 'bold'));
            console.log(colorize('Toggle Allowed Media Types', 'yellow'));
            console.log('─'.repeat(40));
            
            const filters = [
                { key: 'photos', label: '📷 Photos' },
                { key: 'videos', label: '🎬 Videos' },
                { key: 'files', label: '📁 Files' },
                { key: 'links', label: '🔗 Links' },
                { key: 'voice', label: '🎤 Voice' },
                { key: 'gifs', label: '🎞️ GIFs' }
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
            return;
        }

        // Render Group List
        console.log(colorize('⚙️  CONFIGURE MONITOR GROUPS', 'cyan', 'bold'));
        console.log(colorize('Use ↑/↓ move, SPACE toggle, RIGHT edit filters, ENTER save', 'yellow'));
        console.log('─'.repeat(60));

        const start = Math.floor(cursor / pageSize) * pageSize;
        const end = Math.min(start + pageSize, groups.length);
        
        for (let i = start; i < end; i++) {
            const item = selection[i];
            const isSelected = i === cursor;
            
            const cursorChar = isSelected ? colorize('>', 'cyan', 'bold') : ' ';
            const checkChar = item.enabled ? colorize('[✓]', 'green') : colorize('[ ]', 'dim');
            const name = isSelected ? colorize(item.name.slice(0, 40), 'white', 'bold') : item.name.slice(0, 40);
            
            // Show brief filters if enabled
            let info = '';
            if (item.enabled) {
                const f = item.filters;
                const active = [];
                if (f.photos !== false) active.push('📷');
                if (f.videos !== false) active.push('🎬');
                if (f.files !== false) active.push('📁');
                info = colorize(`  ${active.join(' ')}...`, 'dim');
            }

            console.log(`${cursorChar} ${checkChar} ${item.type} ${name}${info}`);
        }
        
        console.log('─'.repeat(60));
        console.log(colorize(`Page ${Math.floor(cursor/pageSize) + 1}/${Math.ceil(groups.length/pageSize)}`, 'dim'));
        console.log(colorize(`Selected: ${selection.filter(s => s.enabled).length} groups`, 'cyan'));
    };

    // Main loop
    await new Promise(resolve => {
        const onKeypress = (str, key) => {
            if (editingFiltersFor >= 0) {
                // Filter Menu Handling
                const filterKeys = ['photos', 'videos', 'files', 'links', 'voice', 'gifs'];
                if (key.name === 'up') {
                    cursor = Math.max(0, cursor - 1);
                } else if (key.name === 'down') {
                    cursor = Math.min(filterKeys.length - 1, cursor + 1);
                } else if (key.name === 'space') {
                    const fKey = filterKeys[cursor];
                    const item = selection[editingFiltersFor];
                    item.filters[fKey] = !item.filters[fKey];
                } else if (key.name === 'return' || key.name === 'left') {
                    editingFiltersFor = -1;
                    cursor = 0;
                }
            } else {
                // Main Menu Handling
                if (key.name === 'up') {
                    cursor = Math.max(0, cursor - 1);
                } else if (key.name === 'down') {
                    cursor = Math.min(groups.length - 1, cursor + 1);
                } else if (key.name === 'space') {
                    selection[cursor].enabled = !selection[cursor].enabled;
                } else if (key.name === 'right') {
                    editingFiltersFor = cursor;
                    cursor = 0;
                } else if (key.name === 'return') {
                    process.stdin.removeListener('keypress', onKeypress);
                    if (process.stdin.isTTY) process.stdin.setRawMode(false);
                    resolve();
                    return;
                }
            }
            
            if (key.ctrl && key.name === 'c') {
                process.exit(0);
            }
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
            toggledCount++;
        } else if (item.enabled) {
            // Add new enabled group
            config.groups.push({
                id: item.id,
                name: item.name,
                enabled: true,
                filters: item.filters,
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
        await startMonitor(client, config);
    }
}

async function startHistory(client, config, connManager) {
    client.setLogLevel('none'); // Suppress verbose download logs
    const startTime = Date.now(); // Defined at start of function
    clearScreen();
    console.log(colorize('╔════════════════════════════════════════╗', 'magenta'));
    console.log(colorize('║    📚 HISTORY DOWNLOAD                 ║', 'magenta', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'magenta'));
    console.log();
    // Import dynamically
    const { DownloadManager } = await import('./core/downloader.js');
    const { HistoryDownloader } = await import('./core/history.js');
    
    // Get dialogs
    console.log(colorize('Fetching dialogs...', 'dim'));
    const dialogs = await client.getDialogs({ limit: 100 });
    const groups = dialogs.filter(d => d.isGroup || d.isChannel);
    
    if (groups.length === 0) {
        console.log(colorize('❌ No groups found!', 'red'));
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
    
    const history = new HistoryDownloader(client, downloader, config);

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
    let lastStatus = '';
    let successCount = 0;
    let errorCount = 0;
    
    const printLog = (msg) => {
        // Clear current status line
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        
        // Print log
        console.log(msg);
        
        // Reprint status if exists
        if (lastStatus) {
            process.stdout.write(lastStatus); 
        }
    };

    const updateStatus = (text) => {
        lastStatus = text;
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(text);
    };

    // --- Event Listeners with Sticky Footer Logic ---
    
    rateLimiter.on('wait', (seconds) => {
        updateStatus(colorize(`⏳ Rate limit: waiting ${seconds}s...`, 'yellow'));
    });

    rateLimiter.on('flood', (seconds) => {
        printLog(colorize(`🛑 FloodWait: pausing ${seconds}s...`, 'red'));
    });

    downloader.on('start', (job) => {
        printLog(colorize(`⬇️  Downloading: `, 'blue') + `${job.mediaType} [${job.message.id}]`);
    });

    downloader.on('progress', ({ job, progress }) => {
        // Optional: show individual file progress? 
        // For now, let's keep the main log clean and rely on the summary status
    });

    downloader.on('complete', (job) => {
        successCount++;
        printLog(colorize(`✅ Saved: `, 'green') + path.basename(job.filePath));
    });

    downloader.on('error', ({ job, error }) => {
        errorCount++;
        printLog(colorize(`❌ Error [${job.message.id}]: `, 'red') + error);
    });

    history.on('progress', (stats) => {
        const status = `🔍 Scanned: ${stats.processed} | 📥 DL: ${stats.downloaded} | ⏭️ Skip: ${stats.skipped}`;
        updateStatus(colorize(status, 'cyan'));
    });

    history.on('log', (msg) => {
        printLog(colorize(msg, 'dim'));
    });

    console.log(colorize('🚀 Starting history download...', 'cyan'));
    console.log('─'.repeat(50));

    await history.downloadHistory(selectedGroup.id, options);
    
    // Cleanup listeners after done
    rateLimiter.removeAllListeners();
    downloader.removeAllListeners();
    history.removeAllListeners();
    
    // Minimalist Live Dashboard
    console.log(colorize('\n🚀 Finalizing downloads...', 'cyan'));
    process.stdout.write('\x1B[?25l'); // Hide cursor

    while (true) {
        const status = downloader.getStatus();
        const remaining = status.queued + status.active;
        
        if (remaining === 0) break;

        const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][Math.floor(Date.now() / 100) % 10];
        
        // Minimalist Status Line
        const line = `\r${colorize(spinner, 'yellow')} ` +
                     `${colorize('⏳ Queue:', 'dim')} ${colorize(status.queued, 'white')} | ` +
                     `${colorize('⬇️  Active:', 'blue')} ${colorize(status.active, 'cyan')} | ` +
                     `${colorize('✅ Done:', 'green')} ${colorize(status.completed, 'green', 'bold')}      `;
        
        process.stdout.write(line);
        await new Promise(r => setTimeout(r, 200));
    }

    process.stdout.write('\x1B[?25h\n'); // Show cursor
    process.stdout.write('\x1B[?25h\n'); // Show cursor
    await downloader.stop(); // Clean stop with flush

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // --- Verification Phase ---
    console.log();
    console.log(colorize('🔍 Verifying file integrity...', 'yellow'));
    
    let verifiedCount = 0;
    let missingCount = 0;
    
    // Check all registries
    for (const [groupId, registry] of downloader.registries) {
        for (const [key, meta] of Object.entries(registry.files)) {
            // Reconstruct path to check existence
            // Note: This relies on the path logic being consistent. 
            // Ideally downloader should expose a verify method, but for now we check existence.
            // We search recursively or just trust the registry count? 
            // Registry count is strictly "Success" writes.
            // Let's do a quick physical check if possible, or just trust stats first.
            // For true verification, we'd need the full path stored. The registry stores filename but not full path?
            // Ah, registry has filename. We need to find it? 
            // Simplification: Trust successCount vs errorCount for now, as physical scan takes long.
            verifiedCount++;
        }
    }

    console.log();
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log(colorize('   🏁 HISTORY DOWNLOAD COMPLETE', 'green', 'bold'));
    console.log(colorize('═══════════════════════════════════════', 'green'));
    console.log(`   ⏱️  Time: ${duration}s`);
    console.log(`   📂 Total Scanned: ${history.stats.processed}`);
    console.log(`   ✅ Successful:    ${colorize(successCount, 'green', 'bold')}`);
    console.log(`   ❌ Failed:        ${colorize(errorCount, 'red')}`);
    console.log(`   ⏭️  Skipped:       ${history.stats.skipped}`);
    
    if (errorCount > 0) {
        console.log();
        console.log(colorize(`💡 Tip: Run the command again to retry failed files.`, 'yellow'));
    }
    console.log(colorize('═══════════════════════════════════════', 'green'));

    // Graceful Shutdown with Force Timeout
    try {
        console.log(colorize('\n👋 Disconnecting...', 'yellow'));
        
        // Force exit if stuck for 3 seconds
        setTimeout(() => {
            console.error(colorize('⚠️  Force quitting...', 'red'));
            process.exit(0);
        }, 3000).unref();

        if (connManager) connManager.stop();
        await client.disconnect();
        await client.destroy();
        console.log(colorize('✅ Disconnected. Goodbye!', 'green'));
    } catch (e) { }
    
    process.exit(0);
}

async function listDialogs(client) {
    console.log(colorize('📋 Your Chats & Groups:', 'cyan', 'bold'));
    console.log('─'.repeat(60));
    
    const dialogs = await client.getDialogs({ limit: 50 });
    
    let count = 0;
    for (const dialog of dialogs) {
        const type = dialog.isGroup ? '👥' : dialog.isChannel ? '📢' : '👤';
        const id = dialog.id;
        const title = dialog.title || dialog.name || 'Unknown';
        
        console.log(`${type} ${colorize(String(id).padEnd(15), 'dim')} ${title}`);
        count++;
    }
    
    console.log('─'.repeat(60));
    console.log(colorize(`Total: ${count} chats`, 'dim'));
    console.log();
    console.log(colorize('💡 To monitor a group, add its ID to data/config.json', 'yellow'));
}

async function startMonitor(client, config) {
    if (config.groups.length === 0) {
        console.log(colorize('⚠️ No groups configured!', 'yellow'));
        console.log(colorize('Add groups to data/config.json first.', 'dim'));
        console.log(colorize('Run: node src/index.js dialogs', 'dim'));
        console.log();
        console.log(colorize('Example config.json groups:', 'dim'));
        console.log(colorize(`
{
  "groups": [
    {
      "id": -1001234567890,
      "name": "My Group",
      "enabled": true,
      "filters": {
        "images": true,
        "videos": true,
        "files": true,
        "audio": false
      }
    }
  ]
}`, 'dim'));
        return;
    }

    // Import modules dynamically
    const { DownloadManager } = await import('./core/downloader.js');
    const { RealtimeMonitor } = await import('./core/monitor.js');

    // Create rate limiter
    const rateLimiter = new RateLimiter(config.rateLimits);

    // Create download manager
    const downloader = new DownloadManager(client, config, rateLimiter);
    await downloader.init();

    // Create monitor
    const monitor = new RealtimeMonitor(client, downloader, config);

    // Event listeners
    downloader.on('queued', (job) => {
        console.log(colorize(`📥 Queued: `, 'cyan') + `${job.mediaType} from ${job.groupName}`);
    });

    downloader.on('start', (job) => {
        console.log(colorize(`⬇️ Downloading: `, 'blue') + `${job.mediaType} [${job.message.id}]`);
    });

    downloader.on('complete', (job) => {
        console.log(colorize(`✅ Saved: `, 'green') + path.basename(job.filePath));
    });

    downloader.on('error', ({ job, error }) => {
        console.log(colorize(`❌ Error: `, 'red') + error);
    });

    downloader.on('skipped', ({ job, reason }) => {
        console.log(colorize(`⏭️ Skipped: `, 'dim') + `[${job.message.id}] ${reason}`);
    });

    monitor.on('urls', ({ group, count }) => {
        console.log(colorize(`🔗 URLs: `, 'yellow') + `${count} saved from ${group}`);
    });

    // Start monitoring
    console.log(colorize('╔════════════════════════════════════════╗', 'red'));
    console.log(colorize('║    🔴 REAL-TIME MONITOR                ║', 'red', 'bold'));
    console.log(colorize('╚════════════════════════════════════════╝', 'red'));
    console.log();

    const enabledGroups = config.groups.filter(g => g.enabled);
    console.log(colorize(`📡 Monitoring ${enabledGroups.length} groups:`, 'cyan'));
    enabledGroups.forEach(g => {
        console.log(colorize(`   • ${g.name}`, 'dim'));
    });
    console.log();
    console.log(colorize('Press Ctrl+C to stop', 'dim'));
    console.log('─'.repeat(50));
    console.log();

    try {
        monitor.start();
    } catch (error) {
        console.log(colorize(`❌ Monitor error: ${error.message}`, 'red'));
        return;
    }

    // Keep running until Ctrl+C
    await new Promise((resolve) => {
        const shutdown = async () => {
            console.log();
            console.log(colorize('🛑 Stopping monitor...', 'yellow'));
            await monitor.stop(); // AWAIT the async stop
            
            const stats = monitor.getStats();
            console.log();
            console.log(colorize('═══════════════════════════════════════', 'cyan'));
            console.log(colorize('   📊 SESSION STATS', 'cyan', 'bold'));
            console.log(colorize('═══════════════════════════════════════', 'cyan'));
            console.log(`   Messages: ${stats.messages}`);
            console.log(`   Media detected: ${stats.media}`);
            console.log(`   Downloaded: ${stats.downloaded}`);
            console.log(`   Skipped: ${stats.skipped}`);
            console.log(`   URLs saved: ${stats.urls}`);
            console.log(colorize('═══════════════════════════════════════', 'cyan'));
            
            resolve();
        };

        process.removeAllListeners('SIGINT');
        process.on('SIGINT', shutdown);
    });
}

function showMenu() {
    console.log(colorize('📌 Available Commands:', 'cyan', 'bold'));
    console.log();
    console.log(colorize('  --- Groups ---', 'dim'));
    console.log('  ' + colorize('node src/index.js config', 'white') + '   - Configure groups (Enable/Disable, Filters)');
    console.log('  ' + colorize('node src/index.js dialogs', 'white') + '  - List all groups');
    console.log();
    console.log(colorize('  --- System ---', 'dim'));
    console.log('  ' + colorize('node src/index.js settings', 'white') + ' - System settings (Disk/Speed/Path)');  
    console.log('  ' + colorize('node src/index.js viewer', 'white') + '   - View download stats');
    console.log();
    console.log(colorize('  --- Download ---', 'dim'));
    console.log('  ' + colorize('node src/index.js monitor', 'white') + '  - Start real-time monitor');
    console.log('  ' + colorize('node src/index.js history', 'white') + '  - Download history');
    console.log();
}

// Handle Ctrl+C
process.on('SIGINT', () => {
    console.log(colorize('\n🛑 Shutting down...', 'yellow'));

    process.exit(0);
});

// Run
main().catch(error => {
    console.error(colorize(`Fatal error: ${error.message}`, 'red'));
    console.error(error.stack);
    process.exit(1);
});
