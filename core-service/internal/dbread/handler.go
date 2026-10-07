// Package dbread contains small read-only SQLite projections used by the Go
// companion. Node remains the only writer; these handlers only answer hot-path
// aggregate reads from a query-only connection.
package dbread

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"

	_ "modernc.org/sqlite"
)

const maxBodyBytes = 16 << 10

var errUnavailable = errors.New("database is not available")

// Row is the stable JSON projection consumed by the Node dashboard.
type Row struct {
	GroupID  string  `json:"group_id"`
	BestName *string `json:"best_name"`
	AnyName  *string `json:"any_name"`
	Count    int64   `json:"count"`
	Size     *int64  `json:"size"`
}

// Handler serves POST /v1/db/group-aggregates.
type Handler struct {
	Path string
	Log  *slog.Logger

	mu       sync.Mutex
	db       *sql.DB
	lastErr  error
	failedAt time.Time
}

func NewHandler(path string, log *slog.Logger) *Handler {
	return &Handler{Path: strings.TrimSpace(path), Log: log}
}

func (h *Handler) open() (*sql.DB, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.db != nil {
		return h.db, nil
	}
	if h.Path == "" {
		return nil, errUnavailable
	}
	if h.lastErr != nil && time.Since(h.failedAt) < 5*time.Second {
		return nil, h.lastErr
	}
	if _, err := os.Stat(h.Path); err != nil {
		h.lastErr, h.failedAt = errUnavailable, time.Now()
		return nil, errUnavailable
	}
	db, err := sql.Open("sqlite", readOnlyDSN(h.Path))
	if err != nil {
		h.lastErr, h.failedAt = err, time.Now()
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxIdleTime(5 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	err = db.PingContext(ctx)
	cancel()
	if err != nil {
		_ = db.Close()
		h.lastErr, h.failedAt = err, time.Now()
		return nil, err
	}
	h.db, h.lastErr = db, nil
	return db, nil
}

// Close releases the read-only pool. It is primarily useful in tests and
// graceful shutdowns; database errors automatically discard the pool too.
func (h *Handler) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.db != nil {
		_ = h.db.Close()
	}
	h.db = nil
}

func readOnlyDSN(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	u := url.URL{Scheme: "file", Path: p}
	q := url.Values{}
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = q.Encode()
	return u.String()
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	var ignored map[string]any
	if err := dec.Decode(&ignored); err != nil {
		msg := "body must be JSON {}"
		if errors.Is(err, io.EOF) {
			msg = "empty body; expected JSON {}"
		}
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", msg)
		return
	}
	db, err := h.open()
	if err != nil {
		if h.Log != nil {
			h.Log.Debug("database aggregate unavailable", "path", h.Path, "err", err)
		}
		hash.WriteError(w, http.StatusServiceUnavailable, "EDBUNAVAILABLE", "database is not available")
		return
	}

	rows, err := db.QueryContext(r.Context(), `
		SELECT CAST(group_id AS TEXT),
		       MAX(CASE
		             WHEN group_name IS NOT NULL
		              AND group_name != ''
		              AND group_name != 'Unknown'
		              AND group_name != 'unknown'
		              AND group_name NOT GLOB '-?[0-9]*'
		              AND group_name NOT GLOB 'Group [0-9]*'
		           THEN group_name END) AS best_name,
		       MAX(group_name) AS any_name,
		       COUNT(*) AS count,
		       SUM(file_size) AS size
		  FROM downloads
		 GROUP BY group_id
	`)
	if err != nil {
		h.reset(err)
		if h.Log != nil {
			h.Log.Debug("database aggregate query failed", "err", err)
		}
		hash.WriteError(w, http.StatusInternalServerError, "EDB", "database aggregate query failed")
		return
	}
	defer rows.Close()
	out := make([]Row, 0, 64)
	for rows.Next() {
		var row Row
		var best, any sql.NullString
		var size sql.NullInt64
		if err := rows.Scan(&row.GroupID, &best, &any, &row.Count, &size); err != nil {
			h.reset(err)
			hash.WriteError(w, http.StatusInternalServerError, "EDB", "database aggregate scan failed")
			return
		}
		if best.Valid {
			v := best.String
			row.BestName = &v
		}
		if any.Valid {
			v := any.String
			row.AnyName = &v
		}
		if size.Valid {
			v := size.Int64
			row.Size = &v
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		h.reset(err)
		hash.WriteError(w, http.StatusInternalServerError, "EDB", "database aggregate read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, map[string]any{"rows": out})
}

func (h *Handler) reset(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.db != nil {
		_ = h.db.Close()
	}
	h.db = nil
	h.lastErr, h.failedAt = err, time.Now()
}
