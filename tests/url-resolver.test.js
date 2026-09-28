import { describe, it, expect } from 'vitest';
import {
    parseTelegramUrl,
    parseUrlList,
    parseChatQuery,
    UrlParseError,
} from '../src/core/url-resolver.js';

describe('parseTelegramUrl', () => {
    it('parses public channel /<chan>/<msg>', () => {
        expect(parseTelegramUrl('https://t.me/durov/100')).toEqual({
            chatRef: '@durov',
            messageId: 100,
        });
    });

    it('parses private channel /c/<id>/<msg> and re-prefixes -100', () => {
        expect(parseTelegramUrl('https://t.me/c/1234567890/55')).toEqual({
            chatRef: '-1001234567890',
            messageId: 55,
        });
    });

    it('parses forum-topic /c/<id>/<topic>/<msg>', () => {
        expect(parseTelegramUrl('https://t.me/c/1234567890/4/55')).toEqual({
            chatRef: '-1001234567890',
            topicId: 4,
            messageId: 55,
        });
    });

    it('parses public forum-topic /<chan>/<topic>/<msg>', () => {
        expect(parseTelegramUrl('https://t.me/somechan/3/100')).toEqual({
            chatRef: '@somechan',
            topicId: 3,
            messageId: 100,
        });
    });

    it('accepts the telegram.me alias', () => {
        expect(parseTelegramUrl('https://telegram.me/foo/42')).toEqual({
            chatRef: '@foo',
            messageId: 42,
        });
    });

    it('parses tg://resolve', () => {
        expect(parseTelegramUrl('tg://resolve?domain=foo&post=42')).toEqual({
            chatRef: '@foo',
            messageId: 42,
        });
    });

    it('parses tg://privatepost with optional thread', () => {
        expect(parseTelegramUrl('tg://privatepost?channel=123&post=99&thread=8')).toEqual({
            chatRef: '-100123',
            messageId: 99,
            topicId: 8,
        });
    });

    it('rejects unsupported hosts', () => {
        expect(() => parseTelegramUrl('https://example.com/foo')).toThrow(UrlParseError);
    });

    it('rejects malformed URLs', () => {
        expect(() => parseTelegramUrl('not-a-url')).toThrow(UrlParseError);
    });

    it('rejects empty input', () => {
        expect(() => parseTelegramUrl('')).toThrow(UrlParseError);
    });

    it('rejects unknown tg:// actions', () => {
        expect(() => parseTelegramUrl('tg://nonsense?foo=bar')).toThrow(UrlParseError);
    });
});

describe('parseUrlList', () => {
    it('splits on newlines and trims', () => {
        expect(parseUrlList('a\nb\r\n  c \n')).toEqual(['a', 'b', 'c']);
    });

    it('returns [] for empty input', () => {
        expect(parseUrlList('')).toEqual([]);
        expect(parseUrlList(null)).toEqual([]);
    });
});

describe('parseChatQuery', () => {
    it('treats plain text as a name search', () => {
        expect(parseChatQuery('Nature shots')).toEqual({ kind: 'name', text: 'Nature shots' });
        expect(parseChatQuery('  ')).toEqual({ kind: 'name', text: '' });
        expect(parseChatQuery('@x y')).toEqual({ kind: 'name', text: '@x y' });
        expect(parseChatQuery('https://example.com/durov')).toEqual({
            kind: 'name',
            text: 'https://example.com/durov',
        });
    });

    it('recognises @usernames and public links', () => {
        const want = { kind: 'username', username: 'durov' };
        expect(parseChatQuery('@durov')).toEqual(want);
        expect(parseChatQuery('https://t.me/durov')).toEqual(want);
        expect(parseChatQuery('t.me/durov')).toEqual(want);
        expect(parseChatQuery('https://www.t.me/durov/')).toEqual(want);
        expect(parseChatQuery('https://t.me/s/durov')).toEqual(want);
        expect(parseChatQuery('tg://resolve?domain=durov')).toEqual(want);
    });

    it('recognises invite links', () => {
        const want = { kind: 'invite', hash: 'AbCdEf123' };
        expect(parseChatQuery('https://t.me/+AbCdEf123')).toEqual(want);
        expect(parseChatQuery('t.me/joinchat/AbCdEf123')).toEqual(want);
        expect(parseChatQuery('tg://join?invite=AbCdEf123')).toEqual(want);
    });

    it('recognises message links', () => {
        expect(parseChatQuery('https://t.me/durov/100')).toEqual({
            kind: 'message',
            chatRef: '@durov',
            messageId: 100,
        });
        expect(parseChatQuery('https://t.me/s/durov/100')).toEqual({
            kind: 'message',
            chatRef: '@durov',
            messageId: 100,
        });
        expect(parseChatQuery('https://t.me/c/1234567890/55?single')).toEqual({
            kind: 'message',
            chatRef: '-1001234567890',
            messageId: 55,
        });
        expect(parseChatQuery('tg://privatepost?channel=1234567890&post=7')).toEqual({
            kind: 'message',
            chatRef: '-1001234567890',
            messageId: 7,
        });
    });

    it('recognises private chat ids', () => {
        const want = { kind: 'id', chatRef: '-1001234567890' };
        expect(parseChatQuery('https://t.me/c/1234567890')).toEqual(want);
        expect(parseChatQuery('-1001234567890')).toEqual(want);
    });

    it('flags t.me links that are not chats', () => {
        expect(parseChatQuery('https://t.me/addstickers/Animals').kind).toBe('unsupported');
        expect(parseChatQuery('https://t.me/+66812345678').kind).toBe('unsupported');
        expect(parseChatQuery('https://t.me/').kind).toBe('unsupported');
        expect(parseChatQuery('https://t.me/durov/abc').kind).toBe('unsupported');
        expect(parseChatQuery('tg://join').kind).toBe('unsupported');
    });
});
