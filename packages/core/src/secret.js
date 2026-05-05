import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const SECRET_PATH = path.join(DATA_DIR, 'secret.key');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

export function getOrGenerateSecret() {
    ensureDataDir();
    
    if (fs.existsSync(SECRET_PATH)) {
        try {
            const secret = fs.readFileSync(SECRET_PATH, 'utf8').trim();
            if (secret.length > 0) return secret;
        } catch (e) {
            console.error('Error reading secret file:', e);
        }
    }

    // Generate new secret
    const newSecret = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(SECRET_PATH, newSecret, { mode: 0o600 }); // Restrict permissions
        console.log('🔐 New security secret generated and saved.');
    } catch (e) {
        console.error('Error writing secret file:', e);
    }
    
    return newSecret;
}
