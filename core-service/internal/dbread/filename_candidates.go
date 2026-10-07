package dbread

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type fileNameRequest struct {
	GroupID  string `json:"groupId"`
	FileName string `json:"fileName"`
	Size     *int64 `json:"size"`
}

type fileNameCandidate struct {
	ID       int64   `json:"id"`
	FilePath *string `json:"file_path"`
	FileSize *int64  `json:"file_size"`
}

type fileNameResponse struct {
	Rows []fileNameCandidate `json:"rows"`
}

// FileNameCandidates serves the legacy same-name/size dedup lookup. Node
// remains the writer; Go only reads candidates.
func (h *Handler) FileNameCandidates(w http.ResponseWriter, r *http.Request) {
	var req fileNameRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.GroupID == "" || req.FileName == "" || req.Size == nil || *req.Size <= 0 {
		hash.WriteJSON(w, http.StatusOK, fileNameResponse{Rows: []fileNameCandidate{}})
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var row fileNameCandidate
	var filePath sql.NullString
	var fileSize sql.NullInt64
	err = db.QueryRowContext(r.Context(), `
		SELECT id, file_path, file_size
		  FROM downloads
		 WHERE group_id = ? AND file_name = ? AND file_size = ?
		 ORDER BY id ASC
		 LIMIT 1`, req.GroupID, req.FileName, *req.Size).Scan(&row.ID, &filePath, &fileSize)
	if errors.Is(err, sql.ErrNoRows) {
		hash.WriteJSON(w, http.StatusOK, fileNameResponse{Rows: []fileNameCandidate{}})
		return
	}
	if err != nil {
		h.queryError(w, err, "database file name query failed")
		return
	}
	row.FilePath = nullableString(filePath)
	row.FileSize = nullableInt64(fileSize)
	hash.WriteJSON(w, http.StatusOK, fileNameResponse{Rows: []fileNameCandidate{row}})
}
