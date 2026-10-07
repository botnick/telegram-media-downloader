package dbread

import (
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type dedupStatsResponse struct {
	TotalFiles int64 `json:"totalFiles"`
	Hashed     int64 `json:"hashed"`
	Missing    int64 `json:"missing"`
}

// DedupStats serves POST /v1/db/dedup-stats. The aggregate mirrors the
// maintenance scanner's eligibility predicate while keeping repeated count
// scans off Node's event loop.
func (h *Handler) DedupStats(w http.ResponseWriter, r *http.Request) {
	if err := decodeEmptyBody(w, r); err != nil {
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var out dedupStatsResponse
	err = db.QueryRowContext(r.Context(), `
		SELECT COUNT(*),
		       COALESCE(SUM(CASE WHEN file_hash IS NOT NULL THEN 1 ELSE 0 END), 0),
		       COALESCE(SUM(CASE WHEN file_hash IS NULL
		                              AND file_path IS NOT NULL
		                              AND COALESCE(file_size, 0) > 0
		                         THEN 1 ELSE 0 END), 0)
		  FROM downloads
	`).Scan(&out.TotalFiles, &out.Hashed, &out.Missing)
	if err != nil {
		h.queryError(w, err, "database dedup stats query failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
