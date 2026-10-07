package dbread

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type nsfwListRequest struct {
	Tier               string   `json:"tier"`
	FileTypes          []string `json:"fileTypes"`
	GroupID            string   `json:"groupId"`
	IncludeWhitelisted bool     `json:"includeWhitelisted"`
	Page               int      `json:"page"`
	Limit              int      `json:"limit"`
	FileKind           string   `json:"fileKind"`
}

type nsfwListRow struct {
	ID            int64    `json:"id"`
	GroupID       string   `json:"group_id"`
	GroupName     *string  `json:"group_name"`
	FileName      *string  `json:"file_name"`
	FilePath      *string  `json:"file_path"`
	FileType      *string  `json:"file_type"`
	FileSize      *int64   `json:"file_size"`
	CreatedAt     *string  `json:"created_at"`
	NsfwScore     *float64 `json:"nsfw_score"`
	NsfwCheckedAt *int64   `json:"nsfw_checked_at"`
	NsfwWhitelist int64    `json:"nsfw_whitelist"`
}

type nsfwListResponse struct {
	Rows       []nsfwListRow `json:"rows"`
	Total      int64         `json:"total"`
	Page       int           `json:"page"`
	TotalPages int           `json:"totalPages"`
}

// NsfwList serves POST /v1/db/nsfw-list for the paginated review table.
func (h *Handler) NsfwList(w http.ResponseWriter, r *http.Request) {
	var req nsfwListRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	types := req.FileTypes
	if len(types) == 0 {
		types = []string{"photo"}
	}
	where := []string{"d.file_type IN (" + strings.TrimSuffix(strings.Repeat("?,", len(types)), ",") + ")", "d.nsfw_score IS NOT NULL"}
	args := make([]any, 0, len(types)+5)
	for _, typ := range types {
		args = append(args, typ)
	}
	if req.FileKind != "" && req.FileKind != "all" {
		where = append(where, "d.file_type = ?")
		args = append(args, req.FileKind)
	}
	if tier, ok := nsfwTierBounds(req.Tier); ok {
		where = append(where, "d.nsfw_score >= ?", "d.nsfw_score < ?")
		args = append(args, tier.Min, tier.Max)
	}
	if !req.IncludeWhitelisted {
		where = append(where, "d.nsfw_whitelist = 0")
	}
	if req.GroupID != "" {
		where = append(where, "d.group_id = ?")
		args = append(args, req.GroupID)
	}
	page := req.Page
	if page < 1 {
		page = 1
	}
	limit := req.Limit
	if limit == 0 {
		limit = 50
	} else if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	offset := (page - 1) * limit
	whereSQL := strings.Join(where, " AND ")
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	var out nsfwListResponse
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads d WHERE "+whereSQL, args...).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database nsfw list count failed")
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT d.id, CAST(d.group_id AS TEXT), d.group_name, d.file_name, d.file_path,
		       d.file_type, d.file_size, CAST(d.created_at AS TEXT), d.nsfw_score,
		       d.nsfw_checked_at, d.nsfw_whitelist
		  FROM downloads d
		 WHERE `+whereSQL+`
		 ORDER BY d.nsfw_score ASC, d.id ASC
		 LIMIT ? OFFSET ?
	`, append(args, limit, offset)...)
	if err != nil {
		h.queryError(w, err, "database nsfw list query failed")
		return
	}
	out.Rows, err = scanNsfwList(rows, limit)
	if err != nil {
		h.queryError(w, err, "database nsfw list read failed")
		return
	}
	out.Page = page
	out.TotalPages = int((out.Total + int64(limit) - 1) / int64(limit))
	if out.TotalPages < 1 {
		out.TotalPages = 1
	}
	hash.WriteJSON(w, http.StatusOK, out)
}

func nsfwTierBounds(id string) (nsfwTier, bool) {
	for _, tier := range nsfwTierDefs {
		if tier.ID == id {
			return tier, true
		}
	}
	return nsfwTier{}, false
}

func scanNsfwList(rows *sql.Rows, capHint int) ([]nsfwListRow, error) {
	defer rows.Close()
	out := make([]nsfwListRow, 0, capHint)
	for rows.Next() {
		var row nsfwListRow
		var groupName, fileName, filePath, fileType, created sql.NullString
		var fileSize, checkedAt sql.NullInt64
		var score sql.NullFloat64
		if err := rows.Scan(&row.ID, &row.GroupID, &groupName, &fileName, &filePath, &fileType, &fileSize, &created, &score, &checkedAt, &row.NsfwWhitelist); err != nil {
			return nil, err
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
		if fileType.Valid {
			v := fileType.String
			row.FileType = &v
		}
		if fileSize.Valid {
			v := fileSize.Int64
			row.FileSize = &v
		}
		if created.Valid {
			v := created.String
			row.CreatedAt = &v
		}
		if score.Valid {
			v := score.Float64
			row.NsfwScore = &v
		}
		if checkedAt.Valid {
			v := checkedAt.Int64
			row.NsfwCheckedAt = &v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
