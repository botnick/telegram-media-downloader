package faststart

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

func TestAlreadyFaststart(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(p, mp4Header("moov"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	req := httptest.NewRequest(http.MethodPost, "/v1/faststart", bytes.NewBufferString(`{"path":"`+p+`"}`))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var got response
	if err := json.Unmarshal(res.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "already" {
		t.Fatalf("response=%+v", got)
	}
}

func TestOutsideAndInvalidFiles(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.mp4")
	if err := os.WriteFile(outside, mp4Header("mdat"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	for _, p := range []string{outside, filepath.Join(dir, "missing.mp4")} {
		req := httptest.NewRequest(http.MethodPost, "/v1/faststart", bytes.NewBufferString(`{"path":"`+p+`"}`))
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != http.StatusForbidden && res.Code != http.StatusUnprocessableEntity {
			t.Errorf("path %q status=%d body=%s", p, res.Code, res.Body.String())
		}
	}
}

func TestOptimizesWithFfmpegWorker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell worker fixture is POSIX-only")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(p, mp4Header("mdat"), 0o644); err != nil {
		t.Fatal(err)
	}
	ffmpeg := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\nout=\"\"\nfor arg; do out=\"$arg\"; done\ncp \"$5\" \"$out\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FFMPEG_PATH", ffmpeg)
	roots, _ := hash.NewRoots([]string{dir})
	h := &Handler{Roots: roots}
	req := httptest.NewRequest(http.MethodPost, "/v1/faststart", bytes.NewBufferString(`{"path":"`+p+`"}`))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var got response
	if err := json.Unmarshal(res.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "optimized" || got.NewSize != int64(len(mp4Header("mdat"))) {
		t.Fatalf("response=%+v", got)
	}
}

func mp4Header(atom string) []byte {
	b := make([]byte, 24)
	binary.BigEndian.PutUint32(b[:4], 16)
	copy(b[4:8], "ftyp")
	copy(b[16:20], atom)
	binary.BigEndian.PutUint32(b[16:20], 8)
	copy(b[20:24], atom)
	return b
}
