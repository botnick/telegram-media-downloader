// Seeds a data directory for the front-server parity suite
// (tests/front-parity.e2e.test.js, scripts/front-parity.js).
//
//   node tests/helpers/front-parity-seed.js <dataDir>
//
// Runs in its own process because src/core/db.js reads TGDL_DATA_DIR once,
// at import time. Everything is deterministic — file bytes, mtimes, session
// tokens, the share secret — so the frozen Node responses in
// tests/fixtures/front-parity.json can be compared byte for byte (bodies)
// and value for value (headers) against a fresh run.

import fs from 'fs';
import path from 'path';

import {
    PARITY_FILES,
    PARITY_MTIME_MS,
    PARITY_PASSWORD,
    PARITY_ROWS,
    PARITY_SESSIONS,
    PARITY_SHARE_SECRET,
    PARITY_THUMB_BYTES,
    thumbCacheName,
} from './front-parity.js';

const dataDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
    console.error('usage: node tests/helpers/front-parity-seed.js <dataDir>');
    process.exit(2);
}
process.env.TGDL_DATA_DIR = dataDir;
delete process.env.TGDL_DOWNLOADS_DIR;

const mtime = new Date(PARITY_MTIME_MS);
const put = (abs, bytes) => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    fs.utimesSync(abs, mtime, mtime);
};

const dl = path.join(dataDir, 'downloads');
for (const f of PARITY_FILES) put(path.join(dataDir, f.dir, ...f.rel.split('/')), f.bytes());
put(path.join(dataDir, 'thumbs', thumbCacheName(1)), PARITY_THUMB_BYTES);
fs.mkdirSync(dl, { recursive: true });

const db = await import('../../src/core/db.js');
const { loadConfig, saveConfig } = await import('../../src/config/manager.js');
const { hashPassword } = await import('../../src/core/web-auth.js');

for (const r of PARITY_ROWS) {
    db.insertDownload({
        groupId: r.groupId,
        groupName: `G${r.groupId}`,
        messageId: r.id,
        fileName: path.basename(r.filePath),
        fileSize: r.size,
        fileType: r.fileType,
        filePath: r.filePath,
    });
}
const got = db
    .getDb()
    .prepare('SELECT id, file_path FROM downloads ORDER BY id')
    .all()
    .map((r) => `${r.id}:${r.file_path}`);
const want = PARITY_ROWS.map((r) => `${r.id}:${r.filePath}`);
if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`unexpected download ids: ${JSON.stringify(got)}`);
}

const now = Date.now();
const day = 24 * 60 * 60 * 1000;
for (const s of PARITY_SESSIONS) {
    const issuedAt = now - s.ageDays * day;
    db.insertSession({
        token: s.token,
        role: s.role,
        issuedAt,
        expiresAt: issuedAt + s.ttlDays * day,
    });
}

const cfg = loadConfig();
cfg.web = {
    ...(cfg.web || {}),
    enabled: true,
    passwordHash: hashPassword(PARITY_PASSWORD),
    guestPasswordHash: hashPassword(`${PARITY_PASSWORD}-guest`),
    guestEnabled: true,
    shareSecret: PARITY_SHARE_SECRET,
};
saveConfig(cfg);
db.getDb().close();
process.stdout.write(`${JSON.stringify({ ok: true, dataDir })}\n`);
