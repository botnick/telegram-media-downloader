package jobs

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTrackerSingleFlightProgressAndCancellation(t *testing.T) {
	tracker := NewTracker()
	started := make(chan struct{})
	finished := make(chan error, 1)
	job, err := tracker.Start(context.Background(), "dedup", 10, func(ctx context.Context, update func(int, string)) error {
		close(started)
		update(3, "hashing")
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tracker.Start(context.Background(), "dedup", 1, func(context.Context, func(int, string)) error { return nil }); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("duplicate start error = %v", err)
	}
	<-started
	snapshot, ok := tracker.Get(job.ID)
	if !ok || snapshot.Done != 3 || snapshot.Stage != "hashing" {
		t.Fatalf("snapshot = %+v ok=%v", snapshot, ok)
	}
	if err := tracker.Cancel(job.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-job.Done:
	case <-time.After(time.Second):
		t.Fatal("job did not finish after cancel")
	}
	finished <- job.Err()
	if !errors.Is(<-finished, context.Canceled) {
		t.Fatalf("job error = %v", job.Err())
	}
}
