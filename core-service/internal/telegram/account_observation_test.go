package telegram

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestJobsConnectionDefersRecoveryUntilObservation(t *testing.T) {
	o := newAccountObservation()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	jobsReady, recoveryEntered, allowRecovery := make(chan struct{}), make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- o.run(ctx, func() { close(jobsReady) }, true, func(ctx context.Context, ready func()) error {
			close(recoveryEntered)
			select {
			case <-allowRecovery:
			case <-ctx.Done():
				return ctx.Err()
			}
			ready()
			<-ctx.Done()
			return ctx.Err()
		})
	}()
	<-jobsReady
	select {
	case <-recoveryEntered:
		t.Fatal("browsing started history recovery")
	default:
	}
	promoted := make(chan error, 1)
	go func() { promoted <- o.start(ctx) }()
	<-recoveryEntered
	select {
	case err := <-promoted:
		t.Fatalf("ready before recovery completed: %v", err)
	default:
	}
	close(allowRecovery)
	if err := <-promoted; err != nil {
		t.Fatal(err)
	}
	if err := o.start(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestJobsConnectionStopDoesNotStartRecovery(t *testing.T) {
	o := newAccountObservation()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- o.run(ctx, func() { close(ready) }, true, func(context.Context, func()) error { t.Error("recovery started"); return nil })
	}()
	<-ready
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	wait, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := o.start(wait); !errors.Is(err, context.Canceled) {
		t.Fatalf("stopped run=%v", err)
	}
}

func TestObservationFailureDoesNotReportReady(t *testing.T) {
	for _, jobsOnly := range []bool{false, true} {
		o := newAccountObservation()
		failure := errors.New("history recovery failed")
		ready := make(chan struct{}, 1)
		done := make(chan error, 1)
		go func() {
			done <- o.run(context.Background(), func() { ready <- struct{}{} }, jobsOnly, func(context.Context, func()) error { return failure })
		}()
		if jobsOnly {
			<-ready
			if err := o.start(context.Background()); !errors.Is(err, failure) {
				t.Fatal(err)
			}
		}
		if err := <-done; !errors.Is(err, failure) {
			t.Fatal(err)
		}
		select {
		case <-ready:
			t.Fatal("monitor ready despite failed recovery")
		default:
		}
	}
}
