package dbread

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type aiCandidatesRequest struct {
	FileTypes []string `json:"fileTypes"`
	Limit     int      `json:"limit"`
}

type aiCandidateRow struct {
	ID        int64   `json:"id"`
	GroupID   *string `json:"group_id"`
	GroupName *string `json:"group_name"`
	FileName  *string `json:"file_name"`
	FilePath  *string `json:"file_path"`
	FileType  *string `json:"file_type"`
	FileSize  *int64  `json:"file_size"`
	CreatedAt *string `json:"created_at"`
}

type aiCandidatesResponse struct {
	Rows []aiCandidateRow `json:"rows"`
}

// AICandidates serves the bounded queue used by the face/AI indexer. Node
// remains the writer; this read-only projection keeps repeated backlog picks
// off the Node event loop while preserving the existing row shape.
func (h *Handler) AICandidates(w http.ResponseWriter, r *http.Request) {
	var req aiCandidatesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	types := make([]string, 0, len(req.FileTypes))
	for _, value := range req.FileTypes {
		value = strings.TrimSpace(value)
		if value != "" {
			types = append(types, value)
		}
	}
	if len(types) == 0 {
		types = []string{"photo"}
	}
	if len(types) > 32 {
		types = types[:32]
	}
	limit := req.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(types)), ",")
	args := make([]any, 0, len(types)+1)
	for _, value := range types {
		args = append(args, value)
	}
	args = append(args, limit)
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), fmt.Sprintf(`
		SELECT id, CAST(group_id AS TEXT), group_name, file_name, file_path,
		       file_type, file_size, CAST(created_at AS TEXT)
		  FROM downloads
		 WHERE file_type IN (%s)
		   AND ai_indexed_at IS NULL
		   AND file_path NOT LIKE '%%.part'
		 ORDER BY id ASC
		 LIMIT ?`, placeholders), args...)
	if err != nil {
		h.queryError(w, err, "database AI candidates query failed")
		return
	}
	defer rows.Close()
	out := aiCandidatesResponse{Rows: make([]aiCandidateRow, 0, limit)}
	for rows.Next() {
		var row aiCandidateRow
		var groupID, groupName, fileName, filePath, fileType, createdAt sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(
			&row.ID,
			&groupID,
			&groupName,
			&fileName,
			&filePath,
			&fileType,
			&fileSize,
			&createdAt,
		); err != nil {
			h.queryError(w, err, "database AI candidates scan failed")
			return
		}
		row.GroupID = nullableString(groupID)
		row.GroupName = nullableString(groupName)
		row.FileName = nullableString(fileName)
		row.FilePath = nullableString(filePath)
		row.FileType = nullableString(fileType)
		row.FileSize = nullableInt64(fileSize)
		row.CreatedAt = nullableString(createdAt)
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database AI candidates read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
