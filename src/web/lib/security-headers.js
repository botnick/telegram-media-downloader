// Content-Security-Policy builder + validator. Pure: no I/O, no Express.
//
// Config shape (all optional, missing => shipped defaults):
//   web.csp = { enabled: true, reportOnly: false, directives: { name: [src] } }
// Defaults live in config/manager.js as data.

import { DEFAULT_CSP_DIRECTIVES } from '../../config/manager.js';

const DEFAULT_XFO = 'SAMEORIGIN';
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
// `;` and `,` split directives / policies; control chars (incl. CR/LF) split
// headers. Anything else is the operator's call.
const BAD_SOURCE_RE = /[;,\u0000-\u001f\u007f]/;
const MAX_SOURCES = 100;
const MAX_SOURCE_LEN = 300;

/**
 * Validate + normalise an incoming `web.csp` object.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateCsp(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'csp must be an object' };
    }
    const out = {
        enabled: input.enabled !== false,
        reportOnly: input.reportOnly === true,
        directives: {},
    };
    const dirs = input.directives ?? {};
    if (typeof dirs !== 'object' || Array.isArray(dirs)) {
        return { ok: false, error: 'csp.directives must be an object' };
    }
    for (const [name, list] of Object.entries(dirs)) {
        if (!NAME_RE.test(name)) return { ok: false, error: `Invalid CSP directive name: ${name}` };
        if (!Array.isArray(list)) {
            return { ok: false, error: `${name}: sources must be an array` };
        }
        if (list.length > MAX_SOURCES) {
            return { ok: false, error: `${name}: too many sources (max ${MAX_SOURCES})` };
        }
        const seen = new Set();
        for (const raw of list) {
            if (typeof raw !== 'string')
                return { ok: false, error: `${name}: sources must be strings` };
            if (BAD_SOURCE_RE.test(raw)) {
                return {
                    ok: false,
                    error: `${name}: source "${raw.replace(/[^\x20-\x7e]/g, '?')}" contains a forbidden character (; , or a control/newline character)`,
                };
            }
            const src = raw.trim();
            if (!src) continue;
            if (/\s/.test(src)) {
                return { ok: false, error: `${name}: source "${src}" contains whitespace` };
            }
            if (src.length > MAX_SOURCE_LEN) {
                return { ok: false, error: `${name}: source too long (max ${MAX_SOURCE_LEN})` };
            }
            seen.add(src);
        }
        out.directives[name] = [...seen];
    }
    return { ok: true, value: out };
}

function sameList(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

let _cache = { key: null, secure: null, off: null, result: null };

/**
 * Build the CSP + X-Frame-Options decision for a request.
 * @param {object} config full config (reads config.web.csp / config.web.forceHttps)
 * @param {{secure?: boolean, env?: object}} [opts]
 * @returns {{ csp: {name: string, value: string} | null, xFrameOptions: string | null }}
 */
export function buildSecurityHeaders(config, opts = {}) {
    const secure = !!opts.secure;
    const env = opts.env || process.env;
    const off = String(env.TGDL_CSP || '').toLowerCase() === 'off';
    const csp = config?.web?.csp;
    const forceHttps = !!config?.web?.forceHttps;
    const upgrade = forceHttps && secure;

    if (_cache.key === csp && _cache.secure === upgrade && _cache.off === off && _cache.result) {
        return _cache.result;
    }

    const enabled = !off && csp?.enabled !== false;
    const directives =
        csp?.directives && typeof csp.directives === 'object'
            ? csp.directives
            : DEFAULT_CSP_DIRECTIVES;

    // X-Frame-Options stays as today unless frame-ancestors was customised;
    // then it would contradict the CSP, so drop it.
    const fa = directives['frame-ancestors'];
    const faCustom =
        !!csp?.directives && !sameList(fa || [], DEFAULT_CSP_DIRECTIVES['frame-ancestors']);
    const xFrameOptions = faCustom ? null : DEFAULT_XFO;

    let cspOut = null;
    if (enabled) {
        const parts = [];
        for (const [name, list] of Object.entries(directives)) {
            if (!Array.isArray(list) || list.length === 0) continue;
            parts.push(`${name} ${list.join(' ')}`);
        }
        let value = parts.join(';');
        if (upgrade) value += ';upgrade-insecure-requests';
        cspOut = {
            name: csp?.reportOnly
                ? 'Content-Security-Policy-Report-Only'
                : 'Content-Security-Policy',
            value,
        };
    }

    const result = { csp: cspOut, xFrameOptions };
    _cache = { key: csp, secure: upgrade, off, result };
    return result;
}
