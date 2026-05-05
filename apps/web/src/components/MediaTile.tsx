/**
 * Single gallery tile — image, video, or document.
 *
 * Renders the same visual as the legacy SPA's tile template:
 *   - thumbnail from /api/thumbs/<id>?w=<width>
 *   - opacity:0 → 1 fade-in via .loaded class on load (matches the
 *     CSS rule from the original main.css)
 *   - play overlay for videos
 *   - filename + groupName + size + date in list mode
 */

import type { ViewerFile } from "@tgdl/shared";
import { useUiStore } from "@/store/ui";

interface Props {
    file: ViewerFile;
    onOpen?(file: ViewerFile): void;
}

export function MediaTile({ file, onOpen }: Props) {
    const { selectMode, selectedPaths, toggleSelected } = useUiStore();
    const selected = selectedPaths.has(file.fullPath);

    const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
    const thumbW = isMobile ? 240 : 320;
    const thumbUrl = `/api/thumbs/${file.id}?w=${thumbW}`;

    const handleClick = () => {
        if (selectMode) {
            toggleSelected(file.fullPath);
        } else if (onOpen) {
            onOpen(file);
        }
    };

    return (
        <button
            type="button"
            data-id={file.id}
            data-path={file.fullPath}
            className={`media-item relative aspect-square overflow-hidden bg-tg-panel ${
                selected ? "is-selected ring-2 ring-tg-blue" : ""
            } ${file.pinned ? "is-pinned" : ""}`}
            onClick={handleClick}
        >
            <div className="tile-thumb relative w-full h-full overflow-hidden">
                {file.type === "videos" ? (
                    <div className="relative w-full h-full bg-black">
                        <img
                            loading="lazy"
                            decoding="async"
                            className="w-full h-full object-cover"
                            alt=""
                            src={thumbUrl}
                            onLoad={(e) => e.currentTarget.classList.add("loaded")}
                            onError={(e) => {
                                e.currentTarget.classList.add("loaded");
                                e.currentTarget.style.display = "none";
                            }}
                        />
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="w-10 h-10 rounded-full bg-black/55 flex items-center justify-center">
                                <span className="text-white text-xl ml-0.5">▶</span>
                            </div>
                        </div>
                    </div>
                ) : file.type === "images" ? (
                    <img
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                        alt=""
                        src={thumbUrl}
                        onLoad={(e) => e.currentTarget.classList.add("loaded")}
                        onError={(e) => {
                            e.currentTarget.classList.add("loaded");
                            e.currentTarget.style.display = "none";
                        }}
                    />
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-tg-text-secondary">
                        <span className="text-3xl">📄</span>
                        <span className="text-xs mt-2 px-2 truncate">{file.name}</span>
                    </div>
                )}
            </div>
        </button>
    );
}
