export function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function nameLooksUnresolved(name, id) {
    if (!name) return true;
    const s = String(name).trim();
    if (!s) return true;
    if (s === 'Unknown' || s === 'unknown') return true;
    if (id != null && s === String(id)) return true;
    if (/^-?\d{6,}$/.test(s)) return true;
    if (/^Group\s/i.test(s)) return true;
    return false;
}

// Resolution priority: live Telegram dialogs name → config label → DB name → placeholder.
export function bestGroupName(id, configName, dbName, dialogsName) {
    if (!nameLooksUnresolved(dialogsName, id)) return dialogsName;
    if (!nameLooksUnresolved(configName, id)) return configName;
    if (!nameLooksUnresolved(dbName, id)) return dbName;
    return `Unknown chat (#${id})`;
}
