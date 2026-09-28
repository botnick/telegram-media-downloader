// Tailwind v3 build config — replaces the in-browser Play CDN
// (`<script src="https://cdn.tailwindcss.com">` + inline `tailwind.config`)
// that every dashboard page used to load. The Play CDN compiled CSS on
// every page load and re-scanned the DOM on every mutation, which cost
// real CPU + RAM on phones. `npm run build:css` now emits a static
// stylesheet at src/web/public/css/tailwind.css, which is committed so the
// Docker image and bare-metal installs need no build step.
//
// Theme + defaults mirror the old inline Play CDN config 1:1 (Tailwind
// v3.4 defaults, `darkMode: 'media'`, `tg-*` colour tokens). Keep the
// colours in sync with the `--tg-*` custom properties in main.css.
//
// Content: every HTML entry point, every ES module (classes are also
// assembled in JS template strings), and the locale bundles (a few
// translated strings embed markup with utility classes).
module.exports = {
    content: {
        relative: true,
        files: [
            '../src/web/public/*.html',
            '../src/web/public/js/**/*.js',
            '../src/web/public/locales/*.json',
        ],
    },
    // Utilities that are only ever assigned from JS at runtime by modules
    // that may not spell them out literally (e.g. the release-notes sheet
    // in changelog-viewer.js). Pinned so they can never drop out of the
    // build if the last literal use elsewhere goes away. Classes composed
    // dynamically (`bg-${x}`) must be added here too — the scanner can't
    // see them.
    safelist: ['hidden', 'text-tg-text', 'text-sm', 'text-tg-textSecondary', 'text-red-400'],
    theme: {
        extend: {
            colors: {
                tg: {
                    blue: '#2AABEE',
                    darkBlue: '#229ED9',
                    bg: '#17212B',
                    sidebar: '#0E1621',
                    panel: '#242F3D',
                    hover: '#2B5278',
                    border: '#0D1117',
                    text: '#F5F5F5',
                    textSecondary: '#8B9BAA',
                    green: '#4FAE4E',
                    red: '#E53935',
                    orange: '#FF9800',
                    lightBg: '#182533',
                },
            },
        },
    },
    plugins: [],
};
