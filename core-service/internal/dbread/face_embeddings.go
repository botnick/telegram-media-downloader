package dbread

import (
	"database/sql"
	"encoding/base64"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type faceEmbeddingsRequest struct {
	AfterID int64 `json:"afterId"`
	Limit   int   `json:"limit"`
}

type faceEmbeddingRow struct {
	ID           int64    `json:"id"`
	Embedding    string   `json:"embedding"`
	QualityScore *float64 `json:"quality_score"`
}

type faceEmbeddingsResponse struct {
	Rows   []faceEmbeddingRow `json:"rows"`
	Total  *int64             `json:"total"`
	NextID *int64             `json:"nextId"`
}

// FaceEmbeddings serves bounded keyset pages for the face clustering pass.
// SQLite reads and BLOB decoding happen on Go's query-only pool; Node keeps
// the clustering orchestration and all face/person writes.
func (h *Handler) FaceEmbeddings(w http.ResponseWriter, r *http.Request) {
	var req faceEmbeddingsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	if req.AfterID < 0 {
		req.AfterID = 0
	}
	limit := req.Limit
	if limit < 1 {
		limit = 500
	}
	if limit > 500 {
		limit = 500
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	out := faceEmbeddingsResponse{Rows: make([]faceEmbeddingRow, 0, limit)}
	if req.AfterID == 0 {
		var total int64
		if err := db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM faces").Scan(&total); err != nil {
			h.queryError(w, err, "database face embedding count failed")
			return
		}
		out.Total = &total
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT id, embedding, quality_score
		  FROM faces
		 WHERE id > ?
		 ORDER BY id ASC
		 LIMIT ?`, req.AfterID, limit)
	if err != nil {
		h.queryError(w, err, "database face embedding query failed")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var row faceEmbeddingRow
		var embedding []byte
		var quality sql.NullFloat64
		if err := rows.Scan(&row.ID, &embedding, &quality); err != nil {
			h.queryError(w, err, "database face embedding scan failed")
			return
		}
		row.Embedding = base64.StdEncoding.EncodeToString(embedding)
		if quality.Valid {
			v := quality.Float64
			row.QualityScore = &v
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database face embedding read failed")
		return
	}
	if len(out.Rows) == limit {
		next := out.Rows[len(out.Rows)-1].ID
		out.NextID = &next
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
