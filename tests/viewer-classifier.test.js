// Smoke test for the file-kind classifier inside src/web/public/js/viewer.js.
// Pure function, zero DOM dependency — exported as `_classifyFileForTests`
// specifically so this test can exercise the dispatch table without
// spinning up jsdom for the rest of the viewer module.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_PATH = join(HERE, '..', 'src/web/public/js/viewer.js');

// The viewer module imports browser-only modules (utils.js / gestures.js)
// transitively. To avoid pulling in jsdom we extract `_classifyFile` from
// the source as a string and re-import via a dynamic data: URL. This keeps
// the test pure-Node and matches what the SPA actually compiles to.
let classify;

beforeAll(async () => {
    const src = readFileSync(VIEWER_PATH, 'utf8');
    // Carve out the function literal exactly as it appears in viewer.js so
    // the test fails fast if the body drifts.
    const match = src.match(/function _classifyFile\(file\) \{[\s\S]*?\n\}/);
    if (!match) throw new Error('Could not locate _classifyFile in viewer.js');
    // Wrap as a module + export so we can `await import(dataUrl)`.
    const wrapped = `${match[0]}\nexport { _classifyFile };`;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(wrapped).toString('base64')}`;
    const mod = await import(dataUrl);
    classify = mod._classifyFile;
});

describe('viewer _classifyFile', () => {
    const cases = [
        // type wins over extension for media tiles
        [{ type: 'images', name: 'cat.jpg' }, 'image'],
        [{ type: 'videos', name: 'clip.mp4' }, 'video'],
        [{ type: 'audio', name: 'song.mp3' }, 'audio'],
        // audio extension recognised even when type is missing
        [{ name: 'song.mp3' }, 'audio'],
        [{ name: 'voice.m4a' }, 'audio'],
        [{ name: 'lossless.flac' }, 'audio'],
        // documents
        [{ name: 'book.pdf' }, 'pdf'],
        [{ name: 'NOTES.md' }, 'markdown'],
        [{ name: 'readme.markdown' }, 'markdown'],
        // text
        [{ name: 'log.txt' }, 'text'],
        [{ name: 'server.log' }, 'text'],
        [{ name: 'export.csv' }, 'text'],
        [{ name: 'data.tsv' }, 'text'],
        [{ name: 'app.env' }, 'text'],
        [{ name: 'config.toml' }, 'text'],
        // code
        [{ name: 'main.js' }, 'code'],
        [{ name: 'index.ts' }, 'code'],
        [{ name: 'snake.py' }, 'code'],
        [{ name: 'app.go' }, 'code'],
        [{ name: 'lib.rs' }, 'code'],
        [{ name: 'page.html' }, 'code'],
        [{ name: 'style.css' }, 'code'],
        [{ name: 'config.yml' }, 'code'],
        [{ name: 'pipeline.yaml' }, 'code'],
        [{ name: 'Dockerfile.dockerfile' }, 'code'],
        // archives
        [{ name: 'pack.zip' }, 'archive'],
        [{ name: 'site.tar.gz' }, 'archive'],
        [{ name: 'site.tgz' }, 'archive'],
        [{ name: 'bundle.7z' }, 'archive'],
        [{ name: 'old.rar' }, 'archive'],
        // office (placeholder branch)
        [{ name: 'report.docx' }, 'office'],
        [{ name: 'budget.xlsx' }, 'office'],
        [{ name: 'deck.pptx' }, 'office'],
        // fallback for the long tail
        [{ name: 'binary.bin' }, 'fallback'],
        [{ name: 'unknown' }, 'fallback'],
        [{ name: '' }, 'fallback'],
    ];

    for (const [file, expected] of cases) {
        it(`classifies "${file.name || '<empty>'}" (type=${file.type || '-'}) → ${expected}`, () => {
            expect(classify(file)).toBe(expected);
        });
    }

    it('handles a missing file object without throwing', () => {
        expect(() => classify(undefined)).not.toThrow();
        expect(() => classify(null)).not.toThrow();
        expect(() => classify({})).not.toThrow();
    });
});
