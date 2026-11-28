package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fullRequest(t *testing.T, a *App, method, path string, body []byte, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("Content-Type", contentType)
	r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	return w
}
func fullJSON(t *testing.T, a *App, method, path string, v any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(v)
	w := fullRequest(t, a, method, path, raw, "application/json")
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func setMarker(t *testing.T, a *App, value string) {
	t.Helper()
	if _, err := a.db.Writer.Exec(`INSERT INTO kv(key,value,updated_at) VALUES('restore-marker',?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, value); err != nil {
		t.Fatal(err)
	}
}
func marker(t *testing.T, a *App) string {
	t.Helper()
	var v string
	if err := a.db.Reader.QueryRow(`SELECT value FROM kv WHERE key='restore-marker'`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestFullBackupDownloadUploadVerifyRestartRestores(t *testing.T) {
	dir := t.TempDir()
	var restarts atomic.Int64
	cfg := Config{DataDir: dir, Restart: func() { restarts.Add(1) }}
	a, err := newConfiguredTestApp(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			a.Close()
		}
	}()
	setMarker(t, a, "at-backup")
	if w, _ := fullJSON(t, a, "POST", "/api/backup/full", map[string]any{"password": "wrong", "passphrase": "backup-pass-123"}); w.Code != 403 {
		t.Fatalf("wrong dashboard password: %d %s", w.Code, w.Body.String())
	}
	if w, _ := fullJSON(t, a, "POST", "/api/backup/full", map[string]any{"password": "test-admin-password", "passphrase": "short"}); w.Code != 400 {
		t.Fatalf("short backup password: %d %s", w.Code, w.Body.String())
	}
	w, built := fullJSON(t, a, "POST", "/api/backup/full", map[string]any{"password": "test-admin-password", "passphrase": "backup-pass-123"})
	if w.Code != 200 || built["id"] == nil || !strings.HasSuffix(built["name"].(string), ".tgdl-backup") {
		t.Fatalf("build: %d %s", w.Code, w.Body.String())
	}
	dl := fullRequest(t, a, "GET", "/api/backup/full/"+built["id"].(string), nil, "")
	if dl.Code != 200 || !bytes.HasPrefix(dl.Body.Bytes(), []byte("TGDLFULL")) || !strings.Contains(dl.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("download: %d %q", dl.Code, dl.Header().Get("Content-Disposition"))
	}
	if miss := fullRequest(t, a, "GET", "/api/backup/full/"+strings.Repeat("0", 32), nil, ""); miss.Code != 404 {
		t.Fatalf("unknown id: %d", miss.Code)
	}
	file := dl.Body.Bytes()
	setMarker(t, a, "after-backup")

	up, upload := func() (*httptest.ResponseRecorder, map[string]any) {
		w := fullRequest(t, a, "POST", "/api/backup/full/restore/upload", file, "application/octet-stream")
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w, out
	}()
	if up.Code != 200 || upload["uploadId"] == nil {
		t.Fatalf("upload: %d %s", up.Code, up.Body.String())
	}
	id := upload["uploadId"].(string)
	if w, _ := fullJSON(t, a, "POST", "/api/backup/full/restore/restart", map[string]any{}); w.Code != 409 {
		t.Fatalf("restart without a verified backup: %d", w.Code)
	}
	if w, out := fullJSON(t, a, "POST", "/api/backup/full/restore/verify", map[string]any{"uploadId": id, "password": "test-admin-password", "passphrase": "not the one"}); w.Code != 400 || !strings.Contains(out["error"].(string), "wrong backup password") {
		t.Fatalf("wrong backup password: %d %s", w.Code, w.Body.String())
	}
	w, verified := fullJSON(t, a, "POST", "/api/backup/full/restore/verify", map[string]any{"uploadId": id, "password": "test-admin-password", "passphrase": "backup-pass-123"})
	if w.Code != 200 || verified["pending"] == nil || verified["canRestart"] != true {
		t.Fatalf("verify (the upload must survive a wrong password): %d %s", w.Code, w.Body.String())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(dir, "restore", "upload-*")); len(leftovers) != 0 {
		t.Fatalf("upload left behind: %v", leftovers)
	}
	if marker(t, a) != "after-backup" {
		t.Fatal("verification touched live data")
	}
	if w, _ := fullJSON(t, a, "POST", "/api/backup/full/restore/restart", map[string]any{}); w.Code != 202 {
		t.Fatalf("restart: %d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for restarts.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("restart was not requested")
		}
		time.Sleep(10 * time.Millisecond)
	}
	a.Close()
	closed = true

	b, err := New(context.Background(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if got := marker(t, b); got != "at-backup" {
		t.Fatalf("restored marker = %q", got)
	}
	_, status := fullJSON(t, b, "GET", "/api/backup/full/restore/status", nil)
	last, _ := status["last"].(map[string]any)
	if status["pending"] != nil || last == nil || last["ok"] != true || status["canRestart"] != false {
		t.Fatalf("status after restart: %+v", status)
	}
	if _, err = os.Stat(filepath.Join(dir, "restore", last["previous"].(string), "db.sqlite")); err != nil {
		t.Fatalf("previous database not kept: %v", err)
	}
}

func TestFullRestoreRefusesBadUploadsAndCancels(t *testing.T) {
	dir := t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if w := fullRequest(t, a, "POST", "/api/backup/full/restore/upload", nil, "application/octet-stream"); w.Code != 411 {
		t.Fatalf("empty upload: %d", w.Code)
	}
	w := fullRequest(t, a, "POST", "/api/backup/full/restore/upload", []byte("not a backup"), "application/octet-stream")
	var up map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &up)
	if w.Code != 200 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	if w, out := fullJSON(t, a, "POST", "/api/backup/full/restore/verify", map[string]any{"uploadId": up["uploadId"], "password": "wrong", "passphrase": "x"}); w.Code != 403 || out["code"] != "BAD_PASSWORD" {
		t.Fatalf("wrong dashboard password: %d %s", w.Code, w.Body.String())
	}
	if w, out := fullJSON(t, a, "POST", "/api/backup/full/restore/verify", map[string]any{"uploadId": up["uploadId"], "password": "test-admin-password", "passphrase": "whatever-123"}); w.Code != 400 || !strings.Contains(out["error"].(string), "not a tgdl full backup") {
		t.Fatalf("not a backup: %d %s", w.Code, w.Body.String())
	}
	if w, _ := fullJSON(t, a, "POST", "/api/backup/full/restore/verify", map[string]any{"uploadId": "../../etc", "password": "test-admin-password", "passphrase": "x"}); w.Code != 400 {
		t.Fatalf("bad upload id: %d", w.Code)
	}
	if w, out := fullJSON(t, a, "POST", "/api/backup/full/restore/cancel", map[string]any{}); w.Code != 200 || out["ok"] != true {
		t.Fatalf("cancel: %d %s", w.Code, w.Body.String())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(dir, "restore", "upload-*")); len(leftovers) != 0 {
		t.Fatalf("cancel left uploads: %v", leftovers)
	}
	if w, out := fullJSON(t, a, "POST", "/api/backup/full/restore/restart", map[string]any{}); w.Code != 409 || out["code"] == "NO_RESTART" {
		t.Fatalf("restart with nothing pending: %d %s", w.Code, w.Body.String())
	}
}
