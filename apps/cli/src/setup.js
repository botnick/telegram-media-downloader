
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '../');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const EXAMPLE_FILE = path.join(ROOT_DIR, 'config.example.json');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise(resolve => rl.question(query, resolve));

async function setup() {
    console.log('\x1b[36m%s\x1b[0m', '╔════════════════════════════════════════╗');
    console.log('\x1b[36m%s\x1b[0m', '║      Telegram Downloader Setup 🛠️      ║');
    console.log('\x1b[36m%s\x1b[0m', '╚════════════════════════════════════════╝');
    console.log();

    // 1. Ensure Data Dir
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // 2. Load Config Template
    let config = {};
    if (fs.existsSync(CONFIG_FILE)) {
        console.log('\x1b[33m%s\x1b[0m', '⚠️  Existing config found.');
        const ans = await question('   Overwrite? (y/N): ');
        if (ans.toLowerCase() !== 'y') {
            console.log('Skipping setup.');
            process.exit(0);
        }
    }
    
    // Load example
    if (fs.existsSync(EXAMPLE_FILE)) {
        config = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
    } else {
        // Fallback default
        config = {
            telegram: { apiId: "", apiHash: "", phoneNumber: "" },
            download: { path: "./data/downloads", concurrent: 3 },
            groups: []
        };
    }

    console.log('Please enter your Telegram credentials.');
    console.log('(Get them from https://my.telegram.org)\n');

    // 3. Ask Inputs
    while (!config.telegram.apiId) {
        config.telegram.apiId = await question('\x1b[32m? API ID: \x1b[0m');
    }
    while (!config.telegram.apiHash) {
        config.telegram.apiHash = await question('\x1b[32m? API Hash: \x1b[0m');
    }
    
    const phone = await question('\x1b[32m? Phone Number (e.g. +66...): \x1b[0m');
    if (phone) config.telegram.phoneNumber = phone;

    // 4. Save
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    
    console.log();
    console.log('\x1b[32m%s\x1b[0m', '✅ Setup Complete!');
    console.log('   Config saved to data/config.json');
    console.log();
    console.log('👉 Run \x1b[36mnpm start\x1b[0m to login and start using.');
    
    rl.close();
}

setup();
