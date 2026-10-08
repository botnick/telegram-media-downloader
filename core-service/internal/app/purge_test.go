package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func purgeFixture(t *testing.T) (*App, string) {
	t.Helper()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{map[string]any{"id": "target", "name": "Renamed Group", "enabled": true}, map[string]any{"id": "other", "name": "Other", "enabled": true}}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"downloads/Old Folder/images/owned.jpg", "downloads/Old Folder/images/shared.jpg", "photos/target.jpg", "photos/other.jpg"} {
		writePurgeFixture(t, filepath.Join(a.dataDir, filepath.FromSlash(path)))
	}
	for _, id := range []int64{1, 2, 3} {
		writePurgeFixture(t, thumbCachePath(filepath.Join(a.dataDir, "thumbs"), id))
	}
	_, err = a.db.Writer.Exec(`
INSERT INTO downloads(id,group_id,message_id,group_name,file_path) VALUES
 (1,'target',1,'Old Folder','Old Folder/images/owned.jpg'),
 (2,'target',2,'Old Folder','Old Folder/images/shared.jpg'),
 (3,'other',3,'Other','Old Folder/images/shared.jpg');
INSERT INTO queue(group_id,message_id) VALUES('target',1),('other',3);
INSERT INTO tgdl_work(account_id,group_id,group_name,message_id,version,identity,media_type,file_name,file_size,body,created_at,updated_at) VALUES
 ('test','target','Old Folder',4,1,'pending','photo','pending.jpg',7,X'01',1,1),
 ('test','other','Other',5,1,'pending','photo','pending.jpg',7,X'01',1,1);
INSERT INTO kv(key,value,updated_at) VALUES('queue_history','[{"groupId":"target","key":"target_1"},{"groupId":"other","key":"other_3"}]',0);
INSERT INTO chat_access(chat_id,state,checked_at,updated_at) VALUES('target','left',1,1);`)
	if err != nil {
		t.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	return a, token
}

func TestMaintenanceStatusReadsDuringReindex(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	for group := 0; group < 8; group++ {
		for file := 0; file < 8; file++ {
			writePurgeFixture(t, filepath.Join(a.dataDir, "downloads", fmt.Sprintf("group-%d", group), "images", fmt.Sprintf("%d.jpg", file)))
		}
	}
	w := httptest.NewRecorder()
	a.handleReindex(w, httptest.NewRequest("POST", "/api/maintenance/reindex", strings.NewReader(`{"confirm":true}`)))
	if w.Code != 200 {
		t.Fatalf("reindex: %d %s", w.Code, w.Body.String())
	}
	done := make(chan struct{})
	go func() { a.maintenanceJobWG.Wait(); close(done) }()
	for {
		select {
		case <-done:
			var count int
			if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&count); err != nil || count != 64 {
				t.Fatalf("reindex result=%d: %v", count, err)
			}
			return
		default:
			w := httptest.NewRecorder()
			a.handleReindexStatus(w, httptest.NewRequest("GET", "/api/maintenance/reindex/status", nil))
			var status map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestPendingPurgePreventsReindexAndIngestionResurrection(t *testing.T) {
	a, token := purgeFixture(t)
	p := purgeRecord{Key: "group:target", GroupID: "target", Phase: "queued", Status: dedupIdleStatus("groupPurge:target")}
	p.Status["startedAt"], p.Status["attempts"] = time.Now().UnixMilli(), 1
	if err := a.commitPurge(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	a.publishPurge(p)
	// Files still exist, but the catalog transaction already removed their
	// rows. A reindex accepted earlier must not recreate them while cleanup
	// is waiting for retry/restart.
	status := maintenanceIdleStatus("reindex")
	a.runReindex(context.Background(), status, time.Now(), 0)
	if status["stage"] != "error" || status["error"] != errPurgePending.Error() {
		t.Fatalf("reindex reported success during unfinished purge: %v", status)
	}
	w := requestPurge(a, token, "POST", "/api/maintenance/reindex", `{"confirm":true}`)
	if w.Code != 409 {
		t.Fatalf("new reindex was accepted: %d %s", w.Code, w.Body.String())
	}
	if _, err := a.IngestTelegram(context.Background(), nil, "target", nil); !errors.Is(err, errPurgePending) {
		t.Fatalf("ingestion did not honor pending purge: %v", err)
	}
	var count int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("purged rows resurrected: %d %v", count, err)
	}
}

func BenchmarkPurgeGroup1000Files(b *testing.B) {
	b.ReportAllocs()
	for iteration := 0; iteration < b.N; iteration++ {
		b.StopTimer()
		a, err := New(context.Background(), Config{DataDir: b.TempDir()})
		if err != nil {
			b.Fatal(err)
		}
		dir := filepath.Join(a.dataDir, "downloads", "original-folder")
		if err := os.MkdirAll(dir, 0700); err != nil {
			b.Fatal(err)
		}
		tx, err := a.db.Writer.Begin()
		if err != nil {
			b.Fatal(err)
		}
		stmt, err := tx.Prepare(`INSERT INTO downloads(group_id,group_name,message_id,file_path) VALUES(?,?,?,?)`)
		if err != nil {
			b.Fatal(err)
		}
		for id := 0; id < 1000; id++ {
			name := fmt.Sprintf("%04d.bin", id)
			if err := os.WriteFile(filepath.Join(dir, name), []byte("purge benchmark media"), 0600); err != nil {
				b.Fatal(err)
			}
			if _, err := stmt.Exec("target", "renamed-group", id, "original-folder/"+name); err != nil {
				b.Fatal(err)
			}
		}
		if _, err := stmt.Exec("other", "other", 1, "original-folder/0000.bin"); err != nil {
			b.Fatal(err)
		}
		stmt.Close()
		if err := tx.Commit(); err != nil {
			b.Fatal(err)
		}
		p := purgeRecord{Key: "group:target", GroupID: "target", Phase: "queued", Status: dedupIdleStatus("groupPurge:target")}
		p.Status["running"], p.Status["startedAt"] = true, time.Now().UnixMilli()
		b.StartTimer()
		err = a.runPurge(context.Background(), p, false)
		b.StopTimer()
		if err != nil {
			b.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(dir, "0000.bin")); err != nil {
			b.Fatal("shared file was removed", err)
		}
		var rows int
		if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&rows); err != nil || rows != 1 {
			b.Fatalf("remaining rows=%d: %v", rows, err)
		}
		if err := a.Close(); err != nil {
			b.Fatal(err)
		}
	}
}

func TestPurgeJoinsActiveTransferBeforeDeletingQueue(t *testing.T) {
	accounts := make(chan *fixtureAccount, 4)
	entered := make(chan struct{}, 1)
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handle func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &fixtureAccount{handle: handle, download: func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
			if _, err := w.Write([]byte("li")); err != nil {
				return err
			}
			entered <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		}}
		accounts <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if w := monitorRequest(t, a, "/api/monitor/start"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if err := (<-accounts).handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("transfer never started")
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	w := requestPurge(a, token, "DELETE", "/api/groups/-1000000000042/purge", "")
	if w.Code != 200 {
		t.Fatalf("purge: %d %s", w.Code, w.Body.String())
	}
	done := make(chan struct{})
	go func() { a.purgeWG.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("purge deadlocked with active transfer")
	}
	assertPurgeDone(t, a, "group:-1000000000042")
	status, err := a.monitor.Status(context.Background())
	if err != nil || status["state"] != "running" {
		t.Fatalf("monitor did not resume: %v %v", status, err)
	}
	// A replay after restart cannot resurrect a group removed from config.
	if err := (<-accounts).handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"downloads", "tgdl_work", "tgdl_ingest_files"} {
		var count int
		if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Errorf("purged work returned in %s: %d %v", table, count, err)
		}
	}
}

func writePurgeFixture(t *testing.T, file string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
}

func requestPurge(a *App, token, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.AddCookie(&http.Cookie{Name: a.sessions.CookieName(), Value: token})
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	return w
}

func assertPurgeFiles(t *testing.T, a *App, removed, retained []string) {
	t.Helper()
	for _, path := range removed {
		if _, err := os.Stat(filepath.Join(a.dataDir, filepath.FromSlash(path))); !os.IsNotExist(err) {
			t.Errorf("purged file remains: %s: %v", path, err)
		}
	}
	for _, path := range retained {
		if _, err := os.Stat(filepath.Join(a.dataDir, filepath.FromSlash(path))); err != nil {
			t.Errorf("retained file lost: %s: %v", path, err)
		}
	}
}

func assertPurgeDone(t *testing.T, a *App, key string) purgeRecord {
	t.Helper()
	a.purgeMu.Lock()
	p := clonePurge(a.purges[key])
	a.purgeMu.Unlock()
	if p.Phase != "done" || p.Status["running"] != false || p.Status["error"] != nil {
		t.Fatalf("purge incomplete: %+v", p)
	}
	if d := purgeTimestamp(p.Status["durationMs"]); p.Status["durationMs"] == nil || d < 0 || d > 60000 {
		t.Fatalf("invalid duration: %v", d)
	}
	return p
}

func TestGroupPurgeUsesStoredPathsAndPreservesOtherOwners(t *testing.T) {
	for _, filesOnly := range []bool{false, true} {
		name := "purge"
		if filesOnly {
			name = "files-only"
		}
		t.Run(name, func(t *testing.T) {
			a, token := purgeFixture(t)
			method, path := "DELETE", "/api/groups/target/purge"
			if filesOnly {
				method, path = "POST", "/api/groups/target/delete-files"
			}
			w := requestPurge(a, token, method, path, "{}")
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"started":true`) {
				t.Fatalf("request: %d %s", w.Code, w.Body.String())
			}
			a.purgeWG.Wait()
			p := assertPurgeDone(t, a, "group:target")
			if p.DeletedRows != 2 || p.DeletedQueue != 2 {
				t.Fatalf("incorrect counts: %+v", p)
			}
			assertPurgeFiles(t, a, []string{"downloads/Old Folder/images/owned.jpg"}, []string{"downloads/Old Folder/images/shared.jpg", "photos/other.jpg"})
			if filesOnly {
				assertPurgeFiles(t, a, nil, []string{"photos/target.jpg"})
			} else {
				assertPurgeFiles(t, a, []string{"photos/target.jpg"}, nil)
			}
			cfg, _ := a.config.Load(context.Background())
			expected := 1
			if filesOnly {
				expected = 2
			}
			if len(configuredGroupList(cfg)) != expected {
				t.Fatalf("wrong config scope: %v", cfg["groups"])
			}
			var history string
			if err := a.db.Reader.QueryRow(`SELECT value FROM kv WHERE key='queue_history'`).Scan(&history); err != nil || strings.Contains(history, "target") || !strings.Contains(history, "other") {
				t.Fatalf("queue history scope: %s %v", history, err)
			}
			if _, err := os.Stat(thumbCachePath(filepath.Join(a.dataDir, "thumbs"), 3)); err != nil {
				t.Fatal("other owner's cache removed", err)
			}
		})
	}
}

func TestFactoryResetRemovesLooseFilesAndDoesNotFollowSymlinks(t *testing.T) {
	a, token := purgeFixture(t)
	writePurgeFixture(t, filepath.Join(a.dataDir, "downloads", "loose.bin"))
	outside := filepath.Join(t.TempDir(), "outside.bin")
	writePurgeFixture(t, outside)
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(a.dataDir, "downloads", "escape")); err != nil {
		t.Skip(err)
	}
	w := requestPurge(a, token, "DELETE", "/api/purge/all", `{"confirm":"DELETE ALL"}`)
	if w.Code != 200 {
		t.Fatalf("reset: %d %s", w.Code, w.Body.String())
	}
	a.purgeWG.Wait()
	p := assertPurgeDone(t, a, "all")
	// Two unique media files, one untracked root file and one symlink entry.
	// Directories and the outside file are not counted as deleted files.
	if p.ResetFiles != 4 || p.DeletedRows != 3 || p.DeletedQueue != 4 {
		t.Fatalf("reset counts: %+v", p)
	}
	for _, area := range []string{"downloads", "photos", "thumbs"} {
		entries, err := os.ReadDir(filepath.Join(a.dataDir, area))
		if err != nil || len(entries) != 0 {
			t.Errorf("reset left %s: %v %v", area, entries, err)
		}
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("reset followed outside symlink", err)
	}
	cfg, _ := a.config.Load(context.Background())
	if len(configuredGroupList(cfg)) != 0 || cfg["web"] == nil {
		t.Fatalf("reset config scope: %v", cfg)
	}
	if w := requestPurge(a, token, "GET", "/api/purge/all/status", ""); w.Code != 200 {
		t.Fatalf("reset lost admin session: %d", w.Code)
	}
}

func TestPurgeResumesCommittedPlanAfterRestart(t *testing.T) {
	for _, all := range []bool{false, true} {
		name := "group"
		if all {
			name = "all"
		}
		t.Run(name, func(t *testing.T) {
			a, _ := purgeFixture(t)
			p := purgeRecord{GroupID: "target", Phase: "queued", All: all, Status: dedupIdleStatus(purgeKind("target", all))}
			if all {
				p.GroupID = ""
				writePurgeFixture(t, filepath.Join(a.dataDir, "downloads", "untracked.bin"))
			}
			p.Key = purgeKey(p.GroupID, all)
			p.Status["running"], p.Status["startedAt"], p.Status["attempts"] = true, time.Now().UnixMilli(), 1
			if err := a.commitPurge(context.Background(), &p); err != nil {
				t.Fatal(err)
			}
			// Crash boundary: catalog/config commit succeeded, no cleanup ran.
			assertPurgeFiles(t, a, nil, []string{"downloads/Old Folder/images/owned.jpg"})
			if err := a.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := New(context.Background(), Config{DataDir: a.dataDir})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			recovered := assertPurgeDone(t, reopened, p.Key)
			if recovered.DeletedRows != p.DeletedRows || recovered.DeletedQueue != p.DeletedQueue {
				t.Fatalf("restart lost original counts: %+v -> %+v", p, recovered)
			}
			assertPurgeFiles(t, reopened, []string{"downloads/Old Folder/images/owned.jpg"}, nil)
			if all {
				assertPurgeFiles(t, reopened, []string{"downloads/untracked.bin", "downloads/Old Folder/images/shared.jpg"}, nil)
			} else {
				assertPurgeFiles(t, reopened, nil, []string{"downloads/Old Folder/images/shared.jpg"})
			}
		})
	}
}

func TestPurgeFailureRollsBackAndRetryDoesNotDoubleCount(t *testing.T) {
	a, token := purgeFixture(t)
	if _, err := a.db.Writer.Exec(`CREATE TRIGGER fail_purge BEFORE DELETE ON downloads BEGIN SELECT RAISE(ABORT, 'injected failure'); END`); err != nil {
		t.Fatal(err)
	}
	w := requestPurge(a, token, "DELETE", "/api/groups/target/purge", "")
	if w.Code != 200 {
		t.Fatalf("request: %d %s", w.Code, w.Body.String())
	}
	a.purgeWG.Wait()
	var rows, pending int
	_ = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM downloads`).Scan(&rows)
	_ = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_file_cleanup`).Scan(&pending)
	cfg, _ := a.config.Load(context.Background())
	if rows != 3 || pending != 0 || len(configuredGroupList(cfg)) != 2 || !a.purgePending() {
		t.Fatalf("failed purge leaked changes: rows=%d pending=%d groups=%v", rows, pending, cfg["groups"])
	}
	assertPurgeFiles(t, a, nil, []string{"downloads/Old Folder/images/owned.jpg"})
	if _, err := a.db.Writer.Exec(`DROP TRIGGER fail_purge`); err != nil {
		t.Fatal(err)
	}
	w = requestPurge(a, token, "DELETE", "/api/groups/target/purge", "")
	if w.Code != 200 {
		t.Fatalf("retry: %d %s", w.Code, w.Body.String())
	}
	a.purgeWG.Wait()
	p := assertPurgeDone(t, a, "group:target")
	if p.DeletedRows != 2 || p.DeletedQueue != 2 || jobCount(p.Status["attempts"]) != 2 {
		t.Fatalf("retry counts: %+v", p)
	}
	var encoded string
	if err := a.db.Reader.QueryRow(`SELECT payload FROM tgdl_purge_jobs WHERE id=?`, p.Key).Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	var saved purgeRecord
	if err := json.Unmarshal([]byte(encoded), &saved); err != nil || saved.Phase != "done" {
		t.Fatalf("terminal status not durable: %s %v", encoded, err)
	}
}

func TestPurgeAcknowledgementSurvivesShutdownAndRejectsOverlap(t *testing.T) {
	a, token := purgeFixture(t)
	a.mediaMu.Lock()
	w := requestPurge(a, token, "DELETE", "/api/groups/target/purge", "")
	if w.Code != 200 {
		a.mediaMu.Unlock()
		t.Fatalf("accepted request: %d %s", w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/groups/target/purge", "/api/purge/all"} {
		w := requestPurge(a, token, "DELETE", path, `{"confirm":"DELETE ALL"}`)
		if w.Code != 409 {
			a.mediaMu.Unlock()
			t.Fatalf("overlap was not rejected: %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	closed := make(chan error, 1)
	go func() { closed <- a.Close() }()
	select {
	case <-a.ctx.Done():
	case <-time.After(5 * time.Second):
		a.mediaMu.Unlock()
		t.Fatal("shutdown did not cancel work")
	}
	a.mediaMu.Unlock()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not join purge worker")
	}
	reopened, err := New(context.Background(), Config{DataDir: a.dataDir})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	assertPurgeDone(t, reopened, "group:target")
	assertPurgeFiles(t, reopened, []string{"downloads/Old Folder/images/owned.jpg"}, []string{"downloads/Old Folder/images/shared.jpg"})
}
