/**
 * Translate the user-facing config.proxy block into the structure that
 * gramJS's TelegramClient constructor expects.
 *
 * Config shape (config.proxy):
 *   { type: 'socks5' | 'socks4' | 'mtproxy' | 'http', host, port,
 *     username?, password?, secret? }
 *
 * Returns null when no proxy is configured (so callers can pass it through
 * unchanged to the TelegramClient options).
 */

export function buildProxy(config) {
    const p = config?.proxy;
    if (!p || !p.host || !p.port) return null;
    const port = parseInt(p.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

    const type = String(p.type || 'socks5').toLowerCase();

    if (type === 'mtproxy') {
        if (!p.secret) throw new Error('MTProxy requires a "secret"');
        return { ip: p.host, port, MTProxy: true, secret: p.secret };
    }
    if (type === 'socks5' || type === 'socks4') {
        const out = { ip: p.host, port, socksType: type === 'socks4' ? 4 : 5 };
        if (p.username) out.username = p.username;
        if (p.password) out.password = p.password;
        return out;
    }
    if (type === 'http') {
        // gramJS's WebSocket transport doesn't natively tunnel through HTTP
        // proxies on Node — surface a clear error instead of silently failing.
        throw new Error('HTTP proxy is not supported by gramJS in this build. Use SOCKS5 or MTProxy.');
    }
    throw new Error(`Unknown proxy type: ${type}`);
}

export function describeProxy(config) {
    const p = config?.proxy;
    if (!p || !p.host) return 'none';
    return `${(p.type || 'socks5').toUpperCase()} ${p.host}:${p.port}`;
}
