/**
 * Single row in the Manage Groups dialog list. Mirrors the legacy
 * SPA's group-config row visually (avatar, name, type+members,
 * Add/Active/Paused button on the right).
 */

import type { Dialog } from "@/api/dialogs";

interface Props {
    dialog: Dialog;
    onAdd?(d: Dialog): void;
    onRowClick?(d: Dialog): void;
}

const TYPE_LABEL: Record<Dialog["type"], string> = {
    group: "Group",
    supergroup: "Group",
    channel: "Channel",
    user: "User",
};

const AVATAR_VARIANTS = [1, 2, 3, 4, 5] as const;

function avatarColorForId(id: string): (typeof AVATAR_VARIANTS)[number] {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % AVATAR_VARIANTS.length;
    return AVATAR_VARIANTS[idx] ?? 1;
}

export function DialogRow({ dialog, onAdd, onRowClick }: Props) {
    const variant = avatarColorForId(dialog.id);
    const initial = dialog.name.trim().slice(0, 1).toUpperCase() || "?";

    return (
        <div
            className="flex items-center gap-3 p-3 rounded-lg bg-tg-panel hover:bg-tg-hover/40 transition-colors"
            onClick={() => onRowClick?.(dialog)}
        >
            {dialog.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={dialog.photoUrl}
                    alt=""
                    className="w-12 h-12 rounded-full object-cover shrink-0"
                />
            ) : (
                <div
                    className={`tg-avatar tg-avatar-${variant} w-12 h-12 text-lg shrink-0`}
                >
                    {initial}
                </div>
            )}

            <div className="min-w-0 flex-1">
                <h4 className="text-tg-text font-medium truncate">{dialog.name}</h4>
                <p className="text-xs text-tg-textSecondary truncate">
                    {TYPE_LABEL[dialog.type]}
                    {typeof dialog.members === "number"
                        ? ` · ${dialog.members.toLocaleString()} members`
                        : ""}
                </p>
            </div>

            {dialog.monitored ? (
                <span
                    className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium ${
                        dialog.state === "paused"
                            ? "bg-tg-orange/20 text-tg-orange"
                            : "bg-tg-green/20 text-tg-green"
                    }`}
                >
                    {dialog.state === "paused" ? "Paused" : "Active"}
                </span>
            ) : (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onAdd?.(dialog);
                    }}
                    className="shrink-0 px-4 py-1.5 rounded-lg bg-tg-blue text-white text-sm font-medium hover:bg-tg-darkBlue transition-colors"
                >
                    Add
                </button>
            )}
        </div>
    );
}
