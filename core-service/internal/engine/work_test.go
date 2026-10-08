package engine

import (
	"context"
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
