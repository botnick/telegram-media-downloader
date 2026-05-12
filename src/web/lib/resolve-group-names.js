import { loadConfig } from '../../config/manager.js';
import { getDb } from '../../core/db.js';
import { writeConfigAtomic } from './config-writer.js';

/**
 * Resolve group names from Telegram API for DB records with NULL or default group_name.
 * Strategy: 1) fetch dialogs and match by normalized ID, 2) fallback to getEntity for unmatched.
 * Also fixes config.json entries with generic names.
 */
export async function resolveGroupNamesFromTelegram({ getTelegramClient, getIsConnected }) {
    const telegramClient = getTelegramClient?.();
    if (!telegramClient || !getIsConnected?.()) return;
    try {
        // Collect all IDs that need fixing (from config)
        let config;
        try {
            config = loadConfig();
        } catch {
            config = { groups: [] };
        }
        const configUnknowns = (config.groups || []).filter(
            (g) => !g.name || g.name.startsWith('Group '),
        );

        // Also check DB
        const db = getDb();
        const dbUnknowns = db
            .prepare(
                `SELECT DISTINCT group_id FROM downloads WHERE group_name IS NULL OR group_name LIKE 'Group %'`,
            )
            .all();

        if (dbUnknowns.length === 0 && configUnknowns.length === 0) return;

        // Collect all unique IDs that need resolution
        const needIds = new Set();
        configUnknowns.forEach((g) => needIds.add(String(g.id)));
        dbUnknowns.forEach((r) => needIds.add(r.group_id));

        console.log(`🔍 Resolving names for ${needIds.size} groups: ${[...needIds].join(', ')}`);

        // Strategy 1: Fetch dialogs and build lookup
        const resolvedNames = new Map(); // raw ID string -> resolved name
        try {
            const dialogs = await telegramClient.getDialogs({ limit: 500 });
            const normalize = (id) => String(id).replace(/^-100/, '').replace(/^-/, '');

            for (const rawId of needIds) {
                const nid = normalize(rawId);
                for (const d of dialogs) {
                    const dnid = normalize(d.id);
                    if (dnid === nid) {
                        const title = d.title || d.name;
                        if (title) {
                            resolvedNames.set(rawId, title);
                            console.log(`  📌 Dialog match: ${rawId} → "${title}"`);
                        }
                        break;
                    }
                }
            }
        } catch (e) {
            console.log(`  ⚠️ getDialogs failed: ${e.message}`);
        }

        // Strategy 2: For unresolved, try getEntity directly
        for (const rawId of needIds) {
            if (resolvedNames.has(rawId)) continue;

            // Try multiple ID formats
            const candidates = [Number(rawId), BigInt(rawId)];
            // If it starts with -, also try -100 prefix variant
            if (rawId.startsWith('-') && !rawId.startsWith('-100')) {
                candidates.push(Number('-100' + rawId.slice(1)));
                candidates.push(BigInt('-100' + rawId.slice(1)));
            }

            for (const tryId of candidates) {
                try {
                    const entity = await telegramClient.getEntity(tryId);
                    if (entity) {
                        const title = entity.title || entity.firstName || entity.username;
                        if (title) {
                            resolvedNames.set(rawId, title);
                            console.log(`  📌 Entity match: ${rawId} → "${title}"`);
                            break;
                        }
                    }
                } catch {
                    /* try next format */
                }
            }
        }

        // Apply fixes to DB
        let dbResolved = 0;
        const stmt = db.prepare(
            `UPDATE downloads SET group_name = ? WHERE group_id = ? AND (group_name IS NULL OR group_name LIKE 'Group %')`,
        );
        for (const row of dbUnknowns) {
            const name = resolvedNames.get(row.group_id);
            if (name) {
                stmt.run(name, row.group_id);
                dbResolved++;
            }
        }

        // Apply fixes to config
        let configChanged = false;
        let configResolved = 0;
        for (const g of configUnknowns) {
            const name = resolvedNames.get(String(g.id));
            if (name) {
                g.name = name;
                configChanged = true;
                configResolved++;
            }
        }
        if (configChanged) {
            await writeConfigAtomic(config);
        }

        const total = resolvedNames.size;
        const failed = needIds.size - total;
        if (total > 0)
            console.log(
                `✅ Resolved ${total} group names (${dbResolved} DB, ${configResolved} config)`,
            );
        if (failed > 0)
            console.log(`⚠️  ${failed} groups could not be resolved (may have left the group)`);
    } catch (e) {
        console.log('⚠️ Could not resolve group names:', e.message);
    }
}
