package engine

import (
	"context"
	"fmt"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/tg"
	"testing"
	"time"
)

func testStore(t *testing.T) *WorkStore {
	t.Helper()
	db, err := store.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Reader.Close(); db.Writer.Close() })
	return NewWorkStore(db.Writer, db.Reader)
}

func BenchmarkAtomicHistoryEnqueue(b *testing.B) {
	ctx := context.Background()
	db, err := store.Open(ctx, b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	if _, err = db.Writer.Exec(`INSERT INTO tgdl_history_jobs(id,group_id,state,payload) VALUES('bench','-1000000000042','running','{}')`); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tx, err := db.Writer.BeginTx(ctx, nil)
		if err != nil {
			b.Fatal(err)
		}
		if _, _, err = enqueueWork(ctx, tx, "one", Target{}, testMessage(i+1, 0, int64(i+1)), 0, "history"); err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE tgdl_history_jobs SET payload=? WHERE id='bench'`, fmt.Sprintf(`{"cursor":%d,"processed":%d}`, i+1, i+1))
		}
		if err == nil {
			err = tx.Commit()
		}
		tx.Rollback()
		if err != nil {
			b.Fatal(err)
		}
	}
}

func TestManualQueueSharesDedupPriorityAndAtomicCheckpoints(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if _, _, err := enqueueWork(ctx, s.writer, "one", Target{}, testMessage(10, 0, 10), 0, "history"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Enqueue(ctx, "one", Target{}, testMessage(11, 0, 11)); err != nil {
		t.Fatal(err)
	}
	work, err := s.Claim(ctx, []string{"one"}, time.Now())
	if err != nil || work == nil || work.MessageID != 11 {
		t.Fatalf("live priority: %+v %v", work, err)
	}
	if err = s.Finish(ctx, work, nil, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	work, err = s.Claim(ctx, []string{"one"}, time.Now(), true)
	if err != nil || work == nil || work.Origin != "history" {
		t.Fatalf("manual claim: %+v %v", work, err)
	}
	if err = s.Finish(ctx, work, nil, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := enqueueWork(ctx, s.writer, "two", Target{}, testMessage(10, 0, 10), 0, "history"); err != nil || changed {
		t.Fatalf("manual dedup changed=%t %v", changed, err)
	}
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = enqueueWork(ctx, tx, "one", Target{}, testMessage(12, 0, 12), 0, "history"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err = s.reader.QueryRow(`SELECT count(*) FROM tgdl_work WHERE message_id=12`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("rolled back checkpoint left work: %d %v", rows, err)
	}
	if _, _, err = s.Enqueue(ctx, "one", Target{}, testMessage(13, 0, 13)); err != nil {
		t.Fatal(err)
	}
	if work, err = s.Claim(ctx, []string{"one"}, time.Now(), true); err != nil || work != nil {
		t.Fatalf("jobs-only claimed live work: %+v %v", work, err)
	}
	if _, changed, err := enqueueWork(ctx, s.writer, "one", Target{}, testMessage(13, 0, 13), 0, "history"); err != nil || !changed {
		t.Fatalf("manual request did not promote queued live work: %t %v", changed, err)
	}
}
func testMessage(id, edit int, media int64) *tg.Message {
	return &tg.Message{ID: id, Date: 1, EditDate: edit, PeerID: &tg.PeerChannel{ChannelID: 42}, Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: media, Size: 4, DCID: 2}}}
}
func TestWorkClaimsSurviveRestartAndKeepLatestEdit(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id, changed, err := s.Enqueue(ctx, "account", Target{Name: "group"}, testMessage(1, 0, 1))
	if err != nil || !changed {
		t.Fatalf("enqueue=%d/%v %v", id, changed, err)
	}
	first, err := s.Claim(ctx, []string{"account"}, time.Now())
	if err != nil || first.ID != id {
		t.Fatalf("claim=%+v %v", first, err)
	}
	if next, err := s.Claim(ctx, []string{"account"}, time.Now()); err != nil || next != nil {
		t.Fatalf("double claim=%+v %v", next, err)
	}
	_, changed, err = s.Enqueue(ctx, "account", Target{Name: "group"}, testMessage(1, 2, 2))
	if err != nil || !changed {
		t.Fatal(err)
	}
	if err = s.Finish(ctx, first, nil, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	second, err := s.Claim(ctx, []string{"account"}, time.Now())
	if err != nil || second == nil || second.Generation <= first.Generation {
		t.Fatalf("edit claim=%+v %v", second, err)
	}
	if err = s.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	replay, err := s.Claim(ctx, []string{"account"}, time.Now())
	if err != nil || replay == nil {
		t.Fatalf("recovery=%+v %v", replay, err)
	}
	message, err := replay.Message()
	if err != nil {
		t.Fatal(err)
	}
	if doc := message.Media.(*tg.MessageMediaDocument).Document.(*tg.Document); doc.ID != 2 {
		t.Fatalf("reverted edit: %d", doc.ID)
	}
	if err = s.Finish(ctx, replay, nil, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if _, changed, err = s.Enqueue(ctx, "other-account", Target{Name: "group"}, testMessage(1, 0, 1)); err != nil || changed {
		t.Fatalf("stale history accepted: %v %v", changed, err)
	}
	if _, changed, err = s.Enqueue(ctx, "account", Target{Name: "group"}, testMessage(1, 2, 2)); err != nil || changed {
		t.Fatalf("completed duplicate accepted: %v %v", changed, err)
	}
}

func TestSameSecondEditsUseTelegramOrderAcrossAccounts(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, edit := range []struct {
		account string
		media   int64
		pts     int
		changed bool
	}{
		{"one", 101, 10, true}, {"one", 202, 11, true}, {"two", 101, 10, false},
		{"two", 202, 13, false}, {"one", 101, 12, false},
	} {
		_, changed, err := s.Enqueue(ctx, edit.account, Target{}, testMessage(1, 2, edit.media), edit.pts)
		if err != nil || changed != edit.changed {
			t.Fatalf("edit %+v: changed=%v err=%v", edit, changed, err)
		}
	}
	work, err := s.Claim(ctx, []string{"one", "two"}, time.Now())
	if err != nil || work == nil {
		t.Fatalf("claim: %v %v", work, err)
	}
	msg, err := work.Message()
	if err != nil {
		t.Fatal(err)
	}
	if msg.Media.(*tg.MessageMediaDocument).Document.(*tg.Document).ID != 202 {
		t.Fatal("stale account rolled back latest edit")
	}
}

func TestCancellationRefundsAttemptsAndClaimDetectsEdit(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if _, _, err := s.Enqueue(ctx, "one", Target{}, testMessage(1, 1, 1)); err != nil {
		t.Fatal(err)
	}
	first, err := s.Claim(ctx, []string{"one"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Finish(ctx, first, context.Canceled, true, time.Time{}); err != nil {
		t.Fatal(err)
	}
	second, err := s.Claim(ctx, []string{"one"}, time.Now())
	if err != nil || second.Attempts != 1 {
		t.Fatalf("shutdown spent retry: %+v %v", second, err)
	}
	if _, _, err = s.Enqueue(ctx, "one", Target{}, testMessage(1, 2, 2)); err != nil {
		t.Fatal(err)
	}
	current, err := s.IsCurrent(ctx, second)
	if err != nil || current {
		t.Fatalf("stale claim still current: %v %v", current, err)
	}
	if err = s.Finish(ctx, second, context.Canceled, true, time.Time{}); err != nil {
		t.Fatal(err)
	}
	third, err := s.Claim(ctx, []string{"one"}, time.Now())
	if err != nil || third.Attempts != 1 {
		t.Fatalf("edit retry count: %+v %v", third, err)
	}
}

func TestQueueControlsAreDurableAndBoundClaims(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for id := 1; id <= 3; id++ {
		if _, changed, err := s.Enqueue(ctx, "one", Target{ID: "-1000000000042", Name: "group"}, testMessage(id, 1, int64(id))); err != nil || !changed {
			t.Fatalf("enqueue %d changed=%v err=%v", id, changed, err)
		}
	}
	if err := s.SetQueuePaused(ctx, true); err != nil {
		t.Fatal(err)
	}
	if work, err := s.Claim(ctx, []string{"one"}, time.Now()); err != nil || work != nil {
		t.Fatalf("paused queue claimed %+v err=%v", work, err)
	}
	if err := s.SetQueuePaused(ctx, false); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.PauseJob(ctx, "-1000000000042_1"); err != nil || !ok {
		t.Fatalf("pause=%v err=%v", ok, err)
	}
	first, err := s.Claim(ctx, []string{"one"}, time.Now())
	if err != nil || first == nil || first.MessageID != 2 {
		t.Fatalf("paused row bypass=%+v err=%v", first, err)
	}
	if err := s.Finish(ctx, first, nil, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.CancelJob(ctx, "-1000000000042_1"); err != nil || !ok {
		t.Fatalf("cancel=%v err=%v", ok, err)
	}
	if ok, err := s.ResumeJob(ctx, "-1000000000042_1"); err != nil || ok {
		t.Fatalf("cancelled row resumed=%v err=%v", ok, err)
	}
	if ok, err := s.PauseJob(ctx, "-1000000000042_3"); err != nil || !ok {
		t.Fatalf("pause pending=%v err=%v", ok, err)
	}
	if err := s.SetQueuePaused(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetQueuePaused(ctx, false); err != nil {
		t.Fatal(err)
	}
	next, err := s.Claim(ctx, []string{"one"}, time.Now())
	if err != nil || next == nil || next.MessageID != 3 {
		t.Fatalf("resume-all did not clear per-job pause: %+v err=%v", next, err)
	}
	if err := s.Finish(ctx, next, nil, false, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := s.Enqueue(ctx, "one", Target{ID: "-1000000000042", Name: "group"}, testMessage(4, 1, 4)); err != nil || !changed {
		t.Fatalf("enqueue after resume changed=%v err=%v", changed, err)
	}
	if removed, err := s.CancelAllQueued(ctx); err != nil || removed != 1 {
		t.Fatalf("cancel all removed=%d err=%v", removed, err)
	}
	if err := s.ClearFinished(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.reader.QueryRowContext(ctx, `SELECT COUNT(*) FROM tgdl_work`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("finished rows=%d err=%v", count, err)
	}
}
