package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/config"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/logx"
	"github.com/botnick/telegram-media-downloader/seekbar-service/internal/worker"
)

// newTestServer builds a server whose pool is never started, so submitted
// jobs stay pending and no ffmpeg is needed.
func newTestServer(t *testing.T, mutate func(*config.Config)) (*Server, http.Handler) {
	t.Helper()
	cfg := config.Defaults()
	dir := t.TempDir()
	cfg.Storage.OutputDir = filepath.Join(dir, "out")
	cfg.Storage.TempDir = filepath.Join(dir, "tmp")
	if mutate != nil {
		mutate(cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	log := logx.New("error", "text")
	srv := New(cfg, log, worker.NewPool(cfg, log))
	return srv, srv.Routes()
}

func do(t *testing.T, h http.Handler, method, url string, body []byte, headers map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, url, bytes.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func TestHealthAdvertisesFeatures(t *testing.T) {
	_, h := newTestServer(t, func(c *config.Config) { c.HTTP.APIToken = "s3cret" })
	rec, body := do(t, h, "GET", "/health", nil, nil)
	if rec.Code != 200 {
		t.Fatalf("health: %d", rec.Code)
	}
	if body["version"] != ServiceVersion || body["auth_required"] != true {
		t.Fatalf("unexpected health: %v", body)
	}
	feats, _ := body["features"].([]any)
	got := map[string]bool{}
	for _, f := range feats {
		got[f.(string)] = true
	}
	for _, want := range []string{"path", "upload", "job_params", "sprite_download"} {
		if !got[want] {
			t.Errorf("feature %q missing from %v", want, feats)
		}
	}
	if body["upload_chunk_bytes"].(float64) != UploadChunkBytes {
		t.Errorf("upload_chunk_bytes = %v", body["upload_chunk_bytes"])
	}
}

func TestChunkedUploadThenSubmit(t *testing.T) {
	srv, h := newTestServer(t, nil)
	up := "/v1/uploads/u-abc123"
	rec, body := do(t, h, "PUT", up, []byte("hello "), map[string]string{"X-Upload-Offset": "0"})
	if rec.Code != 200 || body["size"].(float64) != 6 {
		t.Fatalf("chunk 1: %d %v", rec.Code, body)
	}
	// Wrong offset → 409 with the real size so the client can resume.
	rec, body = do(t, h, "PUT", up, []byte("zzz"), map[string]string{"X-Upload-Offset": "2"})
	if rec.Code != http.StatusConflict || body["size"].(float64) != 6 {
		t.Fatalf("mismatch: %d %v", rec.Code, body)
	}
	rec, body = do(t, h, "PUT", up+"?offset=6", []byte("world"), nil)
	if rec.Code != 200 || body["size"].(float64) != 11 {
		t.Fatalf("chunk 2: %d %v", rec.Code, body)
	}

	sub, _ := json.Marshal(map[string]any{
		"video_id": "42", "upload_id": "u-abc123", "async": true,
		"tile_w": 80, "cols": 99, "format": "jpeg",
	})
	rec, body = do(t, h, "POST", "/v1/sprite", sub, nil)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("submit: %d %s", rec.Code, rec.Body.String())
	}
	if body["source"] != "upload" || body["status"] != "pending" {
		t.Fatalf("job: %v", body)
	}
	params := body["params"].(map[string]any)
	if params["tile_w"].(float64) != 80 || params["format"] != "jpeg" || params["cols"] != nil {
		t.Fatalf("params not clamped: %v", params)
	}
	claimed := srv.uploadPath("u-abc123", ".job")
	data, err := os.ReadFile(claimed)
	if err != nil || string(data) != "hello world" {
		t.Fatalf("claimed upload: %q %v", data, err)
	}
	if _, err := os.Stat(srv.uploadPath("u-abc123", ".part")); !os.IsNotExist(err) {
		t.Fatalf(".part should be gone after claim")
	}
	// The upload can't be claimed twice or appended to after the claim.
	rec, body = do(t, h, "POST", "/v1/sprite", sub, nil)
	if rec.Code != 400 || body["error"] != "upload not found" {
		t.Fatalf("second claim: %d %v", rec.Code, body)
	}
}

func TestUploadSizeCap(t *testing.T) {
	srv, h := newTestServer(t, func(c *config.Config) { c.Storage.MaxUploadMB = 1 })
	big := bytes.Repeat([]byte{1}, 1<<20+1)
	rec, _ := do(t, h, "PUT", "/v1/uploads/big", big, nil)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d", rec.Code)
	}
	st, err := os.Stat(srv.uploadPath("big", ".part"))
	if err != nil || st.Size() != 0 {
		t.Fatalf("oversized chunk must be rolled back: %v %v", st, err)
	}
}

func TestUploadRejectsBadIDs(t *testing.T) {
	_, h := newTestServer(t, nil)
	rec, _ := do(t, h, "PUT", "/v1/uploads/..%2Fescape", []byte("x"), nil)
	if rec.Code != 400 && rec.Code != 404 {
		t.Fatalf("bad id accepted: %d", rec.Code)
	}
	sub, _ := json.Marshal(map[string]any{"video_id": "1", "upload_id": "../x"})
	rec, _ = do(t, h, "POST", "/v1/sprite", sub, nil)
	if rec.Code != 400 {
		t.Fatalf("bad upload_id accepted: %d", rec.Code)
	}
}

func TestTokenGatesMediaAndUploads(t *testing.T) {
	_, h := newTestServer(t, func(c *config.Config) { c.HTTP.APIToken = "s3cret" })
	if rec, _ := do(t, h, "GET", "/sprite/1", nil, nil); rec.Code != 401 {
		t.Fatalf("sprite without token: %d", rec.Code)
	}
	if rec, _ := do(t, h, "GET", "/meta/1", nil, nil); rec.Code != 401 {
		t.Fatalf("meta without token: %d", rec.Code)
	}
	if rec, _ := do(t, h, "GET", "/sprite/1", nil, map[string]string{"X-API-Token": "s3cret"}); rec.Code != 404 {
		t.Fatalf("sprite with token: %d", rec.Code)
	}
	if rec, _ := do(t, h, "PUT", "/v1/uploads/u1", []byte("x"), nil); rec.Code != 401 {
		t.Fatalf("upload without token: %d", rec.Code)
	}

	_, pub := newTestServer(t, func(c *config.Config) {
		c.HTTP.APIToken = "s3cret"
		c.HTTP.PublicMedia = true
	})
	if rec, _ := do(t, pub, "GET", "/sprite/1", nil, nil); rec.Code != 404 {
		t.Fatalf("public media should skip the token: %d", rec.Code)
	}
}

func TestSpriteDownloadServesTheFile(t *testing.T) {
	srv, h := newTestServer(t, nil)
	_ = os.MkdirAll(srv.cfg.Storage.OutputDir, 0o755)
	_ = os.WriteFile(filepath.Join(srv.cfg.Storage.OutputDir, "7.jpg"), []byte{0xff, 0xd8, 0xff}, 0o644)
	rec, _ := do(t, h, "GET", "/sprite/7", nil, nil)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/jpeg" || rec.Body.Len() != 3 {
		t.Fatalf("sprite: %d %s %d", rec.Code, rec.Header().Get("Content-Type"), rec.Body.Len())
	}
}

func TestSweepUploads(t *testing.T) {
	srv, _ := newTestServer(t, nil)
	_ = os.MkdirAll(srv.uploadDir(), 0o755)
	old := srv.uploadPath("old", ".part")
	fresh := srv.uploadPath("fresh", ".part")
	_ = os.WriteFile(old, []byte("x"), 0o644)
	_ = os.WriteFile(fresh, []byte("x"), 0o644)
	past := time.Now().Add(-3 * time.Hour)
	_ = os.Chtimes(old, past, past)
	if n := srv.sweepUploads(time.Now().Add(-time.Hour)); n != 1 {
		t.Fatalf("swept %d", n)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old upload survived")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh upload removed")
	}
}

func TestPathSubmitStillChecksTheSource(t *testing.T) {
	_, h := newTestServer(t, nil)
	sub, _ := json.Marshal(map[string]any{"video_id": "1", "path": "/definitely/not/here.mp4", "async": true})
	rec, body := do(t, h, "POST", "/v1/sprite", sub, nil)
	if rec.Code != 400 || !strings.Contains(body["error"].(string), "source not found") {
		t.Fatalf("missing path: %d %v", rec.Code, body)
	}
}

func TestAllowRootsLimitsPathMode(t *testing.T) {
	base := t.TempDir()
	inside := filepath.Join(base, "media")
	outside := filepath.Join(base, "private")
	for _, d := range []string{inside, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	okFile := filepath.Join(inside, "a.mp4")
	badFile := filepath.Join(outside, "b.mp4")
	for _, f := range []string{okFile, badFile} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	srv, _ := newTestServer(t, func(c *config.Config) { c.Storage.AllowRoots = []string{inside} })

	if _, ok := srv.resolveSource(okFile); !ok {
		t.Fatalf("file under the root was rejected")
	}
	for _, p := range []string{badFile, filepath.Join(inside, "..", "private", "b.mp4"), inside} {
		if _, ok := srv.resolveSource(p); ok {
			t.Fatalf("%s should be rejected", p)
		}
	}
	// A symlink inside the root that points outside it is rejected too.
	link := filepath.Join(inside, "link.mp4")
	if err := os.Symlink(badFile, link); err == nil {
		if _, ok := srv.resolveSource(link); ok {
			t.Fatalf("symlink escaping the root was accepted")
		}
	}

	// Without allow_roots any existing file is accepted, as before.
	open, _ := newTestServer(t, nil)
	if _, ok := open.resolveSource(badFile); !ok {
		t.Fatalf("no allow_roots should keep the old behaviour")
	}
}
