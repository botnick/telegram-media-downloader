package tarstream

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

func newTestHandler(t *testing.T, roots ...string) http.Handler {
	t.Helper()
	r, _ := hash.NewRoots(roots)
	return &Handler{Roots: r, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func post(t *testing.T, h http.Handler, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/tar-gz", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	return res
}

func TestStreamsTarGzSnapshot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "db.sqlite"), []byte("db bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sessions", "one.session"), []byte("session"), 0o600); err != nil {
		t.Fatal(err)
	}

	res := post(t, newTestHandler(t, root), map[string]string{"root": root})
	if res.Code != http.StatusOK {
		t.Fatalf("status %d: %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/gzip" {
		t.Fatalf("content type %q", got)
	}
	gz, err := gzip.NewReader(bytes.NewReader(res.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	want := map[string]string{
		"db.sqlite":            "db bytes",
		"sessions/one.session": "session",
	}
	seen := map[string]bool{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeDir {
			continue
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != want[h.Name] {
			t.Fatalf("%s = %q, want %q", h.Name, body, want[h.Name])
		}
		seen[h.Name] = true
	}
	if len(seen) != len(want) {
		t.Fatalf("entries = %v, want %v", seen, want)
	}
}

func TestRejectsOutsideAndNonDirectoryRoots(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	h := newTestHandler(t, root)
	res := post(t, h, map[string]string{"root": outside})
	if res.Code != http.StatusForbidden {
		t.Fatalf("outside status %d: %s", res.Code, res.Body.String())
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	res = post(t, h, map[string]string{"root": file})
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("file root status %d: %s", res.Code, res.Body.String())
	}
}
