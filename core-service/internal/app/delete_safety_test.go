package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeleteSharedFileKeepsRemainingOwner(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	root := filepath.Join(a.dataDir, "downloads")
	if err := os.MkdirAll(filepath.Join(root, "gallery"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "gallery", "photo.jpg")
	if err := os.WriteFile(file, []byte("shared media"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path) VALUES('1',1,'gallery/photo.jpg'),('2',2,'gallery\photo.jpg')`); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/", nil)
	if _, err := a.deleteRows(r, []int64{1}, nil); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(file); err != nil || string(got) != "shared media" {
		t.Fatalf("remaining owner's media lost: %q %v", got, err)
	}
	if _, err := a.deleteRows(r, []int64{2}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("last owner's media remains: %v", err)
	}
}

func TestDeleteBatchBeyondSQLiteExpressionDepth(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id) VALUES('1',1)`); err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 2000)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	deleted, err := a.deleteRows(httptest.NewRequest("POST", "/", nil), ids, nil)
	if err != nil || deleted != 1 {
		t.Fatalf("2000-item batch: deleted %d error %v", deleted, err)
	}
}

func TestMediaReadAndDeleteCannotFollowOutsideSymlink(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	outside := t.TempDir()
	file := filepath.Join(outside, "secret.jpg")
	if err := os.WriteFile(file, []byte("private fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(a.dataDir, "downloads")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skip(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/files/escape/secret.jpg", nil)
	r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code == 200 || strings.Contains(w.Body.String(), "private fixture") {
		t.Error("outside file served")
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path) VALUES('1',1,'escape/secret.jpg')`); err != nil {
		t.Fatal(err)
	}
	_, _ = a.deleteRows(r, []int64{1}, nil)
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("outside file deleted: %v", err)
	}
}

func TestPurgeRequiresExactConfirmation(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id) VALUES('1',1)`); err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"", `{}`, `{"confirm":true}`, `{"confirm":"delete all"}`} {
		r := httptest.NewRequest("DELETE", "/api/purge/all", strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != 400 {
			t.Errorf("unconfirmed purge status %d", w.Code)
		}
	}
	var count int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unconfirmed purge mutated rows: %d %v", count, err)
	}
}

func TestCleanupFailureSurvivesRestartAndRetries(t *testing.T) {
	dir := t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if a != nil {
			a.Close()
		}
	}()
	file := filepath.Join(dir, "downloads", "blocked.jpg")
	if err := os.MkdirAll(file, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(file, "child"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path) VALUES('1',1,'blocked.jpg')`); err != nil {
		t.Fatal(err)
	}
	n, err := a.deleteRows(httptest.NewRequest("POST", "/", nil), []int64{1}, nil)
	if n != 1 || err == nil {
		t.Fatalf("delete=%d error=%v; expected cleanup failure", n, err)
	}
	var pending int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_file_cleanup`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("lost cleanup task: %d %v", pending, err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	a = nil
	if err := os.Remove(filepath.Join(file, "child")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("ready to remove"), 0600); err != nil {
		t.Fatal(err)
	}
	a, err = New(context.Background(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("startup did not retry cleanup: %v", err)
	}
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_file_cleanup`).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("completed cleanup remains: %d %v", pending, err)
	}
}
