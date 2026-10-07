package dbread

import (
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type seekbarStatsResponse struct {
	Count       int64 `json:"count"`
	Bytes       int64 `json:"bytes"`
	TotalVideos int64 `json:"totalVideos"`
}

// SeekbarStats serves the compact cache counters polled by the maintenance UI.
func (h *Handler) SeekbarStats(w http.ResponseWriter, r *http.Request) {
	if err := decodeEmptyBody(w, r); err != nil {
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var out seekbarStatsResponse
	err = db.QueryRowContext(r.Context(), `
		SELECT
			(SELECT COUNT(*) FROM seekbar_sprites),
			COALESCE((SELECT SUM(bytes) FROM seekbar_sprites), 0),
			(SELECT COUNT(*) FROM downloads
			  WHERE file_type = 'video' AND file_path IS NOT NULL)
	`).Scan(&out.Count, &out.Bytes, &out.TotalVideos)
	if err != nil {
		h.queryError(w, err, "database seekbar stats query failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
