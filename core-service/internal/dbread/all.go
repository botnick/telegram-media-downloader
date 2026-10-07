package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type allDownloadsRequest struct {
	Limit       int    `json:"limit"`
	Offset      int    `json:"offset"`
	Type        string `json:"type"`
	PinnedOnly  bool   `json:"pinnedOnly"`
	PinnedFirst bool   `json:"pinnedFirst"`
}

type allDownloadRow struct {
	ID          int64    `json:"id"`
	GroupID     string   `json:"group_id"`
	GroupName   *string  `json:"group_name"`
	FileName    *string  `json:"file_name"`
	FilePath    *string  `json:"file_path"`
	FileSize    *int64   `json:"file_size"`
	FileType    *string  `json:"file_type"`
	CreatedAt   *string  `json:"created_at"`
	PendingTill *int64   `json:"pending_until"`
	RescuedAt   *int64   `json:"rescued_at"`
	Pinned      int64    `json:"pinned"`
	DurationSec *float64 `json:"duration_sec"`
}

type allDownloadsResponse struct {
	Files []allDownloadRow `json:"files"`
	Total int64            `json:"total"`
}

// AllDownloads serves POST /v1/db/downloads/all for the local gallery scope.
func (h *Handler) AllDownloads(w http.ResponseWriter, r *http.Request) {
	var req allDownloadsRequest
	if err := decodeJSON(w, r, &req); err != nil {
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
	where := "1 = 1"
	args := make([]any, 0, 2)
	typeMap := map[string]string{
		"images": "photo", "videos": "video", "documents": "document", "audio": "audio",
	}
	if fileType := typeMap[req.Type]; req.Type != "" && req.Type != "all" && fileType != "" {
		where += " AND d.file_type = ?"
		args = append(args, fileType)
	}
	if req.PinnedOnly {
		where += " AND d.pinned = 1"
	}
	orderBy := "d.created_at DESC, d.id DESC"
	if req.PinnedFirst {
		orderBy = "d.pinned DESC, d.created_at DESC, d.id DESC"
	}
	var out allDownloadsResponse
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads d WHERE "+where, args...).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database downloads count failed")
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
		h.queryError(w, err, "database downloads query failed")
		return
	}
	defer rows.Close()
	out.Files = make([]allDownloadRow, 0, limit)
	for rows.Next() {
		var row allDownloadRow
		var groupName, fileName, filePath, fileType, created sql.NullString
		var fileSize, pendingTill, rescuedAt sql.NullInt64
		var duration sql.NullFloat64
		if err := rows.Scan(&row.ID, &row.GroupID, &groupName, &fileName, &filePath, &fileSize, &fileType, &created, &pendingTill, &rescuedAt, &row.Pinned, &duration); err != nil {
			h.queryError(w, err, "database downloads scan failed")
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
		if pendingTill.Valid {
			v := pendingTill.Int64
			row.PendingTill = &v
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
		h.queryError(w, err, "database downloads read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
