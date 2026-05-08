// 4-capability grid: embeddings / faces / tags / phash.
//
// Each card has a toggle (PATCH config) + a "Start scan" button. Buttons are
// disabled while a request is in flight or while the matching scan is
// already running on the server (state.scanRunning).

import { aiPost } from './api.js';
import { withButton, toastError } from './api.js';
import { showToast } from '../utils.js';
import { escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';
import { get, on, update } from './state.js';

const ROOT_ID = 'ai-capabilities-grid';

const CAPS = [
    {
        key: 'embeddings',
        titleKey: 'maintenance.ai.cap.embeddings',
        titleFb: 'Semantic search (CLIP/SigLIP)',
        helpKey: 'maintenance.ai.cap.embeddings.help',
        helpFb: 'Encode every photo + text query into a vector and rank matches by cosine similarity.',
        scanUrl: '/api/ai/index/scan',
    },
    {
        key: 'faces',
        titleKey: 'maintenance.ai.cap.faces',
        titleFb: 'Face clustering (people)',
        helpKey: 'maintenance.ai.cap.faces.help',
        helpFb: 'Detect faces and cluster them into "people" tiles.',
        scanUrl: '/api/ai/people/scan',
    },
    {
        key: 'tags',
        titleKey: 'maintenance.ai.cap.tags',
        titleFb: 'Auto-tag',
        helpKey: 'maintenance.ai.cap.tags.help',
        helpFb: 'Top-K labels per photo from a small image classifier.',
        scanUrl: '/api/ai/tags/scan',
    },
    {
        key: 'phash',
        titleKey: 'maintenance.ai.cap.phash',
        titleFb: 'Perceptual dedup',
        helpKey: 'maintenance.ai.cap.phash.help',
        helpFb: 'DCT-based 64-bit pHash — finds near-duplicates that exact-hash dedup misses.',
        scanUrl: '/api/ai/perceptual-dedup/scan',
    },
];

function _progressLine(state, cap) {
    const p = state.scanProgress?.[cap];
    if (!p) return '';
    if (p.stage === 'done') return i18nT('maintenance.ai.scan.done', 'Done');
    if (Number.isFinite(p.processed) && Number.isFinite(p.total)) {
        return i18nTf(
            'maintenance.ai.scan.running',
            { processed: p.processed, total: p.total },
            `Scanning… ${p.processed} / ${p.total}`,
        );
    }
    if (p.stage) return String(p.stage);
    return '';
}

function _renderCard(state, c) {
    const enabled = !!state.capabilities[c.key];
    const masterOn = !!state.enabled;
    const running = !!state.scanRunning[c.key];
    const scanDisabled = !(enabled && masterOn) || running;
    const label = i18nT(c.titleKey, c.titleFb);
    const help = i18nT(c.helpKey, c.helpFb);
    const progress = escapeHtml(_progressLine(state, c.key));
    return `
        <div class="ai-cap-card bg-tg-bg/30 rounded-lg p-2.5 flex items-start gap-2.5" data-cap="${c.key}">
            <div class="flex-1 min-w-0">
                <div class="text-tg-text font-medium">${escapeHtml(label)}</div>
                ${help ? `<div class="text-tg-textSecondary text-[11px] leading-snug">${escapeHtml(help)}</div>` : ''}
                <div class="ai-cap-progress text-[11px] text-tg-textSecondary tabular-nums mt-1">${progress}</div>
            </div>
            <div class="flex flex-col items-end gap-1.5 shrink-0">
                <div id="setting-adv-ai-${c.key}-enabled" class="tg-toggle${enabled ? ' active' : ''}" data-cap-toggle="${c.key}" role="switch" aria-checked="${enabled}"></div>
                <button class="ai-cap-scan-btn tg-btn-secondary text-[11px] px-2 py-1${scanDisabled ? ' opacity-50 cursor-not-allowed' : ''}"
                        ${scanDisabled ? 'disabled' : ''} data-scan-cap="${c.key}">
                    ${running ? `<i class="ri-loader-4-line animate-spin" aria-hidden="true"></i>` : escapeHtml(i18nT('maintenance.ai.scan.start', 'Start scan'))}
                </button>
            </div>
        </div>
    `;
}

function _render(state) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.innerHTML = CAPS.map((c) => _renderCard(state, c)).join('');
    // Wire scan buttons.
    root.querySelectorAll('[data-scan-cap]').forEach((btn) => {
        btn.addEventListener('click', () => _kickScan(btn));
    });
    // Wire toggles.
    root.querySelectorAll('[data-cap-toggle]').forEach((tog) => {
        tog.addEventListener('click', (e) => _toggleCap(e, tog));
    });
}

async function _kickScan(btn) {
    const which = btn.dataset.scanCap;
    const cap = CAPS.find((c) => c.key === which);
    if (!cap) return;
    await withButton(btn, async () => {
        try {
            await aiPost(cap.scanUrl, {});
            showToast(i18nT('maintenance.ai.scan.started', 'Scan started'), 'success');
            update({}); // re-render to flip running state if needed
        } catch (err) {
            const code = err?.code || err?.envelope?.code || '';
            if (code === 'ALREADY_RUNNING') {
                showToast(
                    i18nT('maintenance.ai.scan.already_running', 'A scan is already running.'),
                    'warning',
                );
            } else if (code === 'AI_DISABLED') {
                showToast(
                    i18nT(
                        'maintenance.ai.scan.master_disabled',
                        'Enable the AI master switch first.',
                    ),
                    'warning',
                );
            } else {
                toastError(err, 'Scan failed');
            }
        }
    });
}

async function _toggleCap(e, tog) {
    e.preventDefault();
    if (tog.dataset.busy === '1') return;
    const which = tog.dataset.capToggle;
    const willEnable = !tog.classList.contains('active');
    tog.dataset.busy = '1';
    try {
        await aiPost('/api/config', { advanced: { ai: { [which]: { enabled: willEnable } } } });
        const next = { ...get().capabilities, [which]: willEnable };
        update({ capabilities: next });
    } catch (err) {
        toastError(err);
    } finally {
        delete tog.dataset.busy;
    }
}

let _off = null;
export function init() {
    if (_off) return;
    _off = on(_render);
    _render(get());
}

export function dispose() {
    if (_off) {
        _off();
        _off = null;
    }
}
