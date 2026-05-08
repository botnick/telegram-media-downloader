// HuggingFace access token: input + reveal + test + autosave.

import { aiGet, aiPost, withButton, toastError } from './api.js';
import { showToast, escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';

const INPUT_ID = 'setting-adv-ai-hf-token';
const REVEAL_ID = 'ai-hf-token-reveal';
const TEST_ID = 'ai-hf-token-test';
const RESULT_ID = 'ai-hf-token-result';

let _autosaveTimer = null;

async function _hydrate() {
    const inp = document.getElementById(INPUT_ID);
    if (!inp) return;
    if (inp.value && inp.value.trim() !== inp.dataset.hfTokenSnapshot) return;
    try {
        const cfg = await aiGet('/api/config');
        const saved = String(cfg?.advanced?.ai?.hfToken || '');
        inp.value = saved;
        inp.dataset.hfTokenSnapshot = saved;
    } catch {
        /* ignore */
    }
}

function _wireAutosave() {
    const inp = document.getElementById(INPUT_ID);
    if (!inp || inp.dataset.hfWired === '1') return;
    inp.dataset.hfWired = '1';
    const flush = async () => {
        clearTimeout(_autosaveTimer);
        _autosaveTimer = null;
        const next = String(inp.value || '').trim();
        if (next === (inp.dataset.hfTokenSnapshot || '')) return;
        try {
            await aiPost('/api/config', { advanced: { ai: { hfToken: next } } });
            inp.dataset.hfTokenSnapshot = next;
        } catch (err) {
            showToast(
                i18nTf(
                    'maintenance.ai.hf_token.save_failed',
                    { msg: err?.message || err },
                    `Token save failed: ${err?.message || err}`,
                ),
                'error',
            );
        }
    };
    inp.addEventListener('input', () => {
        clearTimeout(_autosaveTimer);
        _autosaveTimer = setTimeout(flush, 600);
    });
    inp.addEventListener('blur', () => {
        if (_autosaveTimer) flush();
    });
}

function _wireReveal() {
    const btn = document.getElementById(REVEAL_ID);
    const inp = document.getElementById(INPUT_ID);
    if (!btn || !inp || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
        inp.type = inp.type === 'password' ? 'text' : 'password';
    });
}

async function _runTest(btn) {
    const out = document.getElementById(RESULT_ID);
    const inp = document.getElementById(INPUT_ID);
    if (!btn || !out) return;
    out.innerHTML = '';
    await withButton(btn, async () => {
        try {
            const typed = (inp?.value || '').trim();
            const r = await aiPost('/api/ai/hf/test', typed ? { token: typed } : {});
            if (r?.ok) {
                const name = String(r.name || '').replace(/[<>]/g, '');
                out.innerHTML = `
                    <i class="ri-check-line text-tg-green"></i>
                    <span class="text-tg-green">${escapeHtml(
                        i18nTf(
                            'maintenance.ai.hf_token.test_ok',
                            { name },
                            `Token works — signed in as ${name}.`,
                        ),
                    )}</span>`;
            } else {
                const msg =
                    r?.message ||
                    i18nT('maintenance.ai.hf_token.test_fail_generic', 'Token did not work.');
                out.innerHTML = `
                    <i class="ri-error-warning-line text-red-400"></i>
                    <span class="text-red-400">${escapeHtml(msg)}</span>`;
            }
        } catch (err) {
            // Server-side envelope (ok:false at status 200) lands here too.
            const msg = err?.envelope?.message || err?.message || 'Test failed';
            out.innerHTML = `
                <i class="ri-error-warning-line text-red-400"></i>
                <span class="text-red-400">${escapeHtml(msg)}</span>`;
        }
    });
}

function _wireTest() {
    const btn = document.getElementById(TEST_ID);
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => _runTest(btn));
}

export function init() {
    _wireReveal();
    _wireTest();
    _wireAutosave();
    _hydrate().catch(() => {});
}

export function dispose() {
    if (_autosaveTimer) {
        clearTimeout(_autosaveTimer);
        _autosaveTimer = null;
    }
}
