package app

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/seekbar"
	"github.com/botnick/telegram-media-downloader/core-service/internal/ws"
)

// Bounded like the released pregenerate queues: realtime downloads jump ahead
// of history backfill, and an over-full queue drops new ids (the next scan
// picks them up).
const seekbarQueueCap = 200

// seekbarState owns the post-download queue, the two maintenance jobs and the
// limiter every sprite encode shares.
type seekbarState struct {
	limiter seekbar.Limiter
	build   *seekbarJob
	rebuild *seekbarJob

	mu       sync.Mutex
	realtime []int64
	backfill []int64
	queued   map[int64]bool
	inFlight map[int64]bool
	draining bool
}

func newSeekbarState() *seekbarState {
	return &seekbarState{
		build:    newSeekbarJob("seekbarBuild", "seekbar"),
		rebuild:  newSeekbarJob("seekbarRebuild", "seekbar_rebuild"),
		queued:   map[int64]bool{},
		inFlight: map[int64]bool{},
	}
}

func (s *seekbarState) depths() (queued int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.realtime) + len(s.backfill)
}

// seekbarJob is the released JobTracker contract: one run at a time, a
// status snapshot for page reloads, and <prefix>_progress / <prefix>_done
// WebSocket events.
type seekbarJob struct {
	kind, prefix string

	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
	state   map[string]any
}

func newSeekbarJob(kind, prefix string) *seekbarJob {
	return &seekbarJob{kind: kind, prefix: prefix, state: maintenanceIdleStatus(kind)}
}

func (j *seekbarJob) status() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snapshotLocked()
}

func (j *seekbarJob) snapshotLocked() map[string]any {
	out := cloneConfigValue(j.state).(map[string]any)
	out["running"] = j.running
	return out
}

func (j *seekbarJob) progress() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	p, _ := cloneConfigValue(j.state["progress"]).(map[string]any)
	return p
}

func (j *seekbarJob) isRunning() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.running
}

// stop cancels a running job; false when idle.
func (j *seekbarJob) stop() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.running || j.cancel == nil {
		return false
	}
	j.cancel()
	return true
}

type seekbarRunFunc func(ctx context.Context, progress func(map[string]any)) (map[string]any, error)

var errSeekbarStopping = errors.New("server is stopping")

// start launches run unless the job is already running. The returned map is
// the 409 body when started is false.
func (a *App) startSeekbarJob(j *seekbarJob, run seekbarRunFunc) (map[string]any, error) {
	j.mu.Lock()
	if j.running {
		snap := j.snapshotLocked()
		j.mu.Unlock()
		return map[string]any{"started": false, "code": "ALREADY_RUNNING", "snapshot": snap}, nil
	}
	done, ok := a.beginMaintenance()
	if !ok {
		j.mu.Unlock()
		return nil, errSeekbarStopping
	}
	ctx, cancel := context.WithCancel(a.ctx)
	started := time.Now()
	attempts, _ := j.state["attempts"].(int)
	j.running, j.cancel = true, cancel
	j.state["running"], j.state["stage"], j.state["progress"] = true, "starting", map[string]any{}
	j.state["startedAt"], j.state["finishedAt"], j.state["durationMs"] = started.UnixMilli(), 0, 0
	j.state["error"], j.state["attempts"] = nil, attempts+1
	snap := j.snapshotLocked()
	j.mu.Unlock()
	a.broadcastSeekbar(j.prefix+"_progress", snap)

	go func() {
		defer done()
		defer cancel()
		result, err := run(ctx, func(p map[string]any) { a.seekbarJobProgress(j, p) })
		a.finishSeekbarJob(j, started, result, err)
	}()
	return map[string]any{"started": true, "snapshot": snap}, nil
}

func (a *App) seekbarJobProgress(j *seekbarJob, p map[string]any) {
	j.mu.Lock()
	if !j.running {
		j.mu.Unlock()
		return
	}
	merged, _ := j.state["progress"].(map[string]any)
	if merged == nil {
		merged = map[string]any{}
	}
	for k, v := range p {
		merged[k] = v
	}
	j.state["progress"] = merged
	if stage, ok := p["stage"].(string); ok && stage != "" {
		j.state["stage"] = stage
	}
	event := j.snapshotLocked()
	j.mu.Unlock()
	for k, v := range p {
		event[k] = v
	}
	a.broadcastSeekbar(j.prefix+"_progress", event)
}

func (a *App) finishSeekbarJob(j *seekbarJob, started time.Time, result map[string]any, err error) {
	finished := time.Now()
	duration := finished.Sub(started).Milliseconds()
	if errors.Is(err, context.Canceled) {
		// Cancel can land inside any step; it is a finished run, not a failure.
		err, result = nil, map[string]any{"cancelled": true, "durationMs": duration}
	}
	j.mu.Lock()
	progress, _ := j.state["progress"].(map[string]any)
	delete(progress, "running")
	j.state["running"], j.state["progress"] = false, progress
	j.state["finishedAt"], j.state["durationMs"] = finished.UnixMilli(), duration
	event := map[string]any{}
	if err != nil {
		failures, _ := j.state["failures"].(int)
		j.state["stage"], j.state["error"], j.state["failures"] = "error", err.Error(), failures+1
		event["error"] = err.Error()
	} else {
		successes, _ := j.state["successes"].(int)
		j.state["stage"], j.state["error"], j.state["successes"] = "done", nil, successes+1
		j.state["result"] = result
		for k, v := range result {
			event[k] = v
		}
	}
	j.running, j.cancel = false, nil
	j.mu.Unlock()
	event["durationMs"], event["kind"] = duration, j.kind
	a.broadcastSeekbar(j.prefix+"_done", event)
}

func (a *App) broadcastSeekbar(kind string, payload map[string]any) {
	if a.hub != nil {
		a.hub.Broadcast(ws.Event{Type: kind, Flat: true, Payload: payload})
	}
}

// enqueueSeekbar is the post-download hook. It never blocks: the id is queued
// for the background drain, or dropped when the queue is full.
func (a *App) enqueueSeekbar(id int64, realtime bool) {
	s := a.seekbar
	if s == nil || id <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.queued[id] || s.inFlight[id] {
		return
	}
	queue := &s.backfill
	if realtime {
		queue = &s.realtime
	}
	if len(*queue) >= seekbarQueueCap {
		return
	}
	*queue = append(*queue, id)
	s.queued[id] = true
	if s.draining {
		return
	}
	done, ok := a.beginMaintenance()
	if !ok {
		s.clearQueuesLocked()
		return
	}
	s.draining = true
	go func() {
		defer done()
		a.drainSeekbarQueue()
	}()
}

func (s *seekbarState) clearQueuesLocked() {
	s.realtime, s.backfill = nil, nil
	clear(s.queued)
}

// next pops up to n ids, realtime first.
func (s *seekbarState) next(n int) []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var batch []int64
	for len(batch) < n && len(s.realtime)+len(s.backfill) > 0 {
		var id int64
		if len(s.realtime) > 0 {
			id, s.realtime = s.realtime[0], s.realtime[1:]
		} else {
			id, s.backfill = s.backfill[0], s.backfill[1:]
		}
		delete(s.queued, id)
		s.inFlight[id] = true
		batch = append(batch, id)
	}
	if len(batch) == 0 {
		s.draining = false
	}
	return batch
}

func (a *App) drainSeekbarQueue() {
	s := a.seekbar
	for {
		if a.ctx.Err() != nil {
			s.mu.Lock()
			s.clearQueuesLocked()
			s.draining = false
			s.mu.Unlock()
			return
		}
		set := a.seekbarSettings(a.ctx)
		if !set.enabled || !set.autoOnDownload || seekbar.FFmpegPath() == "" {
			// Turning the feature off stops new work at once; the next scan
			// reconciles anything dropped here.
			s.mu.Lock()
			s.clearQueuesLocked()
			s.draining = false
			s.mu.Unlock()
			return
		}
		batch := s.next(set.concurrency)
		if len(batch) == 0 {
			return
		}
		var wg sync.WaitGroup
		for _, id := range batch {
			wg.Add(1)
			go func(id int64) {
				defer wg.Done()
				defer func() {
					s.mu.Lock()
					delete(s.inFlight, id)
					s.mu.Unlock()
				}()
				out, err := a.generateSeekbar(a.ctx, id, set, "if-changed")
				switch {
				case err != nil:
					if a.ctx.Err() == nil {
						a.logSeekbar("seekbar sprite failed for download %d: %v", id, err)
					}
				case out.meta != nil:
					a.broadcastSeekbar("seekbar_sprite_ready", map[string]any{"download_id": id})
				}
			}(id)
		}
		wg.Wait()
	}
}
