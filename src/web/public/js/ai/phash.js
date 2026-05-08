// Near-duplicate (pHash) groups — tile grid.

import { aiGet } from './api.js';
import { escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';

const WRAP_ID = 'ai-phash-groups';
const EMPTY_ID = 'ai-phash-empty';
const COUNT_ID = 'ai-phash-count';

export async function refresh() {
    const wrap = document.getElementById(WRAP_ID);
    const empty = document.getElementById(EMPTY_ID);
    const count = document.getElementById(COUNT_ID);
    if (!wrap) return;
    let data = null;
    try {
        data = await aiGet('/api/ai/perceptual-dedup/groups?threshold=6');
    } catch {
        /* keep last render */
    }
    const groups = data?.groups || [];
    if (!groups.length) {
        wrap.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count)
        count.textContent = i18nTf(
            'maintenance.ai.phash.count',
            { n: groups.length },
            `${groups.length} groups`,
        );
    wrap.innerHTML = groups
        .slice(0, 30)
        .map((g) => {
            const tiles = (g.rows || [])
                .slice(0, 8)
                .map(
                    (row) => `
                        <div class="ai-phash-tile bg-tg-bg/40 rounded overflow-hidden border border-tg-border">
                            <div class="aspect-square bg-black/40 flex items-center justify-center">
                                <img src="/api/thumbs/${row.id}" class="w-full h-full object-cover" alt="" onerror="this.style.display='none'"/>
                            </div>
                            <div class="text-[10px] text-tg-textSecondary truncate px-1 py-0.5">${escapeHtml(row.file_name || '')}</div>
                        </div>
                    `,
                )
                .join('');
            return `
                <div class="ai-phash-group bg-tg-bg/30 rounded-lg p-2">
                    <div class="text-[11px] text-tg-textSecondary mb-1.5">${i18nTf('maintenance.ai.phash.group_size', { n: g.size }, `${g.size} similar`)}</div>
                    <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1.5">${tiles}</div>
                </div>
            `;
        })
        .join('');
}

export function init() {
    refresh();
}

export function dispose() {}
