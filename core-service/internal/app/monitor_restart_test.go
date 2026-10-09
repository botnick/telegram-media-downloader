package app

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/engine"
	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
)

type flakyRunAccount struct {
	fixtureAccount
	fail bool
}

func (a *flakyRunAccount) Run(ctx context.Context, ready func()) error {
	ready()
	if a.fail {
		// Fails after a healthy start, like a dropped connection or a gap.
		select {
		case <-time.After(100 * time.Millisecond):
			return errors.New("connection lost")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	<-ctx.Done()
	return ctx.Err()
}

func TestMonitorRestartsAfterErrorWhileAutoStartIsOn(t *testing.T) {
	saved := monitorRestartDelays
	monitorRestartDelays = []time.Duration{10 * time.Millisecond}
	defer func() { monitorRestartDelays = saved }()
	var runs atomic.Int64
	a, err := newConfiguredTestApp(context.Background(), Config{DataDir: t.TempDir(), AccountFactory: func(_ engine.AccountConfig, _ *telegram.UpdateState, handler func(context.Context, tg.UpdatesClass) error, _ func(int64)) (engine.Account, error) {
		n := runs.Add(1)
		return &flakyRunAccount{fixtureAccount: fixtureAccount{handle: handler}, fail: n == 1}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	configureMonitor(t, a)
	if w := monitorRequest(t, a, "/api/monitor/start"); w.Code != 200 {
		t.Fatalf("start=%d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, _ := a.monitor.Status(context.Background())
		if runs.Load() >= 2 && status["state"] == "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	status, _ := a.monitor.Status(context.Background())
	if runs.Load() != 2 || status["state"] != "running" {
		t.Fatalf("runs=%d status=%v", runs.Load(), status)
	}
	// Stopped by hand: no restart.
	if w := monitorRequest(t, a, "/api/monitor/stop"); w.Code != 200 {
		t.Fatalf("stop=%d", w.Code)
	}
	time.Sleep(100 * time.Millisecond)
	if status, _ := a.monitor.Status(context.Background()); status["state"] != "stopped" || runs.Load() != 2 {
		t.Fatalf("after stop runs=%d status=%v", runs.Load(), status)
	}
}
