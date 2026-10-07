package fsx

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

func TestRemoveTreeKeepsSharedFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(root, "nested", "keep.jpg")
	drop := filepath.Join(root, "nested", "drop.jpg")
	if err := os.WriteFile(keep, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(drop, []byte("drop"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots, _ := hash.NewRoots([]string{root})
	h := &RemoveTreeHandler{Roots: roots}
	body, _ := json.Marshal(map[string]any{"root": root, "keep": []string{keep}})
	req := httptest.NewRequest(http.MethodPost, "/v1/fs/remove-tree", bytes.NewReader(body))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status %d: %s", res.Code, res.Body.String())
	}
	var got struct {
		Kept    int `json:"kept"`
		Removed int `json:"removed"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Kept != 1 {
		t.Fatalf("kept = %d, want 1", got.Kept)
	}
	if got.Removed != 1 {
		t.Fatalf("removed = %d, want 1", got.Removed)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(drop); !os.IsNotExist(err) {
		t.Fatalf("drop stat error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "nested")); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveTreeRejectsOutsideKeep(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	roots, _ := hash.NewRoots([]string{root})
	h := &RemoveTreeHandler{Roots: roots}
	body, _ := json.Marshal(map[string]any{"root": root, "keep": []string{filepath.Join(outside, "x")}})
	req := httptest.NewRequest(http.MethodPost, "/v1/fs/remove-tree", bytes.NewReader(body))
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status %d: %s", res.Code, res.Body.String())
	}
	_, _ = io.Copy(io.Discard, res.Body)
}
