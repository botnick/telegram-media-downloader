// Package jobs provides bounded, restart-safe job state primitives. A caller
// owns durable persistence; this package guarantees single-flight execution,
// cancellation, progress snapshots and terminal completion signalling.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

var ErrAlreadyRunning = errors.New("job is already running")
var ErrNotFound = errors.New("job not found")

type Snapshot struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Total  int    `json:"total"`
	Done   int    `json:"done"`
	Stage  string `json:"stage"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type Job struct {
	ID   string
	Done chan struct{}

	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.RWMutex
	snap   Snapshot
	err    error
}

func (j *Job) Err() error {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.err
}

func (j *Job) Snapshot() Snapshot {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.snap
}

type Tracker struct {
	mu       sync.RWMutex
	jobs     map[string]*Job
	byKind   map[string]string
	sequence atomic.Uint64
}

func NewTracker() *Tracker {
	return &Tracker{jobs: make(map[string]*Job), byKind: make(map[string]string)}
}

func (t *Tracker) Start(parent context.Context, kind string, total int, run func(context.Context, func(int, string)) error) (*Job, error) {
	if kind == "" || run == nil {
		return nil, errors.New("job kind and function are required")
	}
	t.mu.Lock()
	if existingID := t.byKind[kind]; existingID != "" {
		if existing := t.jobs[existingID]; existing != nil {
			t.mu.Unlock()
			return nil, ErrAlreadyRunning
		}
		delete(t.byKind, kind)
	}
	ctx, cancel := context.WithCancel(parent)
	id := fmt.Sprintf("%s-%d", kind, t.sequence.Add(1))
	job := &Job{ID: id, Done: make(chan struct{}), ctx: ctx, cancel: cancel, snap: Snapshot{ID: id, Kind: kind, Total: total, Status: "running", Stage: "queued"}}
	t.jobs[id] = job
	t.byKind[kind] = id
	t.mu.Unlock()
	go func() {
		update := func(done int, stage string) {
			job.mu.Lock()
			if done >= 0 {
				job.snap.Done = done
			}
			if stage != "" {
				job.snap.Stage = stage
			}
			job.mu.Unlock()
		}
		err := run(ctx, update)
		job.mu.Lock()
		job.err = err
		if err == nil {
			job.snap.Status = "completed"
			job.snap.Done = job.snap.Total
		} else if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			job.snap.Status = "cancelled"
			job.snap.Error = context.Canceled.Error()
		} else {
			job.snap.Status = "failed"
			job.snap.Error = err.Error()
		}
		job.mu.Unlock()
		cancel()
		t.mu.Lock()
		delete(t.jobs, id)
		if t.byKind[kind] == id {
			delete(t.byKind, kind)
		}
		t.mu.Unlock()
		close(job.Done)
	}()
	return job, nil
}

func (t *Tracker) Cancel(id string) error {
	t.mu.RLock()
	job := t.jobs[id]
	t.mu.RUnlock()
	if job == nil {
		return ErrNotFound
	}
	job.cancel()
	return nil
}

func (t *Tracker) Get(id string) (Snapshot, bool) {
	t.mu.RLock()
	job := t.jobs[id]
	t.mu.RUnlock()
	if job == nil {
		return Snapshot{}, false
	}
	return job.Snapshot(), true
}

func (t *Tracker) List() []Snapshot {
	t.mu.RLock()
	jobs := make([]*Job, 0, len(t.jobs))
	for _, job := range t.jobs {
		jobs = append(jobs, job)
	}
	t.mu.RUnlock()
	out := make([]Snapshot, 0, len(jobs))
	for _, job := range jobs {
		out = append(out, job.Snapshot())
	}
	return out
}
