
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '../../data/logs');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

export class DebugLogger {
    static log(filename, message, data = null) {
        const timestamp = new Date().toISOString();
        const logFile = path.join(LOG_DIR, filename);

        let logLine = `[${timestamp}] ${message}`;
        if (data) {
            try {
                logLine += `\nData: ${JSON.stringify(data, null, 2)}`;
            } catch (e) {
                logLine += `\nData: [Circular/Unserializable]`;
            }
        }
        logLine += `\n${'-'.repeat(50)}\n`;

        fs.appendFileSync(logFile, logLine);
    }

    static error(error, context = '') {
        const timestamp = new Date().toISOString();
        const logFile = path.join(LOG_DIR, 'errors.log');

        const logLine = `[${timestamp}] ERROR ${context}: ${error.message}\nStack: ${error.stack}\n${'-'.repeat(50)}\n`;
        fs.appendFileSync(logFile, logLine);
    }
}

// ---- noise classifier -----------------------------------------------------
//
// gramJS is chatty during reconnects: it logs "Not connected", "TIMEOUT",
// "Connection closed", "Closing current connection", "Reconnect", and
// "CHANNEL_INVALID" through normal channels even when nothing is wrong. The
// previous codebase silently dropped these by stringly matching them in a
// global console.error override — which also suppressed real problems with
// the same words in their messages.
//
// Instead, we classify: "noisy" messages still go through, but at the debug
// level (always written to data/logs/network.log, only echoed to stderr when
// CLAUDE_DEBUG / TGDL_DEBUG / DEBUG is set). Anything else is logged normally.

const NOISE_PATTERNS = [
    /\bNot connected\b/,
    /\bTIMEOUT\b/,
    /\bConnection closed\b/,
    /\bClosing current connection\b/,
    /\bReconnect\b/i,
    /\bdisconnect/i,
    /\bWebSocket connection failed\b/,
    /\bCHANNEL_INVALID\b/,
    /\bDisconnecting\b/,
    /\bRunning gramJS\b/,
];

function isNoise(msg) {
    if (!msg) return false;
    const text = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
    for (const re of NOISE_PATTERNS) if (re.test(text)) return true;
    return false;
}

const debugMode = !!(process.env.CLAUDE_DEBUG || process.env.TGDL_DEBUG || process.env.DEBUG);

/**
 * Returns true if the caller should suppress the message from stderr.
 * Always logs to data/logs/network.log so the message is preserved.
 *
 * Use as a guard around console.error / console.log:
 *   if (suppressNoise(msg, label)) return;
 */
export function suppressNoise(msg, label = 'gramjs') {
    if (!isNoise(msg)) return false;
    try {
        const ts = new Date().toISOString();
        const text = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
        fs.appendFileSync(path.join(LOG_DIR, 'network.log'), `[${ts}] [${label}] ${text}\n`);
    } catch { /* never let logging crash the app */ }
    // In debug mode, still surface the message so a developer can see reconnect activity.
    return !debugMode;
}

/**
 * Wrap a console method so noisy messages are demoted to debug-only.
 * Used by AccountManager's per-client logger and the global guard in
 * src/index.js. The underlying method is preserved (and called for non-noise
 * messages) so genuine errors still reach stderr / stdout.
 */
export function wrapConsoleMethod(originalFn, label = 'gramjs') {
    return function wrapped(...args) {
        const joined = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
        if (suppressNoise(joined, label)) return;
        return originalFn.apply(console, args);
    };
}
