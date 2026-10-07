package dbread

import (
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type faststartStatsResponse struct {
	Total int64 `json:"total"`
}

// FaststartStats serves the video catalog count used by the maintenance
// progress bar. Keeping the COUNT on the read-only Go pool prevents a large
// library from blocking Node's event loop before the sweep starts.
func (h *Handler) FaststartStats(w http.ResponseWriter, r *http.Request) {
	if err := decodeEmptyBody(w, r); err != nil {
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var out faststartStatsResponse
	if err := db.QueryRowContext(r.Context(), `
		SELECT COUNT(*)
		  FROM downloads
		 WHERE file_type = 'video' AND file_path IS NOT NULL`).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database faststart stats query failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
