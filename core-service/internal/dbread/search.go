package dbread

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type searchRequest struct {
	Query       string `json:"query"`
	Limit       int    `json:"limit"`
	Offset      int    `json:"offset"`
	GroupID     string `json:"groupId"`
	Type        string `json:"type"`
	PinnedOnly  bool   `json:"pinnedOnly"`
	PinnedFirst bool   `json:"pinnedFirst"`
	Order       string `json:"order"`
}

type searchResponse struct {
	Files []allDownloadRow `json:"files"`
	Total int64            `json:"total"`
}

// Search serves POST /v1/db/downloads/search for the local gallery scope.
// It mirrors the Node FTS5-first, LIKE-fallback query. Peer federation stays
// in Node so one projection never mixes local and remote schemas.
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	var req searchRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		hash.WriteJSON(w, http.StatusOK, searchResponse{Files: []allDownloadRow{}, Total: 0})
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

	where, args := searchNarrowing(req)
	ftsQuery := makeFTSQuery(query)
	if ftsQuery != "" {
		if out, ok := h.searchFTS(r, db, ftsQuery, where, args, limit, offset, req); ok {
			hash.WriteJSON(w, http.StatusOK, out)
			return
		}
	}

	pattern := likePattern(query)
	likeWhere := "(d.file_name LIKE ? ESCAPE '\\' OR d.group_name LIKE ? ESCAPE '\\')"
	likeArgs := []any{pattern, pattern}
	if where != "" {
		likeWhere += " AND " + where
		likeArgs = append(likeArgs, args...)
	}
	order := "d.created_at DESC, d.id DESC"
	if req.PinnedFirst {
		order = "d.pinned DESC, d.created_at DESC, d.id DESC"
	}
	var out searchResponse
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads d WHERE "+likeWhere, likeArgs...).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database search count failed")
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT d.id, CAST(d.group_id AS TEXT), d.group_name, d.file_name, d.file_path,
		       d.file_size, d.file_type, CAST(d.created_at AS TEXT), d.pending_until,
		       d.rescued_at, d.pinned, sb.duration_sec
		  FROM downloads d
		  LEFT JOIN seekbar_sprites sb ON sb.download_id = d.id
		 WHERE `+likeWhere+`
		 ORDER BY `+order+` LIMIT ? OFFSET ?
	`, append(likeArgs, limit, offset)...)
	if err != nil {
		h.queryError(w, err, "database search query failed")
		return
	}
	out.Files, err = scanAllRows(rows, limit)
	if err != nil {
		h.queryError(w, err, "database search read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) searchFTS(r *http.Request, db *sql.DB, ftsQuery, where string, args []any, limit, offset int, req searchRequest) (searchResponse, bool) {
	ftsWhere := "downloads_fts MATCH ?"
	ftsArgs := []any{ftsQuery}
	if where != "" {
		ftsWhere += " AND " + where
		ftsArgs = append(ftsArgs, args...)
	}
	var out searchResponse
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM downloads d INNER JOIN downloads_fts fts ON fts.rowid = d.id WHERE "+ftsWhere, ftsArgs...).Scan(&out.Total); err != nil || out.Total == 0 {
		return searchResponse{}, false
	}
	order := "fts.rank"
	if req.Order == "newest" {
		order = "d.created_at DESC, d.id DESC"
		if req.PinnedFirst {
			order = "d.pinned DESC, d.created_at DESC, d.id DESC"
		}
	} else if req.PinnedFirst {
		order = "d.pinned DESC, fts.rank"
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT d.id, CAST(d.group_id AS TEXT), d.group_name, d.file_name, d.file_path,
		       d.file_size, d.file_type, CAST(d.created_at AS TEXT), d.pending_until,
		       d.rescued_at, d.pinned, sb.duration_sec
		  FROM downloads d
		  LEFT JOIN seekbar_sprites sb ON sb.download_id = d.id
		  INNER JOIN downloads_fts fts ON fts.rowid = d.id
		 WHERE `+ftsWhere+`
		 ORDER BY `+order+` LIMIT ? OFFSET ?
	`, append(ftsArgs, limit, offset)...)
	if err != nil {
		return searchResponse{}, false
	}
	out.Files, err = scanAllRows(rows, limit)
	if err != nil {
		return searchResponse{}, false
	}
	return out, true
}

func searchNarrowing(req searchRequest) (string, []any) {
	parts := make([]string, 0, 3)
	args := make([]any, 0, 3)
	if req.GroupID != "" {
		parts = append(parts, "d.group_id = ?")
		args = append(args, req.GroupID)
	}
	typeMap := map[string]string{"images": "photo", "videos": "video", "documents": "document", "audio": "audio"}
	if mapped, ok := typeMap[req.Type]; ok {
		parts = append(parts, "d.file_type = ?")
		args = append(args, mapped)
	}
	if req.PinnedOnly {
		parts = append(parts, "d.pinned = 1")
	}
	return strings.Join(parts, " AND "), args
}

func makeFTSQuery(raw string) string {
	raw = strings.NewReplacer("'", "", `"`, "").Replace(raw)
	parts := strings.Fields(raw)
	for i, part := range parts {
		parts[i] = fmt.Sprintf(`"%s"*`, part)
	}
	return strings.Join(parts, " ")
}

func likePattern(raw string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(raw) + "%"
}

func scanAllRows(rows *sql.Rows, capHint int) ([]allDownloadRow, error) {
	defer rows.Close()
	out := make([]allDownloadRow, 0, capHint)
	for rows.Next() {
		var row allDownloadRow
		var groupName, fileName, filePath, fileType, created sql.NullString
		var fileSize, pendingUntil, rescuedAt sql.NullInt64
		var duration sql.NullFloat64
		if err := rows.Scan(&row.ID, &row.GroupID, &groupName, &fileName, &filePath, &fileSize, &fileType, &created, &pendingUntil, &rescuedAt, &row.Pinned, &duration); err != nil {
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
		out = append(out, row)
	}
	return out, rows.Err()
}
