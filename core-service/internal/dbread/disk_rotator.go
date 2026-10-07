package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type diskRotatorRequest struct {
	Limit int `json:"limit"`
}

type diskRotatorRow struct {
	ID       int64   `json:"id"`
	FileSize *int64  `json:"file_size"`
	FilePath *string `json:"file_path"`
}

type diskRotatorResponse struct {
	Rows []diskRotatorRow `json:"rows"`
}

// DiskRotatorCandidates serves the oldest unpinned catalog rows needed by the
// quota sweeper. The projection is intentionally small: Node still owns file
// deletion and SQLite writes, while the potentially large catalog read stays
// off Node's event loop.
func (h *Handler) DiskRotatorCandidates(w http.ResponseWriter, r *http.Request) {
	var req diskRotatorRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, file_size, file_path
		  FROM downloads
		 WHERE pinned = 0
		 ORDER BY created_at ASC, id ASC
		 LIMIT ?`, limit)
	if err != nil {
		h.queryError(w, err, "database disk rotator candidates query failed")
		return
	}
	defer rows.Close()
	out := diskRotatorResponse{Rows: make([]diskRotatorRow, 0, limit)}
	for rows.Next() {
		var row diskRotatorRow
		var fileSize sql.NullInt64
		var filePath sql.NullString
		if err := rows.Scan(&row.ID, &fileSize, &filePath); err != nil {
			h.queryError(w, err, "database disk rotator candidates scan failed")
			return
		}
		if fileSize.Valid {
			v := fileSize.Int64
			row.FileSize = &v
		}
		if filePath.Valid {
			v := filePath.String
			row.FilePath = &v
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database disk rotator candidates read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
