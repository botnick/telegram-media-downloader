package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type faststartCandidatesRequest struct {
	BeforeID int64 `json:"beforeId"`
	Limit    int   `json:"limit"`
}

type faststartCandidateRow struct {
	ID       int64  `json:"id"`
	FilePath string `json:"file_path"`
}

type faststartCandidatesResponse struct {
	Rows []faststartCandidateRow `json:"rows"`
}

// FaststartCandidates serves the keyset-paged video catalog used by the
// maintenance sweep. Node remains the writer and owns media inspection.
func (h *Handler) FaststartCandidates(w http.ResponseWriter, r *http.Request) {
	var req faststartCandidatesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	before := req.BeforeID
	if before <= 0 {
		before = int64(^uint64(0) >> 1)
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, file_path
		  FROM downloads
		 WHERE file_type = 'video'
		   AND file_path IS NOT NULL
		   AND id < ?
		 ORDER BY id DESC
		 LIMIT ?`, before, limit)
	if err != nil {
		h.queryError(w, err, "database faststart candidates query failed")
		return
	}
	defer rows.Close()
	out := faststartCandidatesResponse{Rows: make([]faststartCandidateRow, 0, limit)}
	for rows.Next() {
		var row faststartCandidateRow
		var filePath sql.NullString
		if err := rows.Scan(&row.ID, &filePath); err != nil {
			h.queryError(w, err, "database faststart candidates scan failed")
			return
		}
		if !filePath.Valid {
			continue
		}
		row.FilePath = filePath.String
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database faststart candidates read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
