package seekbar

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

func TestSeekbarWorker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "clip.mp4")
	output := filepath.Join(dir, "sprite.webp.tmp")
	if err := os.WriteFile(input, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\nout=\"\"\nfor arg; do out=\"$arg\"; done\nprintf webp > \"$out\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots, Workers: 1}
	body, _ := json.Marshal(request{
		Path: input, Output: output, Frames: 12, Interval: 1.5, Cols: 4, Rows: 3,
		TileWidth: 160, Format: "webp", Quality: 75,
	})
	res := httptest.NewRecorder()
	h.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/v1/seekbar", bytes.NewReader(body)))
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var got response
	if err := json.Unmarshal(res.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" || got.Size != 4 {
		t.Fatalf("response=%+v", got)
	}
	if b, err := os.ReadFile(output); err != nil || string(b) != "webp" {
		t.Fatalf("output=%q err=%v", b, err)
	}
}

func TestSeekbarRejectsInvalidParamsAndOutsideOutput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(input, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	base := request{Path: input, Output: filepath.Join(dir, "sprite.webp.tmp"), Frames: 12, Interval: 1, Cols: 4, Rows: 3, TileWidth: 160, Format: "webp", Quality: 75}
	for name, req := range map[string]request{
		"bad frames":   func() request { r := base; r.Frames = 2; return r }(),
		"bad format":   func() request { r := base; r.Format = "png"; return r }(),
		"outside file": func() request { r := base; r.Output = filepath.Join(t.TempDir(), "out.webp"); return r }(),
	} {
		body, _ := json.Marshal(req)
		res := httptest.NewRecorder()
		h.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/v1/seekbar", bytes.NewReader(body)))
		want := http.StatusBadRequest
		if name == "outside file" {
			want = http.StatusForbidden
		}
		if res.Code != want {
			t.Errorf("%s: status=%d body=%s want=%d", name, res.Code, res.Body.String(), want)
		}
	}
}
