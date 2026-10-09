package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Split-disk installs (TGDL_DOWNLOADS_DIR) keep serving, and purging, media
// from the external root after the upgrade from Node.
func TestExternalDownloadsDirServesAndPurgesMedia(t *testing.T) {
	data, external := t.TempDir(), t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: data, DownloadsDir: external})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	rel := filepath.Join("Old Channel", "images", "a.jpg")
	if err := os.MkdirAll(filepath.Join(external, filepath.Dir(rel)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(external, rel), []byte("external media"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,group_name,message_id,file_name,file_size,file_type,file_path) VALUES('-1001','Old Channel',1,'a.jpg',14,'photo',?)`, filepath.ToSlash(rel)); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	if w := do(http.MethodGet, "/files/Old%20Channel/images/a.jpg"); w.Code != 200 || w.Body.String() != "external media" {
		t.Fatalf("external file=%d %q", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(data, "downloads", rel)); !os.IsNotExist(err) {
		t.Fatalf("media duplicated under data dir: %v", err)
	}
	if w := do(http.MethodPost, "/api/groups/-1001/delete-files"); w.Code != 200 {
		t.Fatalf("purge=%d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(external, rel)); os.IsNotExist(err) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("purge left the external file")
}
