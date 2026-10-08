package dbread

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type qualityCandidatesRequest struct {
	AfterID      int64 `json:"afterId"`
	Limit        int   `json:"limit"`
	IncludeTotal bool  `json:"includeTotal"`
}

type qualityFaceRow struct {
	ID int64   `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	W  float64 `json:"w"`
	H  float64 `json:"h"`
}

type qualityCandidateRow struct {
	ID       int64            `json:"id"`
	FilePath *string          `json:"file_path"`
	Faces    []qualityFaceRow `json:"faces"`
}

type qualityCandidatesResponse struct {
	Rows   []qualityCandidateRow `json:"rows"`
	Total  *int64                `json:"total"`
	NextID *int64                `json:"nextId"`
}

// QualityCandidates serves the bounded queue for AI quality backfill. The
// query-only pool joins each download's pending face boxes in one page so
// Node can spend its time on sidecar inference and writes instead of holding
// a synchronous SQLite cursor across every download.
func (h *Handler) QualityCandidates(w http.ResponseWriter, r *http.Request) {
	var req qualityCandidatesRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.AfterID < 0 {
		req.AfterID = 0
	}
	limit := req.Limit
	if limit < 1 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	out := qualityCandidatesResponse{Rows: make([]qualityCandidateRow, 0, limit)}
	if req.IncludeTotal {
		var total int64
		if err := db.QueryRowContext(
			r.Context(),
			"SELECT COUNT(DISTINCT download_id) FROM faces WHERE quality_score IS NULL",
		).Scan(&total); err != nil {
			h.queryError(w, err, "database quality candidate count failed")
			return
		}
		out.Total = &total
	}

	rows, err := db.QueryContext(r.Context(), `
		SELECT d.id, d.file_path
		  FROM downloads d
		 WHERE d.id > ?
		   AND EXISTS (
		       SELECT 1 FROM faces f
		        WHERE f.download_id = d.id
		          AND f.quality_score IS NULL
		   )
		 ORDER BY d.id ASC
		 LIMIT ?`, req.AfterID, limit)
	if err != nil {
		h.queryError(w, err, "database quality candidates query failed")
		return
	}
	ids := make([]int64, 0, limit)
	index := make(map[int64]int, limit)
	for rows.Next() {
		var id int64
		var filePath sql.NullString
		if err := rows.Scan(&id, &filePath); err != nil {
			rows.Close()
			h.queryError(w, err, "database quality candidates scan failed")
			return
		}
		index[id] = len(out.Rows)
		out.Rows = append(out.Rows, qualityCandidateRow{
			ID:       id,
			FilePath: nullableString(filePath),
			Faces:    make([]qualityFaceRow, 0, 2),
		})
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		h.queryError(w, err, "database quality candidates read failed")
		return
	}
	rows.Close()

	if len(ids) > 0 {
		placeholders := make([]byte, 0, len(ids)*2-1)
		for i := range ids {
			if i > 0 {
				placeholders = append(placeholders, ',')
			}
			placeholders = append(placeholders, '?')
		}
		args := make([]any, len(ids))
		for i, id := range ids {
			args[i] = id
		}
		faceRows, err := db.QueryContext(r.Context(), fmt.Sprintf(`
			SELECT download_id, id, x, y, w, h
			  FROM faces
			 WHERE quality_score IS NULL
			   AND download_id IN (%s)
			 ORDER BY download_id ASC, id ASC`, placeholders), args...)
		if err != nil {
			h.queryError(w, err, "database quality candidate faces query failed")
			return
		}
		for faceRows.Next() {
			var downloadID int64
			var face qualityFaceRow
			if err := faceRows.Scan(&downloadID, &face.ID, &face.X, &face.Y, &face.W, &face.H); err != nil {
				faceRows.Close()
				h.queryError(w, err, "database quality candidate faces scan failed")
				return
			}
			if row, ok := index[downloadID]; ok {
				out.Rows[row].Faces = append(out.Rows[row].Faces, face)
			}
		}
		if err := faceRows.Err(); err != nil {
			faceRows.Close()
			h.queryError(w, err, "database quality candidate faces read failed")
			return
		}
		faceRows.Close()
	}
	if len(out.Rows) == limit {
		next := out.Rows[len(out.Rows)-1].ID
		out.NextID = &next
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
