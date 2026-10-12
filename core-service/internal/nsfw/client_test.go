package nsfw

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSidecar mimics nsfw-service/main.py.
type fakeSidecar struct {
	mu        sync.Mutex
	token     string
	features  []string
	allowRoot string // "" = path mode off
	files     map[string]float64
	status    int // forced status for /classify*, 0 = normal
	calls     map[string]int
	lastPath  string
}

func (f *fakeSidecar) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[r.URL.Path]++
	reply := func(code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	if r.URL.Path == "/health" {
		reply(200, map[string]any{"ok": true, "model": "fake", "ready": true, "version": "1.2.0", "features": f.features, "auth_required": f.token != "", "path_mode": f.allowRoot != ""})
		return
	}
	if f.token != "" && r.Header.Get(TokenHeader) != f.token {
		reply(401, map[string]any{"error": "unauthorized", "code": "unauthorized"})
		return
	}
	if f.status != 0 {
		reply(f.status, map[string]any{"error": "forced"})
		return
	}
	body, _ := io.ReadAll(r.Body)
	switch r.URL.Path {
	case "/classify/upload":
		reply(200, map[string]any{"score": scoreOf(body), "label": "x"})
	case "/classify":
		var req struct {
			Path     string `json:"path"`
			ImageB64 string `json:"image_b64"`
		}
		_ = json.Unmarshal(body, &req)
		switch {
		case req.Path != "":
			f.lastPath = req.Path
			if f.allowRoot == "" || !strings.HasPrefix(req.Path, f.allowRoot) {
				reply(403, map[string]any{"error": "path_not_allowed", "code": "path_not_allowed"})
				return
			}
			score, ok := f.files[req.Path]
			if !ok {
				reply(200, map[string]any{"error": "file_not_found", "score": nil})
				return
			}
			reply(200, map[string]any{"score": score, "label": "x"})
		case req.ImageB64 != "":
			raw, _ := base64.StdEncoding.DecodeString(req.ImageB64)
			reply(200, map[string]any{"score": scoreOf(raw), "label": "x"})
		default:
			reply(400, map[string]any{"error": "provide path or image_b64", "code": "missing_input"})
		}
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeSidecar) count(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[path]
}

func (f *fakeSidecar) path() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastPath
}

// scoreOf lets tests choose the score through the uploaded bytes.
func scoreOf(b []byte) float64 {
	switch string(b) {
	case "nsfw":
		return 0.95
	case "bad":
		return -1
	}
	return 0.1
}

func newTestClient(t *testing.T, f *fakeSidecar, s Settings) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	s.URL = srv.URL + "/"
	if s.Backoff == nil {
		s.Backoff = []time.Duration{time.Millisecond}
	}
	c := NewClient(srv.Client())
	c.Configure(s)
	return c, srv
}

func load(b string) func() ([]byte, error) { return func() ([]byte, error) { return []byte(b), nil } }

func TestClassifyPathModeThroughPathMap(t *testing.T) {
	f := &fakeSidecar{features: []string{"path", "upload"}, allowRoot: "/mnt/media/", files: map[string]float64{"/mnt/media/a/b.jpg": 0.8}}
	c, _ := newTestClient(t, f, Settings{PathMap: "/app/data/downloads=/mnt/media"})
	score, err := c.Classify(context.Background(), Image{Path: "/app/data/downloads/a/b.jpg", Load: load("unused")})
	if err != nil || score == nil || *score != 0.8 {
		t.Fatalf("score=%v err=%v", score, err)
	}
	if f.count("/classify/upload") != 0 || f.path() != "/mnt/media/a/b.jpg" {
		t.Fatalf("lastPath=%q", f.path())
	}
}

func TestClassifyFallsBackToUploadAndRemembersPathRejection(t *testing.T) {
	f := &fakeSidecar{features: []string{"path", "upload"}}
	c, _ := newTestClient(t, f, Settings{})
	for i := 0; i < 2; i++ {
		score, err := c.Classify(context.Background(), Image{Path: "/data/x.jpg", Load: load("nsfw")})
		if err != nil || score == nil || *score != 0.95 {
			t.Fatalf("score=%v err=%v", score, err)
		}
	}
	if f.count("/classify") != 1 || f.count("/classify/upload") != 2 {
		t.Fatalf("path mode should be tried once per session, calls=%v", f.count("/classify"))
	}
	if c.Info()["transfer"] != "upload" {
		t.Fatalf("info=%v", c.Info())
	}
}

func TestClassifyUploadsFileTheSidecarCannotFind(t *testing.T) {
	f := &fakeSidecar{features: []string{"path", "upload"}, allowRoot: "/data/", files: map[string]float64{}}
	c, _ := newTestClient(t, f, Settings{})
	score, err := c.Classify(context.Background(), Image{Path: "/data/missing.jpg", Load: load("nsfw")})
	if err != nil || score == nil || *score != 0.95 {
		t.Fatalf("score=%v err=%v", score, err)
	}
	if c.Info()["transfer"] != "path" {
		t.Fatal("file_not_found must not switch the session away from path mode")
	}
}

func TestClassifyUsesBase64ForOldSidecars(t *testing.T) {
	f := &fakeSidecar{features: []string{"path", "b64"}}
	c, _ := newTestClient(t, f, Settings{})
	score, err := c.ClassifyBytes(context.Background(), []byte("nsfw"))
	if err != nil || score == nil || *score != 0.95 {
		t.Fatalf("score=%v err=%v", score, err)
	}
	if f.count("/classify/upload") != 0 || f.count("/classify") != 1 {
		t.Fatalf("calls=%v", f.count("/classify"))
	}
}

func TestClassifySendsTokenAndReportsRejection(t *testing.T) {
	f := &fakeSidecar{token: "secret", features: []string{"upload"}}
	c, srv := newTestClient(t, f, Settings{Token: "secret"})
	if score, err := c.ClassifyBytes(context.Background(), []byte("x")); err != nil || score == nil {
		t.Fatalf("score=%v err=%v", score, err)
	}
	c.Configure(Settings{URL: srv.URL, Token: "wrong", Backoff: []time.Duration{time.Millisecond}})
	if _, err := c.ClassifyBytes(context.Background(), []byte("x")); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err=%v", err)
	}
}

func TestClassifyRetriesThenReportsUnavailable(t *testing.T) {
	f := &fakeSidecar{features: []string{"upload"}, status: http.StatusServiceUnavailable}
	c, _ := newTestClient(t, f, Settings{MaxRetries: 3})
	if _, err := c.ClassifyBytes(context.Background(), []byte("x")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err=%v", err)
	}
	if f.count("/classify/upload") != 3 {
		t.Fatalf("calls=%v", f.count("/classify"))
	}
}

func TestClassifyPerFileFailuresAreNotFatal(t *testing.T) {
	f := &fakeSidecar{features: []string{"upload"}, status: http.StatusRequestEntityTooLarge}
	c, _ := newTestClient(t, f, Settings{})
	score, err := c.ClassifyBytes(context.Background(), []byte("x"))
	if err != nil || score != nil {
		t.Fatalf("score=%v err=%v", score, err)
	}
	// Scores outside 0..1 are clamped.
	f.mu.Lock()
	f.status = 0
	f.mu.Unlock()
	score, err = c.ClassifyBytes(context.Background(), []byte("bad"))
	if err != nil || score == nil || *score != 0 {
		t.Fatalf("score=%v err=%v", score, err)
	}
}

func TestClassifyWithoutURL(t *testing.T) {
	c := NewClient(nil)
	if _, err := c.Classify(context.Background(), Image{Path: "/x"}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err=%v", err)
	}
	if h := c.Health(context.Background()); h.OK || h.Error != "sidecar_url_unset" {
		t.Fatalf("health=%+v", h)
	}
}

func TestProbe(t *testing.T) {
	f := &fakeSidecar{token: "secret", features: []string{"upload"}}
	srv := httptest.NewServer(f)
	defer srv.Close()
	good := Probe(context.Background(), srv.Client(), srv.URL, "secret")
	if !good.OK || good.Auth != "ok" || good.Version != "1.2.0" {
		t.Fatalf("good=%+v", good)
	}
	bad := Probe(context.Background(), srv.Client(), srv.URL, "")
	if bad.OK || bad.Auth != "failed" || bad.Error != "token_required" {
		t.Fatalf("bad=%+v", bad)
	}
	if _, problem := ProbeURL("ftp://x"); problem != "invalid_scheme" {
		t.Fatalf("problem=%q", problem)
	}
	if _, problem := ProbeURL("http://u:p@host"); problem != "invalid_url" {
		t.Fatalf("problem=%q", problem)
	}
	if base, _ := ProbeURL(" https://host/nsfw/// "); base != "https://host/nsfw" {
		t.Fatalf("base=%q", base)
	}
}

func TestNormalizeURLAndPathMap(t *testing.T) {
	for in, want := range map[string]string{"": "", "nsfw:8012/": "http://nsfw:8012", "https://h/p/?q=1#x": "https://h/p"} {
		if got := NormalizeURL(in); got != want {
			t.Errorf("NormalizeURL(%q)=%q want %q", in, got, want)
		}
	}
	rules := ParsePathMap("# comment\n/app/data=/mnt;/app/data/downloads=>/media\nbad")
	for in, want := range map[string]string{
		"/app/data/downloads/a.jpg": "/media/a.jpg",
		"/app/data/x.jpg":           "/mnt/x.jpg",
		"/app/database":             "/app/database",
		"/other/a.jpg":              "/other/a.jpg",
	} {
		if got := ToSidecarPath(in, rules); got != want {
			t.Errorf("ToSidecarPath(%q)=%q want %q", in, got, want)
		}
	}
	win := ParsePathMap(`/app/data/downloads=D:\Media`)
	if got := ToSidecarPath("/app/data/downloads/sub/a.jpg", win); got != `D:\Media\sub\a.jpg` {
		t.Errorf("windows target=%q", got)
	}
}

func TestSpriteTilesAndAggregation(t *testing.T) {
	sheet := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for x := 0; x < 40; x++ {
		for y := 0; y < 20; y++ {
			sheet.Set(x, y, color.RGBA{uint8(x * 6), uint8(y * 12), 0, 255})
		}
	}
	idx := SampleTiles(8, 3)
	if len(idx) != 3 || idx[0] != 0 || idx[1] != 2 || idx[2] != 5 {
		t.Fatalf("indices=%v", idx)
	}
	tiles := SpriteTiles(sheet, Sprite{Cols: 4, Rows: 2, TileW: 10, Frames: 8}, []int{0, 7, 99})
	if len(tiles) != 2 {
		t.Fatalf("tiles=%d", len(tiles))
	}
	img, format, err := image.Decode(strings.NewReader(string(tiles[1])))
	if err != nil || format != "jpeg" || img.Bounds().Dx() != 10 || img.Bounds().Dy() != 10 {
		t.Fatalf("tile decode: %v %s %v", err, format, img.Bounds())
	}
	if got := TopKMean([]float64{0.1, 0.9, 0.5, 0.7}); got < 0.699 || got > 0.701 {
		t.Fatalf("top3=%v", got)
	}
}

func TestPrepareUploadDownscalesLargeImages(t *testing.T) {
	small := []byte("not an image")
	if got := PrepareUpload(small); string(got) != string(small) {
		t.Fatal("small payload must pass through")
	}
	big := make([]byte, downscaleOverBytes+1)
	if got := PrepareUpload(big); len(got) != len(big) {
		t.Fatal("undecodable payload must pass through")
	}
	src := image.NewRGBA(image.Rect(0, 0, 3000, 1500))
	if out := fitInside(src, 1024).Bounds(); out.Dx() != 1024 || out.Dy() != 512 {
		t.Fatalf("fitInside=%v", out)
	}
}
