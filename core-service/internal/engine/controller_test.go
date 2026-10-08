package engine

import (
	"context"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
	"io"
	"testing"
	"time"
)

type connectingAccount struct{ entered chan struct{} }

func (a *connectingAccount) Run(ctx context.Context, ready func()) error {
	close(a.entered)
	<-ctx.Done()
	return ctx.Err()
}
func (a *connectingAccount) Fingerprint() string { return "test-key" }
func (a *connectingAccount) RefreshMessage(_ context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
	return &telegram.RefreshedMessage{Message: m, Entities: &tg.Updates{}}, nil
}
func (a *connectingAccount) DownloadMedia(context.Context, telegram.Attachment, io.Writer) error {
	return nil
}
func TestStopCancelsAccountStartupPromptly(t *testing.T) {
	s := testStore(t)
	entered := make(chan struct{})
	factory := func(AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (Account, error) {
		return &connectingAccount{entered: entered}, nil
	}
	filter := func(context.Context, string, *tg.Message, tg.UpdatesClass) (Target, bool, error) {
		return Target{}, true, nil
	}
	sink := func(context.Context, *Work, *tg.Message, telegram.MediaDownloader) error { return nil }
	c := New(s.writer, s.reader, t.TempDir(), factory, filter, sink, nil)
	request, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan error, 1)
	go func() { started <- c.Start(request, context.Background(), []AccountConfig{{ID: "one"}}, 1, 2) }()
	<-entered
	stopped := make(chan error, 1)
	go func() { stopped <- c.Stop(context.Background()) }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(250 * time.Millisecond):
		cancel()
		<-started
		<-stopped
		t.Fatal("Stop could not cancel account startup")
	}
	if err := <-started; err == nil {
		t.Fatal("cancelled startup reported success")
	}
}

type readyAccount struct {
	connectingAccount
	refreshed *telegram.RefreshedMessage
}

func (a *readyAccount) Run(ctx context.Context, ready func()) error {
	ready()
	<-ctx.Done()
	return ctx.Err()
}
func (a *readyAccount) RefreshMessage(_ context.Context, _ *tg.Message) (*telegram.RefreshedMessage, error) {
	return a.refreshed, nil
}

func TestAttemptDeadlineFailsButRefreshedFilterSkips(t *testing.T) {
	for _, refresh := range []bool{false, true} {
		t.Run(map[bool]string{false: "bounded-timeout", true: "refreshed-filter"}[refresh], func(t *testing.T) {
			ctx := context.Background()
			s := testStore(t)
			if _, _, err := s.Enqueue(ctx, "one", Target{}, testMessage(1, 1, 1)); err != nil {
				t.Fatal(err)
			}
			if refresh {
				if _, err := s.writer.Exec(`UPDATE tgdl_work SET created_at=0`); err != nil {
					t.Fatal(err)
				}
			}
			fresh := &telegram.RefreshedMessage{Message: testMessage(1, 2, 2), Entities: &tg.Updates{Users: []tg.UserClass{&tg.User{ID: 42, Username: "allowed"}}}}
			factory := func(AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (Account, error) {
				return &readyAccount{refreshed: fresh}, nil
			}
			calls := 0
			filter := func(_ context.Context, _ string, _ *tg.Message, u tg.UpdatesClass) (Target, bool, error) {
				if len(u.(*tg.Updates).Users) != 1 {
					t.Error("refresh discarded user entities")
				}
				return Target{}, false, nil
			}
			sink := func(ctx context.Context, _ *Work, _ *tg.Message, _ telegram.MediaDownloader) error {
				calls++
				<-ctx.Done()
				return ctx.Err()
			}
			c := New(s.writer, s.reader, t.TempDir(), factory, filter, sink, nil)
			c.attemptLimit = func(int64) time.Duration { return 10 * time.Millisecond }
			if err := c.Start(ctx, ctx, []AccountConfig{{ID: "one"}}, 1, 1); err != nil {
				t.Fatal(err)
			}
			defer c.Stop(ctx)
			expected := "failed"
			if refresh {
				expected = "skipped"
			}
			deadline := time.Now().Add(3 * time.Second)
			var state string
			for time.Now().Before(deadline) {
				if err := s.reader.QueryRow(`SELECT status FROM tgdl_work`).Scan(&state); err != nil {
					t.Fatal(err)
				}
				if state == expected {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if err := c.Stop(ctx); err != nil {
				t.Fatal(err)
			}
			if state != expected {
				t.Fatalf("status %s, want %s", state, expected)
			}
			if refresh && calls != 0 {
				t.Fatal("disallowed replacement downloaded")
			}
			if !refresh && calls != 1 {
				t.Fatalf("deadline attempts=%d", calls)
			}
		})
	}
}

func TestPendingHistoryRecoveryPreventsStartup(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	if _, err := s.writer.Exec(`INSERT INTO tgdl_update_recovery VALUES('one',42,'gap',0)`); err != nil {
		t.Fatal(err)
	}
	factory := func(AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (Account, error) {
		return &readyAccount{}, nil
	}
	filter := func(context.Context, string, *tg.Message, tg.UpdatesClass) (Target, bool, error) {
		return Target{}, true, nil
	}
	c := New(s.writer, s.reader, t.TempDir(), factory, filter, func(context.Context, *Work, *tg.Message, telegram.MediaDownloader) error { return nil }, nil)
	if err := c.Start(ctx, ctx, []AccountConfig{{ID: "one"}}, 1, 1); err == nil {
		t.Fatal("lost history recovery marker")
	}
}
