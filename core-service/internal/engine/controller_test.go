package engine

import (
	"context"
	"errors"
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

type dialogCallbackAccount struct {
	connectingAccount
	list func(context.Context, int, bool) ([]telegram.Dialog, error)
}

func (a *dialogCallbackAccount) Dialogs(ctx context.Context, limit int, archived bool) ([]telegram.Dialog, error) {
	return a.list(ctx, limit, archived)
}

func TestDialogsRejectsStoppedAccountsAndIncompleteFolder(t *testing.T) {
	calls := 0
	unreachable := errors.New("archive RPC failed")
	account := &dialogCallbackAccount{list: func(_ context.Context, _ int, archived bool) ([]telegram.Dialog, error) {
		calls++
		if archived {
			return nil, unreachable
		}
		return []telegram.Dialog{{ID: "42", Name: "Visible"}}, nil
	}}
	c := &Controller{run: &running{ctx: context.Background(), accounts: map[string]Account{"one": account}, ids: []string{"one"}}}
	for _, state := range []string{"stopped", "starting", "stopping", "error"} {
		c.state = state
		if _, err := c.Dialogs(context.Background(), 500); !errors.Is(err, ErrEngineNotRunning) {
			t.Fatalf("state=%s err=%v", state, err)
		}
	}
	if calls != 0 {
		t.Fatalf("called a disconnected account %d times", calls)
	}
	c.state = "running"
	items, err := c.Dialogs(context.Background(), 500)
	if !errors.Is(err, unreachable) || items != nil || calls != 2 {
		t.Fatalf("partial archive shown as complete: %+v %v calls=%d", items, err, calls)
	}
}

func TestDialogsCancelsWithAccountRun(t *testing.T) {
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	account := &dialogCallbackAccount{list: func(ctx context.Context, _ int, _ bool) ([]telegram.Dialog, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	c := &Controller{state: "running", run: &running{ctx: runCtx, accounts: map[string]Account{"one": account}, ids: []string{"one"}}}
	done := make(chan error, 1)
	go func() {
		_, err := c.Dialogs(context.Background(), 500)
		done <- err
	}()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("account stopped: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("dialog RPC outlived its account")
	}
}

func TestDialogsLeasePreventsIdleStopButAllowsHardStop(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	c := New(s.writer, s.reader, t.TempDir(), func(AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (Account, error) {
		return &readyAccount{}, nil
	}, func(context.Context, string, *tg.Message, tg.UpdatesClass) (Target, bool, error) {
		return Target{}, false, nil
	}, func(context.Context, *Work, *tg.Message, telegram.MediaDownloader) error { return nil }, nil)
	if err := c.StartJobs(ctx, ctx, []AccountConfig{{ID: "one"}}, 1, 1); err != nil {
		t.Fatal(err)
	}
	defer c.Stop(ctx)
	lease, err := c.OpenDialogs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := c.StopIdleJobs(ctx); err != nil {
		t.Fatal(err)
	}
	if err := lease.ctx.Err(); err != nil {
		t.Fatalf("idle drain interrupted browsing: %v", err)
	}
	if err := c.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-lease.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("hard stop did not cancel browsing")
	}
	if _, err := lease.List(500); !errors.Is(err, context.Canceled) {
		t.Fatalf("stopped lease=%v", err)
	}
	lease.Close()
	lease.Close()
	if lease.run.jobUsers.Load() != 0 {
		t.Fatal("lease did not release exactly once")
	}
}
func (a *connectingAccount) Fingerprint() string { return "test-key" }
func (a *connectingAccount) RefreshMessage(_ context.Context, m *tg.Message) (*telegram.RefreshedMessage, error) {
	return &telegram.RefreshedMessage{Message: m, Entities: &tg.Updates{}}, nil
}
func (a *connectingAccount) DownloadMedia(context.Context, telegram.Attachment, io.Writer) error {
	return nil
}

type dialogTestAccount struct {
	connectingAccount
	active, archived []telegram.Dialog
}

func (a *dialogTestAccount) Dialogs(_ context.Context, _ int, archived bool) ([]telegram.Dialog, error) {
	if archived {
		return a.archived, nil
	}
	return a.active, nil
}

func TestDialogsMergeAccountsAndPreferActiveEntries(t *testing.T) {
	accountOne := &dialogTestAccount{active: []telegram.Dialog{{ID: "-1000000000042", Name: "Fresh", Type: "channel"}}, archived: []telegram.Dialog{{ID: "-1000000000042", Name: "Old", Type: "channel", Archived: true}}}
	accountTwo := &dialogTestAccount{active: []telegram.Dialog{{ID: "-1000000000042", Name: "Fresh", Type: "channel"}, {ID: "-9", Name: "Group", Type: "group"}}}
	c := &Controller{state: "running", run: &running{accounts: map[string]Account{"one": accountOne, "two": accountTwo}, ids: []string{"one", "two"}}}
	items, err := c.Dialogs(context.Background(), 500)
	if err != nil || len(items) != 2 {
		t.Fatalf("dialogs=%+v err=%v", items, err)
	}
	if items[0].ID != "-1000000000042" || items[0].Name != "Fresh" || items[0].Archived || len(items[0].AccountIDs) != 2 || items[0].AccountIDs[0] != "one" || items[0].AccountIDs[1] != "two" {
		t.Fatalf("merged channel=%+v", items[0])
	}
	if items[1].ID != "-9" || items[1].AccountIDs[0] != "two" {
		t.Fatalf("second dialog=%+v", items[1])
	}
}

func TestDialogsMergeAccessWithoutHidingReadableAccounts(t *testing.T) {
	one := &dialogTestAccount{active: []telegram.Dialog{{ID: "42", Name: "Old", Access: telegram.DialogAccess{State: "inaccessible", Code: "CHANNEL_FORBIDDEN"}}, {ID: "43", Name: "Deleted", Access: telegram.DialogAccess{State: "deleted", Code: "USER_DELETED"}}}}
	two := &dialogTestAccount{active: []telegram.Dialog{{ID: "42", Name: "Readable", Access: telegram.DialogAccess{State: "ok"}}, {ID: "43", Name: "Partial", Access: telegram.DialogAccess{State: "unknown"}}}}
	c := &Controller{state: "running", run: &running{accounts: map[string]Account{"one": one, "two": two}, ids: []string{"one", "two"}}}
	items, err := c.Dialogs(context.Background(), 500)
	if err != nil || len(items) != 2 {
		t.Fatalf("items=%+v err=%v", items, err)
	}
	if items[0].Access.State != "ok" || items[0].AccountAccess["one"].State != "inaccessible" || items[0].AccountAccess["two"].State != "ok" {
		t.Fatalf("merged=%+v", items[0])
	}
	if items[1].Access.State != "unknown" {
		t.Fatalf("partial account evidence marked every account deleted: %+v", items[1])
	}
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
