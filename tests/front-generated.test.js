// The front server's tables generated from Node libraries must match the
// installed versions: the MIME map send uses, and the conformance table
// the Go tests check the JavaScript-semantics ports against.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { render as renderConformance } from '../scripts/gen-front-conformance.js';
import { render as renderMime } from '../scripts/gen-front-mime.js';

const FRONT = path.resolve(import.meta.dirname, '..', 'core-service', 'internal', 'front');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('tgdl-core front server generated tables', () => {
    it('mime_table.go matches send (run `node scripts/gen-front-mime.js`)', () => {
        expect(read(path.join(FRONT, 'mime_table.go'))).toBe(renderMime());
    });

    it('testdata/conformance.json matches the Node libraries (run `node scripts/gen-front-conformance.js`)', async () => {
        // Compared parsed: Biome reformats the committed JSON.
        expect(JSON.parse(read(path.join(FRONT, 'testdata', 'conformance.json')))).toEqual(
            JSON.parse(await renderConformance()),
        );
    });
});
