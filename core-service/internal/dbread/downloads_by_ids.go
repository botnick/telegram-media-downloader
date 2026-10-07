package dbread

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type downloadsByIDsRequest struct {
	IDs []int64 `json:"ids"`
}

type downloadsByIDsRow struct {
	ID        int64   `json:"id"`
	GroupID   *string `json:"group_id"`
	GroupName *string `json:"group_name"`
	FileName  *string `json:"file_name"`
	FileSize  *int64  `json:"file_size"`
	FileType  *string `json:"file_type"`
	FilePath  *string `json:"file_path"`
}

type downloadsByIDsResponse struct {
	Rows []downloadsByIDsRow `json:"rows"`
}

// DownloadsByIDs returns the small catalog projection used by bulk file
// operations. The Node process remains the only writer and still resolves
// paths and performs deletion/streaming; Go only removes the synchronous
// SQLite read from those async request paths.
func (h *Handler) DownloadsByIDs(w http.ResponseWriter, r *http.Request) {
	var req downloadsByIDsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if len(req.IDs) > 500 {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", "ids must contain at most 500 items")
		return
	}
	ids := make([]int64, 0, len(req.IDs))
	seen := make(map[int64]struct{}, len(req.IDs))
	for _, id := range req.IDs {
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	out := downloadsByIDsResponse{Rows: make([]downloadsByIDsRow, 0, len(ids))}
	if len(ids) == 0 {
		hash.WriteJSON(w, http.StatusOK, out)
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := db.QueryContext(r.Context(), fmt.Sprintf(`
		SELECT id, CAST(group_id AS TEXT), group_name, file_name, file_size,
		       file_type, file_path
		  FROM downloads
		 WHERE id IN (%s)
		 ORDER BY id ASC`, placeholders), args...)
	if err != nil {
		h.queryError(w, err, "database downloads by ids query failed")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var row downloadsByIDsRow
		var groupID, groupName, fileName, fileType, filePath sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(&row.ID, &groupID, &groupName, &fileName, &fileSize, &fileType, &filePath); err != nil {
			h.queryError(w, err, "database downloads by ids scan failed")
			return
		}
		row.GroupID = nullableString(groupID)
		row.GroupName = nullableString(groupName)
		row.FileName = nullableString(fileName)
		row.FileSize = nullableInt64(fileSize)
		row.FileType = nullableString(fileType)
		row.FilePath = nullableString(filePath)
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database downloads by ids read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
