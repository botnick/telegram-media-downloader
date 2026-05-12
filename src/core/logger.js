import fs from 'fs';
import path from 'path';
import { getDataDir } from './paths.js';

const LOG_DIR = path.join(getDataDir(), 'logs');

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

        _rotateIfNeeded(logFile);
        fs.appendFileSync(logFile, logLine);
    }

    static error(error, context = '') {
        const timestamp = new Date().toISOString();
        const logFile = path.join(LOG_DIR, 'errors.log');

        const logLine = `[${timestamp}] ERROR ${context}: ${error.message}\nStack: ${error.stack}\n${'-'.repeat(50)}\n`;
        _rotateIfNeeded(logFile);
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
// TGDL_DEBUG / DEBUG is set). Anything else is logged normally.

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

// network.log rotation — keep the file complete (every line preserved)
// but cap each file at MAX_BYTES so a long-running container can't fill
// the disk. When the size threshold is crossed, rename to .1 (keeping
// one previous generation) and start fresh. Two files × MAX_BYTES is
// the worst-case footprint.
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file → 10 MB total

function _rotateIfNeeded(file) {
    try {
        const st = fs.statSync(file);
        if (st.size > LOG_MAX_BYTES) {
            try {
                fs.renameSync(file, file + '.1');
            } catch {}
        }
    } catch {
        /* file doesn't exist yet */
    }
}

function isNoise(msg) {
    if (!msg) return false;
    const text = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
    for (const re of NOISE_PATTERNS) if (re.test(text)) return true;
    return false;
}

const debugMode = !!(process.env.TGDL_DEBUG || process.env.DEBUG);

// Canonical detector for "an optional native dep failed to load." Lives
// here so the CLI entrypoint, the web server's process traps, and the
// doctor-mode classifier all agree on the same pattern — drift between
// copies has previously caused an alpine-on-glibc reinstall to hide one
// branch's warning while another still threw.
//
// Hits in practice come from `onnxruntime-node` (transitively pulled by
// `@huggingface/transformers`, the optional NSFW classifier) when its
// glibc-only prebuilds run on musl Alpine, and from `better-sqlite3` when
// the on-disk prebuild was compiled against a different Node ABI than
// the running interpreter.
export const NATIVE_LOAD_FAIL =
    /(ld-linux|ld-musl|libonnxruntime|GLIBC_|NODE_MODULE_VERSION|cannot open shared object|Error loading shared library)/i;

/**
 * Returns true if the caller should suppress the message from stderr.
 * Always logs to data/logs/network.log so the message is preserved.
 *
 * Use as a guard around console.error / console.log:
 *   if (suppressNoise(msg, label)) return;
 */
export function suppressNoise(msg, label = 'gramjs') {
    if (!isNoise(msg)) return false;
    const text = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
    try {
        const ts = new Date().toISOString();
        const file = path.join(LOG_DIR, 'network.log');
        _rotateIfNeeded(file);
        fs.appendFileSync(file, `[${ts}] [${label}] ${text}\n`);
    } catch {
        /* never let logging crash the app */
    }
    // In debug mode, still surface the message so a developer can see reconnect activity.
    return !debugMode;
}

/**
 * Wrap a console method so noisy messages are demoted to debug-only.
 * Used by AccountManager's per-client logger and the global guard in
 * src/index.js. The underlying method is preserved (and called for non-noise
 * messages) so genuine errors still reach stderr / stdout.
 *
 * Optional `tee` callback fires for every non-suppressed line BEFORE the
 * underlying console method runs, so the dashboard's `/maintenance/logs`
 * page can capture every backend write — not just lines that explicitly
 * call the structured `log()`. The tee receives `(args, joined)`; throws
 * inside it are swallowed so a buggy hook can never break console output.
 */
export function wrapConsoleMethod(originalFn, label = 'gramjs', tee = null) {
    return function wrapped(...args) {
        const joined = args
            .map((a) =>
                a instanceof Error
                    ? a.stack || a.message
                    : typeof a === 'object'
                      ? safeStringify(a)
                      : String(a),
            )
            .join(' ');
        if (suppressNoise(joined, label)) return;
        if (tee) {
            try {
                tee(args, joined);
            } catch {
                /* never break the underlying console method */
            }
        }
        return originalFn.apply(console, args);
    };
}

function safeStringify(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}
