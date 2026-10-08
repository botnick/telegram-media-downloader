package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type metadataAccount struct {
	recoveryTestAccount
	photo func(context.Context, telegram.Dialog, io.Writer) (bool, error)
	list  func(context.Context, bool) ([]telegram.Dialog, error)
}

func (a *metadataAccount) DownloadDialogPhoto(ctx context.Context, d telegram.Dialog, w io.Writer) (bool, error) {
	return a.photo(ctx, d, w)
}
func (a *metadataAccount) RecoveryDialogs(ctx context.Context, archived bool) ([]telegram.Dialog, error) {
	if a.list != nil {
		return a.list(ctx, archived)
	}
	return a.recoveryTestAccount.RecoveryDialogs(ctx, archived)
}

func profileJPEG(t testing.TB) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, 2, 2))
	im.Set(0, 0, color.RGBA{R: 200, A: 255})
	var b bytes.Buffer
	if err := jpeg.Encode(&b, im, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func metadataFactory(dialogs []telegram.Dialog, photo func(context.Context, telegram.Dialog, io.Writer) (bool, error)) engine.Factory {
	return func(c engine.AccountConfig, _ *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &metadataAccount{recoveryTestAccount: recoveryTestAccount{id: c.ID, dialogs: dialogs, fixtureAccount: fixtureAccount{handle: h}}, photo: photo}, nil
	}
}

func maintenanceDone(t *testing.T, a *App, kind string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s := a.telegramMaintenanceStatus(kind)
		if s["running"] == false && s["stage"] != "idle" {
			return s
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("Telegram maintenance did not finish")
	return nil
}

func groupRefreshDone(t *testing.T, a *App, photos bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s := a.groupRefreshStatus(photos)
		if s["running"] == false && s["stage"] != "idle" {
			return s
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("group refresh did not finish")
	return nil
}

func TestResyncRefreshesNamesAndPhotosPreservingCustomNames(t *testing.T) {
	photo := profileJPEG(t)
	var noPhoto atomic.Bool
	dialogs := []telegram.Dialog{{ID: "-1000000000042", Name: "Fresh title"}, {ID: "-1000000000043", Name: "Remote title"}, {ID: "-1000000000044", Name: "DB only"}}
	factory := metadataFactory(dialogs, func(_ context.Context, _ telegram.Dialog, w io.Writer) (bool, error) {
		if noPhoto.Load() {
			return false, nil
		}
		_, e := w.Write(photo)
		return true, e
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	cfg, _ := a.config.Load(context.Background())
	g := configuredGroupList(cfg)[0]
	g["name"] = "Group 42"
	cfg["groups"] = append(cfg["groups"].([]any), map[string]any{"id": "-1000000000043", "name": "My chosen title", "enabled": false})
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,group_name) VALUES('-1000000000042',1,'Unknown'),('-1000000000042',2,'Keep catalog label'),('-1000000000043',1,'My chosen title'),('-1000000000044',1,'')`); err != nil {
		t.Fatal(err)
	}
	historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
	s := maintenanceDone(t, a, "resyncDialogs")
	if s["stage"] != "done" || jobCount(s["result"].(map[string]any)["updated"]) != 3 {
		t.Fatal(s)
	}
	cfg, err = a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	groups := configuredGroupList(cfg)
	if groups[0]["name"] != "Fresh title" || groups[1]["name"] != "My chosen title" {
		t.Fatal(groups)
	}
	for _, tc := range []struct {
		id   string
		msg  int
		name string
	}{{"-1000000000042", 1, "Fresh title"}, {"-1000000000042", 2, "Keep catalog label"}, {"-1000000000043", 1, "My chosen title"}, {"-1000000000044", 1, "DB only"}} {
		var name string
		if err = a.db.Reader.QueryRow(`SELECT group_name FROM downloads WHERE group_id=? AND message_id=?`, tc.id, tc.msg).Scan(&name); err != nil || name != tc.name {
			t.Fatalf("name=%q want=%q err=%v", name, tc.name, err)
		}
	}
	for _, d := range dialogs {
		data, e := os.ReadFile(filepath.Join(a.dataDir, "photos", d.ID+".jpg"))
		if e != nil || !bytes.Equal(data, photo) {
			t.Fatalf("avatar %s: %v", d.ID, e)
		}
	}
	status, _ := a.monitor.Status(context.Background())
	if status["state"] != "stopped" {
		t.Fatal(status)
	}
	// Both existing refresh buttons use the real pipeline too. Photos can
	// disappear remotely; a forced refresh must not retain the old avatar.
	noPhoto.Store(true)
	historyHTTP(t, a, "POST", "/api/groups/refresh-photos", `{}`)
	if s = groupRefreshDone(t, a, true); s["stage"] != "done" {
		t.Fatal(s)
	}
	if _, err = os.Stat(filepath.Join(a.dataDir, "photos", "-1000000000042.jpg")); !os.IsNotExist(err) {
		t.Fatalf("stale avatar remains: %v", err)
	}
	historyHTTP(t, a, "POST", "/api/groups/refresh-info", `{}`)
	if s = groupRefreshDone(t, a, false); s["stage"] != "done" || jobCount(s["result"].(map[string]any)["updated"]) != 3 {
		t.Fatal(s)
	}
}

func TestResyncSingleFlightAndShutdownJoinsPhoto(t *testing.T) {
	entered := make(chan struct{}, 1)
	factory := metadataFactory([]telegram.Dialog{{ID: "-1000000000042", Name: "Fresh"}}, func(ctx context.Context, _ telegram.Dialog, _ io.Writer) (bool, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return false, ctx.Err()
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("photo did not start")
	}
	token, _ := a.sessions.Create(context.Background(), "admin")
	if r := requestPurge(a, token, "POST", "/api/maintenance/resync-dialogs", `{}`); r.Code != 409 {
		t.Fatalf("overlap accepted: %d", r.Code)
	}
	closed := make(chan error, 1)
	go func() { closed <- a.Close() }()
	select {
	case err = <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not join photo job")
	}
	if s := a.telegramMaintenanceStatus("resyncDialogs"); s["running"] != false || s["stage"] != "error" {
		t.Fatal(s)
	}
}

func TestResyncPurgeCannotPublishLatePhoto(t *testing.T) {
	entered := make(chan struct{}, 1)
	photo := profileJPEG(t)
	factory := metadataFactory([]telegram.Dialog{{ID: "-1000000000042", Name: "Fresh"}}, func(ctx context.Context, _ telegram.Dialog, w io.Writer) (bool, error) {
		entered <- struct{}{}
		<-ctx.Done()
		_, err := w.Write(photo)
		return true, err
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("photo did not start")
	}
	token, _ := a.sessions.Create(context.Background(), "admin")
	if r := requestPurge(a, token, "DELETE", "/api/groups/-1000000000042/purge", ""); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	a.purgeWG.Wait()
	assertPurgeDone(t, a, "group:-1000000000042")
	if s := maintenanceDone(t, a, "resyncDialogs"); s["stage"] != "error" {
		t.Fatal(s)
	}
	if _, err = os.Stat(filepath.Join(a.dataDir, "photos", "-1000000000042.jpg")); !os.IsNotExist(err) {
		t.Fatalf("late photo escaped purge: %v", err)
	}
	cfg, _ := a.config.Load(context.Background())
	if len(configuredGroupList(cfg)) != 0 {
		t.Fatal("purged config was recreated")
	}
}

func TestResyncFailedConfigWriteRollsBackCatalogNameAndKeepsPhoto(t *testing.T) {
	photo := profileJPEG(t)
	factory := metadataFactory([]telegram.Dialog{{ID: "-1000000000042", Name: "Fresh"}}, func(_ context.Context, _ telegram.Dialog, w io.Writer) (bool, error) {
		_, e := w.Write(photo)
		return true, e
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	cfg, _ := a.config.Load(context.Background())
	configuredGroupList(cfg)[0]["name"] = "Unknown"
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,group_name) VALUES('-1000000000042',1,'Unknown'); CREATE TRIGGER fail_metadata BEFORE UPDATE ON kv WHEN NEW.key='config' BEGIN SELECT RAISE(FAIL,'reject metadata'); END`); err != nil {
		t.Fatal(err)
	}
	historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
	s := maintenanceDone(t, a, "resyncDialogs")
	if s["stage"] != "error" || !strings.Contains(toString(s["error"]), "reject metadata") {
		t.Fatal(s)
	}
	var name string
	if err = a.db.Reader.QueryRow(`SELECT group_name FROM downloads`).Scan(&name); err != nil || name != "Unknown" {
		t.Fatalf("catalog escaped rollback: %q %v", name, err)
	}
	if _, err = os.Stat(filepath.Join(a.dataDir, "photos", "-1000000000042.jpg")); !os.IsNotExist(err) {
		t.Fatalf("photo escaped rejected metadata: %v", err)
	}
}

func TestRestartMaintenanceJoinsTransferAndResumesDurableWork(t *testing.T) {
	var factories atomic.Int64
	made := make(chan *fixtureAccount, 2)
	entered := make(chan struct{}, 1)
	stopping := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		n := factories.Add(1)
		account := &fixtureAccount{handle: h, download: func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
			if n == 1 {
				if _, e := w.Write([]byte("li")); e != nil {
					return e
				}
				entered <- struct{}{}
				<-ctx.Done()
				stopping <- struct{}{}
				<-release
				return ctx.Err()
			}
			_, e := w.Write([]byte("live"))
			return e
		}}
		made <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	defer once.Do(func() { close(release) })
	configureMonitor(t, a)
	if r := monitorRequest(t, a, "/api/monitor/start"); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	account := <-made
	if err = account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("transfer did not start")
	}
	historyHTTP(t, a, "POST", "/api/maintenance/restart-monitor", `{"confirm":true}`)
	select {
	case <-stopping:
	case <-time.After(5 * time.Second):
		t.Fatal("restart did not cancel old transfer")
	}
	token, _ := a.sessions.Create(context.Background(), "admin")
	if r := requestPurge(a, token, "POST", "/api/maintenance/restart-monitor", `{"confirm":true}`); r.Code != 409 {
		t.Fatalf("duplicate restart %d", r.Code)
	}
	if factories.Load() != 1 {
		t.Fatal("replacement account opened before old transfer joined")
	}
	once.Do(func() { close(release) })
	s := maintenanceDone(t, a, "restartMonitor")
	if s["stage"] != "done" || s["result"].(map[string]any)["restarted"] != true {
		t.Fatal(s)
	}
	waitCompleted(t, a)
	if factories.Load() != 2 {
		t.Fatalf("factories=%d", factories.Load())
	}
	var path string
	if err = a.db.Reader.QueryRow(`SELECT file_path FROM downloads`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(a.dataDir, "downloads", path))
	if err != nil || string(data) != "live" {
		t.Fatalf("resume=%q %v", data, err)
	}
}

func TestRestartStoppedMonitorDoesNotInterruptManualURL(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	factory := urlFactory(func(_ context.Context, _ telegram.Dialog, id int) (*telegram.RefreshedMessage, error) {
		return urlMessage(id), nil
	}, func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
		entered <- struct{}{}
		select {
		case <-ctx.Done():
			return errors.New("no-op restart cancelled manual URL")
		case <-release:
			_, e := w.Write([]byte("live"))
			return e
		}
	})
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	defer once.Do(func() { close(release) })
	configureDisabledHistory(t, a)
	urlResults(t, a, `{"url":"https://t.me/c/42/10"}`)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("URL transfer did not start")
	}
	historyHTTP(t, a, "POST", "/api/maintenance/restart-monitor", `{"confirm":true}`)
	s := maintenanceDone(t, a, "restartMonitor")
	if s["stage"] != "done" || s["result"].(map[string]any)["restarted"] != false {
		t.Fatal(s)
	}
	once.Do(func() { close(release) })
	waitCompleted(t, a)
}

func TestResyncRejectsPartialIndexAndRetainsFailureCounters(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	var photos atomic.Int64
	factory := func(c engine.AccountConfig, _ *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &metadataAccount{recoveryTestAccount: recoveryTestAccount{id: c.ID, fixtureAccount: fixtureAccount{handle: h}}, list: func(_ context.Context, archived bool) ([]telegram.Dialog, error) {
			if archived {
				if fail.Load() {
					return nil, errors.New("archive RPC failed")
				}
				return nil, nil
			}
			return []telegram.Dialog{{ID: "-1000000000042", Name: "Fresh"}}, nil
		}, photo: func(context.Context, telegram.Dialog, io.Writer) (bool, error) { photos.Add(1); return false, nil }}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
	s := maintenanceDone(t, a, "resyncDialogs")
	if s["stage"] != "error" || photos.Load() != 0 || jobCount(s["failures"]) != 1 {
		t.Fatal(s)
	}
	fail.Store(false)
	historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
	s = maintenanceDone(t, a, "resyncDialogs")
	if s["stage"] != "done" || jobCount(s["attempts"]) != 2 || jobCount(s["failures"]) != 1 || jobCount(s["successes"]) != 1 {
		t.Fatal(s)
	}
}

func TestResyncUsesPinnedPhotoAndPreservesConcurrentEdits(t *testing.T) {
	photo := profileJPEG(t)
	var a *App
	var wrong atomic.Int64
	factory := func(c engine.AccountConfig, _ *telegram.UpdateState, h func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &metadataAccount{recoveryTestAccount: recoveryTestAccount{id: c.ID, dialogs: []telegram.Dialog{{ID: "-1000000000042", Name: "Fresh " + c.ID}}, fixtureAccount: fixtureAccount{handle: h}}, photo: func(_ context.Context, _ telegram.Dialog, w io.Writer) (bool, error) {
			if c.ID != "two" {
				wrong.Add(1)
			}
			a.configMu.Lock()
			defer a.configMu.Unlock()
			cfg, e := a.config.Load(context.Background())
			if e != nil {
				return false, e
			}
			g := configuredGroupList(cfg)[0]
			g["name"] = "Chosen during refresh"
			g["enabled"] = true
			if e = a.config.Save(context.Background(), cfg); e != nil {
				return false, e
			}
			_, e = w.Write(photo)
			return true, e
		}}, nil
	}
	var err error
	a, err = newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureDisabledHistory(t, a)
	if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "two.enc"), []byte("fixture two"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, _ := a.config.Load(context.Background())
	g := configuredGroupList(cfg)[0]
	g["name"] = "Unknown"
	g["monitorAccount"] = "two"
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
	if s := maintenanceDone(t, a, "resyncDialogs"); s["stage"] != "done" {
		t.Fatal(s)
	}
	if wrong.Load() != 0 {
		t.Fatal("used another account's photo")
	}
	cfg, _ = a.config.Load(context.Background())
	g = configuredGroupList(cfg)[0]
	if g["name"] != "Chosen during refresh" || g["enabled"] != true {
		t.Fatal(g)
	}
}

func TestResyncHonorsLegacyAccessAndAuthoritativeRegistry(t *testing.T) {
	for _, restored := range []bool{false, true} {
		t.Run(fmt.Sprintf("registryRestored=%v", restored), func(t *testing.T) {
			var calls atomic.Int64
			factory := metadataFactory([]telegram.Dialog{{ID: "-1000000000042", Name: "Fresh"}}, func(context.Context, telegram.Dialog, io.Writer) (bool, error) {
				calls.Add(1)
				return false, nil
			})
			a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close()
			configureDisabledHistory(t, a)
			cfg, err := a.config.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			g := configuredGroupList(cfg)[0]
			g["name"], g["_resolveFailedAt"], g["_resolveFailedReason"] = "Unknown", 1, "RPC:CHANNEL_PRIVATE"
			if err = a.config.Save(context.Background(), cfg); err != nil {
				t.Fatal(err)
			}
			if restored {
				if _, err = a.db.Writer.Exec(`INSERT INTO chat_access(chat_id,state,checked_at,updated_at) VALUES('-1000000000042','ok',2,2)`); err != nil {
					t.Fatal(err)
				}
			}
			historyHTTP(t, a, "POST", "/api/maintenance/resync-dialogs", `{}`)
			if s := maintenanceDone(t, a, "resyncDialogs"); s["stage"] != "done" {
				t.Fatal(s)
			}
			cfg, err = a.config.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			wantName, wantCalls := "Unknown", int64(0)
			if restored {
				wantName, wantCalls = "Fresh", 1
			}
			if got := configuredGroupList(cfg)[0]["name"]; got != wantName || calls.Load() != wantCalls {
				t.Fatalf("name=%v photoCalls=%d want=%s/%d", got, calls.Load(), wantName, wantCalls)
			}
		})
	}
}

func TestProfilePhotoCacheRejectsOutsideSymlinkAndOversize(t *testing.T) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	outside := t.TempDir()
	if err = os.Symlink(outside, filepath.Join(a.dataDir, "photos")); err != nil {
		t.Skip(err)
	}
	if err = a.publishMetadataPhoto(context.Background(), "42", profileJPEG(t), true); err == nil {
		t.Fatal("photo escaped through directory symlink")
	}
	if entries, e := os.ReadDir(outside); e != nil || len(entries) != 0 {
		t.Fatalf("outside changed: %v %v", entries, e)
	}
	var b photoBuffer
	if _, err = b.Write(make([]byte, (2<<20)+1)); err == nil || b.Len() != 0 {
		t.Fatalf("oversize allocation accepted: %d %v", b.Len(), err)
	}
}

func BenchmarkResync1000Groups(b *testing.B) {
	ctx := context.Background()
	dialogs := make([]telegram.Dialog, 1000)
	groups := make([]any, 1000)
	for n := range dialogs {
		id := fmt.Sprintf("%d", -1000000000001-int64(n))
		dialogs[n] = telegram.Dialog{ID: id, Name: fmt.Sprintf("Fresh %d", n)}
		groups[n] = map[string]any{"id": id, "name": "Unknown", "enabled": false}
	}
	a, err := newConfiguredTestApp(ctx, Config{DataDir: b.TempDir(), AccountFactory: metadataFactory(dialogs, func(context.Context, telegram.Dialog, io.Writer) (bool, error) { return false, nil })})
	if err != nil {
		b.Fatal(err)
	}
	defer a.Close()
	cfg, err := a.config.Load(ctx)
	if err != nil {
		b.Fatal(err)
	}
	cfg["telegram"] = map[string]any{"apiId": 123, "apiHash": "fixture"}
	cfg["groups"] = groups
	if err = os.MkdirAll(filepath.Join(a.dataDir, "sessions"), 0700); err != nil {
		b.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "sessions", "one.enc"), []byte("fixture"), 0600); err != nil {
		b.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(a.dataDir, "secret.key"), []byte("fixture secret"), 0600); err != nil {
		b.Fatal(err)
	}
	tx, err := a.db.Writer.BeginTx(ctx, nil)
	if err != nil {
		b.Fatal(err)
	}
	for _, d := range dialogs {
		if _, err = tx.ExecContext(ctx, `INSERT INTO downloads(group_id,message_id,group_name) VALUES(?,1,'Unknown')`, d.ID); err != nil {
			tx.Rollback()
			b.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		b.StopTimer()
		if err = a.config.Save(ctx, cfg); err != nil {
			b.Fatal(err)
		}
		if _, err = a.db.Writer.Exec(`UPDATE downloads SET group_name='Unknown'`); err != nil {
			b.Fatal(err)
		}
		a.monitorOp.Lock()
		err = a.startTelegramEngine(ctx, false)
		a.monitorOp.Unlock()
		if err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
		result, e := a.refreshTelegramGroups(ctx, false, 0, func(map[string]any) {})
		if e != nil || jobCount(result["updated"]) != 1000 {
			b.Fatalf("resync=%v err=%v", result, e)
		}
	}
	b.StopTimer()
}
