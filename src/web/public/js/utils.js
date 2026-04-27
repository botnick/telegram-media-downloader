// Utility Functions

export function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = 2;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString();
}

/**
 * Telegram-style relative time. "now" / "5m" / "2h" / "yesterday" / dd.mm.
 * Returns '' for invalid / missing input so callers don't have to guard.
 */
export function formatRelativeTime(input) {
    if (!input) return '';
    const t = typeof input === 'number' ? input : Date.parse(input);
    if (!Number.isFinite(t)) return '';
    const now = Date.now();
    const dSec = Math.max(0, Math.round((now - t) / 1000));
    if (dSec < 45) return 'now';
    if (dSec < 60 * 60) return `${Math.round(dSec / 60)}m`;
    if (dSec < 24 * 60 * 60) return `${Math.round(dSec / 3600)}h`;
    if (dSec < 2 * 24 * 60 * 60) return 'yesterday';
    if (dSec < 7 * 24 * 60 * 60) return `${Math.round(dSec / 86400)}d`;
    const d = new Date(t);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}`;
}

export function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function getFileIcon(ext) {
    const map = {
        mp4: 'ri-video-line', mkv: 'ri-video-line', avi: 'ri-video-line', mov: 'ri-video-line', webm: 'ri-video-line',
        mp3: 'ri-music-line', flac: 'ri-music-line', wav: 'ri-music-line', ogg: 'ri-music-line', aac: 'ri-music-line',
        jpg: 'ri-image-line', jpeg: 'ri-image-line', png: 'ri-image-line', gif: 'ri-image-line', webp: 'ri-image-line', bmp: 'ri-image-line',
        pdf: 'ri-file-pdf-line', doc: 'ri-file-word-line', docx: 'ri-file-word-line',
        zip: 'ri-file-zip-line', rar: 'ri-file-zip-line', '7z': 'ri-file-zip-line',
        txt: 'ri-file-text-line', json: 'ri-file-code-line', js: 'ri-file-code-line',
    };
    return map[(ext || '').toLowerCase().replace('.', '')] || 'ri-file-line';
}

export function getGroupType(id) {
    const idStr = String(id);
    if (!idStr.startsWith('-')) return 'Private Chat';
    if (idStr.startsWith('-100')) return 'Channel';
    return 'Group';
}

export function getAvatarClass(id) {
    const colors = [
        'bg-gradient-to-br from-red-500 to-orange-500',
        'bg-gradient-to-br from-orange-400 to-yellow-500',
        'bg-gradient-to-br from-purple-500 to-pink-500',
        'bg-gradient-to-br from-blue-500 to-cyan-500',
        'bg-gradient-to-br from-green-400 to-emerald-600',
        'bg-gradient-to-br from-indigo-500 to-purple-600',
        'bg-gradient-to-br from-pink-500 to-rose-500',
        'bg-gradient-to-br from-cyan-500 to-blue-600'
    ];
    // IDs are usually numeric (Telegram chat ids) but story / username /
    // sentinel rows can be alpha. Slice-then-parseInt would yield NaN and
    // collapse every alpha id onto the same colour. Sum char codes as the
    // fallback so non-numeric ids still spread across the palette.
    const s = String(id ?? '');
    const tail = s.slice(-5);
    let numId = parseInt(tail, 10);
    if (!Number.isFinite(numId)) {
        numId = 0;
        for (let i = 0; i < s.length; i++) numId = (numId + s.charCodeAt(i)) | 0;
    }
    return colors[Math.abs(numId) % colors.length];
}

/**
 * Render a Telegram-style avatar. Two call signatures:
 *   createAvatar(id, name, type)               // legacy positional
 *   createAvatar({ id, name, type, ring, dot, size })   // preferred
 *
 * `ring` ∈ 'downloading' | 'active' | null    → animated gradient ring (story-ring).
 * `dot`  ∈ 'monitor' | 'queue' | 'error' | null → small status dot at bottom-right.
 *                  Replaces the type badge while a runtime-status dot is shown.
 * `size` ∈ 'sm' (32) | 'md' (40) | 'lg' (48 default) | 'xl' (64).
 */
export function createAvatar(idOrOpts, name, type) {
    const opts = typeof idOrOpts === 'object'
        ? idOrOpts
        : { id: idOrOpts, name, type };
    const { id, ring, dot, size = 'lg' } = opts;
    name = opts.name ?? name;
    type = opts.type ?? type;

    const sizePx = { sm: 32, md: 40, lg: 48, xl: 64 }[size] || 48;
    const initialPx = sizePx >= 56 ? 28 : sizePx >= 44 ? 20 : 16;
    const gradient = getAvatarClass(id);
    const initial = (name || '?').charAt(0).toUpperCase();

    let typeIcon = 'question-line';
    if (type === 'channel' || String(id).startsWith('-100')) typeIcon = 'megaphone-fill';
    else if (type === 'group' || String(id).startsWith('-')) typeIcon = 'group-fill';
    else if (type === 'bot') typeIcon = 'robot-2-fill';
    else typeIcon = 'user-fill';

    // The runtime-status dot wins visually over the type badge, but we still
    // render the type badge below for context — Telegram's chat list shows
    // both: a tiny green online dot AND a colored channel/group badge.
    const dotMap = {
        monitor: { color: '#4FAE4E', label: 'monitoring' },
        queue:   { color: '#2AABEE', label: 'in queue' },
        error:   { color: '#E53935', label: 'error' },
    };
    const dotMeta = dotMap[dot];

    const ringClass = ring === 'downloading' ? 'avatar-ring avatar-ring-active'
        : ring === 'active' ? 'avatar-ring' : '';

    return `
        <div class="relative flex-shrink-0 ${ringClass}" style="width:${sizePx}px;height:${sizePx}px">
            <img src="/api/groups/${encodeURIComponent(id)}/photo"
                 class="w-full h-full rounded-full object-cover bg-tg-bg"
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'"
                 loading="lazy"
                 alt="${escapeHtml(String(name || id))}">
            <div class="absolute inset-0 w-full h-full rounded-full ${gradient} flex items-center justify-center text-white hidden shadow-inner">
                <span class="font-bold drop-shadow-md" style="font-size:${initialPx}px">${initial}</span>
            </div>
            ${dotMeta ? `
                <span class="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-tg-sidebar"
                      style="width:14px;height:14px;background:${dotMeta.color}"
                      aria-label="${dotMeta.label}"></span>
            ` : `
                <div class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-tg-panel flex items-center justify-center z-10 border border-tg-bg">
                    <div class="w-4 h-4 rounded-full bg-tg-bg flex items-center justify-center text-tg-textSecondary text-[10px]">
                        <i class="ri-${typeIcon}"></i>
                    </div>
                </div>
            `}
        </div>
    `;
}

function ensureToastStack() {
    let stack = document.getElementById('toast-stack');
    if (stack) return stack;
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'fixed bottom-12 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none';
    document.body.appendChild(stack);
    return stack;
}

export function showToast(message, type = 'info', durationMs = 3000) {
    const stack = ensureToastStack();
    const colorByType = {
        error: 'bg-tg-red text-white',
        success: 'bg-tg-green text-white',
        warning: 'bg-tg-orange text-white',
        info: 'bg-tg-blue text-white',
    };
    const toast = document.createElement('div');
    toast.className = `pointer-events-auto px-4 py-2 rounded-lg shadow-lg transition-opacity duration-300 ${colorByType[type] || colorByType.info}`;
    toast.textContent = message;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    stack.appendChild(toast);
    // Cap visible toasts so a flood doesn't push the screen content offscreen.
    while (stack.children.length > 6) stack.firstChild.remove();
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, durationMs);
}
