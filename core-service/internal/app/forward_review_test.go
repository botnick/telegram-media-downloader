package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
)

// Regression tests for the review of the ported forward queue (3.5.0).

func insertForwardRow(t *testing.T, a *App, messageID int, status string, destinations []forwardDestination) int64 {
	t.Helper()
	now := time.Now().UnixMilli()
	res, err := a.db.Writer.Exec(`INSERT INTO tgdl_forward_queue(group_id,message_id,status,destinations_json,created_at,updated_at) VALUES('-1000000000123',?,?,?,?,?)`, messageID, status, mustJSON(destinations), now, now)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func forwardRowState(t *testing.T, a *App, id int64) (string, []forwardDestination) {
	t.Helper()
	var status, raw string
	if err := a.db.Reader.QueryRow(`SELECT status,destinations_json FROM tgdl_forward_queue WHERE id=?`, id).Scan(&status, &raw); err != nil {
		t.Fatal(err)
	}
	var destinations []forwardDestination
	if err := json.Unmarshal([]byte(raw), &destinations); err != nil {
		t.Fatal(err)
	}
	return status, destinations
}

// A native forward whose response was lost may have landed; it must not be
// followed by an upload of the local copy.
func TestLostNativeForwardResponseDoesNotFallBackToUpload(t *testing.T) {
	ctx := context.Background()
	settings := map[string]any{"enabled": true, "destination": "@Archive", "directForward": true, "captionMode": "native"}
	a, fake := forwardTestAppWith(t, settings, Config{RequireMonitorForwards: true})
	file := filepath.Join(a.downloadsDir, "Source", "media.bin")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("media"), 0o600); err != nil {
		t.Fatal(err)
	}
	destinations := []forwardDestination{{Settings: map[string]any{"destination": "@Archive", "captionMode": "native"}, Status: "pending"}}
	id := insertForwardRow(t, a, 30, "processing", destinations)
	fake.err = context.DeadlineExceeded
	a.forward(ctx, forwardJob{queueID: id, groupID: "-1000000000123", groupName: "Source", messageID: 30, path: "Source/media.bin", settings: settings, accountID: "acct2", stage: "native_forward", destinations: destinations})
	if got := fake.calls(); len(got) != 1 {
		t.Fatalf("Telegram sends=%d, want only the native forward", len(got))
	}
	status, states := forwardRowState(t, a, id)
	if status != "uncertain" || states[0].Status != "uncertain" {
		t.Fatalf("status=%q destination=%+v", status, states[0])
	}
}

// A download that failed after its parallel native forward is retried by the
// engine; the retry must not forward the message a second time.
func TestRetriedDownloadDoesNotForwardAgain(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive", "directForward": true, "captionMode": "native"})
	var direct atomic.Int32
	forward := func(context.Context, telegram.ForwardMessageRequest) error {
		direct.Add(1)
		return nil
	}
	failing := mediaTransport(func(context.Context, telegram.Attachment, io.Writer) error {
		return errors.New("network reset")
	})
	if _, err := a.ingestTelegramWithForward(ctx, docMessage(31, 123, 131, ""), "", "Source", "acct1", failing, forward); err == nil {
		t.Fatal("first download unexpectedly succeeded")
	}
	eventually(t, "first native forward", func() bool { return direct.Load() == 1 })
	if _, err := a.ingestTelegramWithForward(ctx, docMessage(31, 123, 131, ""), "", "Source", "acct1", fiveBytes, forward); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := direct.Load(); n != 1 {
		t.Fatalf("native forwards=%d after a retried download, want 1", n)
	}
}

// A manual forward keeps running after a retry rewrote its stage, even when
// the source group has no auto-forward rule.
func TestRetriedManualForwardIgnoresSourceAutoForwardToggle(t *testing.T) {
	ctx := context.Background()
	a, fake := forwardTestApp(t, map[string]any{"enabled": false})
	cfg, err := a.config.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	settings, accountID := manualForwardSettings(cfg, "-1000000000123", "@Manual", "")
	destinations := []forwardDestination{{Settings: map[string]any{"destinationGroupId": "@Manual", "captionMode": "source_info"}, Status: "pending"}}
	id := insertForwardRow(t, a, 32, "processing", destinations)
	a.forward(ctx, forwardJob{queueID: id, groupID: "-1000000000123", groupName: "Source", messageID: 32, settings: settings, accountID: accountID, stage: "native_forward", destinations: destinations})
	if len(fake.forwards()) != 1 {
		t.Fatalf("manual retry sends=%d, want 1", len(fake.forwards()))
	}
	if status, _ := forwardRowState(t, a, id); status != "forwarded" {
		t.Fatalf("manual retry status=%q", status)
	}
}

// Rules saved before destinations became explicit sent to the storage
// channel; they keep doing so after the upgrade.
func TestLegacyRuleWithoutDestinationForwardsToStorage(t *testing.T) {
	a, _ := forwardTestApp(t, map[string]any{"enabled": true})
	cfg, err := a.config.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	settings, _, enabled := forwardSettings(cfg, "-1000000000123")
	if !enabled || settings["destination"] != "storage" || !hasForwardDestination(settings) {
		t.Fatalf("legacy settings=%v enabled=%v", settings, enabled)
	}
}

// After a crash only a job that was sending can be uncertain; one stopped
// before any send goes back to the queue.
func TestRestartRequeuesJobsThatNeverReachedTelegram(t *testing.T) {
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	sending := insertForwardRow(t, a, 33, "processing", []forwardDestination{{Settings: map[string]any{"destination": "@Archive"}, Status: "processing"}})
	waiting := insertForwardRow(t, a, 34, "processing", []forwardDestination{{Settings: map[string]any{"destination": "@Archive"}, Status: "pending"}})
	if _, err := store.RunMigrations(context.Background(), a.db.Writer); err != nil {
		t.Fatal(err)
	}
	if status, _ := forwardRowState(t, a, sending); status != "uncertain" {
		t.Fatalf("job interrupted while sending=%q, want uncertain", status)
	}
	if status, _ := forwardRowState(t, a, waiting); status != "pending" {
		t.Fatalf("job interrupted before sending=%q, want pending", status)
	}
}

// Destinations and caption rules in the forward queue are admin-only.
func TestGuestCannotReadForwardQueue(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	insertForwardRow(t, a, 35, "failed", []forwardDestination{{Settings: map[string]any{"destination": "@Secret"}, Status: "failed"}})
	guest, err := a.sessions.Create(ctx, "guest")
	if err != nil {
		t.Fatal(err)
	}
	if r := requestPurge(a, guest, "GET", "/api/forward-queue", ""); r.Code != 403 {
		t.Fatalf("guest forward queue status=%d", r.Code)
	}
	// Guests may be kept off the queue page entirely; if they can read it,
	// the forward queue must not be part of the answer.
	r := requestPurge(a, guest, "GET", "/api/queue/snapshot", "")
	if r.Code == 403 {
		return
	}
	if r.Code != 200 {
		t.Fatalf("guest queue snapshot status=%d", r.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, leaked := body["forwardQueue"]; leaked {
		t.Fatal("guest queue snapshot includes the forward queue")
	}
}

// Old processing history is removed in batches, except attempts an unfinished
// forward job still points at.
func TestProcessingHistoryPrunerKeepsRecentAndForwardLinkedRows(t *testing.T) {
	ctx := context.Background()
	a, _ := forwardTestApp(t, map[string]any{"enabled": true, "destination": "@Archive"})
	now := time.Now()
	old := now.Add(-processingHistoryMaxAge - time.Hour).UnixMilli()
	insert := func(created int64) int64 {
		res, err := a.db.Writer.Exec(`INSERT INTO tgdl_processing_attempts(group_id,message_id,created_at) VALUES('-1000000000123',1,?)`, created)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	for range processingHistoryBatch + 10 {
		insert(old)
	}
	linked := insert(old)
	if _, err := a.db.Writer.Exec(`INSERT INTO tgdl_forward_queue(history_id,group_id,message_id,status,created_at,updated_at) VALUES(?,'-1000000000123',1,'failed',1,1)`, linked); err != nil {
		t.Fatal(err)
	}
	recent := insert(now.UnixMilli())
	removed, err := a.pruneProcessingHistory(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	var left int
	if err := a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_processing_attempts WHERE id IN (?,?)`, linked, recent).Scan(&left); err != nil {
		t.Fatal(err)
	}
	var total int
	_ = a.db.Reader.QueryRow(`SELECT COUNT(*) FROM tgdl_processing_attempts`).Scan(&total)
	if removed != processingHistoryBatch+10 || left != 2 || total != 2 {
		t.Fatalf("removed=%d kept=%d total=%d", removed, left, total)
	}
}
