package dbscan

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

// Request limits.
const (
	maxPoints  = 1 << 24 // points per request
	maxValues  = 1 << 28 // n*dim float32s (1 GiB of body)
	maxWaiting = 4       // requests queued behind the running one
)

// ErrQueueFull is returned when too many clusterings are already waiting.
var ErrQueueFull = errors.New("dbscan queue is full")

// Handler serves POST /v1/dbscan.
//
// Query:  n, dim (ints >= 0), eps (float), minPts (finite float),
//
//	weights=0|1
//
// Body:   n*dim float32 little-endian (row-major embeddings), followed by
//
//	n float64 little-endian quality weights when weights=1.
//
// Answer: 200 application/x-ndjson, one JSON object per line, flushed as
// written:
//
//	{"t":"progress","done":D,"n":N}      about once a second, plus (n, n) at the end
//	{"t":"result","count":C,"noiseCount":K,"starts":"…","members":"…","centroids":"…"}
//	{"t":"error","code":"EINTERNAL","message":"…"}   instead of a result
//
// starts / members are base64 of int32 little-endian arrays, centroids of
// float32 little-endian (count*dim), packed exactly like cluster-worker.js.
// Bad parameters or a body of the wrong size answer 400 EINVAL before any
// streaming; more than 4 requests waiting behind the running one, 503
// EQUEUEFULL. One clustering runs at a time.
type Handler struct {
	Log *slog.Logger
	// Workers is the goroutines per clustering; <= 0 means NumCPU-1 (min 1).
	Workers int

	once    sync.Once
	slot    chan struct{}
	waiting atomic.Int64
	// beforeCompute is a test hook run after the slot is taken.
	beforeCompute func()
}

type params struct {
	n, dim      int
	eps, minPts float64
	weights     bool
}

func (h *Handler) init() {
	h.once.Do(func() { h.slot = make(chan struct{}, 1) })
}

func (h *Handler) workers() int {
	if h.Workers > 0 {
		return h.Workers
	}
	if w := runtime.NumCPU() - 1; w > 1 {
		return w
	}
	return 1
}

func (h *Handler) acquire(ctx context.Context) error {
	select {
	case h.slot <- struct{}{}:
		return nil
	default:
	}
	if h.waiting.Add(1) > maxWaiting {
		h.waiting.Add(-1)
		return ErrQueueFull
	}
	defer h.waiting.Add(-1)
	select {
	case h.slot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Handler) release() { <-h.slot }

func parseParams(q url.Values) (params, error) {
	var p params
	var err error
	if p.n, err = strconv.Atoi(q.Get("n")); err != nil || p.n < 0 || p.n > maxPoints {
		return p, fmt.Errorf("n must be an integer in [0, %d]", maxPoints)
	}
	if p.dim, err = strconv.Atoi(q.Get("dim")); err != nil || p.dim < 0 || p.dim > maxValues {
		return p, fmt.Errorf("dim must be an integer in [0, %d]", maxValues)
	}
	if int64(p.n)*int64(p.dim) > maxValues {
		return p, fmt.Errorf("n*dim must be at most %d", maxValues)
	}
	if p.eps, err = strconv.ParseFloat(q.Get("eps"), 64); err != nil {
		return p, errors.New("eps must be a number")
	}
	if p.minPts, err = strconv.ParseFloat(q.Get("minPts"), 64); err != nil || math.IsNaN(p.minPts) || math.IsInf(p.minPts, 0) {
		return p, errors.New("minPts must be a finite number")
	}
	switch q.Get("weights") {
	case "", "0":
	case "1":
		p.weights = true
	default:
		return p, errors.New("weights must be 0 or 1")
	}
	return p, nil
}

// readBody decodes exactly n*dim float32s (and n float64 weights) from r,
// refusing a body that is shorter or longer.
func readBody(r io.Reader, p params) ([]float32, []float64, error) {
	data := make([]float32, p.n*p.dim)
	var weights []float64
	buf := make([]byte, 64<<10)
	for off := 0; off < len(data); {
		want := (len(data) - off) * 4
		if want > len(buf) {
			want = len(buf)
		}
		if _, err := io.ReadFull(r, buf[:want]); err != nil {
			return nil, nil, bodyError(err, p)
		}
		for i := 0; i < want; i += 4 {
			data[off] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i:]))
			off++
		}
	}
	if p.weights {
		weights = make([]float64, p.n)
		for off := 0; off < len(weights); {
			want := (len(weights) - off) * 8
			if want > len(buf) {
				want = len(buf)
			}
			if _, err := io.ReadFull(r, buf[:want]); err != nil {
				return nil, nil, bodyError(err, p)
			}
			for i := 0; i < want; i += 8 {
				weights[off] = math.Float64frombits(binary.LittleEndian.Uint64(buf[i:]))
				off++
			}
		}
	}
	var one [1]byte
	if k, _ := io.ReadFull(r, one[:]); k > 0 {
		return nil, nil, fmt.Errorf("body is longer than the %d bytes n=%d dim=%d weights=%v need", expectedSize(p), p.n, p.dim, p.weights)
	}
	return data, weights, nil
}

func expectedSize(p params) int64 {
	size := int64(p.n) * int64(p.dim) * 4
	if p.weights {
		size += int64(p.n) * 8
	}
	return size
}

func bodyError(err error, p params) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return fmt.Errorf("body is longer than the %d bytes n=%d dim=%d weights=%v need", expectedSize(p), p.n, p.dim, p.weights)
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("body is shorter than the %d bytes n=%d dim=%d weights=%v need", expectedSize(p), p.n, p.dim, p.weights)
	}
	return fmt.Errorf("reading body: %v", err)
}

type progressLine struct {
	T    string `json:"t"`
	Done int    `json:"done"`
	N    int    `json:"n"`
}

type resultLine struct {
	T          string `json:"t"`
	Count      int    `json:"count"`
	NoiseCount int    `json:"noiseCount"`
	Starts     string `json:"starts"`
	Members    string `json:"members"`
	Centroids  string `json:"centroids"`
}

type errorLine struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func int32sLE(v []int32) string {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[4*i:], uint32(x))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func float32sLE(v []float32) string {
	b := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(x))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.init()
	p, err := parseParams(r.URL.Query())
	if err != nil {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", err.Error())
		return
	}
	body := http.MaxBytesReader(w, r.Body, expectedSize(p)+1)
	data, weights, err := readBody(body, p)
	if err != nil {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", err.Error())
		return
	}

	// The body is fully read, so net/http has started its background read
	// with the read deadline cleared: a clustering that outlasts the
	// server's ReadTimeout keeps its context (see
	// TestHandlerOutlivesReadTimeout).
	rc := http.NewResponseController(w)
	ctx := r.Context()
	if err := h.acquire(ctx); err != nil {
		if errors.Is(err, ErrQueueFull) {
			hash.WriteError(w, http.StatusServiceUnavailable, "EQUEUEFULL", err.Error())
			return
		}
		hash.WriteError(w, 499, "ECANCELED", err.Error())
		return
	}
	defer h.release()
	if h.beforeCompute != nil {
		h.beforeCompute()
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	writeLine := func(v any) {
		b, err := json.Marshal(v)
		if err != nil {
			return
		}
		b = append(b, '\n')
		_, _ = w.Write(b)
		_ = rc.Flush()
	}

	started := time.Now()
	res, err := Cluster(ctx, data, p.n, p.dim, weights, p.eps, p.minPts, h.workers(), func(done, n int) {
		writeLine(progressLine{T: "progress", Done: done, N: n})
	})
	if err != nil {
		if ctx.Err() != nil {
			return // caller gave up; nobody reads the rest
		}
		writeLine(errorLine{T: "error", Code: "EINTERNAL", Message: err.Error()})
		return
	}
	writeLine(resultLine{
		T:          "result",
		Count:      res.Count,
		NoiseCount: res.NoiseCount,
		Starts:     int32sLE(res.Starts),
		Members:    int32sLE(res.Members),
		Centroids:  float32sLE(res.Centroids),
	})
	if h.Log != nil {
		h.Log.Debug("dbscan done", "n", p.n, "dim", p.dim, "clusters", res.Count, "noise", res.NoiseCount, "ms", time.Since(started).Milliseconds())
	}
}
