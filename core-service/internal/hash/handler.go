package hash

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync/atomic"
)

// maxBodyBytes bounds the JSON request body ({"path": "..."}).
const maxBodyBytes = 64 << 10

// ErrQueueFull is returned by Limiter.Acquire when too many requests
// are already waiting for a slot.
var ErrQueueFull = errors.New("hash queue is full")

// Limiter bounds how many files are hashed at once (HASH_WORKER_POOL_SIZE
// semantics) and how many requests may wait for a slot.
type Limiter struct {
	slots      chan struct{}
	waiting    atomic.Int64
	maxWaiting int64
}

// NewLimiter allows `concurrency` hashes at once and `maxWaiting` queued.
func NewLimiter(concurrency, maxWaiting int) *Limiter {
	if concurrency < 1 {
		concurrency = 1
	}
	return &Limiter{slots: make(chan struct{}, concurrency), maxWaiting: int64(maxWaiting)}
}

// Capacity is the number of concurrent slots.
func (l *Limiter) Capacity() int { return cap(l.slots) }

// InFlight is the number of slots currently held.
func (l *Limiter) InFlight() int { return len(l.slots) }

// Waiting is the number of callers blocked in Acquire.
func (l *Limiter) Waiting() int64 { return l.waiting.Load() }

// Acquire blocks until a slot is free, ctx is done, or the queue is full.
func (l *Limiter) Acquire(ctx context.Context) error {
	select {
	case l.slots <- struct{}{}:
		return nil
	default:
	}
	if l.waiting.Add(1) > l.maxWaiting {
		l.waiting.Add(-1)
		return ErrQueueFull
	}
	defer l.waiting.Add(-1)
	select {
	case l.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Release frees a slot taken by Acquire.
func (l *Limiter) Release() { <-l.slots }

// Stats are counters exposed on GET /v1/stats.
type Stats struct {
	Completed atomic.Int64
	Failed    atomic.Int64
	Bytes     atomic.Int64
}

// Handler serves POST /v1/hash.
type Handler struct {
	Limiter *Limiter
	Stats   *Stats
	Log     *slog.Logger
}

type request struct {
	Path string `json:"path"`
}

// ErrorBody is the JSON shape of every error response.
type ErrorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// WriteError writes {"error":{"code","message"}} with the given status.
func WriteError(w http.ResponseWriter, status int, code, msg string) {
	var body ErrorBody
	body.Error.Code = code
	body.Error.Message = msg
	WriteJSON(w, status, body)
}

// WriteJSON writes v as a JSON response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// StatusFor maps an error code to the HTTP status of the response:
// 422 for anything about the file itself, so callers can tell "this file
// can't be hashed" apart from "the service is broken".
func StatusFor(code string) int {
	switch code {
	case "EINVAL":
		return http.StatusBadRequest
	case "ECANCELED":
		return 499 // client closed request; nobody reads it
	case "EQUEUEFULL":
		return http.StatusServiceUnavailable
	}
	return http.StatusUnprocessableEntity
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req request
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := dec.Decode(&req); err != nil {
		msg := "body must be JSON {\"path\": \"/abs/path\"}"
		if errors.Is(err, io.EOF) {
			msg = "empty body; expected {\"path\": \"/abs/path\"}"
		}
		WriteError(w, http.StatusBadRequest, "EINVAL", msg)
		return
	}

	ctx := r.Context()
	if err := h.Limiter.Acquire(ctx); err != nil {
		if errors.Is(err, ErrQueueFull) {
			WriteError(w, http.StatusServiceUnavailable, "EQUEUEFULL", err.Error())
			return
		}
		WriteError(w, StatusFor("ECANCELED"), "ECANCELED", err.Error())
		return
	}
	res, err := File(ctx, req.Path)
	h.Limiter.Release()

	if err != nil {
		h.Stats.Failed.Add(1)
		code := "EIO"
		var he *Error
		if errors.As(err, &he) {
			code = he.Code
		}
		if code != "ECANCELED" && h.Log != nil {
			h.Log.Debug("hash failed", "code", code, "err", err)
		}
		WriteError(w, StatusFor(code), code, err.Error())
		return
	}
	h.Stats.Completed.Add(1)
	h.Stats.Bytes.Add(res.Size)
	WriteJSON(w, http.StatusOK, res)
}
