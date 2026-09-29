// Deterministic data dir for the contract suite.
//
// Built straight into each target's temp TGDL_DATA_DIR (some rows store
// absolute paths, e.g. seekbar_sprites.sprite_path, so a copied dir would
// point at the wrong place). Uses better-sqlite3 + the frozen schema.sql —
// no app code — so the very same seed feeds the Node server today and the
// Go server later, and exercises "Go opens a DB Node created".
//
// Everything is fixed: ids (insertion order), timestamps (2024-… and
// ≥ 2099, outside the normaliser's clock window), password hashes (fixed
// scrypt salt), session tokens, share/cluster secrets, backup credential
// blobs (fixed IV), file bytes (committed media) and file mtimes.
//
// Small on purpose: 20 download rows, ~40 KB of media.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const FIXTURES = import.meta.dirname;
const MEDIA = path.join(FIXTURES, 'media');
const SCHEMA = path.join(FIXTURES, 'schema.sql');

// Every seeded file (downloads, photos, sprites) gets this mtime, so
// Last-Modified / static ETags of seeded files are stable.
export const FIXED_MTIME_MS = Date.UTC(2024, 0, 2, 3, 4, 5);

const T = (iso) => Date.parse(`${iso}Z`);
const FAR = Date.UTC(2100, 0, 1); // "never expires" in ms
const FAR_S = Math.floor(FAR / 1000);

export const SEED = {
    adminPassword: 'contract-admin-pass',
    guestPassword: 'contract-guest-pass',
    adminToken: 'a1'.repeat(32),
    guestToken: 'b2'.repeat(32),
    shareSecret: '5e'.repeat(32),
    clusterToken: 'c7'.repeat(32),
    selfPeerId: '00000000-0000-4000-8000-00000000c0de',
    selfPeerName: 'contract-node',
    peers: {
        alpha: {
            peerId: '00000000-0000-4000-8000-0000000000a1',
            name: 'peer-alpha',
            url: 'http://peer-alpha.invalid:3000',
            sharedSecret: '9a'.repeat(32),
        },
        beta: {
            peerId: '00000000-0000-4000-8000-0000000000b2',
            name: 'peer-beta',
            url: 'http://peer-beta.invalid:3000',
            sharedSecret: null, // legacy pairing (migrationRequired)
        },
    },
    groups: {
        alpha: { id: '-1001000000001', name: 'Alpha Photos' },
        beta: { id: '-1001000000002', name: 'Beta Videos' },
        gamma: { id: '-1001000000003', name: 'Gamma Docs' },
        delta: { id: '-1001000000004', name: 'Delta Mixed' },
        epsilon: { id: '-1001000000005', name: 'Epsilon Archive' }, // DB only, not in config
    },
};

const G = SEED.groups;

// [group, media file, relative path, type, created_at, extra columns]
// Row ids are 1..N in this order.
export const DOWNLOADS = [
    [
        G.alpha,
        'photo-a.jpg',
        'Alpha Photos/images/IMG_0001.jpg',
        'photo',
        '2024-01-10 10:00:00',
        { pinned: 1, nsfw_score: 0.05, nsfw_checked_at: T('2024-06-01T00:00:00') },
    ],
    [
        G.alpha,
        'photo-b.jpg',
        'Alpha Photos/images/IMG_0002.jpg',
        'photo',
        '2024-01-11 10:00:00',
        { nsfw_score: 0.45, nsfw_checked_at: T('2024-06-01T00:00:01') },
    ],
    [
        G.alpha,
        'photo-c.png',
        'Alpha Photos/images/IMG_0003.png',
        'photo',
        '2024-01-12 10:00:00',
        { nsfw_score: 0.72, nsfw_checked_at: T('2024-06-01T00:00:02') },
    ],
    [
        G.alpha,
        'photo-d.webp',
        'Alpha Photos/images/IMG_0004.webp',
        'photo',
        '2024-01-13 10:00:00',
        { nsfw_score: 0.93, nsfw_checked_at: T('2024-06-01T00:00:03') },
    ],
    [
        G.alpha,
        'photo-e.jpg',
        'Alpha Photos/images/IMG_0005.jpg',
        'photo',
        '2024-01-14 10:00:00',
        { nsfw_score: 0.88, nsfw_checked_at: T('2024-06-01T00:00:04'), nsfw_whitelist: 1 },
    ],
    [G.alpha, 'clip-a.mp4', 'Alpha Photos/videos/VID_0006.mp4', 'video', '2024-01-15 10:00:00', {}],
    [G.beta, 'clip-b.mp4', 'Beta Videos/videos/VID_0007.mp4', 'video', '2024-02-01 10:00:00', {}],
    [G.beta, 'clip-a.mp4', 'Beta Videos/videos/VID_0008.mp4', 'video', '2024-02-02 10:00:00', {}],
    [
        G.beta,
        'photo-f.jpg',
        'Beta Videos/images/IMG_0009.jpg',
        'photo',
        '2024-02-03 10:00:00',
        { pinned: 1 },
    ],
    [
        G.gamma,
        'doc-a.pdf',
        'Gamma Docs/documents/report.pdf',
        'document',
        '2024-03-01 10:00:00',
        {},
    ],
    [G.gamma, 'notes.txt', 'Gamma Docs/documents/notes.txt', 'document', '2024-03-02 10:00:00', {}],
    [
        G.gamma,
        'bundle.zip',
        'Gamma Docs/documents/bundle.zip',
        'document',
        '2024-03-03 10:00:00',
        {},
    ],
    [
        G.gamma,
        'notes.txt.gz',
        'Gamma Docs/documents/notes.txt.gz',
        'document',
        '2024-03-04 10:00:00',
        {},
    ],
    [G.delta, 'photo-a.jpg', 'Delta Mixed/images/IMG_0014.jpg', 'photo', '2024-04-01 10:00:00', {}],
    // Download-time dedup reference: same file as row 14, another message.
    [
        G.delta,
        null,
        'Delta Mixed/images/IMG_0014.jpg',
        'photo',
        '2024-04-02 10:00:00',
        { sameAs: 14 },
    ],
    [
        G.delta,
        'photo-b.jpg',
        'Delta Mixed/images/ภาพทดสอบ รูป.jpg',
        'photo',
        '2024-04-03 10:00:00',
        {},
    ],
    [
        G.delta,
        'photo-f.jpg',
        'Delta Mixed/images/IMG_0017.jpg',
        'photo',
        '2024-04-04 10:00:00',
        { pending_until: FAR, rescued_at: null },
    ],
    [
        G.epsilon,
        'photo-c.png',
        'Epsilon Archive/images/IMG_0018.png',
        'photo',
        '2024-05-01 10:00:00',
        {},
    ],
    [
        G.epsilon,
        'photo-d.webp',
        'Epsilon Archive/images/IMG_0019.webp',
        'photo',
        '2024-05-02 10:00:00',
        { rescued_at: T('2024-05-10T00:00:00') },
    ],
    [
        G.epsilon,
        'clip-b.mp4',
        'Epsilon Archive/videos/VID_0020.mp4',
        'video',
        '2024-05-03 10:00:00',
        {},
    ],
];

export const DOWNLOAD_IDS = {
    alphaPinned: 1,
    alphaPng: 3,
    alphaNsfwHigh: 4,
    alphaWhitelisted: 5,
    alphaVideo: 6,
    betaVideo: 7,
    betaDupVideo: 8,
    betaPinnedPhoto: 9,
    pdf: 10,
    text: 11,
    zip: 12,
    gz: 13,
    deltaOwner: 14,
    deltaRef: 15,
    unicode: 16,
    rescuePending: 17,
    epsilonPng: 18,
    epsilonRescued: 19,
    epsilonVideo: 20,
};

function scrypt(password, saltHex) {
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, {
        N: 16384,
        r: 8,
        p: 1,
    });
    return {
        algo: 'scrypt',
        salt: saltHex,
        hash: hash.toString('hex'),
        N: 16384,
        r: 8,
        p: 1,
        keylen: 64,
    };
}

let _kek = null;
// Same on-disk format as src/core/backup/credentials.js (magic 'TGDC',
// version 1, 12-byte IV, AES-256-GCM, KEK = PBKDF2-SHA256(shareSecret,
// 'tgdl-cred-v1'‖0-pad, 200k, 32)). Fixed IV so the blob is reproducible.
function encryptBackupConfig(cfg, ivByte) {
    if (!_kek) {
        const salt = Buffer.concat([Buffer.from('tgdl-cred-v1'), Buffer.alloc(4)]);
        _kek = crypto.pbkdf2Sync(Buffer.from(SEED.shareSecret, 'hex'), salt, 200_000, 32, 'sha256');
    }
    const iv = Buffer.alloc(12, ivByte);
    const c = crypto.createCipheriv('aes-256-gcm', _kek, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(cfg), 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from('TGDC'), Buffer.from([1]), iv, ct, c.getAuthTag()]);
}

function embedding(seed, dims = 512) {
    // Deterministic unit vector.
    const v = new Float32Array(dims);
    let x = seed * 9301 + 49297;
    let norm = 0;
    for (let i = 0; i < dims; i++) {
        x = (x * 9301 + 49297) % 233280;
        v[i] = x / 233280 - 0.5;
        norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) v[i] /= norm;
    return Buffer.from(v.buffer);
}

export function seedConfig() {
    const filters = (photos, videos, files) => ({
        photos,
        videos,
        files,
        links: false,
        voice: false,
        gifs: false,
        stickers: false,
    });
    return {
        telegram: { apiId: '', apiHash: '' },
        accounts: [],
        pollingInterval: 10,
        groups: [
            {
                id: G.alpha.id,
                name: G.alpha.name,
                enabled: true,
                filters: filters(true, true, false),
            },
            {
                id: G.beta.id,
                name: G.beta.name,
                enabled: true,
                filters: filters(false, true, false),
            },
            {
                id: G.gamma.id,
                name: G.gamma.name,
                enabled: false,
                filters: filters(false, false, true),
            },
            {
                id: G.delta.id,
                name: G.delta.name,
                enabled: true,
                filters: filters(true, true, true),
                rescueMode: 'on',
            },
        ],
        download: { path: './data/downloads', concurrent: 3, retries: 5, maxSpeed: 0 },
        web: {
            enabled: true,
            passwordHash: scrypt(SEED.adminPassword, '00112233445566778899aabbccddeeff'),
            guestPasswordHash: scrypt(SEED.guestPassword, 'ffeeddccbbaa99887766554433221100'),
            guestEnabled: true,
            shareSecret: SEED.shareSecret,
        },
        advanced: {
            // Sidecars pinned to "configured but unreachable" so no machine-
            // specific binary is spawned and nothing is downloaded.
            seekbar: { sidecarUrl: 'http://seekbar.invalid:9', apiToken: 'contract-seekbar-token' },
            ai: { enabled: true, faces: { backend: 'disabled' } },
            nsfw: { enabled: true, threshold: 0.6 },
        },
    };
}

/**
 * Build the seed into `dataDir` (created if missing, must be empty).
 * @param {string} dataDir
 * @param {{ configPatch?: (cfg: object) => void, afterDb?: (db: Database) => void }} [opts]
 * @returns {{ stable: Set<string>, dataDir: string }}
 */
export function buildSeed(dataDir, opts = {}) {
    const dl = path.join(dataDir, 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    const stable = new Set([
        SEED.adminToken,
        SEED.guestToken,
        SEED.shareSecret,
        SEED.clusterToken,
        SEED.selfPeerId,
        ...Object.values(SEED.peers).flatMap((p) => [p.peerId, p.sharedSecret].filter(Boolean)),
    ]);

    const touch = (abs) => {
        const t = new Date(FIXED_MTIME_MS);
        fs.utimesSync(abs, t, t);
    };
    const put = (rel, mediaName) => {
        const abs = path.join(dl, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(path.join(MEDIA, mediaName), abs);
        touch(abs);
        return fs.readFileSync(abs);
    };

    const db = new Database(path.join(dataDir, 'db.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(SCHEMA, 'utf8'));

    const insDl = db.prepare(`
        INSERT INTO downloads (group_id, group_name, message_id, file_name, file_size, file_type,
            file_path, status, created_at, file_hash, pinned, pending_until, rescued_at,
            nsfw_score, nsfw_checked_at, nsfw_whitelist)
        VALUES (@group_id, @group_name, @message_id, @file_name, @file_size, @file_type,
            @file_path, 'completed', @created_at, @file_hash, @pinned, @pending_until, @rescued_at,
            @nsfw_score, @nsfw_checked_at, @nsfw_whitelist)
    `);
    const bytesById = new Map();
    DOWNLOADS.forEach(([g, media, rel, type, created, extra], i) => {
        const id = i + 1;
        const buf = extra.sameAs ? bytesById.get(extra.sameAs) : put(rel, media);
        bytesById.set(id, buf);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        stable.add(hash);
        insDl.run({
            group_id: g.id,
            group_name: g.name,
            message_id: 100 + id,
            file_name: path.posix.basename(rel),
            file_size: buf.length,
            file_type: type,
            file_path: rel,
            created_at: created,
            file_hash: hash,
            pinned: extra.pinned ?? 0,
            pending_until: extra.pending_until ?? null,
            rescued_at: extra.rescued_at ?? null,
            nsfw_score: extra.nsfw_score ?? null,
            nsfw_checked_at: extra.nsfw_checked_at ?? null,
            nsfw_whitelist: extra.nsfw_whitelist ?? 0,
        });
    });
    for (const f of fs.readdirSync(MEDIA)) {
        stable.add(
            crypto
                .createHash('sha256')
                .update(fs.readFileSync(path.join(MEDIA, f)))
                .digest('hex'),
        );
    }

    // Faces / people (pixel boxes inside the 480×320 / 320×480 photos).
    const now24 = T('2024-06-02T00:00:00');
    const insPerson = db.prepare(
        'INSERT INTO people (label, embedding_centroid, face_count, created_at, updated_at, gender) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insPerson.run('Alice', embedding(1), 2, now24, now24, 'female');
    insPerson.run('Bob', embedding(2), 2, now24, now24, 'male');
    insPerson.run(null, embedding(3), 1, now24, now24, null);
    const insFace = db.prepare(`
        INSERT INTO faces (download_id, x, y, w, h, embedding, person_id, quality_score, exif_oriented, frame_time_sec, gender)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    insFace.run(1, 100, 80, 90, 90, embedding(11), 1, 0.97, null, 'female');
    insFace.run(2, 60, 120, 80, 80, embedding(12), 1, 0.91, null, 'female');
    insFace.run(3, 40, 40, 60, 60, embedding(13), 2, 0.88, null, 'male');
    insFace.run(9, 120, 100, 100, 100, embedding(14), 2, 0.83, null, 'male');
    insFace.run(14, 200, 60, 70, 70, embedding(15), 3, 0.79, null, null);
    insFace.run(4, 150, 90, 50, 50, embedding(16), null, 0.42, null, null);
    insFace.run(6, 30, 20, 40, 40, embedding(17), null, 0.66, 1.0, null);
    db.prepare('UPDATE downloads SET ai_indexed_at = ? WHERE id IN (1,2,3,4,6,9,14)').run(now24);

    // Seekbar sprite for the Alpha video (row 6).
    const sbDir = path.join(dataDir, 'seekbar');
    fs.mkdirSync(sbDir, { recursive: true });
    const sprite = path.join(sbDir, '6.webp');
    const meta = path.join(sbDir, '6.json');
    fs.copyFileSync(path.join(MEDIA, 'sprite.webp'), sprite);
    fs.writeFileSync(
        meta,
        `${JSON.stringify(
            {
                version: 1,
                duration: 2,
                interval: 1,
                frames: 2,
                cols: 2,
                rows: 1,
                tileWidth: 160,
                tileHeight: 60,
                format: 'webp',
                sprite: '6.webp',
            },
            null,
            2,
        )}\n`,
    );
    touch(sprite);
    touch(meta);
    db.prepare(`
        INSERT INTO seekbar_sprites (download_id, sprite_path, meta_path, duration_sec, frames, cols, rows,
            tile_w, tile_h, interval_sec, format, bytes, source_size, source_mtime, generated_at)
        VALUES (6, ?, ?, 2, 2, 2, 1, 160, 60, 1, 'webp', ?, ?, ?, ?)
    `).run(sprite, meta, fs.statSync(sprite).size, bytesById.get(6).length, FIXED_MTIME_MS, now24);

    // Share links: active, expired, revoked.
    const insShare = db.prepare(`
        INSERT INTO share_links (download_id, created_at, expires_at, revoked_at, label, last_accessed_at, access_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // created_at / revoked_at / last_accessed_at are epoch ms (what the app
    // writes); expires_at is epoch seconds (it is signed into the URL).
    insShare.run(1, 1717200000000, FAR_S, null, 'for grandma', null, 0);
    insShare.run(10, 1717200100000, 1717286400, null, 'expired report', 1717200200000, 3);
    insShare.run(2, 1717200200000, FAR_S, 1717300000000, 'revoked', null, 1);

    // Backup destinations (disabled → no worker touches the network).
    const backupRoot = path.join(dataDir, 'backup-target');
    const insDest = db.prepare(`
        INSERT INTO backup_destinations (name, provider, config_blob, enabled, encryption, mode, cron,
            retain_count, last_success_at, last_failure_at, last_error, total_bytes, total_files, created_at)
        VALUES (?, ?, ?, 0, 0, ?, ?, 7, ?, ?, ?, ?, ?, ?)
    `);
    insDest.run(
        'Local mirror',
        'local',
        encryptBackupConfig({ rootPath: backupRoot }, 1),
        'mirror',
        null,
        T('2024-06-03T00:00:00'),
        null,
        null,
        7066,
        2,
        T('2024-06-01T00:00:00'),
    );
    insDest.run(
        'Offsite S3',
        's3',
        encryptBackupConfig(
            {
                endpoint: 'https://s3.invalid',
                region: 'auto',
                bucket: 'tgdl-contract',
                accessKeyId: 'AKIACONTRACTFAKE',
                secretAccessKey: 'fake-secret-key',
                prefix: 'tgdl/',
            },
            2,
        ),
        'snapshot',
        '0 3 * * *',
        null,
        T('2024-06-04T00:00:00'),
        'getaddrinfo ENOTFOUND s3.invalid',
        0,
        0,
        T('2024-06-01T00:00:01'),
    );
    insDest.run(
        'NAS over SFTP',
        'sftp',
        encryptBackupConfig(
            {
                host: 'nas.invalid',
                port: 22,
                username: 'backup',
                password: 'fake-password',
                remoteRoot: '/srv/tgdl',
            },
            3,
        ),
        'mirror',
        null,
        null,
        null,
        null,
        0,
        0,
        T('2024-06-01T00:00:02'),
    );
    const insJob = db.prepare(`
        INSERT INTO backup_jobs (destination_id, download_id, snapshot_path, status, attempts, max_attempts,
            next_retry_at, started_at, finished_at, bytes_uploaded, error, remote_path)
        VALUES (?, ?, ?, ?, ?, 5, ?, ?, ?, ?, ?, ?)
    `);
    insJob.run(
        1,
        1,
        null,
        'done',
        1,
        null,
        T('2024-06-03T00:00:00'),
        T('2024-06-03T00:00:01'),
        3365,
        null,
        'Alpha Photos/images/IMG_0001.jpg',
    );
    insJob.run(
        1,
        2,
        null,
        'done',
        1,
        null,
        T('2024-06-03T00:00:02'),
        T('2024-06-03T00:00:03'),
        3228,
        null,
        'Alpha Photos/images/IMG_0002.jpg',
    );
    insJob.run(
        2,
        null,
        'snapshot-2024-06-04.tar',
        'failed',
        5,
        null,
        T('2024-06-04T00:00:00'),
        T('2024-06-04T00:00:05'),
        0,
        'getaddrinfo ENOTFOUND s3.invalid',
        null,
    );

    // Cluster: identity, two peers, a cached peer catalog, audit rows.
    const fp = (peerId) =>
        crypto.createHash('sha256').update(`${SEED.clusterToken}:${peerId}`).digest('hex');
    const insPeer = db.prepare(`
        INSERT INTO peers (peer_id, name, url, status, stream_mode, last_seen_at, paired_at, fingerprint,
            version, notes, shared_secret, role, ws_last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', NULL)
    `);
    const pa = SEED.peers.alpha;
    const pb = SEED.peers.beta;
    insPeer.run(
        pa.peerId,
        pa.name,
        pa.url,
        'offline',
        'proxy',
        T('2024-06-05T00:00:00'),
        T('2024-06-01T00:00:00'),
        fp(pa.peerId),
        '2.27.1',
        'primary peer',
        Buffer.from(pa.sharedSecret, 'utf8'),
    );
    insPeer.run(
        pb.peerId,
        pb.name,
        pb.url,
        'offline',
        'direct',
        null,
        T('2024-06-01T00:00:01'),
        fp(pb.peerId),
        '2.26.3',
        null,
        null,
    );
    for (const p of [pa, pb]) stable.add(fp(p.peerId));
    const insPd = db.prepare(`
        INSERT INTO peer_downloads (peer_id, remote_id, file_path, file_name, file_size, file_type, file_hash,
            group_id, group_name, message_id, created_at, status, nsfw_score, cached_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?)
    `);
    const remoteHash = 'd'.repeat(64);
    stable.add(remoteHash);
    insPd.run(
        pa.peerId,
        501,
        'Remote Chat/images/R_0501.jpg',
        'R_0501.jpg',
        12345,
        'photo',
        remoteHash,
        '-1009000000001',
        'Remote Chat',
        9001,
        T('2024-06-06T00:00:00'),
        T('2024-06-06T00:00:10'),
    );
    insPd.run(
        pa.peerId,
        502,
        'Remote Chat/videos/R_0502.mp4',
        'R_0502.mp4',
        54321,
        'video',
        null,
        '-1009000000001',
        'Remote Chat',
        9002,
        T('2024-06-06T00:00:01'),
        T('2024-06-06T00:00:10'),
    );
    // A remote copy of a local file (cross-peer dedup hit).
    insPd.run(
        pa.peerId,
        503,
        'Remote Chat/images/R_0503.jpg',
        'R_0503.jpg',
        bytesById.get(1).length,
        'photo',
        crypto.createHash('sha256').update(bytesById.get(1)).digest('hex'),
        '-1009000000001',
        'Remote Chat',
        9003,
        T('2024-06-06T00:00:02'),
        T('2024-06-06T00:00:10'),
    );
    const insAudit = db.prepare(
        'INSERT INTO cluster_audit (ts, peer_id, kind, detail, ok) VALUES (?, ?, ?, ?, ?)',
    );
    insAudit.run(T('2024-06-01T00:00:00'), pa.peerId, 'handshake', 'paired', 1);
    insAudit.run(T('2024-06-05T00:00:00'), pa.peerId, 'signed_request', 'bad signature', 0);
    db.prepare(
        'INSERT INTO peer_failover_log (group_id, from_peer_id, to_peer_id, reason, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(G.beta.id, pa.peerId, SEED.selfPeerId, 'peer offline', T('2024-06-05T01:00:00'));

    // Chat access: one chat we can't reach any more.
    db.prepare(`
        INSERT INTO chat_access (chat_id, state, code, detail, migrated_to, first_seen_at, checked_at,
            next_check_at, checks, accounts, updated_at)
        VALUES (?, 'left', 'USER_NOT_PARTICIPANT', 'account left the chat', NULL, ?, ?, ?, 1, ?, ?)
    `).run(
        G.gamma.id,
        T('2024-06-07T00:00:00'),
        T('2024-06-07T00:00:00'),
        FAR,
        '{}',
        T('2024-06-07T00:00:00'),
    );

    // NSFW blocklist + update history.
    db.prepare(
        'INSERT INTO nsfw_hash_blocklist (file_hash, file_name, deleted_at, source) VALUES (?, ?, ?, ?)',
    ).run('e'.repeat(64), 'blocked.jpg', T('2024-06-08T00:00:00'), 'manual');
    stable.add('e'.repeat(64));
    const insUpd = db.prepare(`
        INSERT INTO update_history (from_version, to_version, started_at, finished_at, status, error_code,
            error_msg, backup_path, backup_bytes, from_instance_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insUpd.run(
        '2.27.0',
        '2.27.1',
        T('2024-06-09T00:00:00'),
        T('2024-06-09T00:02:00'),
        'success',
        null,
        null,
        'data/backups/db-2024-06-09.sqlite',
        1024,
        '00000000-0000-4000-8000-00000000000e',
    );
    insUpd.run(
        '2.27.1',
        null,
        T('2024-06-10T00:00:00'),
        T('2024-06-10T00:00:01'),
        'failed',
        'WATCHTOWER_UNREACHABLE',
        'watchtower did not answer',
        null,
        null,
        null,
    );
    stable.add('00000000-0000-4000-8000-00000000000e');

    // Dashboard sessions: fixed tokens, valid until 2100 (no sliding renewal).
    const insSess = db.prepare(
        'INSERT INTO web_sessions (token, role, issued_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)',
    );
    insSess.run(SEED.adminToken, 'admin', T('2024-01-01T00:00:00'), FAR, T('2024-01-01T00:00:00'));
    insSess.run(SEED.guestToken, 'guest', T('2024-01-01T00:00:00'), FAR, T('2024-01-01T00:00:00'));

    // kv: config + identity + one-shot flags that would otherwise fire at boot.
    const cfg = seedConfig();
    for (const h of [cfg.web.passwordHash, cfg.web.guestPasswordHash]) {
        stable.add(h.salt);
        stable.add(h.hash);
    }
    opts.configPatch?.(cfg);
    const kv = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    const kt = T('2024-01-01T00:00:00');
    kv.run('config', JSON.stringify(cfg), kt);
    kv.run('peer_id', JSON.stringify(SEED.selfPeerId), kt);
    kv.run('peer_name', JSON.stringify(SEED.selfPeerName), kt);
    kv.run('cluster_token', JSON.stringify(SEED.clusterToken), kt);
    kv.run('thumbs_widths_unified_v1', 'true', kt);
    kv.run('disk_usage', JSON.stringify({ size: 0, lastScan: kt }), kt);

    opts.afterDb?.(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();

    // Group avatar for Alpha Photos.
    const photos = path.join(dataDir, 'photos');
    fs.mkdirSync(photos, { recursive: true });
    const avatar = path.join(photos, `${G.alpha.id}.jpg`);
    fs.copyFileSync(path.join(MEDIA, 'photo-f.jpg'), avatar);
    touch(avatar);

    // Directory mtimes too (listing endpoints may expose them).
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) walk(path.join(d, e.name));
        }
        touch(d);
    };
    walk(dl);
    return { stable, dataDir };
}
