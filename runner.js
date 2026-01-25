/**
 * 🌍 Universal Watchdog Runner
 * Works on: Windows, macOS, Linux
 * 
 * Usage: node runner.js
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'data/logs/protection_log.txt');
const APP_SCRIPT = path.join(__dirname, 'src/index.js');
const APP_ARGS = ['history'];

// Configuration
const MAX_CRASHES = 10;
const RESET_WINDOW = 60000; // 1 minute
let crashCount = 0;
let lastCrashTime = 0;

console.log('\x1b[36m%s\x1b[0m', '🌍 Universal Auto-Downloader Watchdog');
console.log('\x1b[90m%s\x1b[0m', `   Target: node ${APP_SCRIPT} ${APP_ARGS.join(' ')}`);
console.log('========================================\n');

// Ensure log dir
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function logCrash(code) {
    const timestamp = new Date().toISOString();
    const msg = `[${timestamp}] Crashed with exit code ${code}\n`;
    fs.appendFileSync(LOG_FILE, msg);
    console.log('\x1b[31m%s\x1b[0m', `❌ ${msg.trim()}`);
    
    // Play sound (Cross-platform bell)
    process.stdout.write('\x07');
}

function startApp() {
    const startTime = Date.now();
    
    console.log('\x1b[32m%s\x1b[0m', `🚀 Launching Process (Attempt #${crashCount + 1})...`);
    
    const child = spawn('node', [APP_SCRIPT, ...APP_ARGS], {
        stdio: 'inherit', // Preserve colors and dashboard
        cwd: __dirname
    });

    child.on('close', (code) => {
        const runDuration = Date.now() - startTime;

        if (code === 0) {
            console.log('\x1b[32m%s\x1b[0m', '✅ Process finished successfully.');
            process.exit(0);
        }

        logCrash(code);

        // Intelligent Backoff
        if (runDuration > RESET_WINDOW) {
            crashCount = 0; // Reset if stable for > 1 min
        } else {
            crashCount++;
        }

        if (crashCount >= MAX_CRASHES) {
            console.log('\x1b[31m%s\x1b[0m', '⛔ Too many crashes. Stopping.');
            process.exit(1);
        }

        const delay = Math.min(30, 5 * (crashCount + 1));
        console.log('\x1b[33m%s\x1b[0m', `⏳ Restarting in ${delay} seconds...`);
        
        setTimeout(startApp, delay * 1000);
    });
}

startApp();
