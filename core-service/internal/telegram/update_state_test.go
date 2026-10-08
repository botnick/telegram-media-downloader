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
