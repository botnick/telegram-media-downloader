#!/usr/bin/env node
/**
 * i18n drift checker.
 *
 * Walks `src/web/public/index.html` for `data-i18n` / `data-i18n-title`
 * attribute values, walks `src/web/public/js/**\/*.js` for `i18nT('…')`
 * and `i18nTf('…', …)` calls, builds the union of every translation
 * key actually referenced by the SPA, then diffs that set against
 * `src/web/public/locales/en.json` and `…/th.json`.
 *
 * Exits non-zero (and prints the missing keys) if either locale is
 * missing a key that the UI references — caught in CI before a
 * release ships with `[missing key]` chrome on a user's screen.
 *
 * Run: `node scripts/check_i18n_drift.js`
 *
 * No deps; intentionally self-contained so it runs on CI nodes that
 * haven't done `npm ci` yet.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML = join(ROOT, 'src/web/public/index.html');
const JS_DIR = join(ROOT, 'src/web/public/js');
const EN = join(ROOT, 'src/web/public/locales/en.json');
const TH = join(ROOT, 'src/web/public/locales/th.json');

function walkJs(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) walkJs(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

function collectKeysFromHtml(html) {
    const keys = new Set();
    // data-i18n="key.path" and data-i18n-title="key.path"
    const re = /data-i18n(?:-(?:title|aria-label))?="([^"]+)"/g;
    for (const m of html.matchAll(re)) keys.add(m[1]);
    return keys;
}

function collectKeysFromJs(src) {
    const keys = new Set();
    // i18nT('key.path', ...) or i18nTf('key.path', ...) — match leading
    // function name + first single- or double-quoted string arg.
    const re = /i18nTf?\(\s*['"]([\w.-]+)['"]/g;
    for (const m of src.matchAll(re)) keys.add(m[1]);
    return keys;
}

function loadLocale(path) {
    const text = readFileSync(path, 'utf8');
    return JSON.parse(text);
}

function main() {
    const used = new Set();
    const html = readFileSync(HTML, 'utf8');
    for (const k of collectKeysFromHtml(html)) used.add(k);
    for (const file of walkJs(JS_DIR)) {
        const src = readFileSync(file, 'utf8');
        for (const k of collectKeysFromJs(src)) used.add(k);
    }

    const en = loadLocale(EN);
    const th = loadLocale(TH);

    const missingEn = [...used].filter((k) => !(k in en)).sort();
    const missingTh = [...used].filter((k) => !(k in th)).sort();
    const extraEn = Object.keys(en)
        .filter((k) => !used.has(k))
        .sort();
    const extraTh = Object.keys(th)
        .filter((k) => !used.has(k))
        .sort();

    let bad = 0;
    if (missingEn.length) {
        bad++;
        console.log(`# Missing in en.json (${missingEn.length}):`);
        for (const k of missingEn) console.log(`  - ${k}`);
    }
    if (missingTh.length) {
        bad++;
        console.log(`# Missing in th.json (${missingTh.length}):`);
        for (const k of missingTh) console.log(`  - ${k}`);
    }
    if (process.env.SHOW_EXTRA === '1') {
        if (extraEn.length) {
            console.log(`# Unused in en.json (${extraEn.length}):`);
            for (const k of extraEn) console.log(`  - ${k}`);
        }
        if (extraTh.length) {
            console.log(`# Unused in th.json (${extraTh.length}):`);
            for (const k of extraTh) console.log(`  - ${k}`);
        }
    }

    if (!bad) {
        const usedCount = used.size;
        console.log(`OK — ${usedCount} keys used by SPA, all present in en + th`);
    }
    process.exit(bad ? 1 : 0);
}

main();
