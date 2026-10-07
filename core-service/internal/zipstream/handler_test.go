package zipstream

import (
	"archive/zip"
	"bytes"
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

func newHandler(t *testing.T, roots ...string) http.Handler {
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
	req := httptest.NewRequest(http.MethodPost, "/v1/zip", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	return res
}

func TestStreamsStoreArchive(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first.txt")
	second := filepath.Join(root, "second.bin")
	if err := os.WriteFile(first, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte{0, 1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	res := post(t, newHandler(t, root), map[string]any{"entries": []map[string]string{
		{"path": first, "name": "Group/hello.txt"},
		{"path": second, "name": "Group/raw.bin"},
	}})
	if res.Code != http.StatusOK {
		t.Fatalf("status %d: %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/zip" {
		t.Fatalf("content type %q", got)
	}
	zr, err := zip.NewReader(bytes.NewReader(res.Body.Bytes()), int64(res.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("entries = %d, want 2", len(zr.File))
	}
	want := map[string]string{"Group/hello.txt": "hello", "Group/raw.bin": string([]byte{0, 1, 2, 3})}
	for _, f := range zr.File {
		if f.Method != zip.Store {
			t.Fatalf("%s method = %d, want STORE", f.Name, f.Method)
		}
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r)
		_ = r.Close()
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want[f.Name] {
			t.Fatalf("%s = %q, want %q", f.Name, got, want[f.Name])
		}
	}
}

func TestRejectsOutsideAndUnsafeNames(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	p := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(p, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := newHandler(t, root)
	res := post(t, h, map[string]any{"entries": []map[string]string{{"path": p, "name": "x.txt"}}})
	if res.Code != http.StatusForbidden {
		t.Fatalf("outside status %d: %s", res.Code, res.Body.String())
	}
	res = post(t, h, map[string]any{"entries": []map[string]string{{"path": filepath.Join(root, "x"), "name": "../x.txt"}}})
	if res.Code != http.StatusBadRequest {
		t.Fatalf("unsafe name status %d: %s", res.Code, res.Body.String())
	}
}
