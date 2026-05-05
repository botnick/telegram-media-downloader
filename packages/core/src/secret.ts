import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { DATA_DIR } from "./data-dir.js";

const SECRET_PATH = path.join(DATA_DIR, "secret.key");

function ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

export function getOrGenerateSecret(): string {
    ensureDataDir();

    if (fs.existsSync(SECRET_PATH)) {
        try {
            const secret = fs.readFileSync(SECRET_PATH, "utf8").trim();
            if (secret.length > 0) return secret;
        } catch (e) {
            console.error("Error reading secret file:", e);
        }
    }

    // Generate new secret. 32 bytes hex = 256 bits of entropy, plenty
    // for AES-GCM IV derivation in core/security.
    const newSecret = crypto.randomBytes(32).toString("hex");
    try {
        fs.writeFileSync(SECRET_PATH, newSecret, { mode: 0o600 });
        console.log("🔐 New security secret generated and saved.");
    } catch (e) {
        console.error("Error writing secret file:", e);
    }

    return newSecret;
}
