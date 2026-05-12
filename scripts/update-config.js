#!/usr/bin/env node
/**
 * Update group auto-forward settings in the SQLite kv-store config.
 *
 * Usage:
 *   node scripts/update-config.js <group-name> <key>=<value> [<key>=<value> ...]
 *
 * Examples:
 *   # Set keepImages for all groups
 *   node scripts/update-config.js --all keepImages=true
 *
 *   # Set keepVideos=true for specific groups
 *   node scripts/update-config.js "Keyshia barbie" keepVideos=true
 *   node scripts/update-config.js "X POSES" keepVideos=true
 *
 *   # Multiple keys at once
 *   node scripts/update-config.js "X POSES" keepImages=true keepVideos=true deleteAfterForward=false
 *
 *   # List current settings
 *   node scripts/update-config.js --list
 */

import { getDb } from '../src/core/db.js';

const db = getDb();
const row = db.prepare(`SELECT value FROM kv WHERE key = 'config'`).get();
if (!row) {
    console.error('No config found in kv store');
    process.exit(1);
}

const config = JSON.parse(row.value);

function list() {
    console.log('Group settings:\n');
    for (const g of config.groups || []) {
        const af = g.autoForward || {};
        console.log(
            `${g.name.padEnd(35)} ` +
                `enabled=${String(g.enabled ?? true).padEnd(5)} ` +
                `delete=${String(af.deleteAfterForward ?? false).padEnd(5)} ` +
                `keepImgs=${String(af.keepImages ?? false).padEnd(5)} ` +
                `keepVids=${String(af.keepVideos ?? false).padEnd(5)} ` +
                `rescue=${g.rescueMode || 'auto'}`,
        );
    }
}

// Parse args
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: node scripts/update-config.js <group-name> <key>=<value> [...]');
    console.log('       node scripts/update-config.js --all <key>=<value> [...]');
    console.log('       node scripts/update-config.js --list');
    process.exit(0);
}

if (args[0] === '--list') {
    list();
    process.exit(0);
}

let targetGroups;
let keyValues = [];

if (args[0] === '--all') {
    targetGroups = config.groups || [];
    keyValues = args.slice(1);
} else {
    const groupName = args[0];
    targetGroups = (config.groups || []).filter((g) => g.name === groupName);
    if (targetGroups.length === 0) {
        console.error(`No group found matching "${groupName}"`);
        console.log('Available groups:');
        for (const g of config.groups || []) console.log(`  ${g.name}`);
        process.exit(1);
    }
    keyValues = args.slice(1);
}

// Parse key=value pairs
const updates = {};
for (const kv of keyValues) {
    const m = kv.match(/^(\w+)=(.*)$/);
    if (!m) {
        console.error(`Invalid key=value: ${kv}`);
        process.exit(1);
    }
    const [, key, val] = m;
    // Auto-convert booleans and numbers
    if (val === 'true') updates[key] = true;
    else if (val === 'false') updates[key] = false;
    else if (/^\d+$/.test(val)) updates[key] = parseInt(val, 10);
    else updates[key] = val;
}

for (const g of targetGroups) {
    if (!g.autoForward) g.autoForward = {};
    Object.assign(g.autoForward, updates);
    console.log(`✓ Updated ${g.name}: ${JSON.stringify(updates)}`);
}

// Write back
const stmt = db.prepare(`UPDATE kv SET value = ? WHERE key = 'config'`);
stmt.run(JSON.stringify(config));

console.log('\nFinal state:');
list();
