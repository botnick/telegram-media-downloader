package seekbar

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Options are the operator's advanced.seekbar tuning knobs. Zero values pick
// the released defaults.
type Options struct {
	IntervalSec float64
	TileWidth   int
	Columns     int
	MaxTiles    int
	Format      string
	Quality     int
	MaxRetries  int
	HWAccel     string
}

// Plan is the sprite layout for one clip.
type Plan struct {
	Frames      int
	IntervalSec float64
	Cols        int
	Rows        int
	TileW       int
}

// Duration-aware tiers: density is the target seconds between frames and
// absoluteMax the frame budget, so long clips keep full coverage without
// unbounded sprite sizes. The operator's maxTiles is a further hard cap.
var spriteTiers = []struct {
	upTo        float64
	density     float64
	absoluteMax int
}{
	{15, 0.5, 30},
	{60, 1, 60},
	{300, 3, 100},
	{900, 5, 180},
	{1800, 7, 300},
	{3600, 9, 450},
	{7200, 12, 600},
	{math.Inf(1), 18, 720},
}

// PlanSprite mirrors the released generator's layout maths, so sprites built
// here match the ones already on disk.
func PlanSprite(duration float64, o Options) Plan {
	tier := spriteTiers[len(spriteTiers)-1]
	for _, t := range spriteTiers {
		if duration <= t.upTo {
			tier = t
			break
		}
	}
	density := tier.density
	if o.IntervalSec > 0 {
		density = math.Max(0.5, o.IntervalSec)
	}
	frames := int(math.Ceil(duration / density))
	if frames < 8 {
		frames = 8
	}
	frames = min(frames, tier.absoluteMax)
	if o.MaxTiles > 0 {
		frames = min(frames, o.MaxTiles)
	}
	cols := o.Columns
	if cols == 0 {
		cols = 10
	}
	cols = max(2, min(maxCols, cols))
	tileW := o.TileWidth
	if tileW == 0 {
		tileW = 160
	}
	tileW = max(40, min(maxTileWidth, tileW))
	return Plan{
		Frames:      frames,
		IntervalSec: duration / float64(frames),
		Cols:        cols,
		Rows:        max(1, int(math.Ceil(float64(frames)/float64(cols)))),
		TileW:       tileW,
	}
}

// NormalizeFormat maps the configured format onto the two stored values.
func NormalizeFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpeg", "jpg":
		return "jpeg"
	default:
		return "webp"
	}
}

// Budget is how long one encode may take. A sprite pass decodes the whole
// clip, so it scales with the duration, clamped to 5-60 minutes.
func Budget(duration float64) time.Duration {
	d := time.Duration(duration * float64(time.Second))
	return min(time.Hour, max(5*time.Minute, d))
}

var permanentError = regexp.MustCompile(`(?i)does not contain any stream|no video stream|Invalid data found|Invalid NAL|moov atom not found|produced an empty sprite`)

// IsPermanent reports whether err means the file can never produce a sprite.
// Such rows are marked failed; anything else is retried by the next scan.
func IsPermanent(err error) bool {
	return err != nil && permanentError.MatchString(err.Error())
}

// ErrTimeout marks an encode that ran past its Budget.
var ErrTimeout = errors.New("ffmpeg sprite timed out — will retry on the next scan")

// ErrNoDuration means neither ffprobe nor ffmpeg could read a duration.
var ErrNoDuration = errors.New("could not read the video duration")

// Encode renders the sprite for plan at output, retrying transient failures
// up to o.MaxRetries times. A hardware decoder that fails is dropped for the
// remaining attempts. Each attempt is bounded by Budget(duration).
func Encode(ctx context.Context, input, output string, duration float64, plan Plan, o Options) error {
	req := request{
		Frames:    plan.Frames,
		Interval:  plan.IntervalSec,
		Cols:      plan.Cols,
		Rows:      plan.Rows,
		TileWidth: plan.TileW,
		Format:    NormalizeFormat(o.Format),
		Quality:   o.Quality,
		HWAccel:   o.HWAccel,
	}
	if req.Quality < 1 || req.Quality > 100 {
		req.Quality = 75
	}
	if req.Interval <= 0 {
		return ErrNoDuration
	}
	attempts := max(1, o.MaxRetries) + 1
	var err error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(50+attempt*100) * time.Millisecond):
			}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, Budget(duration))
		err = render(attemptCtx, input, output, req)
		timedOut := errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
		cancel()
		if err == nil {
			return nil
		}
		_ = os.Remove(output)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if timedOut {
			return ErrTimeout
		}
		if req.HWAccel != "" {
			req.HWAccel = ""
			continue
		}
		if IsPermanent(err) {
			return err
		}
	}
	return err
}

var durationLine = regexp.MustCompile(`Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)`)

// ProbeDuration returns the clip length in seconds. It uses ffprobe and falls
// back to the header ffmpeg prints, so a build without ffprobe still works.
func ProbeDuration(ctx context.Context, input string) (float64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if bin := FFprobePath(); bin != "" {
		cmd := exec.CommandContext(ctx, bin, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input)
		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		if err := runLowPriority(cmd); err == nil {
			if v, err := strconv.ParseFloat(strings.TrimSpace(stdout.String()), 64); err == nil && v > 0 && !math.IsInf(v, 0) {
				return v, nil
			}
		} else if ctx.Err() != nil {
			return 0, ctx.Err()
		}
	}
	bin := FFmpegPath()
	if bin == "" {
		return 0, errors.New("ffmpeg: executable not found")
	}
	cmd := exec.CommandContext(ctx, bin, "-hide_banner", "-i", input)
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	_ = runLowPriority(cmd) // exits non-zero without an output file
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	m := durationLine.FindStringSubmatch(stderr.String())
	if m == nil {
		return 0, ErrNoDuration
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	s, _ := strconv.ParseFloat(m[3], 64)
	if v := float64(h*3600+mi*60) + s; v > 0 {
		return v, nil
	}
	return 0, ErrNoDuration
}

// FFmpegPath resolves FFMPEG_PATH or ffmpeg on PATH; empty when missing.
func FFmpegPath() string {
	if bin := strings.TrimSpace(os.Getenv("FFMPEG_PATH")); bin != "" {
		return bin
	}
	bin, _ := exec.LookPath("ffmpeg")
	return bin
}

// FFprobePath resolves FFPROBE_PATH, an ffprobe beside FFMPEG_PATH, or
// ffprobe on PATH; empty when missing.
func FFprobePath() string {
	if bin := strings.TrimSpace(os.Getenv("FFPROBE_PATH")); bin != "" {
		return bin
	}
	if ff := strings.TrimSpace(os.Getenv("FFMPEG_PATH")); ff != "" {
		name := "ffprobe"
		if strings.EqualFold(filepath.Ext(ff), ".exe") {
			name += ".exe"
		}
		candidate := filepath.Join(filepath.Dir(ff), name)
		if st, err := os.Stat(candidate); err == nil && st.Mode().IsRegular() {
			return candidate
		}
	}
	bin, _ := exec.LookPath("ffprobe")
	return bin
}

// HWAccels lists the hardware decoders ffmpeg was built with.
func HWAccels(ctx context.Context) []string {
	bin := FFmpegPath()
	if bin == "" {
		return []string{}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "-hide_banner", "-hwaccels").Output()
	compiled := []string{}
	if err != nil {
		return compiled
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.ToLower(strings.TrimSpace(line))
		if hwaccelAllow[line] && !contains(compiled, line) {
			compiled = append(compiled, line)
		}
	}
	return compiled
}

func contains(values []string, v string) bool {
	for _, s := range values {
		if s == v {
			return true
		}
	}
	return false
}

// Limiter bounds concurrent encodes across the background queue and the
// maintenance scan. The limit is passed on each Acquire so a config change
// applies to the next encode without a restart.
type Limiter struct {
	mu     sync.Mutex
	active int
	wake   chan struct{}
}

// Acquire waits for a slot while fewer than limit encodes run.
func (l *Limiter) Acquire(ctx context.Context, limit int) error {
	limit = max(1, limit)
	for {
		l.mu.Lock()
		if l.active < limit {
			l.active++
			l.mu.Unlock()
			return nil
		}
		if l.wake == nil {
			l.wake = make(chan struct{})
		}
		wake := l.wake
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-wake:
		}
	}
}

// Release frees a slot taken by Acquire.
func (l *Limiter) Release() {
	l.mu.Lock()
	l.active--
	if l.wake != nil {
		close(l.wake)
		l.wake = nil
	}
	l.mu.Unlock()
}

// Active reports the number of running encodes.
func (l *Limiter) Active() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.active
}

// Meta is the JSON document stored beside each sprite and served by
// GET /api/seekbar/meta/{id}. Field names match the released format.
type Meta struct {
	Version     int     `json:"version"`
	DownloadID  int64   `json:"download_id"`
	SpriteURL   string  `json:"sprite_url"`
	MetaURL     string  `json:"meta_url"`
	DurationSec float64 `json:"duration_sec"`
	Frames      int     `json:"frames"`
	Cols        int     `json:"cols"`
	Rows        int     `json:"rows"`
	TileW       int     `json:"tile_w"`
	TileH       *int    `json:"tile_h"`
	IntervalSec float64 `json:"interval_sec"`
	Format      string  `json:"format"`
	Bytes       int64   `json:"bytes"`
	SourceSize  *int64  `json:"source_size"`
	SourceMtime *int64  `json:"source_mtime"`
	GeneratedAt int64   `json:"generated_at"`
}

// NewMeta builds the stored metadata for a finished sprite.
func NewMeta(id int64, duration float64, plan Plan, format string, size, sourceSize, sourceMtime int64, generated time.Time) Meta {
	return Meta{
		Version:     1,
		DownloadID:  id,
		SpriteURL:   fmt.Sprintf("/api/seekbar/sprite/%d", id),
		MetaURL:     fmt.Sprintf("/api/seekbar/meta/%d", id),
		DurationSec: duration,
		Frames:      plan.Frames,
		Cols:        plan.Cols,
		Rows:        plan.Rows,
		TileW:       plan.TileW,
		IntervalSec: plan.IntervalSec,
		Format:      format,
		Bytes:       size,
		SourceSize:  &sourceSize,
		SourceMtime: &sourceMtime,
		GeneratedAt: generated.UnixMilli(),
	}
}
