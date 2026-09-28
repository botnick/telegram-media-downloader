package worker

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/config"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/ffmpeg"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/logx"
)

func TestJobParamsClamp(t *testing.T) {
	jp := (&JobParams{TileW: 5000, Cols: 12, Format: "gif", Quality: 80, IntervalSec: 0.1}).Clamp()
	if jp == nil || jp.Cols != 12 || jp.Quality != 80 || jp.TileW != 0 || jp.Format != "" || jp.IntervalSec != 0 {
		t.Fatalf("clamp: %+v", jp)
	}
	if (&JobParams{TileW: 1}).Clamp() != nil {
		t.Fatal("all-invalid params should clamp to nil")
	}
	var nilParams *JobParams
	if nilParams.Clamp() != nil {
		t.Fatal("nil clamp")
	}
}

func TestThumbForOverrides(t *testing.T) {
	base := config.Defaults().Thumb
	got := thumbFor(base, &JobParams{TileW: 80, Format: "jpeg"})
	if got.Width != 80 || got.Format != "jpeg" || got.Columns != base.Columns || got.Quality != base.Quality {
		t.Fatalf("thumbFor: %+v", got)
	}
	if thumbFor(base, nil) != base {
		t.Fatal("nil params must keep the defaults")
	}
}

// End-to-end through ffmpeg: an uploaded source honours per-job params and
// is deleted once the job settles. Skipped when ffmpeg isn't installed.
func TestUploadJobUsesParamsAndCleansUp(t *testing.T) {
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	probe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "u1.job")
	gen := exec.Command(ff, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
		"-i", "testsrc=duration=6:size=320x180:rate=10", "-pix_fmt", "yuv420p", "-f", "mp4", "-y", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Skipf("cannot make a test clip: %v %s", err, out)
	}

	cfg := config.Defaults()
	cfg.Storage.OutputDir = filepath.Join(dir, "out")
	cfg.Storage.TempDir = cfg.Storage.OutputDir
	cfg.FFmpeg.Path = ff
	cfg.FFmpeg.ProbePath = probe
	cfg.FFmpeg.HWAccel = "none"
	cfg.Storage.Overwrite = "never" // must not short-circuit an upload
	cfg.Jobs.MaxRetries = 0
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(cfg.Storage.OutputDir, 0o755)
	// A stale sprite from an earlier run must not be returned for an upload.
	_ = os.WriteFile(filepath.Join(cfg.Storage.OutputDir, "9.jpg"), []byte("stale"), 0o644)
	_ = os.WriteFile(filepath.Join(cfg.Storage.OutputDir, "9.json"), []byte("{}"), 0o644)

	p := NewPool(cfg, logx.New("error", "text"))
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		p.Stop()
	}()
	p.Start(ctx, "none")
	j := &Job{ID: "j1", VideoID: "9", SrcPath: src, Source: "upload",
		Params: (&JobParams{TileW: 80, Cols: 4, Format: "jpeg"}).Clamp()}
	p.Submit(j)

	deadline := time.Now().Add(60 * time.Second)
	for {
		p.mu.Lock()
		status := j.Status
		p.mu.Unlock()
		if status == "done" || status == "failed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job stuck in %q", status)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Give the worker a moment to run the post-job cleanup.
	time.Sleep(100 * time.Millisecond)
	if j.Status != "done" {
		t.Fatalf("job failed: %s", j.Error)
	}
	if j.Format != "jpg" || j.Cols != 4 || j.TileW != 80 {
		t.Fatalf("params ignored: format=%s cols=%d tile_w=%d", j.Format, j.Cols, j.TileW)
	}
	w, _, err := ffmpeg.ReadImageDims(j.SpritePath)
	if err != nil || w != 4*80 {
		t.Fatalf("sprite width %d (err %v), want %d", w, err, 4*80)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatal("uploaded source was not deleted after the job")
	}
}
