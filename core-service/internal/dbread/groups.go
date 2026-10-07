package dbread

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type groupStatsResponse struct {
	TotalFiles     int64            `json:"totalFiles"`
	TotalBytes     int64            `json:"totalBytes"`
	ByType         map[string]int64 `json:"byType"`
	FirstMessageID *int64           `json:"firstMessageId"`
	LastMessageID  *int64           `json:"lastMessageId"`
	LastDownloadAt *string          `json:"lastDownloadAt"`
}

type groupRequest struct {
	GroupID string `json:"groupId"`
}

// GroupStats serves POST /v1/db/group-stats.
func (h *Handler) GroupStats(w http.ResponseWriter, r *http.Request) {
	var req groupRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", "groupId is required")
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var total groupStatsResponse
	var first, last sql.NullInt64
	var at sql.NullString
	err = db.QueryRowContext(r.Context(), `
		SELECT COUNT(*),
		       COALESCE(SUM(COALESCE(file_size, 0)), 0),
		       MIN(message_id), MAX(message_id), MAX(CAST(created_at AS TEXT))
		  FROM downloads
		 WHERE group_id = ?
	`, groupID).Scan(&total.TotalFiles, &total.TotalBytes, &first, &last, &at)
	if err != nil {
		h.queryError(w, err, "database group stats query failed")
		return
	}
	if first.Valid {
		v := first.Int64
		total.FirstMessageID = &v
	}
	if last.Valid {
		v := last.Int64
		total.LastMessageID = &v
	}
	if at.Valid {
		v := at.String
		total.LastDownloadAt = &v
	}
	total.ByType = make(map[string]int64)
	rows, err := db.QueryContext(r.Context(), `
		SELECT file_type, COUNT(*)
		  FROM downloads
		 WHERE group_id = ?
		 GROUP BY file_type
	`, groupID)
	if err != nil {
		h.queryError(w, err, "database group type stats query failed")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var kind sql.NullString
		var count int64
		if err := rows.Scan(&kind, &count); err != nil {
			h.queryError(w, err, "database group type stats scan failed")
			return
		}
		key := "other"
		if kind.Valid && kind.String != "" {
			key = kind.String
		}
		total.ByType[key] = count
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database group type stats read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, total)
}

type groupFilesRequest struct {
	GroupID string `json:"groupId"`
	Limit   int    `json:"limit"`
	Offset  int    `json:"offset"`
	Type    string `json:"type"`
}

type groupFileRow struct {
	ID        int64    `json:"id"`
	MessageID int64    `json:"message_id"`
	FileName  *string  `json:"file_name"`
	FilePath  *string  `json:"file_path"`
	FileType  *string  `json:"file_type"`
	FileSize  *int64   `json:"file_size"`
	CreatedAt *string  `json:"created_at"`
	NSFWScore *float64 `json:"nsfw_score"`
}

type groupFilesResponse struct {
	Rows    []groupFileRow `json:"rows"`
	Total   int64          `json:"total"`
	Limit   int            `json:"limit"`
	Offset  int            `json:"offset"`
	HasMore bool           `json:"hasMore"`
}

// GroupFiles serves POST /v1/db/group-files.
func (h *Handler) GroupFiles(w http.ResponseWriter, r *http.Request) {
	var req groupFilesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", "groupId is required")
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 50
	} else if limit < 1 {
		limit = 1
	}
	if limit > 500 {
		limit = 500
	}
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	where := "group_id = ?"
	args := []any{groupID}
	if req.Type != "" {
		where += " AND file_type = ?"
		args = append(args, req.Type)
	}
	var out groupFilesResponse
	out.Limit, out.Offset = limit, offset
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads WHERE "+where, args...).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database group files count failed")
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, message_id, file_name, file_path, file_type, file_size,
		       CAST(created_at AS TEXT), nsfw_score
		  FROM downloads
		 WHERE `+where+`
		 ORDER BY created_at DESC, id DESC
		 LIMIT ? OFFSET ?
	`, append(args, limit, offset)...)
	if err != nil {
		h.queryError(w, err, "database group files query failed")
		return
	}
	defer rows.Close()
	out.Rows = make([]groupFileRow, 0, limit)
	for rows.Next() {
		var row groupFileRow
		var name, filePath, kind, created sql.NullString
		var size sql.NullInt64
		var score sql.NullFloat64
		if err := rows.Scan(&row.ID, &row.MessageID, &name, &filePath, &kind, &size, &created, &score); err != nil {
			h.queryError(w, err, "database group files scan failed")
			return
		}
		if name.Valid {
			v := name.String
			row.FileName = &v
		}
		if filePath.Valid {
			v := filePath.String
			row.FilePath = &v
		}
		if kind.Valid {
			v := kind.String
			row.FileType = &v
		}
		if size.Valid {
			v := size.Int64
			row.FileSize = &v
		}
		if created.Valid {
			v := created.String
			row.CreatedAt = &v
		}
		if score.Valid {
			v := score.Float64
			row.NSFWScore = &v
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database group files read failed")
		return
	}
	out.HasMore = offset+len(out.Rows) < int(out.Total)
	hash.WriteJSON(w, http.StatusOK, out)
}
