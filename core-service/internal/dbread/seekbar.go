package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type seekbarListRequest struct {
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

type seekbarListRow struct {
	ID          int64    `json:"id"`
	Bytes       *int64   `json:"bytes"`
	Frames      *int64   `json:"frames"`
	Cols        *int64   `json:"cols"`
	Rows        *int64   `json:"rows"`
	DurationSec *float64 `json:"duration_sec"`
	Format      *string  `json:"format"`
	GeneratedAt *int64   `json:"generated_at"`
	FileName    *string  `json:"file_name"`
}

type seekbarListResponse struct {
	Rows    []seekbarListRow `json:"rows"`
	Total   int64            `json:"total"`
	Limit   int              `json:"limit"`
	Offset  int              `json:"offset"`
	HasMore bool             `json:"hasMore"`
}

// SeekbarList serves the paginated sprite catalog without running SQLite
// queries on Node's event loop.
func (h *Handler) SeekbarList(w http.ResponseWriter, r *http.Request) {
	var req seekbarListRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
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
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}

	var out seekbarListResponse
	out.Limit = limit
	out.Offset = offset
	if err := db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM seekbar_sprites`).Scan(&out.Total); err != nil {
		h.queryError(w, err, "database seekbar count failed")
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT s.download_id, s.bytes, s.frames, s.cols, s."rows", s.duration_sec,
		       s.format, s.generated_at, d.file_name
		  FROM seekbar_sprites s
		  JOIN downloads d ON d.id = s.download_id
		 ORDER BY s.generated_at DESC
		 LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		h.queryError(w, err, "database seekbar query failed")
		return
	}
	defer rows.Close()
	out.Rows = make([]seekbarListRow, 0, limit)
	for rows.Next() {
		var row seekbarListRow
		var bytes, frames, cols, spriteRows, generated sql.NullInt64
		var duration sql.NullFloat64
		var format, fileName sql.NullString
		if err := rows.Scan(
			&row.ID,
			&bytes,
			&frames,
			&cols,
			&spriteRows,
			&duration,
			&format,
			&generated,
			&fileName,
		); err != nil {
			h.queryError(w, err, "database seekbar scan failed")
			return
		}
		if bytes.Valid {
			v := bytes.Int64
			row.Bytes = &v
		}
		if frames.Valid {
			v := frames.Int64
			row.Frames = &v
		}
		if cols.Valid {
			v := cols.Int64
			row.Cols = &v
		}
		if spriteRows.Valid {
			v := spriteRows.Int64
			row.Rows = &v
		}
		if duration.Valid {
			v := duration.Float64
			row.DurationSec = &v
		}
		if format.Valid {
			v := format.String
			row.Format = &v
		}
		if generated.Valid {
			v := generated.Int64
			row.GeneratedAt = &v
		}
		if fileName.Valid {
			v := fileName.String
			row.FileName = &v
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database seekbar read failed")
		return
	}
	out.HasMore = int64(offset+len(out.Rows)) < out.Total
	hash.WriteJSON(w, http.StatusOK, out)
}
