package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type recoveryTestAccount struct {
	fixtureAccount
	id      string
	dialogs []telegram.Dialog
	probe   func(context.Context, telegram.Dialog) error
	refresh func(context.Context, *tg.Message) (*telegram.RefreshedMessage, error)
}

func (a *recoveryTestAccount) Fingerprint() string { return "key-" + a.id }
func (a *recoveryTestAccount) RecoveryDialogs(_ context.Context, archived bool) ([]telegram.Dialog, error) {
	if archived {
		return nil, nil
	}
	return a.dialogs, nil
}
func (a *recoveryTestAccount) ProbeDialog(ctx context.Context, d telegram.Dialog) error {
	if a.probe != nil {
		return a.probe(ctx, d)
	}
	return nil
}
func (a *recoveryTestAccount) ResolveDialog(context.Context, string) (telegram.Dialog, error) {
	return telegram.Dialog{}, errors.New("index_miss")
}
func (a *recoveryTestAccount) RefreshMessage(ctx context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
	if a.refresh != nil {
		return a.refresh(ctx, m)
	}
	return a.fixtureAccount.RefreshMessage(ctx, m)
}

func recoveryRequest(t *testing.T, a *App, method, op, body string) map[string]any {
	t.Helper()
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	rec := requestPurge(a, token, method, "/api/maintenance/recovery/"+op, body)
	if rec.Code != 200 {
		t.Fatalf("%s: %d %s", op, rec.Code, rec.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func recoveryDone(t *testing.T, a *App) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status := recoveryRequest(t, a, "GET", "status", "")
		if status["running"] == false && status["stage"] != "idle" {
			return status
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("recovery did not finish")
	return nil
}
func recoveryApp(t *testing.T, dialogs []telegram.Dialog, probe func(context.Context, telegram.Dialog) error) (*App, chan *recoveryTestAccount) {
	t.Helper()
	made := make(chan *recoveryTestAccount, 8)
	factory := func(cfg engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &recoveryTestAccount{id: cfg.ID, dialogs: dialogs, probe: probe, fixtureAccount: fixtureAccount{handle: handler, download: func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
			_, err := w.Write([]byte("live"))
			return err
		}}}
		made <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	configureMonitor(t, a)
	return a, made
}
func seedRecoveryGroup(t *testing.T, a *App, id string) {
	t.Helper()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{map[string]any{"id": id, "name": "Lost Folder", "enabled": true}}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,group_name,message_id,file_path) VALUES(?,'Lost Folder',-1,'Old Folder/saved.bin')`, id); err != nil {
		t.Fatal(err)
	}
	writePurgeFixture(t, filepath.Join(a.dataDir, "downloads", "Old Folder", "saved.bin"))
}
func startRecoveryMonitor(t *testing.T, a *App) {
	t.Helper()
	if rec := monitorRequest(t, a, "/api/monitor/start"); rec.Code != 200 {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRecoveryResolvesSyntheticGroupAndKeepsStoredFile(t *testing.T) {
	a, made := recoveryApp(t, []telegram.Dialog{{ID: "-1000000000042", Name: "Lost Folder", Type: "channel"}}, nil)
	seedRecoveryGroup(t, a, "unknown:Lost_Folder")
	if _, err := a.db.Writer.Exec(`INSERT INTO chat_access(chat_id,state,checked_at,updated_at) VALUES('unknown:Lost_Folder','left',1,1); INSERT INTO kv(key,value,updated_at) VALUES('queue_history','[{"groupId":"unknown:Lost_Folder","key":"unknown:Lost_Folder_-1"}]',0)`); err != nil {
		t.Fatal(err)
	}
	startRecoveryMonitor(t, a)
	<-made
	recoveryRequest(t, a, "POST", "resolve", `{"ids":["unknown:Lost_Folder","missing"]}`)
	status := recoveryDone(t, a)
	if status["stage"] != "done" || number(status["result"].(map[string]any)["resolved"], 0) != 1 {
		t.Fatalf("status=%+v", status)
	}
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	group := configuredGroupList(cfg)[0]
	if group["id"] != "-1000000000042" || group["monitorAccount"] != "one" {
		t.Fatalf("config=%+v", group)
	}
	var id, path, history string
	if err := a.db.Reader.QueryRow(`SELECT group_id,file_path FROM downloads`).Scan(&id, &path); err != nil {
		t.Fatal(err)
	}
	if id != "-1000000000042" || path != "Old Folder/saved.bin" {
		t.Fatalf("row=%s %s", id, path)
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, "downloads", path)); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRow(`SELECT value FROM kv WHERE key='queue_history'`).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(history, "unknown:") {
		t.Fatalf("history not migrated: %s", history)
	}
	// Resolution restarted the native monitor. A live raw update now maps to
	// the corrected group and follows the ordinary durable ingestion path.
	account := <-made
	if err := account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	waitCompleted(t, a)
}

func TestRecoveryRejectsAmbiguityAndCatalogCollision(t *testing.T) {
	for _, kind := range []string{"ambiguous_title", "target_conflict"} {
		t.Run(kind, func(t *testing.T) {
			dialogs := []telegram.Dialog{{ID: "-1000000000042", Name: "Lost Folder"}}
			if kind == "ambiguous_title" {
				dialogs = append(dialogs, telegram.Dialog{ID: "-1000000000043", Name: "Lost Folder"})
			}
			a, _ := recoveryApp(t, dialogs, nil)
			seedRecoveryGroup(t, a, "unknown:Lost Folder")
			if kind == "target_conflict" {
				if _, err := a.db.Writer.Exec(`INSERT INTO downloads(group_id,message_id,file_path) VALUES('-1000000000042',-1,'other.bin')`); err != nil {
					t.Fatal(err)
				}
			}
			startRecoveryMonitor(t, a)
			recoveryRequest(t, a, "POST", "resolve", `{"ids":["unknown:Lost Folder"]}`)
			status := recoveryDone(t, a)
			result := status["result"].(map[string]any)
			item := result["results"].([]any)[0].(map[string]any)
			if item["reason"] != kind || item["status"] != "still_unknown" {
				t.Fatalf("result=%+v", item)
			}
			cfg, _ := a.config.Load(context.Background())
			if configuredGroupList(cfg)[0]["id"] != "unknown:Lost Folder" {
				t.Fatal("ambiguous group was renamed")
			}
		})
	}
}

func TestRecoveryCatalogFailureRollsBackConfig(t *testing.T) {
	a, _ := recoveryApp(t, []telegram.Dialog{{ID: "-1000000000042", Name: "Lost Folder"}}, nil)
	seedRecoveryGroup(t, a, "unknown:Lost Folder")
	if _, err := a.db.Writer.Exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE OF group_id ON downloads BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END`); err != nil {
		t.Fatal(err)
	}
	startRecoveryMonitor(t, a)
	recoveryRequest(t, a, "POST", "resolve", `{"ids":["unknown:Lost Folder"]}`)
	status := recoveryDone(t, a)
	if status["stage"] != "error" {
		t.Fatalf("status=%+v", status)
	}
	cfg, _ := a.config.Load(context.Background())
	if configuredGroupList(cfg)[0]["id"] != "unknown:Lost Folder" {
		t.Fatal("config escaped transaction")
	}
	var id string
	if err := a.db.Reader.QueryRow(`SELECT group_id FROM downloads`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id != "unknown:Lost Folder" {
		t.Fatalf("row changed: %s", id)
	}
	if err := a.monitor.RequireRunning(); err != nil {
		t.Fatalf("rollback left monitor stopped: %v", err)
	}
}

func TestRecoverySingleFlightAndConcurrentConfigChange(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	a, _ := recoveryApp(t, []telegram.Dialog{{ID: "-1000000000042", Name: "Lost Folder"}}, func(ctx context.Context, _ telegram.Dialog) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	seedRecoveryGroup(t, a, "unknown:Lost Folder")
	startRecoveryMonitor(t, a)
	recoveryRequest(t, a, "POST", "resolve", `{"ids":["unknown:Lost Folder"]}`)
	<-entered
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	rec := requestPurge(a, token, "POST", "/api/maintenance/recovery/resolve", `{"ids":["unknown:Lost Folder"]}`)
	if rec.Code != 409 {
		t.Fatalf("double claim: %d %s", rec.Code, rec.Body.String())
	}
	a.configMu.Lock()
	cfg, _ := a.config.Load(context.Background())
	configuredGroupList(cfg)[0]["enabled"] = false
	err = a.config.Save(context.Background(), cfg)
	a.configMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	status := recoveryDone(t, a)
	item := status["result"].(map[string]any)["results"].([]any)[0].(map[string]any)
	if item["reason"] != "config_changed" {
		t.Fatalf("overwrote concurrent config: %+v", item)
	}
}

func TestRecoveryShutdownJoinsActiveProbe(t *testing.T) {
	entered := make(chan struct{})
	var cancelled atomic.Bool
	a, _ := recoveryApp(t, []telegram.Dialog{{ID: "-1000000000042", Name: "Lost Folder"}}, func(ctx context.Context, _ telegram.Dialog) error {
		close(entered)
		<-ctx.Done()
		cancelled.Store(true)
		return ctx.Err()
	})
	seedRecoveryGroup(t, a, "unknown:Lost Folder")
	startRecoveryMonitor(t, a)
	recoveryRequest(t, a, "POST", "resolve", `{"ids":["unknown:Lost Folder"]}`)
	<-entered
	done := make(chan error, 1)
	go func() { done <- a.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not cancel recovery")
	}
	if !cancelled.Load() {
		t.Fatal("probe outlived database shutdown")
	}
}

func TestRecoveryDeleteActuallyCleansUnsharedFiles(t *testing.T) {
	a, token := purgeFixture(t)
	rec := requestPurge(a, token, "POST", "/api/maintenance/recovery/delete", `{"ids":["target"],"purgeDownloads":true}`)
	if rec.Code != 200 {
		t.Fatalf("delete=%d %s", rec.Code, rec.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["totalRows"] != float64(2) || result["totalFiles"] != float64(1) {
		t.Fatalf("counts=%+v", result)
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, "downloads/Old Folder/images/owned.jpg")); !os.IsNotExist(err) {
		t.Fatalf("orphan retained: %v", err)
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, "downloads/Old Folder/images/shared.jpg")); err != nil {
		t.Fatalf("shared file removed: %v", err)
	}
}

func TestRecoveryDisableUnknownIDDoesNotMutateOrphanQueue(t *testing.T) {
	a, token := purgeFixture(t)
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["groups"] = []any{configuredGroupList(cfg)[1]}
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	rec := requestPurge(a, token, "POST", "/api/maintenance/recovery/disable", `{"ids":["target"]}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"disabled":0`) {
		t.Fatalf("disable=%d %s", rec.Code, rec.Body.String())
	}
	var pending int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_work WHERE group_id='target' AND status='pending'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 1 {
		t.Fatal("an unconfigured ID silently removed queued work")
	}
}

func TestRecoveryDeleteRetriesPersistedFailure(t *testing.T) {
	a, token := purgeFixture(t)
	if _, err := a.db.Writer.Exec(`CREATE TRIGGER reject_cleanup BEFORE DELETE ON downloads BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END`); err != nil {
		t.Fatal(err)
	}
	body := `{"ids":["target"],"purgeDownloads":true}`
	first := requestPurge(a, token, "POST", "/api/maintenance/recovery/delete", body)
	if first.Code != 500 || !a.purgePending() {
		t.Fatalf("failure was not retained: %d %s", first.Code, first.Body.String())
	}
	blocked := requestPurge(a, token, "POST", "/api/maintenance/recovery/disable", `{"ids":["other"]}`)
	if blocked.Code != 409 {
		t.Fatalf("edit bypassed pending cleanup: %d", blocked.Code)
	}
	if _, err := a.db.Writer.Exec(`DROP TRIGGER reject_cleanup`); err != nil {
		t.Fatal(err)
	}
	second := requestPurge(a, token, "POST", "/api/maintenance/recovery/delete", body)
	if second.Code != 200 || a.purgePending() {
		t.Fatalf("retry=%d %s", second.Code, second.Body.String())
	}
}

func TestRecoveryPinnedAccountNeverSwitchesAfterProbeFailure(t *testing.T) {
	var otherProbes atomic.Int64
	factory := func(cfg engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		return &recoveryTestAccount{id: cfg.ID, fixtureAccount: fixtureAccount{handle: handler}, dialogs: []telegram.Dialog{{ID: "-1000000000042", Name: "Lost Folder"}}, probe: func(context.Context, telegram.Dialog) error {
			if cfg.ID == "two" {
				otherProbes.Add(1)
				return nil
			}
			return errors.New("CHANNEL_PRIVATE")
		}}, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	seedRecoveryGroup(t, a, "unknown:Lost Folder")
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	configuredGroupList(cfg)[0]["monitorAccount"] = "one"
	if err := a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.dataDir, "sessions/two.enc"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	startRecoveryMonitor(t, a)
	recoveryRequest(t, a, "POST", "resolve", `{"ids":["unknown:Lost Folder"]}`)
	status := recoveryDone(t, a)
	item := status["result"].(map[string]any)["results"].([]any)[0].(map[string]any)
	if item["reason"] != "CHANNEL_PRIVATE" || otherProbes.Load() != 0 {
		t.Fatalf("pin bypassed: %+v other=%d", item, otherProbes.Load())
	}
}

func TestRecoveryReassignRefreshesWithChosenAccount(t *testing.T) {
	made := make(chan *recoveryTestAccount, 8)
	var transfers, refreshes atomic.Int64
	factory := func(cfg engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &recoveryTestAccount{id: cfg.ID}
		account.fixtureAccount = fixtureAccount{handle: handler, download: func(_ context.Context, media telegram.Attachment, w io.Writer) error {
			if cfg.ID != "two" || string(media.Location.(*tg.InputDocumentFileLocation).FileReference) != "new-account" {
				return errors.New("used wrong account or stale file reference")
			}
			transfers.Add(1)
			_, err := w.Write([]byte("live"))
			return err
		}}
		account.refresh = func(_ context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
			if cfg.ID != "two" {
				return nil, errors.New("refreshed wrong account")
			}
			refreshes.Add(1)
			m.Media.(*tg.MessageMediaDocument).Document.(*tg.Document).FileReference = []byte("new-account")
			return &telegram.RefreshedMessage{Message: m, Entities: &tg.Updates{}}, nil
		}
		made <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if err := os.WriteFile(filepath.Join(a.dataDir, "sessions/two.enc"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	startRecoveryMonitor(t, a)
	first, second := <-made, <-made
	if first.id != "one" {
		first, second = second, first
	}
	if err := a.monitor.PauseAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	update := updateFixture()
	update.Updates[0].(*tg.UpdateNewChannelMessage).Pts = 101
	if err := first.handle(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	recoveryRequest(t, a, "POST", "reassign", `{"ids":["-1000000000042"],"monitorAccount":"two"}`)
	var account string
	var force, pts int
	if err := a.db.Reader.QueryRow(`SELECT account_id,refresh_required,source_pts FROM tgdl_work`).Scan(&account, &force, &pts); err != nil {
		t.Fatal(err)
	}
	if account != "two" || force != 1 || pts != 101 {
		t.Fatalf("queue reassign=%s force=%d pts=%d", account, force, pts)
	}
	if err := a.monitor.ResumeAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitCompleted(t, a)
	if transfers.Load() != 1 || refreshes.Load() != 1 {
		t.Fatalf("transfers=%d refreshes=%d", transfers.Load(), refreshes.Load())
	}
	// An update from the previously selected account cannot replace queued work.
	for len(made) > 0 {
		candidate := <-made
		if candidate.id == "one" {
			first = candidate
		}
	}
	update.Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message).ID = 11
	if err := first.handle(context.Background(), update); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_work`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("old account bypassed pin")
	}
}

func TestRecoveryReassignJoinsAnActiveOldAccountTransfer(t *testing.T) {
	entered := make(chan struct{}, 1)
	made := make(chan *recoveryTestAccount, 8)
	var cancelled atomic.Bool
	factory := func(cfg engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &recoveryTestAccount{id: cfg.ID}
		account.fixtureAccount = fixtureAccount{handle: handler, download: func(ctx context.Context, media telegram.Attachment, w io.Writer) error {
			if cfg.ID == "one" {
				if _, err := w.Write([]byte("li")); err != nil {
					return err
				}
				entered <- struct{}{}
				<-ctx.Done()
				cancelled.Store(true)
				return ctx.Err()
			}
			if !cancelled.Load() || string(media.Location.(*tg.InputDocumentFileLocation).FileReference) != "second" {
				return errors.New("old transfer not joined or references not renewed")
			}
			_, err := w.Write([]byte("live"))
			return err
		}}
		account.refresh = func(_ context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
			m.Media.(*tg.MessageMediaDocument).Document.(*tg.Document).FileReference = []byte("second")
			return &telegram.RefreshedMessage{Message: m, Entities: &tg.Updates{}}, nil
		}
		made <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if err := os.WriteFile(filepath.Join(a.dataDir, "sessions/two.enc"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	startRecoveryMonitor(t, a)
	one, two := <-made, <-made
	if one.id != "one" {
		one = two
	}
	if err := one.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("first transfer never started")
	}
	recoveryRequest(t, a, "POST", "reassign", `{"ids":["-1000000000042"],"monitorAccount":"two"}`)
	waitCompleted(t, a)
	var path string
	if err := a.db.Reader.QueryRow(`SELECT file_path FROM downloads`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(a.dataDir, "downloads", path))
	if err != nil || string(data) != "live" {
		t.Fatalf("partial bytes survived reassignment: %q %v", data, err)
	}
}

func TestRecoveryFolderMatchingPreservesHistoricSpelling(t *testing.T) {
	for raw, want := range map[string]string{" Lost / Folder ": "Lost_Folder", "CON.jpg": "_CON.jpg", "\u200b": "_unnamed_6bv", "ไทย\u200d ทดสอบ": "ไทย_ทดสอบ", "A\u0085 B": "A\u0085_B"} {
		if got := recoveryFolderName(raw); got != want {
			t.Fatalf("%q: %q want %q", raw, got, want)
		}
	}
}

func BenchmarkRecoveryList1000Groups(b *testing.B) {
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: b.TempDir()})
	if err != nil {
		b.Fatal(err)
	}
	defer a.Close()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		b.Fatal(err)
	}
	groups := make([]any, 0, 1000)
	tx, err := a.db.Writer.Begin()
	if err != nil {
		b.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		id := fmt.Sprintf("unknown:Folder_%d", i)
		groups = append(groups, map[string]any{"id": id, "name": id, "enabled": true})
		if _, err := tx.Exec(`INSERT INTO downloads(group_id,message_id) VALUES(?,1)`, id); err != nil {
			b.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	cfg["groups"] = groups
	if err := a.config.Save(context.Background(), cfg); err != nil {
		b.Fatal(err)
	}
	token, err := a.sessions.Create(context.Background(), "admin")
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := requestPurge(a, token, "GET", "/api/maintenance/recovery/list", "")
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"total":1000`) {
			b.Fatalf("list: %d", rec.Code)
		}
	}
}
