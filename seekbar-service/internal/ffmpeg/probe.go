// Package ffmpeg wraps the external ffmpeg / ffprobe binaries.
//
// `probe.Duration` runs ffprobe to extract the clip duration; sprite
// generation needs this to lay out the tile grid.
package ffmpeg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	encoderCacheMu sync.Mutex
	encoderCache   map[string]bool
)

// HasEncoder returns true when the named encoder (e.g. "libwebp") is present
// in the local ffmpeg build. Results are cached after the first call per encoder.
func HasEncoder(ctx context.Context, ffmpegBin, encoder string) bool {
	if ffmpegBin == "" {
		ffmpegBin = "ffmpeg"
	}
	cacheKey := ffmpegBin + ":" + encoder
	encoderCacheMu.Lock()
	if encoderCache != nil {
		if v, ok := encoderCache[cacheKey]; ok {
			encoderCacheMu.Unlock()
			return v
		}
	}
	encoderCacheMu.Unlock()

	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(probeCtx, ffmpegBin, "-encoders").Output()
	found := err == nil && bytes.Contains(out, []byte(" "+encoder+" "))

	encoderCacheMu.Lock()
	if encoderCache == nil {
		encoderCache = make(map[string]bool)
	}
	encoderCache[cacheKey] = found
	encoderCacheMu.Unlock()
	return found
}

// Duration returns the clip's duration in seconds. ffprobe is spawned
// with a hard 10s timeout — a broken container should never hang the
// worker.
func Duration(ctx context.Context, probeBin, src string) (float64, error) {
	if probeBin == "" {
		probeBin = "ffprobe"
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, probeBin,
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		src,
	)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return 0, fmt.Errorf("ffprobe: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	s := strings.TrimSpace(out.String())
	d, err := strconv.ParseFloat(s, 64)
	if err != nil || d <= 0 {
		return 0, errors.New("ffprobe: unparseable duration: " + s)
	}
	return d, nil
}
