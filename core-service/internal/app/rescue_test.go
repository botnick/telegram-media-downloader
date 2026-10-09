package app

import (
	"context"
	"database/sql"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/rescue"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func enableRescue(t *testing.T, a *App) {
	t.Helper()
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfg["rescue"] = map[string]any{"enabled": true, "retentionHours": float64(1)}
	if err = a.config.Save(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
}

func rescueInsert(t *testing.T, a *App, id int, path string, pending, rescued any, pinned int) {
	t.Helper()
	_, err := a.db.Writer.Exec(`INSERT INTO downloads(id,group_id,message_id,file_path,file_size,pending_until,rescued_at,pinned) VALUES(?,'legacy',?,?,4,?,?,?)`, id, id, path, pending, rescued, pinned)
	if err != nil {
		t.Fatal(err)
	}
}

func rescueFile(t *testing.T, a *App, path string) string {
	t.Helper()
	name := filepath.Join(a.dataDir, "downloads", path)
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("live"), 0600); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestRescueSweepPreservesSharedPinnedRescuedAndFutureFiles(t *testing.T) {
	a, _ := socketTestApp(t)
	now := time.Now()
	expired := now.Add(-time.Hour).UnixMilli()
	shared := rescueFile(t, a, "shared.bin")
	gone := rescueFile(t, a, "expired.bin")
	rescueInsert(t, a, 1, "shared.bin", expired, nil, 0)
	rescueInsert(t, a, 2, "shared.bin", nil, nil, 0)
	rescueInsert(t, a, 3, "expired.bin", expired, nil, 0)
	rescueInsert(t, a, 4, "pinned.bin", expired, nil, 1)
	rescueInsert(t, a, 5, "rescued.bin", expired, now.UnixMilli(), 0)
	rescueInsert(t, a, 6, "future.bin", now.Add(time.Hour).UnixMilli(), nil, 0)
	for _, name := range []string{"pinned.bin", "rescued.bin", "future.bin"} {
		rescueFile(t, a, name)
	}
	n, err := a.sweepRescue(context.Background(), now)
	if err != nil || n != 2 {
		t.Fatalf("sweep %d %v", n, err)
	}
	if _, err = os.Stat(shared); err != nil {
		t.Fatal("removed shared owner", err)
	}
	if _, err = os.Stat(gone); !os.IsNotExist(err) {
		t.Fatalf("expired file remains: %v", err)
	}
	for _, id := range []int{2, 4, 5, 6} {
		var n int
		if err = a.db.Reader.QueryRow(`SELECT count(*) FROM downloads WHERE id=?`, id).Scan(&n); err != nil || n != 1 {
			t.Fatalf("retained %d count %d %v", id, n, err)
		}
	}
	if n, err = a.sweepRescue(context.Background(), now); err != nil || n != 0 {
		t.Fatalf("empty pass %d %v", n, err)
	}
	var last int
	if err = a.db.Reader.QueryRow(`SELECT value FROM kv WHERE key='native_rescue_last'`).Scan(&last); err != nil || last != 2 {
		t.Fatalf("last meaningful count %d %v", last, err)
	}
}

func TestRescueSweepRollbackAndRestartCleanup(t *testing.T) {
	t.Run("transaction_rollback", func(t *testing.T) {
		a, _ := socketTestApp(t)
		file := rescueFile(t, a, "keep.bin")
		rescueInsert(t, a, 1, "keep.bin", 1, nil, 0)
		if _, err := a.db.Writer.Exec(`CREATE TRIGGER fail_rescue BEFORE DELETE ON downloads BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
			t.Fatal(err)
		}
		if n, err := a.sweepRescue(context.Background(), time.Now()); err == nil || n != 0 {
			t.Fatal("failed delete accepted", n, err)
		}
		if _, err := os.Stat(file); err != nil {
			t.Fatal(err)
		}
		var rows, queued int
		if err := a.db.Reader.QueryRow(`SELECT (SELECT count(*) FROM downloads),(SELECT count(*) FROM tgdl_file_cleanup)`).Scan(&rows, &queued); err != nil || rows != 1 || queued != 0 {
			t.Fatalf("rollback %d %d %v", rows, queued, err)
		}
	})
	t.Run("durable_cleanup", func(t *testing.T) {
		dir := t.TempDir()
		a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { a.Close() }()
		child := rescueFile(t, a, "blocked/child.bin")
		rescueInsert(t, a, 1, "blocked", 1, nil, 0)
		if n, err := a.sweepRescue(context.Background(), time.Now()); n != 1 || err == nil {
			t.Fatal("failed physical deletion not reported", n, err)
		}
		var queued int
		if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_file_cleanup`).Scan(&queued); err != nil || queued != 1 {
			t.Fatal(queued, err)
		}
		if err = a.Close(); err != nil {
			t.Fatal(err)
		}
		if err = os.Remove(child); err != nil {
			t.Fatal(err)
		}
		a, err = New(context.Background(), Config{DataDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = os.Stat(filepath.Dir(child)); !os.IsNotExist(err) {
			t.Fatalf("startup did not finish cleanup %v", err)
		}
		if err = a.db.Reader.QueryRow(`SELECT count(*) FROM tgdl_file_cleanup`).Scan(&queued); err != nil || queued != 0 {
			t.Fatal(queued, err)
		}
	})
}

func TestRescueSweepBoundsBacklogAndPreservesUnexpiredRow(t *testing.T) {
	a, _ := socketTestApp(t)
	now := time.Now()
	tx, err := a.db.Writer.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for id := 1; id <= rescueBatchSize+2; id++ {
		deadline := now.Add(-time.Hour).UnixMilli()
		if id == rescueBatchSize+2 {
			deadline = now.Add(time.Hour).UnixMilli()
		}
		if _, err = tx.Exec(`INSERT INTO downloads(group_id,message_id,pending_until) VALUES('batch',?,?)`, id, deadline); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for pass, want := range []int{rescueBatchSize, 1, 0} {
		if got, err := a.sweepRescue(context.Background(), now); err != nil || got != want {
			t.Fatalf("pass %d: cleared %d, want %d: %v", pass, got, want, err)
		}
	}
	var left, id int
	if err = a.db.Reader.QueryRow(`SELECT count(*),message_id FROM downloads`).Scan(&left, &id); err != nil || left != 1 || id != rescueBatchSize+2 {
		t.Fatalf("retained rows %d, message %d: %v", left, id, err)
	}
}

func TestRescueReceiptsFollowRecoveryResolution(t *testing.T) {
	for _, collision := range []bool{false, true} {
		t.Run(strconv.FormatBool(collision), func(t *testing.T) {
			a, _ := recoveryApp(t, []telegram.Dialog{{ID: "-1000000000042", Name: "Lost Folder", Type: "channel"}}, nil)
			seedRecoveryGroup(t, a, "unknown:Lost Folder")
			if _, err := a.db.Writer.Exec(`INSERT INTO tgdl_rescue_messages(group_id,message_id,account_id,channel_id,pending_until,rescued_at) VALUES('unknown:Lost Folder',22,'original',42,123,456)`); err != nil {
				t.Fatal(err)
			}
			if collision {
				if _, err := a.db.Writer.Exec(`INSERT INTO tgdl_rescue_messages(group_id,message_id,account_id,channel_id,pending_until) VALUES('-1000000000042',22,'other',42,789)`); err != nil {
					t.Fatal(err)
				}
			}
			startRecoveryMonitor(t, a)
			recoveryRequest(t, a, "POST", "resolve", `{"ids":["unknown:Lost Folder"]}`)
			status := recoveryDone(t, a)
			item := status["result"].(map[string]any)["results"].([]any)[0].(map[string]any)
			wantID := "-1000000000042"
			if collision {
				wantID = "unknown:Lost Folder"
				if item["reason"] != "target_conflict" {
					t.Fatal(item)
				}
			} else if item["status"] != "resolved" {
				t.Fatal(item)
			}
			var id string
			var channel, pending, rescued int64
			if err := a.db.Reader.QueryRow(`SELECT group_id,channel_id,pending_until,rescued_at FROM tgdl_rescue_messages WHERE account_id='original'`).Scan(&id, &channel, &pending, &rescued); err != nil || id != wantID || channel != 42 || pending != 123 || rescued != 456 {
				t.Fatalf("receipt %s %d %d %d: %v", id, channel, pending, rescued, err)
			}
		})
	}
}

func TestRescueSourceDeleteDuringTransferThenDedupSiblingExpires(t *testing.T) {
	made := make(chan *fixtureAccount, 1)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	var transfers atomic.Int64
	factory := func(_ engine.AccountConfig, _ *telegram.UpdateState, handle func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		account := &fixtureAccount{handle: handle, download: func(ctx context.Context, _ telegram.Attachment, w io.Writer) error {
			if transfers.Add(1) == 1 {
				close(entered)
			}
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err := w.Write([]byte("live"))
			return err
		}}
		made <- account
		return account, nil
	}
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: factory})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	enableRescue(t, a)
	if res := monitorRequest(t, a, "/api/monitor/start"); res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	account := <-made
	if err = account.handle(context.Background(), updateFixture()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("download not started")
	}
	if err = account.handle(context.Background(), &tg.Updates{Updates: []tg.UpdateClass{&tg.UpdateDeleteChannelMessages{ChannelID: 42, Messages: []int{10}, Pts: 2, PtsCount: 1}}}); err != nil {
		t.Fatal(err)
	}
	unblock()
	waitCompleted(t, a)
	var pending, rescued sql.NullInt64
	var path string
	if err = a.db.Reader.QueryRow(`SELECT pending_until,rescued_at,file_path FROM downloads WHERE message_id=10`).Scan(&pending, &rescued, &path); err != nil {
		t.Fatal(err)
	}
	if pending.Valid || !rescued.Valid {
		t.Fatalf("delete during transfer lost: %v %v", pending, rescued)
	}
	next := updateFixture()
	next.Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message).ID = 11
	if err = account.handle(context.Background(), next); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		var n int
		if err = a.db.Reader.QueryRow(`SELECT count(*) FROM downloads`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("dedup sibling not completed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if transfers.Load() != 1 {
		t.Fatal("forward caused second byte transfer")
	}
	if _, err = a.db.Writer.Exec(`UPDATE downloads SET pending_until=1 WHERE message_id=11`); err != nil {
		t.Fatal(err)
	}
	if n, err := a.sweepRescue(context.Background(), time.Now()); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if _, err = os.Stat(filepath.Join(a.dataDir, "downloads", path)); err != nil {
		t.Fatal("expired sibling removed rescued physical file", err)
	}
}

func TestRescueOrdinaryDeletesAreAccountScoped(t *testing.T) {
	a, _ := socketTestApp(t)
	enableRescue(t, a)
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("live"))
		return err
	})
	for i, account := range []string{"first", "second", "first"} {
		message := updateFixture().Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
		if i < 2 {
			message.PeerID = &tg.PeerUser{UserID: int64(100 + i)}
		}
		if _, err := a.ingestTelegram(context.Background(), message, strconv.Itoa(100+i), "fixture", account, transport); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.observeRescueUpdate(context.Background(), "first", &tg.UpdateDeleteMessages{Messages: []int{10}}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		var rescued sql.NullInt64
		if err := a.db.Reader.QueryRow(`SELECT rescued_at FROM downloads WHERE group_id=?`, strconv.Itoa(100+i)).Scan(&rescued); err != nil {
			t.Fatal(err)
		}
		if rescued.Valid != (i == 0) {
			t.Fatalf("wrong account/channel rescued: %d %v", i, rescued)
		}
	}
}

func TestRescueReceiptSurvivesPublishedFileRecovery(t *testing.T) {
	dir := t.TempDir()
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { a.Close() }()
	enableRescue(t, a)
	if _, err = a.db.Writer.Exec(`CREATE TRIGGER fail_catalog BEFORE INSERT ON downloads BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	msg := updateFixture().Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
	_, err = a.ingestTelegram(context.Background(), msg, "-1000000000042", "fixture", "first", mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("live"))
		return err
	}))
	if err == nil {
		t.Fatal("catalog failure missing")
	}
	if err = a.markRescued(context.Background(), "first", 42, []int{10}); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Writer.Exec(`DROP TRIGGER fail_catalog`); err != nil {
		t.Fatal(err)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = New(context.Background(), Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	var pending, rescued sql.NullInt64
	if err = a.db.Reader.QueryRow(`SELECT pending_until,rescued_at FROM downloads WHERE message_id=10`).Scan(&pending, &rescued); err != nil {
		t.Fatal(err)
	}
	if pending.Valid || !rescued.Valid {
		t.Fatal("recovery lost rescue receipt", pending, rescued)
	}
}

func TestRescueRetainsOriginalDeadlineAndExistingPermanentFiles(t *testing.T) {
	a, _ := socketTestApp(t)
	transport := mediaTransport(func(_ context.Context, _ telegram.Attachment, w io.Writer) error {
		_, err := w.Write([]byte("live"))
		return err
	})
	msg := updateFixture().Updates[0].(*tg.UpdateNewChannelMessage).Message.(*tg.Message)
	if _, err := a.ingestTelegram(context.Background(), msg, "-1000000000042", "fixture", "first", transport); err != nil {
		t.Fatal(err)
	}
	enableRescue(t, a)
	if _, err := a.ingestTelegram(context.Background(), msg, "-1000000000042", "fixture", "first", transport); err != nil {
		t.Fatal(err)
	}
	var pending sql.NullInt64
	if err := a.db.Reader.QueryRow(`SELECT pending_until FROM downloads WHERE message_id=10`).Scan(&pending); err != nil || pending.Valid {
		t.Fatal("permanent file became disposable", pending, err)
	}
	msg.ID = 11
	if _, err := a.ingestTelegram(context.Background(), msg, "-1000000000042", "fixture", "first", transport); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRow(`SELECT pending_until FROM downloads WHERE message_id=11`).Scan(&pending); err != nil || !pending.Valid {
		t.Fatal("new file has no retention", pending, err)
	}
	deadline := pending.Int64
	if _, err := a.ingestTelegram(context.Background(), msg, "-1000000000042", "fixture", "second", transport); err != nil {
		t.Fatal(err)
	}
	if err := a.db.Reader.QueryRow(`SELECT pending_until FROM downloads WHERE message_id=11`).Scan(&pending); err != nil || pending.Int64 != deadline {
		t.Fatal("replay extended retention", pending, err)
	}
}

func TestRescueRetentionModesAndBounds(t *testing.T) {
	for _, tc := range []struct {
		name       string
		group, cfg map[string]any
		want       time.Duration
	}{
		{"off", nil, nil, 0},
		{"global", nil, map[string]any{"rescue": map[string]any{"enabled": true}}, 48 * time.Hour},
		{"override_on", map[string]any{"rescueMode": "on", "rescueRetentionHours": "2.5"}, nil, 150 * time.Minute},
		{"override_off", map[string]any{"rescueMode": "off"}, map[string]any{"rescue": map[string]any{"enabled": true}}, 0},
		{"minimum", map[string]any{"rescueMode": "on", "rescueRetentionHours": 0.5}, nil, time.Hour},
		{"maximum", map[string]any{"rescueMode": "on", "rescueRetentionHours": 9999.0}, nil, 720 * time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := rescue.Retention(tc.group, tc.cfg); got != tc.want {
				t.Fatalf("%s != %s", got, tc.want)
			}
		})
	}
}
