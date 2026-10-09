package engine

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestBandwidthSharedAcrossWorkers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var limit bandwidthLimiter
		limit.set(100)
		start := time.Now()
		var wg sync.WaitGroup
		for range 2 {
			wg.Go(func() {
				w := trackedWriter{Writer: io.Discard, stats: &transferStats{}, ctx: context.Background(), bandwidth: &limit}
				if n, err := w.Write(make([]byte, 100)); n != 100 || err != nil {
					t.Errorf("write=%d, %v", n, err)
				}
			})
		}
		wg.Wait()
		if elapsed := time.Since(start); elapsed < 2*time.Second || elapsed > 2100*time.Millisecond {
			t.Fatalf("aggregate rate doubled or stalled: %v", elapsed)
		}
	})
}

func TestBandwidthLiveChangeAndCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var limit bandwidthLimiter
		limit.set(1)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			w := trackedWriter{Writer: io.Discard, stats: &transferStats{}, ctx: ctx, bandwidth: &limit}
			_, err := w.Write(make([]byte, 10))
			done <- err
		}()
		synctest.Wait()
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel=%v", err)
		}
		go func() {
			w := trackedWriter{Writer: io.Discard, stats: &transferStats{}, ctx: context.Background(), bandwidth: &limit}
			_, err := w.Write(make([]byte, 10))
			done <- err
		}()
		synctest.Wait()
		start := time.Now()
		limit.set(0)
		if err := <-done; err != nil || time.Since(start) != 0 {
			t.Fatalf("removing limit left old wait: %v elapsed=%v", err, time.Since(start))
		}
		limit.set(100)
		time.Sleep(time.Second) // Accumulated burst must be clamped on lowering.
		limit.set(1)
		start = time.Now()
		w := trackedWriter{Writer: io.Discard, stats: &transferStats{}, ctx: context.Background(), bandwidth: &limit}
		if _, err := w.Write(make([]byte, 3)); err != nil || time.Since(start) < 2*time.Second {
			t.Fatalf("lowered cap kept stale credit: %v elapsed=%v", err, time.Since(start))
		}
	})
}

func TestPacingDoesNotConsumeAttemptBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		budget := newAttemptBudget(context.Background(), 50*time.Millisecond)
		defer budget.stop()
		var limit bandwidthLimiter
		limit.set(10)
		stats := &transferStats{}
		w := trackedWriter{Writer: io.Discard, stats: stats, ctx: budget.ctx, bandwidth: &limit, budget: budget}
		if n, err := w.Write(make([]byte, 10)); n != 10 || err != nil || stats.received.Load() != 10 {
			t.Fatalf("pacing consumed timeout or lost progress: n=%d err=%v bytes=%d", n, err, stats.received.Load())
		}
		if budget.ctx.Err() != nil {
			t.Fatal("intentional pacing expired attempt")
		}
		time.Sleep(60 * time.Millisecond)
		if !errors.Is(context.Cause(budget.ctx), context.DeadlineExceeded) {
			t.Fatalf("actual stall unbounded: %v", context.Cause(budget.ctx))
		}
	})
}
