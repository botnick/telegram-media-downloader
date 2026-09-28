// Shared rendering for the "Test" buttons of external sidecars (NSFW,
// seekbar). The server-side probes return the same shape:
//   { ok, reachable, error, version, features[], auth, authRequired, … }
// plus a per-sidecar `transferText` the caller picks (path / upload / …).

import { t as i18nT } from './i18n.js';

const RESULT_BASE = 'text-[11px] mt-1.5 block';

function _errorText(r) {
    const err = String(r?.error || '');
    const ver = r?.version ? ` (v${r.version})` : '';
    if (!r?.reachable) {
        return `${i18nT('maintenance.sidecar.test.unreachable', 'Unreachable')}: ${err || '?'}`;
    }
    if (err === 'token_rejected') {
        return `${i18nT('maintenance.sidecar.test.token_rejected', 'Reachable, but the sidecar rejected the API token')}${ver}`;
    }
    if (err === 'token_required') {
        return `${i18nT('maintenance.sidecar.test.token_required', 'Reachable, but the sidecar requires an API token')}${ver}`;
    }
    if (/^http_\d+$/.test(err)) {
        return `HTTP ${err.slice(5)} — ${i18nT('maintenance.sidecar.test.check_url', 'check the URL and any reverse-proxy path prefix')}`;
    }
    if (err.startsWith('not a sidecar')) {
        return i18nT(
            'maintenance.sidecar.test.not_sidecar',
            'Something answered, but it is not the sidecar — check the URL / tunnel target',
        );
    }
    if (err === 'unhealthy') {
        return `${i18nT('maintenance.sidecar.test.not_ready', 'Sidecar reachable but not ready yet')}${ver}`;
    }
    return err || i18nT('maintenance.sidecar.test.failed', 'Test failed');
}

/**
 * Paint a probe result into `el`.
 * @param {HTMLElement} el
 * @param {object} r            probe response
 * @param {object} [o]
 * @param {string[]} [o.parts]  extra facts for a good result (model, device…)
 * @param {string} [o.transferText] how files will reach the sidecar
 * @param {string} [o.url]      the tested URL (public https + no token → warning)
 * @returns {boolean} r.ok
 */
export function renderSidecarTest(el, r, { parts = [], transferText = '', url = '' } = {}) {
    if (!el) return !!r?.ok;
    if (r?.ok) {
        const auth =
            r.auth === 'ok'
                ? i18nT('maintenance.sidecar.test.token_ok', 'token accepted')
                : r.auth === 'open'
                  ? i18nT('maintenance.sidecar.test.no_token', 'no token required')
                  : '';
        const facts = [r.version ? `v${r.version}` : null, ...parts, auth, transferText].filter(
            Boolean,
        );
        el.textContent = `✓ ${facts.join(' · ') || i18nT('maintenance.sidecar.test.connected', 'Connected')}`;
        el.className = `${RESULT_BASE} text-green-400`;
        if (r.auth === 'open' && /^https:/i.test(String(url))) {
            el.textContent += ` — ${i18nT('maintenance.sidecar.test.open_warning', 'anyone who can reach this URL can use it; consider setting a token')}`;
            el.className = `${RESULT_BASE} text-yellow-400`;
        }
        return true;
    }
    el.textContent = `✗ ${_errorText(r)}`;
    el.className = `${RESULT_BASE} text-red-400`;
    return false;
}

/** "Saved — leave blank to keep" placeholder + clear-button visibility. */
export function syncTokenField(input, clearBtn, tokenSet) {
    if (input) {
        input.value = '';
        input.placeholder = tokenSet
            ? i18nT('maintenance.sidecar.token_saved', 'Saved — leave blank to keep it')
            : i18nT(
                  'maintenance.sidecar.token_placeholder',
                  'Optional — the token set on the sidecar',
              );
    }
    if (clearBtn) clearBtn.classList.toggle('hidden', !tokenSet);
}

/** Notice shown when an env var overrides the dashboard value. */
export function renderEnvNote(el, envNames) {
    if (!el) return;
    const names = (envNames || []).filter(Boolean);
    el.classList.toggle('hidden', names.length === 0);
    el.textContent = names.length
        ? `${i18nT('maintenance.sidecar.env_override', 'Set by environment variable — the dashboard value is ignored:')} ${names.join(', ')}`
        : '';
}
