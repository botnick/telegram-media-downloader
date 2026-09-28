// The Node implementations tgdl-core replaced, kept verbatim (only
// parameterised) as the reference the Go path is checked against:
//
//   oracleSweepChecks    the Promise.all(fs.stat) block of integrity.sweep
//   oracleReindex        integrity.reindexFromDisk's nested fs.readdir walk
//   oracleDiskUsage      server.js scanDirectorySize
//
// Test-only. Production code no longer contains these.

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { sanitizeName } from '../../src/core/downloader.js';

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** integrity.sweep's per-page stat block. rows: {id, file_path, file_size}. */
export async function oracleSweepChecks(rows, DOWNLOADS_DIR) {
    const sizeFixes = [];
    const deleteIds = [];
    const checks = await Promise.all(
        rows.map(async (r) => {
            let rel = String(r.file_path || '').replace(/\\/g, '/');
            if (!rel) return null;
            while (rel.startsWith('data/downloads/')) rel = rel.slice('data/downloads/'.length);
            if (rel.startsWith('_clusterref/')) return null;
            const abs = path.resolve(DOWNLOADS_DIR, rel);
            try {
                const st = await fs.stat(abs);
                if (st.size <= 0) return r.id;
                const stored = Number(r.file_size) || 0;
                if (stored !== st.size) sizeFixes.push({ id: r.id, size: st.size });
                return null;
            } catch (e) {
                return MISSING_CODES.has(e?.code) ? r.id : null;
            }
        }),
    );
    for (const id of checks) if (id) deleteIds.push(id);
    sizeFixes.sort((a, b) => a.id - b.id);
    return { deleteIds, sizeFixes };
}

const TYPE_FOLDER_TO_FILETYPE = {
    images: 'photo',
    videos: 'video',
    audio: 'audio',
    documents: 'document',
    gifs: 'video',
    stickers: 'photo',
    others: 'document',
};
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac']);
function fileTypeFromExt(ext) {
    if (PHOTO_EXTS.has(ext)) return 'photo';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return 'document';
}
const FILENAME_MSGID_RE = /_(\d+)\.[^.]+$/;
function deriveMessageId(relPath, fileName) {
    const m = FILENAME_MSGID_RE.exec(fileName);
    if (m) return Number(m[1]);
    const h = crypto.createHash('sha256').update(relPath).digest();
    const n = h.readUInt32BE(0) || 1;
    return -n;
}
function resolveGroupId(folderName, configGroups) {
    if (!Array.isArray(configGroups)) return null;
    for (const g of configGroups) {
        if (String(g.id) === folderName) return { id: String(g.id), name: g.name || folderName };
    }
    for (const g of configGroups) {
        const sanitised = sanitizeName(g.name || '');
        if (sanitised && sanitised === folderName) return { id: String(g.id), name: g.name };
    }
    return null;
}

/**
 * reindexFromDisk's walk. `insert(row)` stands in for insertDownload and
 * returns `{ changes }`. Resolves the result counters (or rejects exactly
 * like the old code did).
 */
export async function oracleReindex(DOWNLOADS_DIR, configGroups, insert) {
    const result = { scanned: 0, added: 0, skipped: 0, errors: 0, groups: 0 };
    let topEntries = [];
    try {
        topEntries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
    } catch {
        return result;
    }
    const groupDirs = topEntries.filter((e) => e.isDirectory() && e.name !== '.deleted');
    result.groups = groupDirs.length;
    const ingest = async ({ fullAbs, relPath, fileName, groupId, groupName, fileType }) => {
        result.scanned += 1;
        try {
            const st = await fs.stat(fullAbs);
            if (!st.isFile() || st.size <= 0) {
                result.skipped += 1;
                return;
            }
            const messageId = deriveMessageId(relPath, fileName);
            const r = insert({
                groupId,
                groupName,
                messageId,
                fileName,
                fileSize: st.size,
                fileType,
                filePath: relPath,
            });
            if (r && r.changes > 0) result.added += 1;
            else result.skipped += 1;
        } catch {
            result.errors += 1;
        }
    };
    for (const gd of groupDirs) {
        const folderName = gd.name;
        const resolved = resolveGroupId(folderName, configGroups);
        const groupId = resolved ? resolved.id : `unknown:${folderName}`;
        const groupName = resolved ? resolved.name : folderName;
        const subEntries = await fs.readdir(path.join(DOWNLOADS_DIR, folderName), {
            withFileTypes: true,
        });
        for (const sub of subEntries) {
            if (sub.isDirectory()) {
                const typeFolder = sub.name;
                const folderType = TYPE_FOLDER_TO_FILETYPE[typeFolder] || null;
                let files = [];
                try {
                    files = await fs.readdir(path.join(DOWNLOADS_DIR, folderName, typeFolder), {
                        withFileTypes: true,
                    });
                } catch {
                    continue;
                }
                for (const f of files) {
                    if (!f.isFile() || f.name.endsWith('.part')) continue;
                    await ingest({
                        fullAbs: path.join(DOWNLOADS_DIR, folderName, typeFolder, f.name),
                        relPath: path.posix
                            .join(folderName, typeFolder, f.name)
                            .replace(/\\/g, '/'),
                        fileName: f.name,
                        groupId,
                        groupName,
                        fileType: folderType || fileTypeFromExt(path.extname(f.name).toLowerCase()),
                    });
                }
            } else if (sub.isFile() && !sub.name.endsWith('.part')) {
                await ingest({
                    fullAbs: path.join(DOWNLOADS_DIR, folderName, sub.name),
                    relPath: path.posix.join(folderName, sub.name).replace(/\\/g, '/'),
                    fileName: sub.name,
                    groupId,
                    groupName,
                    fileType: fileTypeFromExt(path.extname(sub.name).toLowerCase()),
                });
            }
        }
    }
    return result;
}

/** server.js scanDirectorySize. */
export async function oracleDiskUsage(dir) {
    let total = 0;
    async function walk(current) {
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            try {
                const st = await fs.stat(fullPath);
                if (st.isFile()) total += st.size;
            } catch {
                /* file disappeared mid-scan */
            }
        }
    }
    await walk(dir);
    return total;
}
