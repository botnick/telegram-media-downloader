import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-tag-suggest-test-'));

let db;
let getTagCooccurrenceSuggestions;
let setImageTags;
let insertDownload;

beforeAll(async () => {
    process.env.TGDL_DATA_DIR = DATA_DIR;
    const dbApi = await import('../../src/core/db.js');
    db = dbApi.getDb();
    insertDownload = dbApi.insertDownload;
    const facesApi = await import('../../src/core/db/faces.js');
    getTagCooccurrenceSuggestions = facesApi.getTagCooccurrenceSuggestions;
    setImageTags = facesApi.setImageTags;
    // Disable foreign keys for tests to simplify setup
    db.pragma('foreign_keys = OFF');
});

let _downloadCounter = 1000;

function _createDownload() {
    const id = _downloadCounter++;
    insertDownload({
        groupId: `-100${id}`,
        groupName: `Test Group ${id}`,
        messageId: id,
        fileName: `test${id}.jpg`,
        fileSize: 1000,
        filePath: `data/downloads/test${id}.jpg`,
        fileType: 'photo',
        createdAt: Math.floor(Date.now() / 1000),
    });
    return id;
}

afterAll(() => {
    try {
        db.pragma('foreign_keys = ON');
        db.close();
    } catch {}
    delete process.env.TGDL_DATA_DIR;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('Tag Cooccurrence Suggestions', () => {
    it('should return empty array when no tags exist', () => {
        const suggestions = getTagCooccurrenceSuggestions();
        expect(suggestions).toEqual([]);
    });

    it('should return empty array when fewer than 2 tags', () => {
        const id1 = _createDownload();
        setImageTags(id1, [{ tag: 'cat', score: 0.9 }]);
        const suggestions = getTagCooccurrenceSuggestions();
        expect(suggestions).toEqual([]);
    });

    it('should suggest tags that appear together frequently', () => {
        // Create downloads
        const id1 = _createDownload();
        const id2 = _createDownload();
        const id3 = _createDownload();
        const id4 = _createDownload();

        // Image 1 has both 'cat' and 'kitten'
        setImageTags(id1, [
            { tag: 'cat', score: 0.95 },
            { tag: 'kitten', score: 0.92 },
        ]);

        // Image 2 has both 'cat' and 'kitten'
        setImageTags(id2, [
            { tag: 'cat', score: 0.94 },
            { tag: 'kitten', score: 0.91 },
        ]);

        // Image 3 has only 'cat'
        setImageTags(id3, [{ tag: 'cat', score: 0.9 }]);

        // Image 4 has 'dog'
        setImageTags(id4, [{ tag: 'dog', score: 0.88 }]);

        const suggestions = getTagCooccurrenceSuggestions({ minCooccurrenceRate: 0.5 });

        expect(suggestions.length).toBeGreaterThan(0);
        const catKittenPair = suggestions.find(
            (s) =>
                (s.tag1 === 'cat' && s.tag2 === 'kitten') ||
                (s.tag1 === 'kitten' && s.tag2 === 'cat'),
        );
        expect(catKittenPair).toBeDefined();
        expect(catKittenPair.images_together).toBe(2);
        expect(catKittenPair.cooccurrence_rate).toBeGreaterThanOrEqual(0.5);
    });

    it('should respect minCooccurrenceRate parameter', () => {
        const id1 = _createDownload();
        const id2 = _createDownload();
        const id3 = _createDownload();
        const id4 = _createDownload();

        setImageTags(id1, [
            { tag: 'sunset', score: 0.85 },
            { tag: 'beach', score: 0.8 },
        ]);
        setImageTags(id2, [
            { tag: 'sunset', score: 0.86 },
            { tag: 'beach', score: 0.81 },
        ]);
        setImageTags(id3, [{ tag: 'sunset', score: 0.87 }]);
        setImageTags(id4, [{ tag: 'sunset', score: 0.88 }]);

        const lowThreshold = getTagCooccurrenceSuggestions({ minCooccurrenceRate: 0.3 });
        const highThreshold = getTagCooccurrenceSuggestions({ minCooccurrenceRate: 0.8 });

        expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
    });

    it('should respect minImagesPerTag parameter', () => {
        const id1 = _createDownload();
        const id2 = _createDownload();
        const id3 = _createDownload();
        const id4 = _createDownload();

        // Rare tag pair
        setImageTags(id1, [
            { tag: 'rare1', score: 0.9 },
            { tag: 'rare2', score: 0.9 },
        ]);

        // Common tags
        setImageTags(id2, [
            { tag: 'common1', score: 0.9 },
            { tag: 'common2', score: 0.9 },
        ]);
        setImageTags(id3, [
            { tag: 'common1', score: 0.9 },
            { tag: 'common2', score: 0.9 },
        ]);
        setImageTags(id4, [
            { tag: 'common1', score: 0.9 },
            { tag: 'common2', score: 0.9 },
        ]);

        const minImages2 = getTagCooccurrenceSuggestions({ minImagesPerTag: 2 });
        const minImages1 = getTagCooccurrenceSuggestions({ minImagesPerTag: 1 });

        // minImages2 should exclude rare tags
        const rareInMin2 = minImages2.some((s) => s.tag1 === 'rare1' || s.tag2 === 'rare1');
        expect(rareInMin2).toBe(false);

        // minImages1 should include rare tags
        const rareInMin1 = minImages1.some((s) => s.tag1 === 'rare1' || s.tag2 === 'rare1');
        expect(rareInMin1).toBe(true);
    });

    it('should sort by cooccurrence rate descending', () => {
        const id1 = _createDownload();
        const id2 = _createDownload();
        const id3 = _createDownload();
        const id4 = _createDownload();
        const id5 = _createDownload();
        const id6 = _createDownload();

        // High cooccurrence pair
        setImageTags(id1, [
            { tag: 'high1', score: 0.9 },
            { tag: 'high2', score: 0.9 },
        ]);
        setImageTags(id2, [
            { tag: 'high1', score: 0.9 },
            { tag: 'high2', score: 0.9 },
        ]);
        setImageTags(id3, [
            { tag: 'high1', score: 0.9 },
            { tag: 'high2', score: 0.9 },
        ]);

        // Low cooccurrence pair
        setImageTags(id4, [
            { tag: 'low1', score: 0.9 },
            { tag: 'low2', score: 0.9 },
        ]);
        setImageTags(id5, [{ tag: 'low1', score: 0.9 }]);
        setImageTags(id6, [{ tag: 'low1', score: 0.9 }]);

        const suggestions = getTagCooccurrenceSuggestions({ minImagesPerTag: 1 });

        // Verify sorted by rate DESC
        for (let i = 0; i < suggestions.length - 1; i++) {
            expect(suggestions[i].cooccurrence_rate).toBeGreaterThanOrEqual(
                suggestions[i + 1].cooccurrence_rate,
            );
        }
    });
});
