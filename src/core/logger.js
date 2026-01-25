
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
