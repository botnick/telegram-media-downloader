package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type seekbarCandidatesRequest struct {
	BeforeID int64 `json:"beforeId"`
	Limit    int   `json:"limit"`
}

type seekbarCandidateRow struct {
	ID       int64   `json:"id"`
	FilePath *string `json:"file_path"`
	FileType *string `json:"file_type"`
	FileSize *int64  `json:"file_size"`
	FileName *string `json:"file_name"`
}

type seekbarCandidatesResponse struct {
	Rows []seekbarCandidateRow `json:"rows"`
}

// SeekbarCandidates serves the keyset-paged video backlog used by the
// maintenance sweep. Node remains the writer; Go only reads the candidates.
func (h *Handler) SeekbarCandidates(w http.ResponseWriter, r *http.Request) {
	var req seekbarCandidatesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 200
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
		SELECT d.id, d.file_path, d.file_type, d.file_size, d.file_name
		  FROM downloads d
		  LEFT JOIN seekbar_sprites s ON s.download_id = d.id
		 WHERE d.file_type = 'video'
		   AND d.file_path IS NOT NULL
		   AND s.download_id IS NULL
		   AND d.id < ?
		 ORDER BY d.id DESC
		 LIMIT ?`, before, limit)
	if err != nil {
		h.queryError(w, err, "database seekbar candidates query failed")
		return
	}
	defer rows.Close()
	out := seekbarCandidatesResponse{Rows: make([]seekbarCandidateRow, 0, limit)}
	for rows.Next() {
		var row seekbarCandidateRow
		var filePath, fileType, fileName sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(&row.ID, &filePath, &fileType, &fileSize, &fileName); err != nil {
			h.queryError(w, err, "database seekbar candidates scan failed")
			return
		}
		row.FilePath = nullableString(filePath)
		row.FileType = nullableString(fileType)
		row.FileSize = nullableInt64(fileSize)
		row.FileName = nullableString(fileName)
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database seekbar candidates read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
