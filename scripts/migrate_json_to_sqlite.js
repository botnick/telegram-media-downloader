/**
 * Migration Script: JSON -> SQLite
 * Reads all legacy JSON log files and inserts them into the new SQLite database.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../src/core/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

async function migrate() {
    console.log('🚀 Starting Migration: JSON -> SQLite...');

    if (!(await fileExists(LOGS_DIR))) {
        console.log('❌ No logs directory found. Nothing to migrate.');
        return;
    }

    const groups = await fs.readdir(LOGS_DIR, { withFileTypes: true });
    let totalImported = 0;
    let totalErrors = 0;

    for (const group of groups) {
        if (!group.isDirectory()) continue;

        const groupId = group.name;
        const groupDir = path.join(LOGS_DIR, groupId);
        console.log(`📂 Processing group: ${groupId}...`);

        const files = await fs.readdir(groupDir);
        for (const file of files) {
            // Check for bucket files
            if (file.startsWith('bucket_') && file.endsWith('.json')) {
                try {
                    const content = JSON.parse(
                        await fs.readFile(path.join(groupDir, file), 'utf8'),
                    );
                    await importBucket(groupId, content);
                    totalImported += Object.keys(content).length;
                } catch (e) {
                    console.error(`❌ Error reading ${file}:`, e.message);
                    totalErrors++;
                }
            }
            // Check for legacy flat files (if any remain)
            else if (file === `${groupId}.json`) {
                try {
                    const content = JSON.parse(
                        await fs.readFile(path.join(groupDir, file), 'utf8'),
                    );
                    if (content.files) {
                        await importBucket(groupId, content.files);
                        totalImported += Object.keys(content.files).length;
                    }
                } catch (e) {
                    console.error(`❌ Error reading legacy ${file}:`, e.message);
                }
            }
        }
    }

    console.log('─'.repeat(50));
    console.log(`✅ Migration Complete!`);
    console.log(`📥 Imported: ${totalImported} records`);
    console.log(`❌ Errors:   ${totalErrors}`);
    console.log('─'.repeat(50));
}

async function importBucket(groupId, data) {
    const db = getDb();

    // Use transaction for speed
    const insert = db.prepare(`
        INSERT OR IGNORE INTO downloads (group_id, message_id, file_name, file_size, file_type, file_path, created_at)
        VALUES (@groupId, @messageId, @fileName, @fileSize, @fileType, @filePath, @createdAt)
    `);

    const transaction = db.transaction((entries) => {
        for (const entry of entries) {
            insert.run(entry);
        }
    });

    const rows = [];
    for (const [key, meta] of Object.entries(data)) {
        // Key: "groupId_msgId"
        const parts = key.split('_');
        const msgId = parts.length > 1 ? parts[1] : 0;

        let type = 'document'; // default
        // Infer type from extension if available, or just generic
        // In legacy JSON, we didn't store 'type' explicitly in all versions.
        // We can inspect extension.
        // Assuming meta has { file, size, date }

        if (meta.file) {
            const ext = path.extname(meta.file).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) type = 'photo';
            else if (['.mp4', '.mov', '.avi'].includes(ext)) type = 'video';
            else if (['.mp3', '.ogg'].includes(ext)) type = 'audio';
        }

        rows.push({
            groupId: groupId,
            messageId: msgId,
            fileName: meta.file || 'unknown',
            fileSize: meta.size || 0,
            fileType: type,
            filePath: meta.file, // We only stored filename in JSON usually, assume relative path matching downloader logic?
            // Actually downloader v1 stored just filename.
            // We need to reconstruct path?
            // New `downloader.js` expects `filePath` to be relative path.
            // If we only have filename, we can put filename.
            createdAt: meta.date ? new Date(meta.date).toISOString() : new Date().toISOString(),
        });
    }

    transaction(rows);
}

async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

migrate();
