import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../data/config.json');

const DEFAULT_CONFIG = {
    telegram: {
        apiId: '',
        apiHash: ''
    },
    groups: [],
    download: {
        path: './data/downloads',
        concurrent: 3,
        retries: 5,
        maxSpeed: 0 // 0 = unlimited
    },
    rateLimits: {
        requestsPerMinute: 15,
        delayMs: { min: 500, max: 2000 }
    },
    diskManagement: {
        maxTotalSize: '50GB',
        autoCleanup: false
    }
};

export function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            const dir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4));
            return DEFAULT_CONFIG;
        }
        
        const data = fs.readFileSync(CONFIG_PATH, 'utf8');
        const userConfig = JSON.parse(data);
        
        // Deep Merge to ensure new defaults are present in old configs
        return {
            ...DEFAULT_CONFIG,
            ...userConfig,
            telegram: { ...DEFAULT_CONFIG.telegram, ...userConfig.telegram },
            download: { ...DEFAULT_CONFIG.download, ...userConfig.download },
            rateLimits: { ...DEFAULT_CONFIG.rateLimits, ...userConfig.rateLimits },
            diskManagement: { ...DEFAULT_CONFIG.diskManagement, ...userConfig.diskManagement },
            // Groups are array, keep user's array
            groups: userConfig.groups || []
        };
    } catch (error) {
        console.error('Config error:', error.message);
        return DEFAULT_CONFIG;
    }
}

export function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
}

export function addGroup(config, group) {
    const existingIndex = config.groups.findIndex(g => g.id === group.id);
    if (existingIndex >= 0) {
        config.groups[existingIndex] = group;
    } else {
        config.groups.push(group);
    }
    saveConfig(config);
    return config;
}

export function watchConfig(callback) {
    let fsWait = false;
    fs.watch(CONFIG_PATH, (event, filename) => {
        if (filename && event === 'change') {
            if (fsWait) return;
            fsWait = setTimeout(() => {
                fsWait = false;
                console.log('\x1b[36m%s\x1b[0m', '🔄 Config change detected. Reloading...');
                const newConfig = loadConfig();
                callback(newConfig);
            }, 100); // 100ms Debounce
        }
    });
}
