/**
 * Parses Telegram message URLs to a uniform { chatRef, messageId, topicId? }
 * shape that the downloader can resolve via getEntity + getMessages.
 *
 * Supported inputs:
 *   https://t.me/<username>/<msg>
 *   https://t.me/<username>/<topic>/<msg>
 *   https://t.me/c/<channel-id>/<msg>             (private channel)
 *   https://t.me/c/<channel-id>/<topic>/<msg>     (private channel forum topic)
 *   https://telegram.me/...   (legacy alias for t.me)
 *   tg://resolve?domain=<username>&post=<msg>
 *   tg://privatepost?channel=<channel-id>&post=<msg>
 *
 * Numeric chat IDs that come from the t.me/c/ form get re-prefixed with -100
 * so the result matches the IDs used elsewhere in the codebase.
 */

export class UrlParseError extends Error {}

function toChannelId(id) {
    const n = String(id).replace(/^-?100/, '');
    if (!/^\d+$/.test(n)) throw new UrlParseError('Channel id is not numeric');
    return `-100${n}`;
}

function parseTmeHttp(url) {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) throw new UrlParseError('Telegram URL is missing the message id');

    if (segs[0] === 'c') {
        // /c/<id>/<msg> or /c/<id>/<topic>/<msg>
        if (segs.length < 3) throw new UrlParseError('Private-channel URL must include a message id');
        const chatRef = toChannelId(segs[1]);
        if (segs.length === 3) {
            return { chatRef, messageId: parseInt(segs[2], 10) };
        }
        return {
            chatRef,
            topicId: parseInt(segs[2], 10),
            messageId: parseInt(segs[3], 10),
        };
    }
    // Public: /<username>/<msg> or /<username>/<topic>/<msg>
    const username = `@${segs[0]}`;
    if (segs.length === 2) return { chatRef: username, messageId: parseInt(segs[1], 10) };
    return {
        chatRef: username,
        topicId: parseInt(segs[1], 10),
        messageId: parseInt(segs[2], 10),
    };
}

function parseTgScheme(url) {
    const m = url.match(/^tg:\/\/(\w+)\?(.+)$/);
    if (!m) throw new UrlParseError('Unknown tg:// URL');
    const action = m[1];
    const params = Object.fromEntries(
        m[2].split('&').map(p => p.split('=').map(decodeURIComponent)),
    );
    if (action === 'resolve') {
        if (!params.domain) throw new UrlParseError('tg://resolve missing domain');
        if (!params.post) throw new UrlParseError('tg://resolve missing post');
        const out = { chatRef: `@${params.domain}`, messageId: parseInt(params.post, 10) };
        if (params.thread) out.topicId = parseInt(params.thread, 10);
        return out;
    }
    if (action === 'privatepost') {
        if (!params.channel) throw new UrlParseError('tg://privatepost missing channel');
        if (!params.post) throw new UrlParseError('tg://privatepost missing post');
        const out = { chatRef: toChannelId(params.channel), messageId: parseInt(params.post, 10) };
        if (params.thread) out.topicId = parseInt(params.thread, 10);
        return out;
    }
    throw new UrlParseError(`Unsupported tg:// action: ${action}`);
}

export function parseTelegramUrl(input) {
    if (typeof input !== 'string') throw new UrlParseError('URL must be a string');
    const trimmed = input.trim();
    if (!trimmed) throw new UrlParseError('Empty URL');

    if (trimmed.startsWith('tg://')) return parseTgScheme(trimmed);

    let urlObj;
    try { urlObj = new URL(trimmed); } catch { throw new UrlParseError('Not a valid URL'); }
    const host = urlObj.host.toLowerCase();
    if (host !== 't.me' && host !== 'telegram.me' && host !== 'telegram.dog') {
        throw new UrlParseError(`Unsupported host: ${host}`);
    }
    return parseTmeHttp(trimmed);
}

/** Splits a multi-line text input into individual URLs (newline-separated). */
export function parseUrlList(text) {
    return String(text || '')
        .split(/[\r\n]+/)
        .map(s => s.trim())
        .filter(Boolean);
}
