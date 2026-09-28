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
        if (segs.length < 3)
            throw new UrlParseError('Private-channel URL must include a message id');
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
        m[2].split('&').map((p) => p.split('=').map(decodeURIComponent)),
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
    try {
        urlObj = new URL(trimmed);
    } catch {
        throw new UrlParseError('Not a valid URL');
    }
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
        .map((s) => s.trim())
        .filter(Boolean);
}

// t.me paths that are not chats (sticker sets, proxies, themes, folders…).
const NON_CHAT_PATHS = new Set([
    'addemoji',
    'addlist',
    'addstickers',
    'addtheme',
    'bg',
    'boost',
    'confirmphone',
    'contact',
    'giftcode',
    'invoice',
    'iv',
    'login',
    'proxy',
    'setlanguage',
    'share',
    'socks',
]);
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;
const TME_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);

/**
 * Classify what someone typed into the dashboard's "Add" box:
 *
 *   { kind: 'message', chatRef, messageId, topicId? }  a message link
 *   { kind: 'username', username }                   @name, t.me/name, tg://resolve?domain=name
 *   { kind: 'invite', hash }                         t.me/+HASH, t.me/joinchat/HASH, tg://join?invite=HASH
 *   { kind: 'id', chatRef }                          t.me/c/<id>, -100<id>
 *   { kind: 'name', text }                           anything else — search your chats by name
 *   { kind: 'unsupported', reason }                  a t.me link that isn't a chat (stickers, proxy…)
 *
 * Never throws; parseTelegramUrl() stays the strict parser for downloads.
 */
export function parseChatQuery(input) {
    const text = String(input ?? '').trim();
    if (!text) return { kind: 'name', text: '' };

    if (/^-?100\d{5,}$/.test(text)) return { kind: 'id', chatRef: toChannelId(text) };

    if (text.startsWith('@')) {
        const u = text.slice(1);
        return USERNAME_RE.test(u) ? { kind: 'username', username: u } : { kind: 'name', text };
    }

    if (/^tg:\/\//i.test(text)) return classifyTgScheme(text);

    // t.me links, with or without the scheme.
    const withScheme = /^(t\.me|telegram\.me|telegram\.dog)\//i.test(text)
        ? `https://${text}`
        : text;
    let url;
    try {
        url = new URL(withScheme);
    } catch {
        return { kind: 'name', text };
    }
    const host = url.host.toLowerCase().replace(/^www\./, '');
    if (!TME_HOSTS.has(host)) return { kind: 'name', text };

    let segs = url.pathname.split('/').filter(Boolean);
    if (segs[0] === 's') segs = segs.slice(1); // t.me/s/<name> is the web preview
    if (!segs.length) return { kind: 'unsupported', reason: 'Not a chat link' };

    const first = segs[0];
    if (first.startsWith('+')) {
        const hash = first.slice(1);
        // t.me/+<digits> is a phone number, not an invite.
        if (!hash || /^\d+$/.test(hash)) return { kind: 'unsupported', reason: 'Not a chat link' };
        return { kind: 'invite', hash };
    }
    if (first.toLowerCase() === 'joinchat') {
        return segs[1]
            ? { kind: 'invite', hash: segs[1] }
            : { kind: 'unsupported', reason: 'Not a chat link' };
    }
    if (first === 'c') {
        if (!segs[1] || !/^\d+$/.test(segs[1])) {
            return { kind: 'unsupported', reason: 'Private-channel link without a chat id' };
        }
        if (segs.length === 2) return { kind: 'id', chatRef: toChannelId(segs[1]) };
    } else {
        if (NON_CHAT_PATHS.has(first.toLowerCase()) || !USERNAME_RE.test(first)) {
            return { kind: 'unsupported', reason: 'Not a chat link' };
        }
        if (segs.length === 1) return { kind: 'username', username: first };
    }
    try {
        const parsed = parseTmeHttp(`https://t.me/${segs.join('/')}`);
        if (
            !Number.isFinite(parsed.messageId) ||
            (parsed.topicId !== undefined && !Number.isFinite(parsed.topicId))
        ) {
            return { kind: 'unsupported', reason: 'Bad message id' };
        }
        return { kind: 'message', ...parsed };
    } catch (e) {
        return { kind: 'unsupported', reason: e.message };
    }
}

function classifyTgScheme(text) {
    const m = text.match(/^tg:\/\/(\w+)\?(.*)$/i);
    if (!m) return { kind: 'unsupported', reason: 'Unknown tg:// link' };
    const action = m[1].toLowerCase();
    const params = new URLSearchParams(m[2]);
    if (action === 'join') {
        const hash = params.get('invite');
        return hash ? { kind: 'invite', hash } : { kind: 'unsupported', reason: 'Empty invite' };
    }
    if (action === 'resolve' && !params.get('post')) {
        const u = params.get('domain') || '';
        return USERNAME_RE.test(u)
            ? { kind: 'username', username: u }
            : { kind: 'unsupported', reason: 'Not a chat link' };
    }
    try {
        const parsed = parseTgScheme(text);
        if (!Number.isFinite(parsed.messageId)) {
            return { kind: 'unsupported', reason: 'Bad message id' };
        }
        return { kind: 'message', ...parsed };
    } catch (e) {
        return { kind: 'unsupported', reason: e.message };
    }
}
