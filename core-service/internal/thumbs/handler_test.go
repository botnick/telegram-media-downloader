package thumbs

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

func TestVideoThumbWorker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "clip.mp4")
	output := filepath.Join(dir, "thumb.webp.tmp")
	if err := os.WriteFile(input, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nout=\"\"\nfor arg; do out=\"$arg\"; done\nprintf webp > \"$out\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots, Workers: 1}
	body, _ := json.Marshal(request{Path: input, Output: output, Width: 320})
	req := httptest.NewRequest(http.MethodPost, "/v1/thumb/video", bytes.NewReader(body))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
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
	if string(mustRead(t, output)) != "webp" {
		t.Fatalf("output=%q", mustRead(t, output))
	}
}

func TestImageAndAudioThumbWorkers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "media.bin")
	if err := os.WriteFile(input, []byte("media"), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nout=\"\"\nfor arg; do out=\"$arg\"; done\nprintf webp > \"$out\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	roots, _ := hash.NewRoots([]string{dir})
	for _, kind := range []string{"image", "audio"} {
		h := &Handler{Roots: roots, Workers: 1, Kind: kind}
		output := filepath.Join(dir, kind+".webp.tmp")
		body, _ := json.Marshal(request{Path: input, Output: output, Width: 320})
		req := httptest.NewRequest(http.MethodPost, "/v1/thumb/"+kind, bytes.NewReader(body))
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", kind, res.Code, res.Body.String())
		}
		if string(mustRead(t, output)) != "webp" {
			t.Fatalf("%s output=%q", kind, mustRead(t, output))
		}
	}
}

func TestVideoThumbOutputMustStayInsideRoots(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(input, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	body, _ := json.Marshal(request{Path: input, Output: filepath.Join(t.TempDir(), "out.webp"), Width: 320})
	req := httptest.NewRequest(http.MethodPost, "/v1/thumb/video", bytes.NewReader(body))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestVideoThumbRetriesAtZeroSeconds(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "clip.mp4")
	output := filepath.Join(dir, "thumb.webp.tmp")
	if err := os.WriteFile(input, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	script := "#!/bin/sh\nprev=''\nfor arg; do\n  if [ \"$prev\" = \"-ss\" ] && [ \"$arg\" = \"1\" ]; then exit 1; fi\n  prev=\"$arg\"\ndone\nprintf webp > \"$prev\"\n"
	if err := os.WriteFile(ffmpeg, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots, Workers: 1}
	body, _ := json.Marshal(request{Path: input, Output: output, Width: 320})
	req := httptest.NewRequest(http.MethodPost, "/v1/thumb/video", bytes.NewReader(body))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	if string(mustRead(t, output)) != "webp" {
		t.Fatalf("output=%q", mustRead(t, output))
	}
}

func TestVideoThumbRejectsInvalidWidth(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "clip.mp4")
	output := filepath.Join(dir, "thumb.webp.tmp")
	if err := os.WriteFile(input, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	body, _ := json.Marshal(request{Path: input, Output: output, Width: maxWidth + 1})
	req := httptest.NewRequest(http.MethodPost, "/v1/thumb/video", bytes.NewReader(body))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
