package fsx

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

// MaxBatch is the most paths one stat-batch request may carry.
const MaxBatch = 1000

const (
	maxStatBody = 16 << 20
	maxWalkBody = 64 << 10
	// StatParallel is how many stats one request runs at once.
	StatParallel = 16
)

// Stats are counters for GET /v1/stats.
type Stats struct {
	StatCalls atomic.Int64
	StatPaths atomic.Int64
	Walks     atomic.Int64
	WalkFiles atomic.Int64
}

// StatBatchHandler serves POST /v1/fs/stat-batch:
//
//	{"paths": ["/abs/a", ...]}  (at most MaxBatch)
//	-> {"results": [{"ok":true,"size":N,"mtimeMs":F,"isFile":B,"isDir":B} | {"code":"ENOENT"}, ...]}
//
// Results are in request order; codes are Node's (libuv's) for the same
// fs.stat, plus EOUTSIDE for a path outside the allowed roots and
// ERR_INVALID_ARG_VALUE / EINVAL for a path fs.stat itself would reject.
type StatBatchHandler struct {
	Roots *hash.Roots
	Stats *Stats
	Log   *slog.Logger

	once sync.Once
	dirs *DirCache
}

func (h *StatBatchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths []string `json:"paths"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxStatBody))
	if err := dec.Decode(&req); err != nil {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"paths": ["/abs/path", ...]}`)
		return
	}
	if len(req.Paths) > MaxBatch {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", "at most "+strconv.Itoa(MaxBatch)+" paths per request")
		return
	}
	h.once.Do(func() { h.dirs = NewDirCache(DirCacheTTL) })
	res, err := StatBatch(r.Context(), h.Roots, req.Paths, StatParallel, h.dirs)
	if err != nil {
		hash.WriteError(w, hash.StatusFor("ECANCELED"), "ECANCELED", err.Error())
		return
	}
	if h.Stats != nil {
		h.Stats.StatCalls.Add(1)
		h.Stats.StatPaths.Add(int64(len(req.Paths)))
	}
	hash.WriteJSON(w, http.StatusOK, map[string]any{"results": res})
}

// WalkHandler serves POST /v1/fs/walk:
//
//	{"root": "/abs/dir", "maxDepth": 0, "stat": "none|files|nondir", "entries": true}
//
// and streams NDJSON (application/x-ndjson), one object per line:
//
//	{"t":"d","p":"a/b"}                                   directory entry
//	{"t":"f","p":"a/b/c.jpg","k":"file"[, stat or "code"]}  any other entry
//	{"t":"e","p":"a/b","code":"EACCES"}                   directory that could not be listed
//	{"t":"end","dirs":N,"files":N,"errors":N,"stated":N,"bytes":N,"outside":["a/link", ...]}
//
// "p" is relative to the root with "/" separators; the order is the
// order a recursive fs.readdir walk sees. "entries": false sends only
// the "end" line (disk usage). A stream without an "end" line was cut off.
type WalkHandler struct {
	Roots *hash.Roots
	Stats *Stats
	Log   *slog.Logger
}

type walkRequest struct {
	Root     string `json:"root"`
	MaxDepth int    `json:"maxDepth"`
	Stat     string `json:"stat"`
	Entries  *bool  `json:"entries"`
}

func (h *WalkHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req walkRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWalkBody))
	if err := dec.Decode(&req); err != nil || req.MaxDepth < 0 {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", `body must be JSON {"root": "/abs/dir", "maxDepth": 0, "stat": "none"}`)
		return
	}
	entries := req.Entries == nil || *req.Entries

	var bw *bufio.Writer
	started := false
	start := func() {
		if started {
			return
		}
		started = true
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		bw = bufio.NewWriterSize(w, 64<<10)
	}
	var files int64
	emit := func(ev Event) error {
		if ev.T == "f" {
			files++
		}
		if !entries {
			return nil
		}
		start()
		_, err := bw.Write(appendEvent(nil, ev))
		return err
	}
	opts := WalkOptions{MaxDepth: req.MaxDepth, Stat: req.Stat, Parallel: 8}
	sum, err := Walk(r.Context(), h.Roots, req.Root, opts, emit)
	if h.Stats != nil {
		h.Stats.Walks.Add(1)
		h.Stats.WalkFiles.Add(files)
	}
	if err != nil {
		var he *hash.Error
		if !started && errors.As(err, &he) {
			hash.WriteError(w, hash.StatusFor(he.Code), he.Code, he.Error())
			return
		}
		// Cancelled or the client went away: stop without an "end" line.
		if h.Log != nil && !errors.Is(err, io.ErrClosedPipe) {
			h.Log.Debug("walk stopped", "err", err)
		}
		if started {
			_ = bw.Flush()
		}
		return
	}
	start()
	_, _ = bw.Write(appendSummary(nil, sum))
	_ = bw.Flush()
}

func appendString(b []byte, s string) []byte {
	q, _ := json.Marshal(s)
	return append(b, q...)
}

func appendEvent(b []byte, ev Event) []byte {
	b = append(b, `{"t":`...)
	b = appendString(b, ev.T)
	b = append(b, `,"p":`...)
	b = appendString(b, ev.P)
	if ev.T == "f" {
		b = append(b, `,"k":`...)
		b = appendString(b, ev.Kind)
	}
	if ev.Code != "" {
		b = append(b, `,"code":`...)
		b = appendString(b, ev.Code)
	} else if ev.Stated {
		b = append(b, `,"ok":true,"size":`...)
		b = strconv.AppendInt(b, ev.Stat.Size, 10)
		b = append(b, `,"mtimeMs":`...)
		mt, _ := json.Marshal(ev.Stat.MtimeMs)
		b = append(b, mt...)
		b = append(b, `,"isFile":`...)
		b = strconv.AppendBool(b, ev.Stat.IsFile)
		b = append(b, `,"isDir":`...)
		b = strconv.AppendBool(b, ev.Stat.IsDir)
	}
	return append(b, "}\n"...)
}

func appendSummary(b []byte, s Summary) []byte {
	out := s.Outside
	if out == nil {
		out = []string{}
	}
	line, _ := json.Marshal(map[string]any{
		"t":       "end",
		"dirs":    s.Dirs,
		"files":   s.Files,
		"errors":  s.Errors,
		"stated":  s.Stated,
		"bytes":   s.Bytes,
		"outside": out,
	})
	return append(append(b, line...), '\n')
}
