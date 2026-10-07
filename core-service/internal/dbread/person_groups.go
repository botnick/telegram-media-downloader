package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type personGroupsRequest struct {
	Limit int `json:"limit"`
}

type personGroupRow struct {
	ID              int64   `json:"id"`
	Label           *string `json:"label"`
	FaceCount       int64   `json:"face_count"`
	CoverDownloadID *int64  `json:"cover_download_id"`
}

type personGroupsResponse struct {
	Success bool             `json:"success"`
	Groups  []personGroupRow `json:"groups"`
}

// PersonGroups serves the compact local people grouping used by the gallery.
func (h *Handler) PersonGroups(w http.ResponseWriter, r *http.Request) {
	var req personGroupsRequest
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
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT p.id, p.label, p.face_count,
		       (SELECT f.download_id FROM faces f WHERE f.person_id = p.id LIMIT 1)
		  FROM people p
		 ORDER BY p.face_count DESC, p.id ASC
		 LIMIT ?`, limit)
	if err != nil {
		h.queryError(w, err, "database person groups query failed")
		return
	}
	defer rows.Close()
	out := make([]personGroupRow, 0, limit)
	for rows.Next() {
		var row personGroupRow
		var label sql.NullString
		var cover sql.NullInt64
		if err := rows.Scan(&row.ID, &label, &row.FaceCount, &cover); err != nil {
			h.queryError(w, err, "database person groups scan failed")
			return
		}
		if label.Valid {
			v := label.String
			row.Label = &v
		}
		if cover.Valid {
			v := cover.Int64
			row.CoverDownloadID = &v
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database person groups read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, personGroupsResponse{Success: true, Groups: out})
}
