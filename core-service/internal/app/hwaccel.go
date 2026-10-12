package app

import (
	"context"
	"os"
	"strings"
)

// thumbHWAccel picks the ffmpeg -hwaccel backend for video thumbnails the
// way 2.x did: FFMPEG_HWACCEL (the headless override) wins over Settings →
// Advanced (advanced.thumbs.hwaccel). Anything off the allow-list, or
// nothing, means CPU decode. Renderers retry on the CPU when the chosen
// backend fails, so a host without the device still gets thumbnails.
func (a *App) thumbHWAccel(ctx context.Context) string {
	cfg, _ := a.config.Load(ctx)
	return resolveHWAccel(os.Getenv("FFMPEG_HWACCEL"), stringOr(objectAt(cfg, "advanced", "thumbs")["hwaccel"], ""))
}

func resolveHWAccel(env, configured string) string {
	if backend := allowedThumbAccel(env); backend != "" {
		return backend
	}
	return allowedThumbAccel(configured)
}

// seekbarHWAccelFor resolves advanced.seekbar.hwaccel: "none" forces the
// CPU, an explicit backend wins, and auto (empty) inherits the thumbnail
// backend, FFMPEG_HWACCEL included.
func seekbarHWAccelFor(cfg map[string]any) string {
	switch hw := strings.ToLower(strings.TrimSpace(stringOr(objectAt(cfg, "advanced", "seekbar")["hwaccel"], ""))); hw {
	case "none":
		return ""
	case "", "auto":
		return resolveHWAccel(os.Getenv("FFMPEG_HWACCEL"), stringOr(objectAt(cfg, "advanced", "thumbs")["hwaccel"], ""))
	default:
		return hw
	}
}
