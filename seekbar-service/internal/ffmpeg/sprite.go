package ffmpeg

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// SpritePlan is the deterministic layout decision for one clip. The
// service stamps these numbers into the JSON sidecar so the frontend
// can map hover-position → tile-index without round-tripping.
type SpritePlan struct {
	Frames      int     // total tiles in the sprite
	IntervalSec float64 // seconds between adjacent tile centres
	Cols        int
	Rows        int
	TileW       int
	TileH       int // 0 = unknown (computed from final image dims)
}

// Plan picks the tile grid for a given duration + thumb config.
// Algorithm: clamp(ceil(duration / interval), 12, maxTiles), then
// recompute interval = duration / frames so the final sample lands on
// the clip's last second.
func Plan(durationSec float64, targetIntervalSec float64, columns, maxTiles, tileWidth int) SpritePlan {
	if targetIntervalSec <= 0 {
		targetIntervalSec = 5
	}
	const minFrames = 12
	if maxTiles < minFrames {
		maxTiles = minFrames
	}
	frames := int(math.Ceil(durationSec / targetIntervalSec))
	if frames < minFrames {
		frames = minFrames
	}
	if frames > maxTiles {
		frames = maxTiles
	}
	interval := durationSec / float64(frames)
	if columns < 2 {
		columns = 10
	}
	if columns > 50 {
		columns = 50
	}
	rows := int(math.Ceil(float64(frames) / float64(columns)))
	if tileWidth < 40 {
		tileWidth = 160
	}
	return SpritePlan{
		Frames:      frames,
		IntervalSec: interval,
		Cols:        columns,
		Rows:        rows,
		TileW:       tileWidth,
	}
}

// BuildArgs returns the full ffmpeg argv (excluding the binary itself)
// for a single sprite encode. The encoder choice depends on `format`:
//   - "webp" / "" → -c:v libwebp
//   - "jpeg" / "jpg" → -q:v <derived from quality>
func BuildArgs(srcAbs, dstTmp string, plan SpritePlan, format string, quality int, hwArgs []string, extraArgs string) []string {
	if quality <= 0 {
		quality = 70
	}
	if quality > 100 {
		quality = 100
	}
	filter := fmt.Sprintf(
		"fps=1/%s,scale=%d:-2:flags=fast_bilinear,tile=%dx%d",
		strconv.FormatFloat(plan.IntervalSec, 'f', 6, 64),
		plan.TileW, plan.Cols, plan.Rows,
	)
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, hwArgs...)
	args = append(args,
		"-i", srcAbs,
		"-frames:v", "1",
		"-an",
		"-vf", filter,
	)
	switch strings.ToLower(format) {
	case "jpeg", "jpg":
		// Map quality 1..100 to ffmpeg -q:v 31..2 (lower is better).
		qv := 31 - (quality * 29 / 100)
		if qv < 2 {
			qv = 2
		}
		if qv > 31 {
			qv = 31
		}
		// Temp file extension (.jpg.tmp.XXXX) is not a known ffmpeg format,
		// so declare the codec and muxer explicitly.
		args = append(args, "-c:v", "mjpeg", "-f", "image2", "-q:v", strconv.Itoa(qv))
	default:
		args = append(args,
			"-c:v", "libwebp",
			"-quality", strconv.Itoa(quality),
			"-compression_level", "6",
			"-f", "webp",
		)
	}
	if extra := strings.TrimSpace(extraArgs); extra != "" {
		// Split on whitespace; ffmpeg arg lists rarely need quoting and
		// the operator gets full responsibility for the override.
		for _, a := range strings.Fields(extra) {
			args = append(args, a)
		}
	}
	args = append(args, "-y", dstTmp)
	return args
}

// Run executes an ffmpeg invocation and surfaces stderr on failure.
// Caller owns the context (and any timeout it carries).
func Run(ctx context.Context, ffmpegBin string, args []string) error {
	if ffmpegBin == "" {
		ffmpegBin = "ffmpeg"
	}
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		tail := stderr.String()
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		return fmt.Errorf("ffmpeg: %w (stderr: %s)", err, strings.TrimSpace(tail))
	}
	return nil
}

// AtomicRename moves `tmp` to `dst` after an fsync so a crash mid-write
// can't leave a half-flushed sprite mistaken for a valid cache hit.
func AtomicRename(tmp, dst string) error {
	if f, err := os.OpenFile(tmp, os.O_RDWR, 0); err == nil {
		_ = f.Sync()
		_ = f.Close()
	}
	return os.Rename(tmp, dst)
}

// TempPath produces a randomised .tmp path next to `target` so concurrent
// workers writing different sprites don't collide on filename.
func TempPath(target string) string {
	dir := filepath.Dir(target)
	base := filepath.Base(target)
	var b [4]byte
	_, _ = rand.Read(b[:])
	return filepath.Join(dir, "."+base+".tmp."+hex.EncodeToString(b[:]))
}
