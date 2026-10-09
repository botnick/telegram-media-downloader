package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type deferredObservationAccount struct {
	readyAccount
	jobsStarted bool
	entered     chan struct{}
	release     chan struct{}
	failure     error
}

func (*deferredObservationAccount) SupportsHistoryRecovery() bool { return true }
func (*deferredObservationAccount) Run(context.Context, func()) error {
	return errors.New("ordinary Run starts expensive history recovery")
}
func (a *deferredObservationAccount) RunJobs(ctx context.Context, ready func()) error {
	a.jobsStarted = true
	ready()
	<-ctx.Done()
	return ctx.Err()
}
func (a *deferredObservationAccount) StartObserving(ctx context.Context) error {
	close(a.entered)
	select {
	case <-a.release:
		return a.failure
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestJobsConnectionPromotionWaitsForRecoveryAndKeepsLease(t *testing.T) {
	for _, mode := range []string{"success", "failure", "stop"} {
		t.Run(mode, func(t *testing.T) {
			s := testStore(t)
			if _, err := s.writer.Exec(`INSERT INTO tgdl_update_recovery VALUES('one',42,'gap',0)`); err != nil {
				t.Fatal(err)
			}
			a := &deferredObservationAccount{entered: make(chan struct{}), release: make(chan struct{})}
			if mode == "failure" {
				a.failure = errors.New("repair failed")
			}
			c := New(s.writer, s.reader, t.TempDir(), func(AccountConfig, *telegram.UpdateState, func(context.Context, tg.UpdatesClass) error, func(int64)) (Account, error) {
				return a, nil
			}, func(context.Context, string, *tg.Message, tg.UpdatesClass) (Target, bool, error) {
				return Target{}, false, nil
			}, func(context.Context, *Work, *tg.Message, telegram.MediaDownloader) error { return nil }, nil)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := c.StartJobs(ctx, ctx, []AccountConfig{{ID: "one"}}, 1, 1); err != nil {
				t.Fatal(err)
			}
			defer c.Stop(ctx)
			lease, err := c.OpenDialogs(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lease.Close()
			if !a.jobsStarted {
				t.Fatal("jobs used ordinary Run")
			}
			var count int
			if err := s.reader.QueryRow(`SELECT count(*) FROM tgdl_update_recovery`).Scan(&count); err != nil || count != 1 {
				t.Fatalf("lost pending recovery: %d %v", count, err)
			}
			promoted := make(chan error, 1)
			go func() { promoted <- c.Start(ctx, ctx, []AccountConfig{{ID: "one"}}, 1, 1) }()
			<-a.entered
			status, err := c.Status(ctx)
			if err != nil || status["state"] != "starting" {
				t.Fatalf("premature ready: %v %v", status, err)
			}
			select {
			case err := <-promoted:
				t.Fatalf("promotion did not wait: %v", err)
			default:
			}
			if mode == "stop" {
				if err := c.StopObserving(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case err := <-promoted:
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("promotion stop: %v", err)
					}
				case <-time.After(time.Second):
					t.Fatal("stop did not release promotion wait")
				}
				if err := lease.Err(); err != nil {
					t.Fatalf("monitor stop cancelled manual lease: %v", err)
				}
				status, _ = c.Status(ctx)
				if status["state"] != "stopped" {
					t.Fatal(status)
				}
				return
			}
			close(a.release)
			err = <-promoted
			if mode == "failure" {
				if !errors.Is(err, a.failure) {
					t.Fatalf("failure=%v", err)
				}
				if lease.Err() == nil {
					t.Fatal("failed account lease stayed live")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if err := lease.Err(); err != nil {
					t.Fatalf("promotion cancelled active browsing: %v", err)
				}
				status, _ = c.Status(ctx)
				if status["state"] != "running" {
					t.Fatal(status)
				}
			}
		})
	}
}
