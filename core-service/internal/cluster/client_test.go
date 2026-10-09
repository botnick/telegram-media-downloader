package cluster

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSigningClockRollbackHonorsCancellation(t *testing.T) {
	c := &Client{}
	c.stamp.Store(time.Now().Add(2 * time.Minute).UnixMilli())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.timestamp(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("clock rollback emitted an invalid timestamp instead of waiting: %v", err)
	}
}
