// People grid (face clusters) — tile + inline rename.

import { aiGet, aiPut, toastError } from './api.js';
import { showToast, escapeHtml } from '../utils.js';
import { t as i18nT, tf as i18nTf } from '../i18n.js';

const GRID_ID = 'ai-people-grid';
const EMPTY_ID = 'ai-people-empty';
const COUNT_ID = 'ai-people-count';

export async function refresh() {
    const grid = document.getElementById(GRID_ID);
    const empty = document.getElementById(EMPTY_ID);
    const count = document.getElementById(COUNT_ID);
    if (!grid) return;
    let data = null;
    try {
        data = await aiGet('/api/ai/people');
    } catch {
        /* keep last render */
    }
    const list = data?.people || [];
    if (!list.length) {
        grid.innerHTML = '';
        empty?.classList.remove('hidden');
        if (count) count.textContent = '';
        return;
    }
    empty?.classList.add('hidden');
    if (count)
        count.textContent = i18nTf(
            'maintenance.ai.people.count',
            { n: list.length },
            `${list.length} clusters`,
        );
    grid.innerHTML = list
        .map((p) => {
            const cover = p.cover_download_id
                ? `<img src="/api/thumbs/${p.cover_download_id}" class="w-full h-full object-cover" alt="" onerror="this.style.display='none'"/>`
                : '<i class="ri-user-line text-3xl text-tg-textSecondary"></i>';
            const lbl =
                p.label && p.label.trim()
                    ? escapeHtml(p.label)
                    : escapeHtml(i18nT('maintenance.ai.people.unnamed', 'Unnamed person'));
            return `
                <div class="ai-person-tile bg-tg-bg/40 rounded-lg overflow-hidden border border-tg-border" data-person-id="${p.id}">
                    <div class="aspect-square bg-black/40 flex items-center justify-center overflow-hidden">${cover}</div>
                    <div class="p-2">
                        <input class="ai-person-rename w-full bg-transparent text-tg-text text-xs border-none focus:outline-none focus:ring-1 focus:ring-tg-blue/40 rounded px-1 py-0.5"
                               data-person-id="${p.id}"
                               placeholder="${escapeHtml(i18nT('maintenance.ai.people.rename_placeholder', 'Add a name…'))}"
                               value="${escapeHtml(p.label || '')}"
                               data-original="${escapeHtml(p.label || '')}"/>
                        <div class="text-[11px] text-tg-textSecondary tabular-nums mt-0.5">${escapeHtml(lbl)} · ${p.face_count || 0}</div>
                    </div>
                </div>
            `;
        })
        .join('');
    grid.querySelectorAll('.ai-person-rename').forEach((inp) => {
        inp.addEventListener('change', async () => {
            const id = Number(inp.dataset.personId);
            const newLabel = inp.value.trim();
            if (newLabel === inp.dataset.original) return;
            try {
                await aiPut(`/api/ai/people/${id}`, { label: newLabel || null });
                inp.dataset.original = newLabel;
                showToast(i18nT('maintenance.ai.people.saved', 'Name saved'), 'success');
            } catch (err) {
                toastError(err);
            }
        });
    });
}

export function init() {
    refresh();
}

export function dispose() {
    /* no timers / listeners to clean up — re-render is idempotent */
}
