package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestGalleryPathsServeRootLegacyAndSharedFiles(t *testing.T) {
	dir := t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	fixtures := []struct{ name, stored, want string }{
		{"root.txt", "root.txt", "root.txt"},
		{"legacy.txt", "legacy.txt", "Gallery/documents/legacy.txt"},
		{"forwarded.txt", "Original/documents/shared.txt", "Original/documents/shared.txt"},
	}
	for i, row := range fixtures {
		path := filepath.Join(dir, "downloads", filepath.FromSlash(row.want))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(row.name), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,group_name,message_id,file_name,file_path,file_size,file_type) VALUES('-1','Gallery',?,?,?,?, 'document')`, i+1, row.name, row.stored, len(row.name)); err != nil {
			t.Fatal(err)
		}
	}
	// A legacy filename-only row must not be redirected to an unrelated root
	// file with the same basename. Its established group layout takes priority.
	if err := os.WriteFile(filepath.Join(dir, "downloads", "legacy.txt"), []byte("unrelated root file"), 0600); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	get := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/api/downloads/all", "/api/downloads/-1", "/api/downloads/search?q=txt"} {
		w := get(path)
		var result struct {
			Files []struct{ Name, FullPath string }
		}
		if w.Code != 200 {
			t.Fatalf("%s: status %d", path, w.Code)
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Files) != len(fixtures) {
			t.Fatalf("%s: files %d", path, len(result.Files))
		}
		for _, file := range result.Files {
			for _, row := range fixtures {
				if file.Name != row.name {
					continue
				}
				if file.FullPath != row.want {
					t.Fatalf("%s: %s fullPath=%q want=%q", path, row.name, file.FullPath, row.want)
				}
				media := get("/files/" + url.PathEscape(file.FullPath))
				if media.Code != 200 || media.Body.String() != row.name {
					t.Fatalf("%s: media status=%d body=%q", row.name, media.Code, media.Body.String())
				}
			}
		}
	}
	legacyDir := filepath.Join(dir, "downloads", "Gallery", "documents")
	if err := os.Chmod(legacyDir, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(legacyDir, 0700)
	w := get("/api/downloads/all")
	var result struct {
		Files []struct{ Name, FullPath string }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	for _, file := range result.Files {
		if file.Name == "legacy.txt" && file.FullPath != "Gallery/documents/legacy.txt" {
			t.Fatal("inaccessible legacy file was replaced by unrelated root file", file.FullPath)
		}
	}
}
