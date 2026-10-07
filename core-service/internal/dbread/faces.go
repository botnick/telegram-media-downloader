package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type facesByDownloadRequest struct {
	DownloadID int64 `json:"downloadId"`
}

type faceByDownloadRow struct {
	ID           int64    `json:"id"`
	X            float64  `json:"x"`
	Y            float64  `json:"y"`
	W            float64  `json:"w"`
	H            float64  `json:"h"`
	PersonID     *int64   `json:"person_id"`
	QualityScore *float64 `json:"quality_score"`
	PersonLabel  *string  `json:"person_label"`
}

type facesByDownloadResponse struct {
	Success    bool                `json:"success"`
	DownloadID int64               `json:"downloadId"`
	Faces      []faceByDownloadRow `json:"faces"`
}

// FacesByDownload serves the viewer's indexed face boxes for one download.
func (h *Handler) FacesByDownload(w http.ResponseWriter, r *http.Request) {
	var req facesByDownloadRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.DownloadID <= 0 {
		hash.WriteError(w, http.StatusBadRequest, "EINVAL", "invalid download id")
		return
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT f.id, f.x, f.y, f.w, f.h, f.person_id, f.quality_score,
		       p.label AS person_label
		  FROM faces f
		  LEFT JOIN people p ON p.id = f.person_id
		 WHERE f.download_id = ?
		 ORDER BY f.id ASC`, req.DownloadID)
	if err != nil {
		h.queryError(w, err, "database faces query failed")
		return
	}
	defer rows.Close()
	out := make([]faceByDownloadRow, 0, 16)
	for rows.Next() {
		var row faceByDownloadRow
		var personID sql.NullInt64
		var quality sql.NullFloat64
		var label sql.NullString
		if err := rows.Scan(&row.ID, &row.X, &row.Y, &row.W, &row.H, &personID, &quality, &label); err != nil {
			h.queryError(w, err, "database faces scan failed")
			return
		}
		if personID.Valid {
			v := personID.Int64
			row.PersonID = &v
		}
		if quality.Valid {
			v := quality.Float64
			row.QualityScore = &v
		}
		if label.Valid {
			v := label.String
			row.PersonLabel = &v
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database faces read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, facesByDownloadResponse{
		Success:    true,
		DownloadID: req.DownloadID,
		Faces:      out,
	})
}
