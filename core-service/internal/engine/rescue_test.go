package engine

import (
	"context"
	"errors"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
)

func TestEveryMessageQueueOriginPersistsRescueBeforeClaim(t *testing.T) {
	for _, origin := range []string{"live", "history", "url", "stories"} {
		t.Run(origin, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			if _, err := s.writer.Exec(`INSERT INTO kv(key,value,updated_at) VALUES('config','{"rescue":{"enabled":true}}',0)`); err != nil {
				t.Fatal(err)
			}
			tx, err := s.writer.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err = enqueueWork(ctx, tx, "one", Target{}, testMessage(10, 0, 10), 0, origin); err != nil {
				tx.Rollback()
				t.Fatal(err)
			}
			var n int
			if err = tx.QueryRow(`SELECT count(*) FROM tgdl_rescue_messages`).Scan(&n); err != nil {
				tx.Rollback()
				t.Fatal(err)
			}
			want := 1
			if origin == "stories" {
				want = 0
			}
			if n != want {
				tx.Rollback()
				t.Fatalf("rescue receipt count %d want %d", n, want)
			}
			if err = tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			if err = s.reader.QueryRow(`SELECT (SELECT count(*) FROM tgdl_work)+(SELECT count(*) FROM tgdl_rescue_messages)`).Scan(&n); err != nil || n != 0 {
				t.Fatalf("queue rollback leaked receipt %d %v", n, err)
			}
		})
	}
}

func TestFailedDeleteObserverPreventsTelegramCursorAcknowledgement(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	state := &telegram.UpdateState{Writer: s.writer, Reader: s.reader, AccountID: "one"}
	if err := state.SetState(ctx, 1, updates.State{Pts: 10}); err != nil {
		t.Fatal(err)
	}
	c := New(s.writer, s.reader, "", nil, nil, nil, nil)
	injected := errors.New("rescue write failed")
	c.SetUpdateObserver(func(context.Context, string, tg.UpdateClass) error { return injected })
	run := &running{} // Manual-only account: delete receipts must still be handled.
	handle := state.GuardHandler(func(ctx context.Context, u tg.UpdatesClass) error { return c.accept(ctx, run, "one", u) })
	if err := handle(ctx, &tg.UpdateShort{Update: &tg.UpdateDeleteMessages{Messages: []int{10}, Pts: 11, PtsCount: 1}}); !errors.Is(err, injected) {
		t.Fatal(err)
	}
	if err := state.SetPts(ctx, 1, 11); !errors.Is(err, injected) {
		t.Fatal("cursor advanced after lost delete", err)
	}
	stored, ok, err := state.GetState(ctx, 1)
	if err != nil || !ok || stored.Pts != 10 {
		t.Fatalf("cursor %+v %v %v", stored, ok, err)
	}
}
