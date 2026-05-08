// Gated-model warning banner — visible when /api/ai/status reports
// `gatedWarnings: [{cap, currentId, suggested}]`. One-click "Apply public
// default" PATCHes config for every offending capability in a single call.

import { aiPost, withButton, toastError } from './api.js';
import { showToast, escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';
import { get, on } from './state.js';

const ROOT_ID = 'ai-gated-warning';
const LIST_ID = 'ai-gated-warning-list';
const APPLY_ID = 'ai-gated-warning-apply';

function _render(state) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const list = state.gatedWarnings || [];
    if (!list.length) {
        root.classList.add('hidden');
        return;
    }
    root.classList.remove('hidden');
    const ul = document.getElementById(LIST_ID);
    if (ul) {
        ul.innerHTML = list
            .map(
                (w) => `
                    <div>
                        <span class="text-amber-400">${escapeHtml(w.cap)}</span>:
                        <span class="line-through text-tg-textSecondary/70">${escapeHtml(w.currentId || '')}</span>
                        →
                        <span class="text-tg-text">${escapeHtml(w.suggested || '')}</span>
                    </div>
                `,
            )
            .join('');
    }
}

async function _onApply(e) {
    const list = get().gatedWarnings || [];
    if (!list.length) return;
    await withButton(e.currentTarget, async () => {
        try {
            const patch = { advanced: { ai: {} } };
            for (const w of list) {
                patch.advanced.ai[w.cap] = {
                    ...(patch.advanced.ai[w.cap] || {}),
                    model: w.suggested,
                };
            }
            await aiPost('/api/config', patch);
            showToast(
                i18nT(
                    'maintenance.ai.gated_warning.applied_toast',
                    'Applied public defaults. Re-running scans will now succeed.',
                ),
                'success',
            );
        } catch (err) {
            toastError(err);
        }
    });
}

let _off = null;
let _wired = false;
export function init() {
    if (!_wired) {
        document.getElementById(APPLY_ID)?.addEventListener('click', _onApply);
        _wired = true;
    }
    if (!_off) {
        _off = on(_render);
        _render(get());
    }
}

export function dispose() {
    if (_off) {
        _off();
        _off = null;
    }
}
