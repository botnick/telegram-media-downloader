// Tailwind v4 ships its plugin as a dedicated PostCSS module — no
// `tailwind.config.js` needed since theme values live in CSS via
// @theme. autoprefixer for vendor fallbacks.
export default {
    plugins: {
        "@tailwindcss/postcss": {},
        autoprefixer: {},
    },
};
