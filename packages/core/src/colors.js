export const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

export const colorize = (text, ...styles) => 
    styles.map(s => colors[s] || '').join('') + text + colors.reset;

export const clearScreen = () => 
    process.stdout.write('\x1b[2J\x1b[H');



export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const size = typeof bytes === 'bigint' ? Number(bytes) : bytes;
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(size) / Math.log(k));
    return parseFloat((size / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
