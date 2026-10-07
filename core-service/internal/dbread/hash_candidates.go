package dbread

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type fileHashRequest struct {
	Hash string `json:"hash"`
	Size *int64 `json:"size"`
}

type fileHashCandidate struct {
	ID       int64   `json:"id"`
	FilePath *string `json:"file_path"`
	FileSize *int64  `json:"file_size"`
}

type fileHashResponse struct {
	Rows []fileHashCandidate `json:"rows"`
}

// FileHashCandidates serves the bounded content-dedup lookup used after a
// download is hashed. Node remains the writer; Go only reads candidates.
func (h *Handler) FileHashCandidates(w http.ResponseWriter, r *http.Request) {
	var req fileHashRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.Hash == "" || req.Size == nil || *req.Size <= 0 {
		hash.WriteJSON(w, http.StatusOK, fileHashResponse{Rows: []fileHashCandidate{}})
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var row fileHashCandidate
	var filePath sql.NullString
	var fileSize sql.NullInt64
	err = db.QueryRowContext(r.Context(), `
		SELECT id, file_path, file_size
		  FROM downloads
		 WHERE file_hash = ? AND file_size = ? AND file_path IS NOT NULL
		 ORDER BY id ASC
		 LIMIT 1`, req.Hash, *req.Size).Scan(&row.ID, &filePath, &fileSize)
	if errors.Is(err, sql.ErrNoRows) {
		hash.WriteJSON(w, http.StatusOK, fileHashResponse{Rows: []fileHashCandidate{}})
		return
	}
	if err != nil {
		h.queryError(w, err, "database file hash query failed")
		return
	}
	row.FilePath = nullableString(filePath)
	row.FileSize = nullableInt64(fileSize)
	hash.WriteJSON(w, http.StatusOK, fileHashResponse{Rows: []fileHashCandidate{row}})
}
