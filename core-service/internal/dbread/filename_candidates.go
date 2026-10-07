package dbread

import (
	"database/sql"
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
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, file_path, file_size
		  FROM downloads
		 WHERE group_id = ? AND file_name = ? AND file_size = ?
		 ORDER BY id ASC
		 LIMIT 1`, req.GroupID, req.FileName, *req.Size)
	if err != nil {
		h.queryError(w, err, "database file name query failed")
		return
	}
	defer rows.Close()
	out := make([]fileNameCandidate, 0, 1)
	for rows.Next() {
		var row fileNameCandidate
		var filePath sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(&row.ID, &filePath, &fileSize); err != nil {
			h.queryError(w, err, "database file name scan failed")
			return
		}
		row.FilePath = nullableString(filePath)
		row.FileSize = nullableInt64(fileSize)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database file name read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, fileNameResponse{Rows: out})
}
