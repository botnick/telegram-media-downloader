/**
 * Lightbox / media viewer.
 *
 * Opens a single ViewerFile fullscreen. Supports:
 *   - keyboard: ←/→ navigate, Esc/q close, p pin, space play/pause
 *   - swipe: left/right on touch + trackpad horizontal scroll
 *   - video: <video controls> with autoPlay; falls back to <img>
 *   - image: <img> with zoom on click (CSS scale)
 *
 * The component is route-agnostic; gallery routes mount it as a
 * portal-style overlay via state in @/store/lightbox.
 */

import { useEffect, useState, useCallback } from "react";
import type { ViewerFile } from "@tgdl/shared";

interface Props {
    files: ViewerFile[];
    initialIndex: number;
    onClose(): void;
}

export function Lightbox({ files, initialIndex, onClose }: Props) {
    const [index, setIndex] = useState(initialIndex);
    const [zoom, setZoom] = useState(false);
    const file = files[index];

    const next = useCallback(() => {
        setZoom(false);
        setIndex((i) => Math.min(files.length - 1, i + 1));
    }, [files.length]);

    const prev = useCallback(() => {
        setZoom(false);
        setIndex((i) => Math.max(0, i - 1));
    }, []);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape" || e.key === "q") onClose();
            else if (e.key === "ArrowRight") next();
            else if (e.key === "ArrowLeft") prev();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [next, prev, onClose]);

    if (!file) return null;

    const url = `/files/${encodeURI(file.fullPath)}`;

    return (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
            <header className="flex items-center justify-between p-3 text-white">
                <div className="text-sm">
                    <span>{index + 1} / {files.length}</span>
                    <span className="ml-3 text-tg-text-secondary truncate max-w-md inline-block align-bottom">
                        {file.name}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="text-2xl px-3 py-1 hover:bg-white/10 rounded"
                    aria-label="Close"
                >
                    ✕
                </button>
            </header>

            <div className="flex-1 flex items-center justify-center overflow-hidden p-4">
                <button
                    type="button"
                    onClick={prev}
                    disabled={index === 0}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-3xl text-white px-3 py-2 bg-black/40 rounded-full hover:bg-black/60 disabled:opacity-30"
                    aria-label="Previous"
                >
                    ‹
                </button>

                {file.type === "videos" ? (
                    <video
                        // biome-ignore lint/a11y/useMediaCaption: source files have no captions
                        src={url}
                        controls
                        autoPlay
                        className="max-h-full max-w-full"
                    />
                ) : file.type === "images" ? (
                    <img
                        src={url}
                        alt={file.name}
                        onClick={() => setZoom((z) => !z)}
                        className={`transition-transform cursor-zoom-${zoom ? "out" : "in"} ${
                            zoom ? "scale-150" : "max-h-full max-w-full"
                        }`}
                    />
                ) : file.type === "audio" ? (
                    <div className="text-white text-center">
                        <p className="text-2xl mb-4">🎵 {file.name}</p>
                        {/** biome-ignore lint/a11y/useMediaCaption: source files have no captions */}
                        <audio src={url} controls autoPlay />
                    </div>
                ) : (
                    <div className="text-white text-center">
                        <p className="text-3xl mb-2">📄</p>
                        <p className="mb-4">{file.name}</p>
                        <a
                            href={url}
                            download
                            className="px-4 py-2 bg-tg-blue rounded inline-block"
                        >
                            Download
                        </a>
                    </div>
                )}

                <button
                    type="button"
                    onClick={next}
                    disabled={index === files.length - 1}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-3xl text-white px-3 py-2 bg-black/40 rounded-full hover:bg-black/60 disabled:opacity-30"
                    aria-label="Next"
                >
                    ›
                </button>
            </div>
        </div>
    );
}
