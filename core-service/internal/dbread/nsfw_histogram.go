package dbread

import (
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type nsfwHistogramRequest struct {
	FileTypes []string `json:"fileTypes"`
	Bins      int      `json:"bins"`
}

type nsfwHistogramResponse struct {
	Bins   int     `json:"bins"`
	Counts []int64 `json:"counts"`
}

// NsfwHistogram serves POST /v1/db/nsfw-histogram for the review chart.
func (h *Handler) NsfwHistogram(w http.ResponseWriter, r *http.Request) {
	var req nsfwHistogramRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	types := req.FileTypes
	if len(types) == 0 {
		types = []string{"photo"}
	}
	n := req.Bins
	if n == 0 {
		n = 20
	} else if n < 4 {
		n = 4
	} else if n > 50 {
		n = 50
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(types)), ",")
	args := make([]any, 0, len(types)+4)
	args = append(args, n, n, n, n)
	for _, typ := range types {
		args = append(args, typ)
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT CASE WHEN CAST(nsfw_score * ? AS INTEGER) >= ?
		            THEN ? - 1
		            ELSE CAST(nsfw_score * ? AS INTEGER)
		       END AS bin,
		       COUNT(*) AS n
		  FROM downloads
		 WHERE file_type IN (`+placeholders+`)
		   AND nsfw_score IS NOT NULL
		 GROUP BY bin
	`, args...)
	if err != nil {
		h.queryError(w, err, "database nsfw histogram query failed")
		return
	}
	defer rows.Close()
	counts := make([]int64, n)
	for rows.Next() {
		var bin, count int64
		if err := rows.Scan(&bin, &count); err != nil {
			h.queryError(w, err, "database nsfw histogram scan failed")
			return
		}
		if bin < 0 {
			bin = 0
		}
		if bin >= int64(n) {
			bin = int64(n - 1)
		}
		counts[bin] = count
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database nsfw histogram read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, nsfwHistogramResponse{Bins: n, Counts: counts})
}
