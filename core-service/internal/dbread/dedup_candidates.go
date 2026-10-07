package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type dedupCandidatesRequest struct {
	BeforeID int64 `json:"beforeId"`
	Limit    int   `json:"limit"`
}

type dedupCandidateRow struct {
	ID       int64  `json:"id"`
	FilePath string `json:"file_path"`
	FileSize int64  `json:"file_size"`
}

type dedupCandidatesResponse struct {
	Rows []dedupCandidateRow `json:"rows"`
}

// DedupCandidates serves the bounded catch-up hashing queue. Node remains the
// writer and owns path resolution, hashing orchestration and progress state.
func (h *Handler) DedupCandidates(w http.ResponseWriter, r *http.Request) {
	var req dedupCandidatesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
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
		 WHERE file_hash IS NULL
		   AND file_path IS NOT NULL
		   AND COALESCE(file_size, 0) > 0
		   AND id < ?
		 ORDER BY id DESC
		 LIMIT ?`, before, limit)
	if err != nil {
		h.queryError(w, err, "database dedup candidates query failed")
		return
	}
	defer rows.Close()
	out := dedupCandidatesResponse{Rows: make([]dedupCandidateRow, 0, limit)}
	for rows.Next() {
		var row dedupCandidateRow
		var filePath sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(&row.ID, &filePath, &fileSize); err != nil {
			h.queryError(w, err, "database dedup candidates scan failed")
			return
		}
		if !filePath.Valid || !fileSize.Valid || fileSize.Int64 <= 0 {
			continue
		}
		row.FilePath = filePath.String
		row.FileSize = fileSize.Int64
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database dedup candidates read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
