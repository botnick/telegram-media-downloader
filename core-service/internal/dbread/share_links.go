package dbread

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type shareLinksRequest struct {
	DownloadID     *int64 `json:"downloadId"`
	IncludeRevoked bool   `json:"includeRevoked"`
	Limit          int    `json:"limit"`
	Offset         int    `json:"offset"`
	Search         string `json:"search"`
}

type shareLinkRow struct {
	ID           int64   `json:"id"`
	DownloadID   int64   `json:"download_id"`
	CreatedAt    int64   `json:"created_at"`
	ExpiresAt    int64   `json:"expires_at"`
	RevokedAt    *int64  `json:"revoked_at"`
	Label        *string `json:"label"`
	LastAccessed *int64  `json:"last_accessed_at"`
	AccessCount  int64   `json:"access_count"`
	FileName     *string `json:"file_name"`
	FileType     *string `json:"file_type"`
	FileSize     *int64  `json:"file_size"`
	GroupID      string  `json:"group_id"`
	GroupName    *string `json:"group_name"`
}

type shareLinksResponse struct {
	Rows  []shareLinkRow `json:"rows"`
	Total int64          `json:"total"`
}

// ShareLinks serves POST /v1/db/share-links for the local admin list.
// Mutations and signed URL construction stay in Node; this endpoint only
// reads the joined projection and count from SQLite.
func (h *Handler) ShareLinks(w http.ResponseWriter, r *http.Request) {
	var req shareLinksRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 500
	} else if limit < 1 {
		limit = 1
	}
	if limit > 2000 {
		limit = 2000
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
	where := make([]string, 0, 3)
	args := make([]any, 0, 5)
	if req.DownloadID != nil {
		where = append(where, "s.download_id = ?")
		args = append(args, *req.DownloadID)
	}
	if !req.IncludeRevoked {
		where = append(where, "s.revoked_at IS NULL")
	}
	if search := strings.TrimSpace(req.Search); search != "" {
		where = append(where, "(s.label LIKE ? OR d.file_name LIKE ? OR d.group_name LIKE ?)")
		pattern := "%" + search + "%"
		args = append(args, pattern, pattern, pattern)
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " WHERE " + strings.Join(where, " AND ")
	}
	var out shareLinksResponse
	if err := db.QueryRowContext(r.Context(), `
		SELECT COUNT(*)
		  FROM share_links s
		  JOIN downloads d ON d.id = s.download_id`+whereSQL, args...).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database share links count failed")
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT s.id, s.download_id, s.created_at, s.expires_at, s.revoked_at,
		       s.label, s.last_accessed_at, s.access_count,
		       d.file_name, d.file_type, d.file_size, CAST(d.group_id AS TEXT), d.group_name
		  FROM share_links s
		  JOIN downloads d ON d.id = s.download_id`+whereSQL+`
		 ORDER BY s.created_at DESC
		 LIMIT ? OFFSET ?
	`, append(args, limit, offset)...)
	if err != nil {
		h.queryError(w, err, "database share links query failed")
		return
	}
	out.Rows, err = scanShareLinks(rows, limit)
	if err != nil {
		h.queryError(w, err, "database share links read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}

func scanShareLinks(rows *sql.Rows, capHint int) ([]shareLinkRow, error) {
	defer rows.Close()
	out := make([]shareLinkRow, 0, capHint)
	for rows.Next() {
		var row shareLinkRow
		var revokedAt, lastAccessed sql.NullInt64
		var label, fileName, fileType, groupName sql.NullString
		var fileSize sql.NullInt64
		if err := rows.Scan(
			&row.ID, &row.DownloadID, &row.CreatedAt, &row.ExpiresAt, &revokedAt,
			&label, &lastAccessed, &row.AccessCount, &fileName, &fileType, &fileSize,
			&row.GroupID, &groupName,
		); err != nil {
			return nil, err
		}
		if revokedAt.Valid {
			v := revokedAt.Int64
			row.RevokedAt = &v
		}
		if label.Valid {
			v := label.String
			row.Label = &v
		}
		if lastAccessed.Valid {
			v := lastAccessed.Int64
			row.LastAccessed = &v
		}
		if fileName.Valid {
			v := fileName.String
			row.FileName = &v
		}
		if fileType.Valid {
			v := fileType.String
			row.FileType = &v
		}
		if fileSize.Valid {
			v := fileSize.Int64
			row.FileSize = &v
		}
		if groupName.Valid {
			v := groupName.String
			row.GroupName = &v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
