// Tools catalogue — the 11 maintenance tools, grouped into the four Tools
// pages under Settings. Pure data so the router (nav.js), the Tools pages
// (tools-hub.js) and the command palette can share it without pulling in
// each other.
//
// URLs:
//   #/settings/tools                  → the Tools card on the Settings page
//   #/settings/tools/<group>          → one group's page (tool cards)
//   #/settings/tools/<group>/<tool>   → a tool's full page inside its group
// Old #/maintenance/<tool> links still resolve (see nav.js).

export const TOOL_GROUPS = [
    {
        slug: 'library',
        icon: 'ri-heart-pulse-line',
        title: ['tools.group.library', 'Library health'],
        desc: [
            'tools.group.library_desc',
            'Duplicates, thumbnails, seekbar previews and videos that stream.',
        ],
        tools: ['duplicates', 'thumbs', 'seekbar', 'video'],
    },
    {
        slug: 'safety',
        icon: 'ri-shield-user-line',
        title: ['tools.group.safety', 'Safety & AI'],
        desc: ['tools.group.safety_desc', 'NSFW review and face recognition.'],
        tools: ['nsfw', 'ai'],
    },
    {
        slug: 'sync',
        icon: 'ri-cloud-line',
        title: ['tools.group.sync', 'Backup & sync'],
        desc: ['tools.group.sync_desc', 'Backup destinations and paired cluster peers.'],
        tools: ['backup', 'cluster'],
    },
    {
        slug: 'system',
        icon: 'ri-terminal-box-line',
        title: ['tools.group.system', 'System'],
        desc: ['tools.group.system_desc', 'Logs, updates and recovery cleanup.'],
        tools: ['logs', 'updates', 'recovery'],
    },
];

// Tool slugs are the old /maintenance/<slug> ones, so existing bookmarks
// and the per-tool page ids (#page-maintenance-<slug>) stay the same.
// `name` is the short card title, `desc` the one-liner (both reuse the
// Maintenance hub strings), `words` extra English search words.
export const TOOLS = {
    duplicates: {
        icon: 'ri-file-copy-2-line',
        accent: 'orange',
        name: ['nav.maintenance.duplicates', 'Duplicates'],
        desc: [
            'maintenance.hub.duplicates.body',
            'Hash every file and reclaim space from byte-identical copies.',
        ],
        words: 'dedup duplicate hash reclaim space copies',
    },
    thumbs: {
        icon: 'ri-image-2-line',
        accent: 'blue',
        name: ['nav.maintenance.thumbs', 'Thumbnails'],
        desc: ['maintenance.hub.thumbs.body', 'Generate WebP previews for every catalogued file.'],
        words: 'thumbnail preview webp cache build',
    },
    seekbar: {
        icon: 'ri-movie-line',
        accent: 'blue',
        name: ['nav.maintenance.seekbar', 'Seekbar previews'],
        desc: [
            'maintenance.hub.seekbar.body',
            'WebP sprite-sheet hover previews on the video player seek bar.',
        ],
        words: 'seekbar sprite hover preview video timeline',
    },
    video: {
        icon: 'ri-film-line',
        accent: 'blue',
        name: ['tools.video', 'Video faststart'],
        desc: [
            'maintenance.hub.video.body',
            'Rewrite MP4s with `+faststart` so the player can seek + play audio without buffering the whole file.',
        ],
        words: 'faststart mp4 stream optimise optimize video moov',
    },
    nsfw: {
        icon: 'ri-alarm-warning-line',
        accent: 'red',
        name: ['nav.maintenance.nsfw', 'NSFW'],
        desc: [
            'maintenance.hub.nsfw.body',
            'Five-tier classifier — keep what is confidently 18+, delete what is not.',
        ],
        words: 'nsfw adult classifier review 18+',
    },
    ai: {
        icon: 'ri-user-smile-line',
        accent: 'violet',
        name: ['tools.faces', 'Faces'],
        desc: [
            'maintenance.hub.ai.body',
            'Face clustering via a local Python sidecar (insightface buffalo_l) — opt-in, no upload.',
        ],
        words: 'ai faces people face clustering insightface sidecar',
    },
    backup: {
        icon: 'ri-cloud-line',
        accent: 'green',
        name: ['nav.maintenance.backup', 'Backup'],
        desc: [
            'maintenance.hub.backup.body',
            'NAS / S3 / SFTP / Google Drive / Dropbox mirror + scheduled snapshots.',
        ],
        words: 'backup mirror s3 sftp nas drive dropbox snapshot',
    },
    cluster: {
        icon: 'ri-broadcast-line',
        accent: 'blue',
        name: ['nav.maintenance.cluster', 'Cluster'],
        desc: [
            'maintenance.hub.cluster.body',
            'Pair multiple instances so they federate downloads, gallery, and dedup.',
        ],
        words: 'cluster peer pair federation federate sync',
    },
    logs: {
        icon: 'ri-terminal-box-line',
        accent: 'purple',
        name: ['nav.maintenance.logs', 'Logs'],
        desc: [
            'maintenance.hub.logs.body',
            'Realtime tail of every backend log source — no docker logs needed.',
        ],
        words: 'logs log errors console tail debug',
    },
    updates: {
        icon: 'ri-download-cloud-2-line',
        accent: 'blue',
        name: ['nav.maintenance.updates', 'Updates'],
        desc: [
            'maintenance.hub.updates.body',
            'Install the latest release in one click and audit every past attempt.',
        ],
        words: 'update upgrade version release install',
    },
    recovery: {
        icon: 'ri-first-aid-kit-line',
        accent: 'pink',
        name: ['nav.maintenance.recovery', 'Recovery'],
        desc: [
            'maintenance.hub.recovery.body',
            'Resolve, disable, or delete groups that no loaded Telegram account can access.',
        ],
        words: 'recovery recover orphan inaccessible chats cleanup',
    },
};

const _groupOf = new Map();
for (const g of TOOL_GROUPS) for (const t of g.tools) _groupOf.set(t, g.slug);

/** Group slug a tool belongs to, or null for an unknown tool. */
export function groupOfTool(tool) {
    return _groupOf.get(tool) || null;
}

export function getGroup(slug) {
    return TOOL_GROUPS.find((g) => g.slug === slug) || null;
}

export function toolHref(tool) {
    const g = groupOfTool(tool);
    return g ? `#/settings/tools/${g}/${tool}` : '#/settings/tools';
}

export function groupHref(slug) {
    return `#/settings/tools/${slug}`;
}
