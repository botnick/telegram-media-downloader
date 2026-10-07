package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type downloadsGroupRequest struct {
	GroupID     string `json:"groupId"`
	Limit       int    `json:"limit"`
	Offset      int    `json:"offset"`
	Type        string `json:"type"`
	PinnedOnly  bool   `json:"pinnedOnly"`
	PinnedFirst bool   `json:"pinnedFirst"`
}

type downloadsGroupRow struct {
	ID           int64    `json:"id"`
	GroupID      string   `json:"group_id"`
	GroupName    *string  `json:"group_name"`
	FileName     *string  `json:"file_name"`
	FilePath     *string  `json:"file_path"`
	FileSize     *int64   `json:"file_size"`
	FileType     *string  `json:"file_type"`
	CreatedAt    *string  `json:"created_at"`
	PendingUntil *int64   `json:"pending_until"`
	RescuedAt    *int64   `json:"rescued_at"`
	Pinned       int64    `json:"pinned"`
	DurationSec  *float64 `json:"duration_sec"`
}

type downloadsGroupResponse struct {
	Files []downloadsGroupRow `json:"files"`
	Total int64               `json:"total"`
}

// DownloadsGroup serves POST /v1/db/downloads/group for the local gallery
// scope. Federation stays in the Node query path.
func (h *Handler) DownloadsGroup(w http.ResponseWriter, r *http.Request) {
	var req downloadsGroupRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.GroupID == "" {
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
	where := "d.group_id = ?"
	args := []any{req.GroupID}
	typeMap := map[string]string{
		"images": "photo", "videos": "video", "documents": "document", "audio": "audio",
	}
	if req.Type != "" && req.Type != "all" {
		if mapped, ok := typeMap[req.Type]; ok {
			where += " AND d.file_type = ?"
			args = append(args, mapped)
		}
	}
	if req.PinnedOnly {
		where += " AND d.pinned = 1"
	}
	orderBy := "d.created_at DESC, d.id DESC"
	if req.PinnedFirst {
		orderBy = "d.pinned DESC, d.created_at DESC, d.id DESC"
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var out downloadsGroupResponse
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads d WHERE "+where, args...).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database group downloads count failed")
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT d.id, CAST(d.group_id AS TEXT), d.group_name, d.file_name, d.file_path,
		       d.file_size, d.file_type, CAST(d.created_at AS TEXT), d.pending_until,
		       d.rescued_at, d.pinned, sb.duration_sec
		  FROM downloads d
		  LEFT JOIN seekbar_sprites sb ON sb.download_id = d.id
		 WHERE `+where+`
		 ORDER BY `+orderBy+` LIMIT ? OFFSET ?
	`, append(args, limit, offset)...)
	if err != nil {
		h.queryError(w, err, "database group downloads query failed")
		return
	}
	defer rows.Close()
	out.Files = make([]downloadsGroupRow, 0, limit)
	for rows.Next() {
		var row downloadsGroupRow
		var groupName, fileName, filePath, fileType, created sql.NullString
		var fileSize, pendingUntil, rescuedAt sql.NullInt64
		var duration sql.NullFloat64
		if err := rows.Scan(&row.ID, &row.GroupID, &groupName, &fileName, &filePath, &fileSize, &fileType, &created, &pendingUntil, &rescuedAt, &row.Pinned, &duration); err != nil {
			h.queryError(w, err, "database group downloads scan failed")
			return
		}
		if groupName.Valid {
			v := groupName.String
			row.GroupName = &v
		}
		if fileName.Valid {
			v := fileName.String
			row.FileName = &v
		}
		if filePath.Valid {
			v := filePath.String
			row.FilePath = &v
		}
		if fileSize.Valid {
			v := fileSize.Int64
			row.FileSize = &v
		}
		if fileType.Valid {
			v := fileType.String
			row.FileType = &v
		}
		if created.Valid {
			v := created.String
			row.CreatedAt = &v
		}
		if pendingUntil.Valid {
			v := pendingUntil.Int64
			row.PendingUntil = &v
		}
		if rescuedAt.Valid {
			v := rescuedAt.Int64
			row.RescuedAt = &v
		}
		if duration.Valid {
			v := duration.Float64
			row.DurationSec = &v
		}
		out.Files = append(out.Files, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database group downloads read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
