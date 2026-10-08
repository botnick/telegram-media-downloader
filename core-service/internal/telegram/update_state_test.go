package telegram

import (
	"context"
	"errors"
	"github.com/botnick/telegram-media-downloader/core-service/internal/store"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"testing"
)

func TestUpdateCursorDoesNotAdvanceAfterQueueFailure(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	state := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	if err = state.SetState(ctx, 42, updates.State{Pts: 10, Seq: 5}); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("queue commit failed")
	handle := state.GuardHandler(func(context.Context, tg.UpdatesClass) error { return failure })
	if err = handle(ctx, &tg.Updates{}); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if err = state.SetPts(ctx, 42, 20); !errors.Is(err, failure) {
		t.Fatalf("cursor advanced after sink failure: %v", err)
	}
	if err = state.SetSeq(ctx, 42, 6); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	recovered := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	got, found, err := recovered.GetState(ctx, 42)
	if err != nil || !found || got.Pts != 10 || got.Seq != 5 {
		t.Fatalf("saved=%+v found=%v err=%v", got, found, err)
	}
	other := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "two"}
	if _, found, err := other.GetState(ctx, 42); err != nil || found {
		t.Fatalf("account cursor leaked: %v %v", found, err)
	}
}

func TestDialogHashesAreAccountScopedAndDoNotPoisonUpdateCursor(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Reader.Close()
	defer db.Writer.Close()
	state := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "one"}
	if err := state.SetChannelPts(ctx, 7, 42, 10); err != nil {
		t.Fatal(err)
	}
	chats := []tg.ChatClass{&tg.Channel{ID: 42, AccessHash: 1234}, &tg.Channel{ID: 43, AccessHash: 900, Min: true}}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := state.cacheDialogHashes(cancelled, 7, chats); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel=%v", err)
	}
	if err := state.cacheDialogHashes(ctx, 7, chats); err != nil {
		t.Fatalf("cancel poisoned account: %v", err)
	}
	if pts, found, err := state.GetChannelPts(ctx, 7, 42); err != nil || !found || pts != 10 {
		t.Fatalf("hash cache changed cursor: %d %v %v", pts, found, err)
	}
	if hash, found, err := state.GetChannelAccessHash(ctx, 7, 42); err != nil || !found || hash != 1234 {
		t.Fatalf("hash=%d found=%v err=%v", hash, found, err)
	}
	if _, found, err := state.GetChannelAccessHash(ctx, 7, 43); err != nil || found {
		t.Fatalf("minimal hash accepted: %v %v", found, err)
	}
	other := &UpdateState{Writer: db.Writer, Reader: db.Reader, AccountID: "two"}
	if _, found, err := other.GetChannelAccessHash(ctx, 7, 42); err != nil || found {
		t.Fatalf("hash leaked across accounts: %v %v", found, err)
	}
	if err := state.SetChannelPts(ctx, 7, 42, 11); err != nil {
		t.Fatalf("cancelled browse blocked updates: %v", err)
	}
}
