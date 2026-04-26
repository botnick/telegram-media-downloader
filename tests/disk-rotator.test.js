import { describe, it, expect } from 'vitest';
import { parseSize } from '../src/core/disk-rotator.js';

describe('parseSize (disk-rotator)', () => {
    it('parses plain numbers as bytes', () => {
        expect(parseSize('1024')).toBe(1024);
        expect(parseSize(512)).toBe(512);
    });

    it('parses unit suffixes (KB / MB / GB / TB)', () => {
        expect(parseSize('10KB')).toBe(10 * 1024);
        expect(parseSize('500 MB')).toBe(500 * 1024 ** 2);
        expect(parseSize('10 GB')).toBe(10 * 1024 ** 3);
        expect(parseSize('1TB')).toBe(1024 ** 4);
    });

    it('is case-insensitive and tolerates whitespace', () => {
        expect(parseSize(' 2 gb ')).toBe(2 * 1024 ** 3);
        expect(parseSize('2gB')).toBe(2 * 1024 ** 3);
    });

    it('accepts fractional values', () => {
        expect(parseSize('1.5 GB')).toBe(Math.floor(1.5 * 1024 ** 3));
    });

    it('returns 0 for falsy / empty / nonsense input (treated as no cap)', () => {
        expect(parseSize(null)).toBe(0);
        expect(parseSize(undefined)).toBe(0);
        expect(parseSize('')).toBe(0);
        expect(parseSize('   ')).toBe(0);
        expect(parseSize('not a size')).toBe(0);
        expect(parseSize('GB10')).toBe(0);
    });

    it('rejects negative values', () => {
        expect(parseSize('-5GB')).toBe(0);
    });
});
