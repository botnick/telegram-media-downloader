package hash

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
)

// MaxBatch is the maximum number of files accepted by one batch hash call.
// The limit keeps the request/response bounded while removing one HTTP round
// trip per row from large maintenance scans.
const MaxBatch = 256

const maxBatchBody = 2 << 20

type batchRequest struct {
	Paths []string `json:"paths"`
}

// BatchResult is deliberately per-file: a missing or out-of-root file must
// not discard successful hashes for the rest of the batch.
type BatchResult struct {
	SHA256  string  `json:"sha256,omitempty"`
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtimeMs"`
	Code    string  `json:"code,omitempty"`
	Message string  `json:"message,omitempty"`
}

// BatchHandler serves POST /v1/hash-batch. The shared Limiter bounds hashing
// across both single-file and batch requests, so a maintenance scan cannot
// starve realtime download-time hashes.
type BatchHandler struct {
	Limiter *Limiter
	Stats   *Stats
	Roots   *Roots
}

func batchError(err error) BatchResult {
	result := BatchResult{Code: "EIO"}
	var he *Error
	if errors.As(err, &he) {
		result.Code = he.Code
	}
	result.Message = err.Error()
	return result
}

func (h *BatchHandler) hashOne(ctx context.Context, raw string) BatchResult {
	resolved, err := h.Roots.Resolve(raw)
	if err != nil {
		return batchError(err)
	}
	if err := h.Limiter.Acquire(ctx); err != nil {
		if errors.Is(err, ErrQueueFull) {
			return BatchResult{Code: "EQUEUEFULL", Message: err.Error()}
		}
		return BatchResult{Code: "ECANCELED", Message: err.Error()}
	}
	result, err := File(ctx, resolved)
	h.Limiter.Release()
	if err != nil {
		if h.Stats != nil {
			h.Stats.Failed.Add(1)
		}
		return batchError(err)
	}
	if h.Stats != nil {
		h.Stats.Completed.Add(1)
		h.Stats.Bytes.Add(result.Size)
	}
	return BatchResult{SHA256: result.SHA256, Size: result.Size, MtimeMs: result.MtimeMs}
}

func (h *BatchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req batchRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBatchBody))
	if err := dec.Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"paths": ["/abs/path", ...]}`)
		return
	}
	if len(req.Paths) == 0 || len(req.Paths) > MaxBatch {
		WriteError(w, http.StatusBadRequest, "EINVAL", "paths must contain 1 to 256 files")
		return
	}

	results := make([]BatchResult, len(req.Paths))
	workers := len(req.Paths)
	if capacity := h.Limiter.Capacity(); capacity > 0 && capacity < workers {
		workers = capacity
	}
	// Keep one goroutine per hashing slot instead of one per input path. A
	// batch may contain 256 paths, while the limiter normally allows far
	// fewer files to hash at once; the old shape needlessly left the rest
	// parked in Acquire and amplified cancellation/queue pressure.
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i] = h.hashOne(r.Context(), req.Paths[i])
			}
		}()
	}
	for i := range req.Paths {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	WriteJSON(w, http.StatusOK, map[string]any{"results": results})
}
