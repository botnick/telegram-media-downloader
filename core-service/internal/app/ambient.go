package app

import (
	"context"
	"fmt"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// One owned loop per task, not one timer/query per browser connection. A slow
// query or sweep cannot spawn overlapping passes or accumulate goroutines.
func (a *App) startAmbient() {
	a.rescueWake = make(chan struct{}, 1)
	a.ambientWG.Add(4)
	go func() { defer a.ambientWG.Done(); a.runPushes(a.ctx, 3*time.Second, a.pushMonitorStatus) }()
	go func() { defer a.ambientWG.Done(); a.runPushes(a.ctx, 30*time.Second, a.pushStats) }()
	go func() { defer a.ambientWG.Done(); a.runRescueSweeper(a.ctx) }()
	go func() { defer a.ambientWG.Done(); a.runClusterSync(a.ctx) }()
}

func (a *App) runPushes(ctx context.Context, interval time.Duration, push func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if ctx.Err() != nil {
				return
			}
			if a.hub.Count() == 0 {
				continue
			}
			attempt, cancel := context.WithTimeout(ctx, 2*time.Second)
			// A subsequent tick retries; never publish invented zero counters.
			_ = push(attempt)
			cancel()
		}
	}
}

func (a *App) pushMonitorStatus(ctx context.Context) error {
	status, err := a.monitorStatusPayload(ctx)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	a.hub.Broadcast(ws.Event{Type: "monitor_status_push", Payload: status})
	return nil
}

func (a *App) pushStats(ctx context.Context) error {
	var files, size int64
	if err := a.db.Reader.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(file_size),0) FROM downloads`).Scan(&files, &size); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	a.hub.Broadcast(ws.Event{Type: "stats_push", Payload: map[string]any{"totalFiles": files, "totalSize": size, "diskUsage": size, "diskUsageFormatted": formatBytes(size)}})
	return nil
}

func (a *App) runRescueSweeper(ctx context.Context) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-a.rescueWake:
			timer.Reset(5 * time.Second)
		case <-timer.C:
			attempt, cancel := context.WithTimeout(ctx, time.Minute)
			cleared, err := a.sweepRescue(attempt, time.Now())
			cancel()
			if err != nil && ctx.Err() == nil && a.output != nil {
				fmt.Fprintf(a.output, "Rescue cleanup remains pending: %v\n", err)
			}
			interval := 10 * time.Minute
			if cfg, err := a.config.Load(ctx); err == nil {
				rescue, _ := cfg["rescue"].(map[string]any)
				minutes := int(number(rescue["sweepIntervalMin"], 10))
				if minutes == 0 {
					minutes = 10
				}
				interval = time.Duration(max(1, min(1440, minutes))) * time.Minute
			}
			// Drain large backlogs in bounded transactions without holding the
			// single writer through an unbounded sweep or waiting ten minutes
			// between full batches. Errors retain the normal retry cadence.
			if err == nil && cleared == rescueBatchSize {
				interval = time.Second
			}
			timer.Reset(interval)
		}
	}
}
