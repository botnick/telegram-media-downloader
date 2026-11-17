package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/seekbar"
)

func seekbarTestApp(t *testing.T) *App {
	t.Helper()
	bin := seekbar.FFmpegPath()
	if bin == "" {
		t.Skip("ffmpeg not installed")
	}
	if !testWebPEncoderAvailable(bin) {
		t.Skip("ffmpeg without libwebp or cwebp")
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := a.Close(); err != nil {
			t.Error(err)
		}
	})
	return a
}

func testWebPEncoderAvailable(bin string) bool {
	if out, err := exec.Command(bin, "-hide_banner", "-encoders").Output(); err == nil && bytes.Contains(out, []byte("libwebp")) {
		return true
	}
	_, err := exec.LookPath("cwebp")
	return err == nil
}

func seekbarVideo(t *testing.T, a *App, id int, name string, render bool) {
	t.Helper()
	if render {
		path := filepath.Join(a.downloadsDir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(seekbar.FFmpegPath(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
			"testsrc=duration=2:size=160x120:rate=10", "-pix_fmt", "yuv420p", "-y", path)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("ffmpeg cannot render a test clip: %v %s", err, out)
		}
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_name,file_size,file_type,file_path) VALUES(?,'chat',?,?,1,'video',?)`, id, id, name, name); err != nil {
		t.Fatal(err)
	}
}

func seekbarWait(t *testing.T, a *App, job *seekbarJob) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for job.isRunning() {
		if time.Now().After(deadline) {
			t.Fatal("seekbar job did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return job.status()
}

func seekbarRow(t *testing.T, a *App, id int) (sprite, meta, format string, frames int, ok bool) {
	t.Helper()
	err := a.db.Reader.QueryRow(`SELECT sprite_path,meta_path,format,frames FROM seekbar_sprites WHERE download_id=?`, id).Scan(&sprite, &meta, &format, &frames)
	return sprite, meta, format, frames, err == nil
}

func TestSeekbarBuildAllServesSpritesAndMarksMissing(t *testing.T) {
	a := seekbarTestApp(t)
	seekbarVideo(t, a, 1, "chat/clip.mp4", true)
	seekbarVideo(t, a, 2, "chat/gone.mp4", false)

	w := accountRequest(t, a, "GET", "/api/maintenance/seekbar/build/status", "")
	var idle map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &idle)
	if idle["kind"] != "seekbarBuild" || idle["stage"] != "idle" || idle["running"] != false {
		t.Fatalf("idle status = %s", w.Body)
	}

	w = accountRequest(t, a, "POST", "/api/maintenance/seekbar/build-all", "{}")
	if w.Code != http.StatusOK {
		t.Fatalf("build-all = %d %s", w.Code, w.Body)
	}
	status := seekbarWait(t, a, a.seekbar.build)
	result, _ := status["result"].(map[string]any)
	if status["stage"] != "done" || result["generated"] != 1 || result["skipped"] != 1 || result["errored"] != 0 {
		t.Fatalf("build status = %+v", status)
	}

	sprite, meta, format, frames, ok := seekbarRow(t, a, 1)
	if !ok || format != "webp" || frames != 8 || sprite != filepath.Join(a.dataDir, "seekbar", "1.webp") || meta != filepath.Join(a.dataDir, "seekbar", "1.json") {
		t.Fatalf("row = %q %q %q %d %v", sprite, meta, format, frames, ok)
	}
	if _, _, format, _, ok := seekbarRow(t, a, 2); !ok || format != "missing" {
		t.Fatalf("missing marker = %q %v", format, ok)
	}

	w = accountRequest(t, a, "GET", "/api/seekbar/sprite/1", "")
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/webp" || !bytes.HasPrefix(w.Body.Bytes(), []byte("RIFF")) {
		t.Fatalf("sprite = %d %q", w.Code, w.Header().Get("Content-Type"))
	}
	w = accountRequest(t, a, "GET", "/api/seekbar/meta/1", "")
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil || w.Code != http.StatusOK || m["frames"] != float64(8) || m["sprite_url"] != "/api/seekbar/sprite/1" || m["cols"] != float64(10) {
		t.Fatalf("meta = %d %s", w.Code, w.Body)
	}
	if w := accountRequest(t, a, "GET", "/api/seekbar/sprite/2", ""); w.Code != http.StatusNotFound {
		t.Fatalf("marker sprite = %d", w.Code)
	}

	w = accountRequest(t, a, "GET", "/api/maintenance/seekbar/stats", "")
	var stats map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &stats)
	if stats["count"] != float64(2) || stats["totalVideos"] != float64(2) || stats["ffmpegAvailable"] != true || stats["success"] != true {
		t.Fatalf("stats = %s", w.Body)
	}
	w = accountRequest(t, a, "GET", "/api/maintenance/seekbar/build/stats", "")
	var last map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &last)
	if lb, _ := last["lastBuild"].(map[string]any); lb == nil || lb["generated"] != float64(1) || lb["finishedAt"] == nil {
		t.Fatalf("build stats = %s", w.Body)
	}
	if a.kvGetJSON(context.Background(), "pending_job_seekbarBuild") != nil {
		t.Fatal("pending build marker left behind")
	}

	// A second scan finds nothing left to do.
	accountRequest(t, a, "POST", "/api/maintenance/seekbar/build-all", "{}")
	status = seekbarWait(t, a, a.seekbar.build)
	if result, _ := status["result"].(map[string]any); result["processed"] != 0 {
		t.Fatalf("rescan = %+v", status)
	}

	w = accountRequest(t, a, "POST", "/api/maintenance/seekbar/rebuild", `{"wipeOnly":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("wipe = %d %s", w.Code, w.Body)
	}
	status = seekbarWait(t, a, a.seekbar.rebuild)
	if wiped, _ := status["result"].(map[string]any)["wiped"].(map[string]any); wiped["removed"] != 2 {
		t.Fatalf("wipe status = %+v", status)
	}
	if _, _, _, _, ok := seekbarRow(t, a, 1); ok || nonEmptyFile(sprite) || nonEmptyFile(meta) {
		t.Fatal("wipe left the sprite behind")
	}
}

func TestSeekbarRegenAndAutoOnDownload(t *testing.T) {
	a := seekbarTestApp(t)
	seekbarVideo(t, a, 5, "clip.mp4", true)
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_type,file_path) VALUES(6,'chat',6,'photo','a.jpg')`); err != nil {
		t.Fatal(err)
	}
	if w := accountRequest(t, a, "POST", "/api/maintenance/seekbar/regen/6", ""); w.Code != http.StatusBadRequest {
		t.Fatalf("regen photo = %d", w.Code)
	}
	if w := accountRequest(t, a, "POST", "/api/maintenance/seekbar/regen/99", ""); w.Code != http.StatusNotFound {
		t.Fatalf("regen unknown = %d", w.Code)
	}
	w := accountRequest(t, a, "POST", "/api/maintenance/seekbar/regen/5", "")
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != http.StatusOK || body["success"] != true || body["download_id"] != float64(5) {
		t.Fatalf("regen = %d %s", w.Code, w.Body)
	}
	if _, err := a.db.Writer.Exec(`DELETE FROM seekbar_sprites`); err != nil {
		t.Fatal(err)
	}

	// Disabled: the post-download hook drops the work.
	cfg, _ := a.config.Load(context.Background())
	cfg["advanced"] = map[string]any{"seekbar": map[string]any{"enabled": false}}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	a.enqueueSeekbar(5, true)
	waitSeekbarQueue(t, a)
	if _, _, _, _, ok := seekbarRow(t, a, 5); ok {
		t.Fatal("disabled seekbar still generated a sprite")
	}

	// Enabled: the cached files are reused and the row restored.
	cfg["advanced"] = map[string]any{"seekbar": map[string]any{"enabled": true, "autoOnDownload": true}}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	a.enqueueSeekbar(5, true)
	a.enqueueSeekbar(5, false) // deduplicated
	waitSeekbarQueue(t, a)
	if _, _, format, frames, ok := seekbarRow(t, a, 5); !ok || format != "webp" || frames != 8 {
		t.Fatalf("auto row = %q %d %v", format, frames, ok)
	}
}

func waitSeekbarQueue(t *testing.T, a *App) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		a.seekbar.mu.Lock()
		busy := a.seekbar.draining || len(a.seekbar.inFlight) > 0
		a.seekbar.mu.Unlock()
		if !busy {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("seekbar queue did not drain")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSeekbarBuildCancelAndAlreadyRunning(t *testing.T) {
	a := seekbarTestApp(t)
	for i := 1; i <= 3; i++ {
		seekbarVideo(t, a, i, "clip"+string(rune('0'+i))+".mp4", true)
	}
	cfg, _ := a.config.Load(context.Background())
	cfg["advanced"] = map[string]any{"seekbar": map[string]any{"concurrency": 1}}
	_ = a.config.Save(context.Background(), cfg)
	if w := accountRequest(t, a, "POST", "/api/maintenance/seekbar/build-all", "{}"); w.Code != http.StatusOK {
		t.Fatalf("start = %d", w.Code)
	}
	w := accountRequest(t, a, "POST", "/api/maintenance/seekbar/build-all", "{}")
	if a.seekbar.build.isRunning() && (w.Code != http.StatusConflict || !bytes.Contains(w.Body.Bytes(), []byte("ALREADY_RUNNING"))) {
		t.Fatalf("second start = %d %s", w.Code, w.Body)
	}
	if w := accountRequest(t, a, "POST", "/api/maintenance/seekbar/build/cancel", "{}"); w.Code != http.StatusOK {
		t.Fatalf("cancel = %d", w.Code)
	}
	status := seekbarWait(t, a, a.seekbar.build)
	if status["stage"] != "done" || status["running"] != false {
		t.Fatalf("cancelled status = %+v", status)
	}
	w = accountRequest(t, a, "GET", "/api/maintenance/seekbar/queue/stats", "")
	var q map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &q)
	if q["success"] != true || q["running"] != false || q["processing"] != float64(0) {
		t.Fatalf("queue stats = %s", w.Body)
	}
	for _, path := range []string{"/api/maintenance/seekbar/health", "/api/maintenance/seekbar/hwaccel-probe", "/api/maintenance/seekbar/list"} {
		if w := accountRequest(t, a, "GET", path, ""); w.Code != http.StatusOK {
			t.Fatalf("%s = %d %s", path, w.Code, w.Body)
		}
	}
	if w := accountRequest(t, a, "POST", "/api/maintenance/seekbar/sidecar-test", `{}`); w.Code != http.StatusBadRequest {
		t.Fatalf("sidecar-test without url = %d", w.Code)
	}
}
