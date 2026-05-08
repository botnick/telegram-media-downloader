// Auto-tag cloud — chips sized by frequency, click routes back to the search hero.

import { aiGet } from './api.js';
import { escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';

const CLOUD_ID = 'ai-tags-cloud';
const EMPTY_ID = 'ai-tags-empty';
const COUNT_ID = 'ai-tags-count';

export async function refresh() {
    const cloud = document.getElementById(CLOUD_ID);
    const empty = document.getElementById(EMPTY_ID);
    const count = document.getElementById(COUNT_ID);
    if (!cloud) return;
    let data = null;
    try {
        data = await aiGet('/api/ai/tags');
    } catch {
        /* keep last render */
    }
    const tags = data?.tags || [];
    if (!tags.length) {
        cloud.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count)
        count.textContent = i18nTf(
            'maintenance.ai.tags.count',
            { n: tags.length },
            `${tags.length} tags`,
        );
    const max = Math.max(...tags.map((t) => t.count));
    cloud.innerHTML = tags
        .map((t) => {
            const ratio = max ? Math.max(0.7, Math.min(2.0, t.count / max + 0.7)) : 1;
            const size = Math.floor(ratio * 12);
            return `
                <button type="button" class="ai-tag-chip bg-tg-bg/40 hover:bg-tg-blue/15 text-tg-text rounded-full px-2.5 py-0.5"
                        style="font-size: ${size}px"
                        data-tag="${escapeHtml(t.tag)}">
                    ${escapeHtml(t.tag)} <span class="text-tg-textSecondary tabular-nums">${t.count}</span>
                </button>
            `;
        })
        .join('');
    cloud.querySelectorAll('.ai-tag-chip').forEach((b) => {
        b.addEventListener('click', () => {
            const input = document.getElementById('ai-search-input');
            if (input) {
                input.value = b.dataset.tag;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

export function init() {
    refresh();
}

export function dispose() {}
