package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type peopleRequest struct {
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
	Sort   string `json:"sort"`
	Dir    string `json:"dir"`
}

type personRow struct {
	ID              int64    `json:"id"`
	Label           *string  `json:"label"`
	FaceCount       int64    `json:"face_count"`
	CreatedAt       int64    `json:"created_at"`
	UpdatedAt       int64    `json:"updated_at"`
	CoverDownloadID *int64   `json:"cover_download_id"`
	CoverFaceID     *int64   `json:"cover_face_id"`
	CoverX          *float64 `json:"cover_x"`
	CoverY          *float64 `json:"cover_y"`
	CoverW          *float64 `json:"cover_w"`
	CoverH          *float64 `json:"cover_h"`
	VideoFaceCount  int64    `json:"video_face_count"`
	AvgQuality      float64  `json:"avg_quality"`
}

type peopleResponse struct {
	People []personRow `json:"people"`
	Total  int64       `json:"total"`
}

// People serves POST /v1/db/people for the local face-cluster list.
// Federated peer merging and all face/person writes stay in Node.
func (h *Handler) People(w http.ResponseWriter, r *http.Request) {
	var req peopleRequest
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
	sortKey, dir := peopleSort(req.Sort, req.Dir)
	order := peopleOrder(sortKey, dir)
	qualityJoin := ""
	if sortKey == "avg_quality" {
		qualityJoin = `LEFT JOIN (SELECT person_id, AVG(quality_score) AS q FROM faces
			WHERE person_id IS NOT NULL AND quality_score IS NOT NULL
			GROUP BY person_id) aq ON aq.person_id = p.id`
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		WITH page AS (
			SELECT p.id, ROW_NUMBER() OVER (ORDER BY `+order+`) AS ord
			  FROM people p
			  `+qualityJoin+`
			 ORDER BY ord
			 LIMIT ? OFFSET ?
		)
		SELECT p.id, p.label, p.face_count, p.created_at, p.updated_at,
		       f.download_id AS cover_download_id,
		       f.id AS cover_face_id, f.x AS cover_x, f.y AS cover_y,
		       f.w AS cover_w, f.h AS cover_h,
		       COALESCE((SELECT COUNT(*) FROM faces fv
				JOIN downloads dv ON dv.id = fv.download_id
				WHERE fv.person_id = p.id AND dv.file_type = 'video'), 0) AS video_face_count,
		       COALESCE((SELECT AVG(f3.quality_score) FROM faces f3
				WHERE f3.person_id = p.id AND f3.quality_score IS NOT NULL), 0) AS avg_quality
		  FROM page
		  JOIN people p ON p.id = page.id
		  LEFT JOIN faces f ON f.id = (
			SELECT ff.id FROM faces ff
			 WHERE ff.person_id = p.id
			 ORDER BY COALESCE(ff.quality_score, 0) DESC, ff.w * ff.h DESC
			 LIMIT 1
		  )
		 ORDER BY page.ord
	`, limit, offset)
	if err != nil {
		h.queryError(w, err, "database people query failed")
		return
	}
	people, err := scanPeople(rows, limit)
	if err != nil {
		h.queryError(w, err, "database people read failed")
		return
	}
	var total int64
	if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM people").Scan(&total); err != nil {
		h.queryError(w, err, "database people count failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, peopleResponse{People: people, Total: total})
}

func peopleSort(sort, dir string) (string, string) {
	if sort != "face_count" && sort != "avg_quality" && sort != "name" {
		sort = "face_count"
	}
	if dir != "asc" && dir != "desc" {
		if sort == "name" {
			dir = "asc"
		} else {
			dir = "desc"
		}
	}
	return sort, dir
}

func peopleOrder(sort, dir string) string {
	if sort == "avg_quality" {
		if dir == "asc" {
			return "COALESCE(aq.q, 0) ASC, p.face_count DESC, p.id ASC"
		}
		return "COALESCE(aq.q, 0) DESC, p.face_count DESC, p.id ASC"
	}
	if sort == "name" {
		if dir == "asc" {
			return "(COALESCE(p.label, '') = '') DESC, p.label COLLATE NOCASE ASC, p.face_count DESC, p.id ASC"
		}
		return "(COALESCE(p.label, '') = '') ASC, p.label COLLATE NOCASE DESC, p.face_count DESC, p.id ASC"
	}
	if dir == "asc" {
		return "p.face_count ASC, p.id ASC"
	}
	return "p.face_count DESC, p.id ASC"
}

func scanPeople(rows *sql.Rows, capHint int) ([]personRow, error) {
	defer rows.Close()
	out := make([]personRow, 0, capHint)
	for rows.Next() {
		var row personRow
		var label sql.NullString
		var coverDownloadID, coverFaceID sql.NullInt64
		var coverX, coverY, coverW, coverH sql.NullFloat64
		if err := rows.Scan(&row.ID, &label, &row.FaceCount, &row.CreatedAt, &row.UpdatedAt, &coverDownloadID, &coverFaceID, &coverX, &coverY, &coverW, &coverH, &row.VideoFaceCount, &row.AvgQuality); err != nil {
			return nil, err
		}
		if label.Valid {
			v := label.String
			row.Label = &v
		}
		if coverDownloadID.Valid {
			v := coverDownloadID.Int64
			row.CoverDownloadID = &v
		}
		if coverFaceID.Valid {
			v := coverFaceID.Int64
			row.CoverFaceID = &v
		}
		if coverX.Valid {
			v := coverX.Float64
			row.CoverX = &v
		}
		if coverY.Valid {
			v := coverY.Float64
			row.CoverY = &v
		}
		if coverW.Valid {
			v := coverW.Float64
			row.CoverW = &v
		}
		if coverH.Valid {
			v := coverH.Float64
			row.CoverH = &v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
