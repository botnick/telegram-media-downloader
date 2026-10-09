package engine

import (
	"context"
	"sync"
	"time"
)

// bandwidthLimiter is shared by all media workers, including different accounts.
// One waiter owns token acquisition at a time; it releases the gate each small
// chunk so a large file cannot reserve the whole queue's future bandwidth.
type bandwidthLimiter struct {
	once    sync.Once
	gate    chan struct{}
	mu      sync.Mutex
	speed   int64
	tokens  float64
	updated time.Time
	changed chan struct{}
}

func (l *bandwidthLimiter) init() {
	l.once.Do(func() { l.gate = make(chan struct{}, 1); l.changed = make(chan struct{}) })
}

func bandwidthChunk(speed int64) int {
	return int(min(int64(32<<10), max(int64(1), speed/10)))
}

func (l *bandwidthLimiter) refill(now time.Time) {
	if l.speed > 0 && !l.updated.IsZero() {
		l.tokens = min(float64(bandwidthChunk(l.speed)), l.tokens+now.Sub(l.updated).Seconds()*float64(l.speed))
	}
	l.updated = now
}

func (l *bandwidthLimiter) set(speed int64) {
	l.init()
	l.mu.Lock()
	defer l.mu.Unlock()
	speed = max(speed, 0)
	if l.speed == speed {
		return
	}
	l.refill(time.Now())
	l.speed = speed
	l.tokens = min(l.tokens, float64(bandwidthChunk(speed)))
	if speed == 0 {
		l.tokens = 0
	}
	close(l.changed)
	l.changed = make(chan struct{})
}

func (l *bandwidthLimiter) limit() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.speed
}

func (l *bandwidthLimiter) take(ctx context.Context, requested int) (int, error) {
	l.init()
	select {
	case l.gate <- struct{}{}:
		defer func() { <-l.gate }()
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		l.mu.Lock()
		l.refill(time.Now())
		n := min(requested, 32<<10)
		if l.speed == 0 {
			l.mu.Unlock()
			return n, nil
		}
		n = min(n, bandwidthChunk(l.speed))
		if l.tokens >= float64(n) {
			l.tokens -= float64(n)
			l.mu.Unlock()
			return n, nil
		}
		wait := max(time.Nanosecond, time.Duration((float64(n)-l.tokens)/float64(l.speed)*float64(time.Second)))
		changed := l.changed
		l.mu.Unlock()
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return 0, ctx.Err()
		case <-changed:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// SetMaxSpeed applies a bytes/second ceiling immediately. Zero means unlimited.
func (c *Controller) SetMaxSpeed(bytesPerSecond int64) { c.bandwidth.set(bytesPerSecond) }

// attemptBudget bounds work time, excluding deliberate bandwidth waits. A slow
// configured limit must not repeatedly restart a healthy large transfer. Parent
// cancellation still interrupts a paused budget, including queue pause/stop.
type attemptBudget struct {
	ctx       context.Context
	cancel    context.CancelCauseFunc
	mu        sync.Mutex
	timer     *time.Timer
	remaining time.Duration
	started   time.Time
	pauses    int
	stopped   bool
}

func newAttemptBudget(parent context.Context, limit time.Duration) *attemptBudget {
	ctx, cancel := context.WithCancelCause(parent)
	b := &attemptBudget{ctx: ctx, cancel: cancel, remaining: limit, started: time.Now()}
	b.mu.Lock()
	b.timer = time.AfterFunc(limit, b.expire)
	b.mu.Unlock()
	return b
}

func (b *attemptBudget) expire() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopped || b.pauses > 0 {
		return
	}
	left := b.remaining - time.Since(b.started)
	if left > 0 {
		b.timer.Reset(left)
		return
	}
	b.cancel(context.DeadlineExceeded)
}

func (b *attemptBudget) pause() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pauses == 0 && !b.stopped {
		b.remaining -= time.Since(b.started)
		b.timer.Stop()
		if b.remaining <= 0 {
			b.cancel(context.DeadlineExceeded)
		}
	}
	b.pauses++
}

func (b *attemptBudget) resume() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pauses--
	if b.pauses == 0 && !b.stopped && b.ctx.Err() == nil {
		b.started = time.Now()
		b.timer.Reset(b.remaining)
	}
}

func (b *attemptBudget) stop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stopped = true
	b.timer.Stop()
	b.cancel(context.Canceled)
}
