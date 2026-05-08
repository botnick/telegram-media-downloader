// Master AI on/off toggle.

import { aiPost } from './api.js';
import { withButton, toastError } from './api.js';
import { showToast } from '../utils.js';
import { t as i18nT } from '../i18n.js';
import { update, get, on } from './state.js';

const TOGGLE_ID = 'setting-adv-ai-enabled';
const PILL_ID = 'ai-master-state-pill';

function _render(state) {
    const tog = document.getElementById(TOGGLE_ID);
    const pill = document.getElementById(PILL_ID);
    if (tog) {
        tog.classList.toggle('active', !!state.enabled);
        tog.setAttribute('aria-checked', state.enabled ? 'true' : 'false');
    }
    if (pill) {
        pill.innerHTML = state.enabled
            ? `<span class="text-tg-green">● <span data-i18n="maintenance.ai.master.state.on">On</span></span>`
            : `<span class="text-tg-textSecondary">○ <span data-i18n="maintenance.ai.master.state.off">Off</span></span>`;
    }
}

async function _onClick(e) {
    e.preventDefault();
    const tog = e.currentTarget;
    if (!tog || tog.dataset.busy === '1') return;
    const willEnable = !tog.classList.contains('active');
    tog.dataset.busy = '1';
    tog.disabled = true;
    try {
        await aiPost('/api/config', { advanced: { ai: { enabled: willEnable } } });
        update({ enabled: willEnable });
        showToast(
            willEnable
                ? i18nT('maintenance.ai.master.toast_on', 'AI subsystem enabled.')
                : i18nT('maintenance.ai.master.toast_off', 'AI subsystem stopped.'),
            'success',
        );
    } catch (err) {
        toastError(err);
    } finally {
        tog.disabled = false;
        delete tog.dataset.busy;
    }
}

let _off = null;
let _wired = false;
export function init() {
    if (!_wired) {
        const tog = document.getElementById(TOGGLE_ID);
        if (tog) tog.addEventListener('click', _onClick);
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
