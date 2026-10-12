package engine

import (
	"context"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

func TestGaugesReportRunAndQueue(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	c := New(s.writer, s.reader, t.TempDir(), func(AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (Account, error) {
		return &readyAccount{}, nil
	}, func(context.Context, string, *tg.Message, tg.UpdatesClass) (Target, bool, error) {
		return Target{}, false, nil
	}, func(context.Context, *Work, *tg.Message, telegram.MediaDownloader) error { return nil }, nil)
	if err := s.SetQueuePaused(ctx, true); err != nil {
		t.Fatal(err)
	}
	for id := 21; id <= 23; id++ {
		if _, _, err := s.Enqueue(ctx, "one", Target{}, testMessage(id, 0, int64(id))); err != nil {
			t.Fatal(err)
		}
	}
	g, err := c.Gauges(ctx)
	if err != nil || g != (Gauges{Queue: 3}) {
		t.Fatalf("stopped engine gauges %+v %v", g, err)
	}
	if err := c.StartJobs(ctx, ctx, []AccountConfig{{ID: "one"}}, 2, 1); err != nil {
		t.Fatal(err)
	}
	g, err = c.Gauges(ctx)
	if err != nil || g.Accounts != 1 || g.Workers != 2 || g.Queue != 3 || g.Active != 0 {
		t.Fatalf("running engine gauges %+v %v", g, err)
	}
	if err := c.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if g, err = c.Gauges(ctx); err != nil || g.Accounts != 0 || g.Workers != 0 {
		t.Fatalf("stopped engine still reports a run %+v %v", g, err)
	}
}
