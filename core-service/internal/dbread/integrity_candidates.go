package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type integrityCandidatesRequest struct {
	BeforeID int64 `json:"beforeId"`
	Limit    int   `json:"limit"`
}

type integrityCandidateRow struct {
	ID       int64  `json:"id"`
	FilePath string `json:"file_path"`
	FileSize *int64 `json:"file_size"`
}

type integrityCandidatesResponse struct {
	Rows []integrityCandidateRow `json:"rows"`
}

// IntegrityCandidates serves keyset-paged local file rows for the integrity
// sweep. Node remains responsible for stat decisions and all writes.
func (h *Handler) IntegrityCandidates(w http.ResponseWriter, r *http.Request) {
	var req integrityCandidatesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 64
	}
	if limit > 2000 {
		limit = 2000
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
		SELECT id, file_path, file_size
		  FROM downloads
		 WHERE file_path IS NOT NULL
		   AND id < ?
		 ORDER BY id DESC
		 LIMIT ?`, before, limit)
	if err != nil {
		h.queryError(w, err, "database integrity candidates query failed")
		return
	}
	defer rows.Close()
	out := integrityCandidatesResponse{Rows: make([]integrityCandidateRow, 0, limit)}
	for rows.Next() {
		var row integrityCandidateRow
		var filePath sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(&row.ID, &filePath, &fileSize); err != nil {
			h.queryError(w, err, "database integrity candidates scan failed")
			return
		}
		if !filePath.Valid {
			continue
		}
		row.FilePath = filePath.String
		row.FileSize = nullableInt64(fileSize)
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database integrity candidates read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
