package seekbar

import (
	"context"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func hasCwebp() bool {
	_, err := exec.LookPath("cwebp")
	return err == nil
}

// testVideo renders a short clip with ffmpeg's test source and requires a WebP encoder.
func testVideo(t *testing.T, seconds int) string {
	t.Helper()
	bin := FFmpegPath()
	if bin == "" {
		t.Skip("ffmpeg not installed")
	}
	if out, err := exec.Command(bin, "-hide_banner", "-encoders").Output(); (err != nil || !strings.Contains(string(out), "libwebp")) && !hasCwebp() {
		t.Skip("ffmpeg without libwebp or cwebp")
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	cmd := exec.Command(bin, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
		"testsrc=duration="+strconv.Itoa(seconds)+":size=160x120:rate=10", "-pix_fmt", "yuv420p", "-y", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot render a test clip: %v %s", err, out)
	}
	return path
}

func TestPlanSpriteMatchesReleasedLayout(t *testing.T) {
	cases := []struct {
		duration float64
		opts     Options
		frames   int
		cols     int
		rows     int
	}{
		{2, Options{}, 8, 10, 1},                                    // short clips keep the 8-frame floor
		{40, Options{IntervalSec: 4}, 10, 10, 1},                    // 40 s / 4 s
		{600, Options{IntervalSec: 4}, 150, 10, 15},                 // tier 900 s caps at 180
		{7200, Options{IntervalSec: 4, MaxTiles: 240}, 240, 10, 24}, // operator cap
		{100000, Options{}, 720, 10, 72},                            // longest tier
		{30, Options{Columns: 1, TileWidth: 9999}, 30, 2, 15},       // clamps
	}
	for _, c := range cases {
		p := PlanSprite(c.duration, c.opts)
		if p.Frames != c.frames || p.Cols != c.cols || p.Rows != c.rows {
			t.Errorf("PlanSprite(%v, %+v) = %+v, want frames=%d cols=%d rows=%d", c.duration, c.opts, p, c.frames, c.cols, c.rows)
		}
		if math.Abs(p.IntervalSec*float64(p.Frames)-c.duration) > 1e-9 {
			t.Errorf("interval %v does not span %v s", p.IntervalSec, c.duration)
		}
		if p.TileW < 40 || p.TileW > maxTileWidth {
			t.Errorf("tile width %d out of range", p.TileW)
		}
	}
}

func TestBudgetAndPermanentErrors(t *testing.T) {
	if Budget(1) != 5*time.Minute || Budget(36000) != time.Hour || Budget(1200) != 20*time.Minute {
		t.Fatalf("budget clamps wrong: %v %v %v", Budget(1), Budget(36000), Budget(1200))
	}
	if !IsPermanent(errors.New("ffmpeg: moov atom not found")) || IsPermanent(errors.New("ffmpeg: Device creation failed")) || IsPermanent(nil) {
		t.Fatal("permanent error classification is wrong")
	}
}

func TestLimiterBoundsAndCancels(t *testing.T) {
	var l Limiter
	ctx := context.Background()
	if err := l.Acquire(ctx, 1); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if err := l.Acquire(waitCtx, 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second acquire = %v, want deadline", err)
	}
	got := make(chan error, 1)
	go func() { got <- l.Acquire(ctx, 1) }()
	time.Sleep(10 * time.Millisecond)
	l.Release()
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("waiter not woken by release")
	}
	if l.Active() != 1 {
		t.Fatalf("active = %d", l.Active())
	}
	l.Release()
}

func TestProbeAndEncodeRealVideo(t *testing.T) {
	src := testVideo(t, 3)
	ctx := context.Background()
	duration, err := ProbeDuration(ctx, src)
	if err != nil || math.Abs(duration-3) > 0.2 {
		t.Fatalf("duration = %v err = %v", duration, err)
	}
	// Without ffprobe the ffmpeg header is parsed instead.
	t.Setenv("FFPROBE_PATH", filepath.Join(t.TempDir(), "missing-ffprobe"))
	if d, err := ProbeDuration(ctx, src); err != nil || math.Abs(d-duration) > 0.05 {
		t.Fatalf("fallback duration = %v err = %v", d, err)
	}
	plan := PlanSprite(duration, Options{IntervalSec: 1, Columns: 4, TileWidth: 80})
	out := filepath.Join(t.TempDir(), "sprite.webp")
	// An unusable hardware decoder must not fail the encode.
	if err := Encode(ctx, src, out, duration, plan, Options{Format: "webp", Quality: 70, MaxRetries: 1, HWAccel: "vaapi"}); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 12)
	f, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Read(head); err != nil || string(head[0:4]) != "RIFF" || string(head[8:12]) != "WEBP" {
		t.Fatalf("sprite header = %q err = %v", head, err)
	}

	bad := filepath.Join(t.TempDir(), "bad.mp4")
	if err := os.WriteFile(bad, []byte("not a video at all"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ProbeDuration(ctx, bad); !errors.Is(err, ErrNoDuration) {
		t.Fatalf("probe of garbage = %v", err)
	}
	if err := Encode(ctx, bad, out+".bad", 3, plan, Options{Format: "webp", Quality: 70, MaxRetries: 3}); !IsPermanent(err) {
		t.Fatalf("garbage encode error = %v, want permanent", err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := Encode(cancelled, src, out+".c", duration, plan, Options{Format: "webp"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled encode = %v", err)
	}
}
