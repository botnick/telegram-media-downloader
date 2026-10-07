package dbread

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type dedupFilesRequest struct {
	Hashes []string `json:"hashes"`
}

type dedupFileRow struct {
	Hash      string  `json:"hash"`
	ID        int64   `json:"id"`
	GroupID   *string `json:"group_id"`
	GroupName *string `json:"group_name"`
	FileName  *string `json:"file_name"`
	FilePath  *string `json:"file_path"`
	FileSize  *int64  `json:"file_size"`
	FileType  *string `json:"file_type"`
	CreatedAt *string `json:"created_at"`
}

type dedupFilesResponse struct {
	Rows []dedupFileRow `json:"rows"`
}

// DedupFiles returns rows for a bounded batch of hashes. Batching keeps the
// large duplicate detail pass off Node's synchronous SQLite connection while
// avoiding one HTTP round trip per hash.
func (h *Handler) DedupFiles(w http.ResponseWriter, r *http.Request) {
	var req dedupFilesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	hashes := make([]string, 0, len(req.Hashes))
	seen := make(map[string]struct{}, len(req.Hashes))
	for _, value := range req.Hashes {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		hashes = append(hashes, value)
		if len(hashes) == 500 {
			break
		}
	}
	out := dedupFilesResponse{Rows: make([]dedupFileRow, 0)}
	if len(hashes) == 0 {
		hash.WriteJSON(w, http.StatusOK, out)
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(hashes)), ",")
	args := make([]any, len(hashes))
	for i, value := range hashes {
		args[i] = value
	}
	rows, err := db.QueryContext(r.Context(), fmt.Sprintf(`
		SELECT file_hash, id, group_id, group_name, file_name, file_path,
		       file_size, file_type, CAST(created_at AS TEXT)
		  FROM downloads
		 WHERE file_hash IN (%s)
		 ORDER BY file_hash ASC, created_at ASC, id ASC`, placeholders), args...)
	if err != nil {
		h.queryError(w, err, "database dedup files query failed")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var row dedupFileRow
		var groupID, groupName, fileName, filePath, fileType, createdAt sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(
			&row.Hash,
			&row.ID,
			&groupID,
			&groupName,
			&fileName,
			&filePath,
			&fileSize,
			&fileType,
			&createdAt,
		); err != nil {
			h.queryError(w, err, "database dedup files scan failed")
			return
		}
		row.GroupID = nullableString(groupID)
		row.GroupName = nullableString(groupName)
		row.FileName = nullableString(fileName)
		row.FilePath = nullableString(filePath)
		row.FileSize = nullableInt64(fileSize)
		row.FileType = nullableString(fileType)
		row.CreatedAt = nullableString(createdAt)
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database dedup files read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
