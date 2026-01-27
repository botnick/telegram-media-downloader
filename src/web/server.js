
/**
 * Web GUI Server - Configuration + Profile Photos
 * Features: Groups, Settings, Viewer, Real Telegram Profile Photos
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos'); // Cache for profile photos
const SESSION_PATH = path.join(DATA_DIR, 'session.enc');
const SESSION_PASSWORD = 'telegram-dl-2026';

const app = express();
// [NEW] Get all dialogs (groups/channels) for selection
app.get('/api/dialogs', async (req, res) => {
    try {
        if (!telegramClient || !telegramClient.connected) {
            return res.status(503).json({ error: 'Telegram client not connected' });
        }
        
        const dialogs = await telegramClient.getDialogs({ limit: 200 });
        const results = dialogs
            .map(d => ({
                id: d.id.toString(),
                name: d.title || d.name || 'Unknown',
                type: d.isUser ? 'user' : (d.isChannel ? 'channel' : 'group'),
                username: d.username
            }));
            
        res.json({ success: true, dialogs: results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

// Telegram client
let telegramClient = null;
let isConnected = false;

// Ensure photos directory exists
if (!fsSync.existsSync(PHOTOS_DIR)) {
    fsSync.mkdirSync(PHOTOS_DIR, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve static files with Fuzzy Matching and Enhanced Path Handling
app.use('/files', async (req, res, next) => {
    try {
        // Decode URL to get the requested path
        // Format: /GroupName/Path/To/File.ext
        const reqPath = decodeURIComponent(req.path).replace(/^\//, ''); // Remove leading slash
        
        if (!reqPath) return next();

        // Progressive Matching Strategy
        // Because GroupName can contain slashes (e.g. "VIP SET /FOR LIFE"), we can't just split by first slash.
        // We iterate through possible split points to find the longest matching folder.
        
        const pathParts = reqPath.split('/');
        let match = null;
        let matchedGroupPath = '';
        let remainingPath = '';
        
        // Load all directories once for performance
        const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
        const directories = entries.filter(e => e.isDirectory());

        // Try progressively longer group names
        // e.g. ["VIP SET ", "FOR LIFE", "file.mp4"]
        // 1. "VIP SET " -> No match
        // 2. "VIP SET /FOR LIFE" -> Fuzzy Match "VIP_SET__FOR_LIFE" -> Match!
        
        for (let i = 1; i <= pathParts.length; i++) {
            const potentialGroupName = pathParts.slice(0, i).join('/');
            
            // 1. Exact Match
            let validPath = path.join(DOWNLOADS_DIR, potentialGroupName);
            if (fsSync.existsSync(validPath) && fsSync.statSync(validPath).isDirectory()) {
                match = potentialGroupName; // Use original name if exact
                matchedGroupPath = validPath;
                remainingPath = pathParts.slice(i).join('/');
                break;
            }
            
            // 2. Fuzzy Match
            const normalizedTarget = normalizeName(potentialGroupName);
            const found = directories.find(d => normalizeName(d.name) === normalizedTarget);
            
            if (found) {
                match = found.name;
                matchedGroupPath = path.join(DOWNLOADS_DIR, found.name);
                remainingPath = pathParts.slice(i).join('/');
                // Don't break yet? 
                // Actually, if we find a match, is it possible there's a LONGER match?
                // Example: Group "A", Group "A/B". 
                // If path is "A/B/file.jpg", "A" matches. "A/B" matches.
                // We should probably prefer the LONGEST match?
                // But simplified: usually minimal overlap. Let's take the first reasonable match OR verify file existence?
                // If we match folder "A", does "B/file.jpg" exist in "A"? 
                // Checking file existence is safer.
                
                const checkFilePath = path.join(matchedGroupPath, remainingPath);
                if (fsSync.existsSync(checkFilePath)) {
                    break; 
                }
                // If file doesn't exist, maybe it wasn't this group (e.g. folder "A" exists but we wanted "A/B")
                // Continue loop
            }
        }

        if (!matchedGroupPath || !remainingPath) {
            return next(); // 404
        }
        
        // Construct full file path
        const filePath = path.join(matchedGroupPath, remainingPath);
        
        // Security check
        const relative = path.relative(DOWNLOADS_DIR, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return res.status(403).send('Forbidden');
        }

        if (fsSync.existsSync(filePath)) {
            return res.sendFile(filePath);
        } else {
            return next();
        }
    } catch (e) {
        console.error('File serving error:', e);
        next();
    }
});
app.use('/photos', express.static(PHOTOS_DIR));

// ============ Telegram Client ============

async function loadSession() {
    try {
        if (fsSync.existsSync(SESSION_PATH)) {
            const encryptedStr = await fs.readFile(SESSION_PATH, 'utf8');
            const encrypted = JSON.parse(encryptedStr);
            
            const key = crypto.scryptSync(SESSION_PASSWORD, 'tg-dl-salt-v1', 32);
            
            const decipher = crypto.createDecipheriv(
                'aes-256-gcm',
                key,
                Buffer.from(encrypted.iv, 'hex')
            );
            
            decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
            
            const decrypted = Buffer.concat([
                decipher.update(Buffer.from(encrypted.data, 'hex')),
                decipher.final()
            ]);
            
            return decrypted.toString('utf8');
        }
    } catch (e) {
        console.log('Could not load session:', e.message);
    }
    return '';
}

async function connectTelegram() {
    if (telegramClient && isConnected) return telegramClient;
    
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const sessionString = await loadSession();
        
        if (!sessionString) {
            console.log('⚠️ No session found. Profile photos will use fallback.');
            return null;
        }
        
        const stringSession = new StringSession(sessionString);
        telegramClient = new TelegramClient(
            stringSession,
            parseInt(config.telegram.apiId),
            config.telegram.apiHash,
            { 
                connectionRetries: 3,
                useWSS: false 
            }
        );
        
        // Suppress verbose logs
        telegramClient.setLogLevel('none');
        
        await telegramClient.connect();
        
        if (await telegramClient.isUserAuthorized()) {
            isConnected = true;
            console.log('✅ Connected to Telegram (for profile photos)');
            
            // Cache dialogs for faster entity resolution
            try {
                await telegramClient.getDialogs({ limit: 100 });
            } catch (e) {}
            
            return telegramClient;
        }
    } catch (error) {
        console.log('⚠️ Telegram connection failed:', error.message);
    }
    return null;
}

// Memory cache for resolved entities (key: any ID format -> entity)
const entityCache = new Map();
const dialogsCache = [];

async function cacheAllDialogs() {
    if (dialogsCache.length > 0) return dialogsCache;
    
    const client = await connectTelegram();
    if (!client) return [];
    
    try {
        const dialogs = await client.getDialogs({ limit: 500 });
        dialogs.forEach(d => {
            if (d.entity) {
                dialogsCache.push({
                    id: d.entity.id?.toString(),
                    fullId: d.id?.toString(),
                    title: d.title || d.name,
                    entity: d.entity
                });
            }
        });
        console.log(`📋 Cached ${dialogsCache.length} dialogs`);
    } catch (e) {
        console.log('Could not cache dialogs:', e.message);
    }
    return dialogsCache;
}

async function downloadProfilePhoto(groupId) {
    const idStr = String(groupId);
    const photoPath = path.join(PHOTOS_DIR, `${idStr}.jpg`);
    
    // Check local cache first
    if (fsSync.existsSync(photoPath)) {
        return `/photos/${idStr}.jpg`;
    }
    
    const client = await connectTelegram();
    if (!client) return null;
    
    try {
        let entity = entityCache.get(idStr);
        
        if (!entity) {
            // Strategy 1: Try direct getEntity with multiple ID formats
            const idsToTry = [
                idStr,                                    // As-is
                idStr.replace(/^-100/, ''),              // Remove -100 prefix
                '-100' + idStr.replace(/^-/, ''),        // Add -100 prefix
                BigInt(idStr),                           // As BigInt
            ];
            
            for (const tryId of idsToTry) {
                try {
                    entity = await client.getEntity(tryId);
                    if (entity) {
                        console.log(`✅ Found entity for ${idStr} using ${tryId}`);
                        break;
                    }
                } catch (e) {
                    // Silent, try next
                }
            }
            
            // Strategy 2: Search in cached dialogs
            if (!entity) {
                const dialogs = await cacheAllDialogs();
                
                // Try multiple matching strategies
                const found = dialogs.find(d => {
                    const rawId = idStr.replace(/^-100/, '').replace(/^-/, '');
                    return (
                        d.id === idStr ||
                        d.id === rawId ||
                        d.fullId === idStr ||
                        d.fullId === rawId ||
                        d.id === `-100${rawId}` ||
                        `-100${d.id}` === idStr
                    );
                });
                
                if (found) {
                    entity = found.entity;
                    console.log(`✅ Found entity for ${idStr} in dialogs cache (${found.title})`);
                }
            }
        }
        
        if (entity) {
            entityCache.set(idStr, entity);
            
            if (entity.photo) {
                try {
                    const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
                    if (buffer && buffer.length > 0) {
                        await fs.writeFile(photoPath, buffer);
                        console.log(`📸 Saved profile photo for ${idStr}`);
                        return `/photos/${idStr}.jpg`;
                    }
                } catch (downloadErr) {
                    console.log(`Could not download photo for ${idStr}:`, downloadErr.message);
                }
            } else {
                console.log(`ℹ️ Entity ${idStr} has no photo`);
            }
        } else {
            console.log(`❌ Could not find entity for ${idStr}`);
        }
    } catch (error) {
        console.log(`Error processing ${idStr}:`, error.message);
    }
    return null;
}

// ============ CONFIG API ============

app.get('/api/config', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        const currentConfig = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const newConfig = { ...currentConfig, ...req.body };
        
        if (req.body.download) {
            newConfig.download = { ...currentConfig.download, ...req.body.download };
        }
        if (req.body.rateLimits) {
            newConfig.rateLimits = { ...currentConfig.rateLimits, ...req.body.rateLimits };
        }
        if (req.body.diskManagement) {
            newConfig.diskManagement = { ...currentConfig.diskManagement, ...req.body.diskManagement };
        }
        
        await fs.writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 4));
        broadcast({ type: 'config_updated', config: newConfig });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ GROUPS API ============

app.get('/api/groups', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        
        // Add photo URLs to groups
        const groupsWithPhotos = await Promise.all((config.groups || []).map(async (group) => {
            const photoPath = path.join(PHOTOS_DIR, `${group.id}.jpg`);
            const hasPhoto = fsSync.existsSync(photoPath);
            return {
                ...group,
                photoUrl: hasPhoto ? `/photos/${group.id}.jpg` : null
            };
        }));
        
        res.json(groupsWithPhotos);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Normalize name for matching (folder names use _ instead of space and remove some special chars)
function normalizeName(name) {
    if (!name) return '';
    return name
        .replace(/[_|]+/g, ' ')          // underscore, pipe -> space
        .replace(/\s+/g, ' ')            // multiple spaces -> single space
        .replace(/[\/\\:*?"<>]/g, '')    // remove Windows-invalid chars
        .trim()
        .toLowerCase();
}

app.get('/api/groups/:id/photo', async (req, res) => {
    try {
        const idOrName = decodeURIComponent(req.params.id);
        const normalizedInput = normalizeName(idOrName);
        
        // Load config to find group (OPTIONAL MATCH)
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        
        // Try to find group object for better naming/caching
        let group = config.groups?.find(g => String(g.id) === idOrName);
        if (!group) {
            group = config.groups?.find(g => normalizeName(g.name) === normalizedInput);
        }
        
        let targetId = idOrName;
        // If matched in config, use that ID (trusted)
        if (group && group.id) {
            targetId = String(group.id);
        } else {
            // For raw IDs (like from dialog list), use as is
            // Basic validation: must be number or start with -100
            if (!/^-?\d+$/.test(targetId)) {
                // If it's a name and not in config, we can't easily resolve it without searching dialogs
                // But downloadProfilePhoto can try caching dialogs.
                // Let's pass it through.
            }
        }
        
        const photoPath = path.join(PHOTOS_DIR, `${targetId}.jpg`);
        
        // Check if already cached
        if (fsSync.existsSync(photoPath)) {
            return res.sendFile(photoPath);
        }
        
        // Try to download from Telegram
        const url = await downloadProfilePhoto(targetId);
        if (url) {
             // Handle case where downloadProfilePhoto returns /photos/ID.jpg or null
             // Access the file path derived from targetId (downloadProfilePhoto saves it there)
             if (fsSync.existsSync(photoPath)) {
                return res.sendFile(photoPath);
             }
        }
        
        res.status(404).json({ error: 'Photo not found' });
    } catch (error) {
        // console.log(`Photo fetch error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to refresh all profile photos
app.post('/api/groups/refresh-photos', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const results = [];
        
        for (const group of config.groups || []) {
            const url = await downloadProfilePhoto(group.id);
            results.push({ id: group.id, name: group.name, photoUrl: url });
        }
        
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/groups/:id', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const groupId = req.params.id;
        const groupIndex = config.groups.findIndex(g => String(g.id) === groupId);
        
        if (groupIndex === -1) {
            return res.status(404).json({ error: 'Group not found' });
        }
        
        if (req.body.filters) {
            config.groups[groupIndex].filters = {
                ...config.groups[groupIndex].filters,
                ...req.body.filters
            };
            delete req.body.filters;
        }
        
        config.groups[groupIndex] = { ...config.groups[groupIndex], ...req.body };
        await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 4));
        broadcast({ type: 'group_updated', group: config.groups[groupIndex] });
        res.json({ success: true, group: config.groups[groupIndex] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ DOWNLOADS/VIEWER API ============

app.get('/api/downloads', async (req, res) => {
    try {
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        const configGroups = config.groups || [];
        const mergedGroups = new Map(); // Use Map to deduplicate
        
        if (fsSync.existsSync(DOWNLOADS_DIR)) {
            const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
            
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const folderName = entry.name;
                    const normalizedFolder = normalizeName(folderName);
                    const groupPath = path.join(DOWNLOADS_DIR, folderName);
                    const stats = await getGroupStats(groupPath);
                    
                    // Find matching config group
                    const configGroup = configGroups.find(g => 
                        normalizeName(g.name) === normalizedFolder ||
                        normalizeName(g.name).includes(normalizedFolder) ||
                        normalizedFolder.includes(normalizeName(g.name))
                    );
                    
                    if (configGroup) {
                        // Use config group ID as key to deduplicate
                        const key = String(configGroup.id);
                        const existing = mergedGroups.get(key);
                        
                        if (existing) {
                            // Merge stats if folder already exists
                            existing.totalFiles += stats.totalFiles;
                            existing.totalSize += stats.totalSize;
                            existing.folderNames.push(folderName);
                            Object.keys(stats.types || {}).forEach(t => {
                                existing.types[t] = (existing.types[t] || 0) + (stats.types[t] || 0);
                            });
                        } else {
                            // Create new entry with config data
                            mergedGroups.set(key, {
                                id: configGroup.id,
                                name: configGroup.name,  // Use config name
                                folderName: folderName,  // Keep original for file access
                                folderNames: [folderName],
                                enabled: configGroup.enabled,
                                ...stats,
                                photoUrl: `/api/groups/${configGroup.id}/photo`
                            });
                        }
                    } else {
                        // No config match - use folder name
                        const key = `folder_${folderName}`;
                        if (!mergedGroups.has(key)) {
                            mergedGroups.set(key, {
                                id: null,
                                name: folderName,
                                folderName: folderName,
                                folderNames: [folderName],
                                enabled: false,
                                ...stats,
                                photoUrl: null
                            });
                        }
                    }
                }
            }
        }
        
        // Convert to array and sort by name
        const groups = Array.from(mergedGroups.values())
            .sort((a, b) => a.name.localeCompare(b.name));
        
        res.json(groups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/downloads/:group', async (req, res) => {
    try {
        const groupName = decodeURIComponent(req.params.group);
        let groupPath = path.join(DOWNLOADS_DIR, groupName);
        
        // Exact match check
        if (!fsSync.existsSync(groupPath)) {
            // Try fuzzy match
            const normalizedTarget = normalizeName(groupName);
            const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
            const match = entries.find(e => {
                return e.isDirectory() && normalizeName(e.name) === normalizedTarget;
            });
            
            if (match) {
                groupPath = path.join(DOWNLOADS_DIR, match.name);
                // console.log(`📂 Fuzzy matched folder: "${groupName}" -> "${match.name}"`);
            } else {
                // console.log(`❌ Folder not found for: "${groupName}"`);
                return res.json({ total: 0, page: 1, limit: 50, files: [] });
            }
        }
        
        const filter = req.query.type || 'all';
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        
        const files = await getGroupFiles(groupPath, filter);
        const start = (page - 1) * limit;
        const paginated = files.slice(start, start + limit);
        
        res.json({ total: files.length, page, limit, files: paginated });
    } catch (error) {
        console.error(`Error loading files for ${req.params.group}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ============ FILE INFO API ============

app.get('/api/file-info', async (req, res) => {
    try {
        const filePath = path.join(DOWNLOADS_DIR, req.query.path);
        
        if (!fsSync.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        const stats = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();
        
        const info = {
            name: path.basename(filePath),
            path: req.query.path,
            size: stats.size,
            sizeFormatted: formatBytes(stats.size),
            created: stats.birthtime,
            modified: stats.mtime,
            extension: ext,
            type: getFileType(ext)
        };
        
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            try {
                const dimensions = await getImageDimensions(filePath);
                info.dimensions = dimensions;
            } catch (e) {}
        }
        
        res.json(info);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ DELETE FILE API ============

app.delete('/api/file', async (req, res) => {
    try {
        const filePath = req.query.path;
        
        if (!filePath) {
            return res.status(400).json({ error: 'File path is required' });
        }
        
        // Parse the path: GroupName/subpath/file.ext
        const pathParts = filePath.split('/');
        if (pathParts.length < 2) {
            return res.status(400).json({ error: 'Invalid path format' });
        }
        
        const groupName = pathParts[0];
        const remainingPath = pathParts.slice(1).join('/');
        
        // Find matching folder (fuzzy match like file serving)
        const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
        const directories = entries.filter(e => e.isDirectory());
        
        const normalizedTarget = normalizeName(groupName);
        const matchedDir = directories.find(d => normalizeName(d.name) === normalizedTarget);
        
        if (!matchedDir) {
            console.log(`Delete: No match for group "${groupName}" (normalized: "${normalizedTarget}")`);
            return res.status(404).json({ error: 'Group folder not found' });
        }
        
        // Build full path
        const fullPath = path.join(DOWNLOADS_DIR, matchedDir.name, remainingPath);
        
        // Security check
        if (!fullPath.startsWith(DOWNLOADS_DIR)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (!fsSync.existsSync(fullPath)) {
            console.log(`Delete: File not found at "${fullPath}"`);
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Check if it's actually a file (not a directory)
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
            return res.status(400).json({ error: 'Cannot delete directories' });
        }
        
        // Delete the file
        await fs.unlink(fullPath);
        
        console.log(`🗑️  Deleted: ${matchedDir.name}/${remainingPath}`);
        res.json({ success: true, message: 'File deleted successfully' });
        
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ STATS API ============

app.get('/api/stats', async (req, res) => {
    try {
        const diskUsagePath = path.join(DATA_DIR, 'disk_usage.json');
        let diskUsage = { size: 0 };
        
        if (fsSync.existsSync(diskUsagePath)) {
            diskUsage = JSON.parse(await fs.readFile(diskUsagePath, 'utf8'));
        }
        
        const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        
        let totalFiles = 0, totalImages = 0, totalVideos = 0;
        
        if (fsSync.existsSync(DOWNLOADS_DIR)) {
            const groups = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
            for (const group of groups) {
                if (group.isDirectory()) {
                    const stats = await getGroupStats(path.join(DOWNLOADS_DIR, group.name));
                    totalFiles += stats.totalFiles;
                    totalImages += stats.types?.images || 0;
                    totalVideos += stats.types?.videos || 0;
                }
            }
        }
        
        res.json({
            diskUsage: diskUsage.size,
            diskUsageFormatted: formatBytes(diskUsage.size),
            maxDiskSize: config.diskManagement?.maxTotalSize || '0',
            totalGroups: config.groups?.length || 0,
            enabledGroups: config.groups?.filter(g => g.enabled).length || 0,
            totalFiles, totalImages, totalVideos,
            telegramConnected: isConnected
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// [NEW] Get group/channel profile photo
app.get('/api/groups/:id/photo', async (req, res) => {
    try {
        const url = await downloadProfilePhoto(req.params.id);
        if (url) {
            return res.redirect(url);
        }
        res.status(404).send('Not found');
    } catch (e) {
        console.error('Error fetching photo:', e);
        res.status(500).send(e.message);
    }
});

// ============ HELPER FUNCTIONS ============

async function getGroupStats(groupPath) {
    let totalFiles = 0, totalSize = 0;
    const types = { images: 0, videos: 0, documents: 0, audio: 0, stickers: 0, others: 0 };
    
    const scanDir = async (dir) => {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (types.hasOwnProperty(entry.name)) {
                        const subEntries = await fs.readdir(fullPath);
                        types[entry.name] = subEntries.length;
                        totalFiles += subEntries.length;
                        
                        for (const f of subEntries) {
                            try {
                                const stats = await fs.stat(path.join(fullPath, f));
                                totalSize += stats.size;
                            } catch (e) {}
                        }
                    } else {
                        await scanDir(fullPath);
                    }
                } else {
                    totalFiles++;
                    const stats = await fs.stat(fullPath);
                    totalSize += stats.size;
                }
            }
        } catch (e) {}
    };
    
    await scanDir(groupPath);
    return { totalFiles, totalSize, sizeFormatted: formatBytes(totalSize), types };
}

async function getGroupFiles(groupPath, filter = 'all') {
    const files = [];
    
    const scanDir = async (dir, relativePath = '') => {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                
                if (entry.isDirectory()) {
                    await scanDir(fullPath, relPath);
                } else {
                    const ext = path.extname(entry.name).toLowerCase();
                    const type = getFileType(ext);
                    
                    if (filter === 'all' || type === filter) {
                        const stats = await fs.stat(fullPath);
                        files.push({
                            name: entry.name,
                            path: relPath,
                            fullPath: path.basename(groupPath) + '/' + relPath,
                            size: stats.size,
                            sizeFormatted: formatBytes(stats.size),
                            modified: stats.mtime,
                            type,
                            extension: ext
                        });
                    }
                }
            }
        } catch (e) {}
    };
    
    await scanDir(groupPath);
    files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return files;
}

function getFileType(ext) {
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif'];
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
    const audioExts = ['.mp3', '.ogg', '.wav', '.flac', '.m4a'];
    const stickerExts = ['.tgs', '.webp'];
    
    if (imageExts.includes(ext)) return 'images';
    if (videoExts.includes(ext)) return 'videos';
    if (audioExts.includes(ext)) return 'audio';
    if (stickerExts.includes(ext)) return 'stickers';
    return 'documents';
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getImageDimensions(filePath) {
    const buffer = Buffer.alloc(24);
    const fd = await fs.open(filePath, 'r');
    await fd.read(buffer, 0, 24, 0);
    await fd.close();
    
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    return null;
}

// ============ DELETE FILE API ============

app.delete('/api/file', async (req, res) => {
    try {
        const filePath = req.query.path;
        
        if (!filePath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        
        // Security: Ensure path is within DOWNLOADS_DIR
        const absolutePath = path.resolve(filePath);
        const relative = path.relative(DOWNLOADS_DIR, absolutePath);
        
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return res.status(403).json({ error: 'Access denied - path outside downloads folder' });
        }
        
        // Check file exists
        if (!fsSync.existsSync(absolutePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Check it's a file not directory
        const stat = fsSync.statSync(absolutePath);
        if (stat.isDirectory()) {
            return res.status(400).json({ error: 'Cannot delete directories' });
        }
        
        // Delete the file
        await fs.unlink(absolutePath);
        
        console.log(`🗑️ Deleted file: ${path.basename(absolutePath)}`);
        
        // Broadcast deletion
        broadcast({ type: 'file_deleted', path: filePath });
        
        res.json({ success: true, message: 'File deleted' });
    } catch (error) {
        console.error('Delete file error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ WEBSOCKET ============

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) client.send(message);
    });
}

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🌐 Telegram Downloader - Configuration GUI              ║
║                                                            ║
║   Server: http://localhost:${PORT}                          ║
║                                                            ║
║   Features:                                                ║
║   • View Downloads (Gallery)                               ║
║   • Configure Groups (Enable/Disable/Filters)              ║
║   • System Settings (Disk/Speed/Path)                      ║
║   • Real Profile Photos from Telegram                      ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
    
    // Connect to Telegram for profile photos
    await connectTelegram();
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (telegramClient) await telegramClient.disconnect();
    process.exit(0);
});

export { broadcast };
