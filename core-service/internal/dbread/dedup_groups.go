package dbread

import (
	"database/sql"
	"net/http"

	"github.com/botnick/telegram-media-downloader/core-service/internal/hash"
)

type dedupGroupsRequest struct {
	AfterHash string `json:"afterHash"`
	Limit     int    `json:"limit"`
}

type dedupGroupRow struct {
	Hash    string `json:"hash"`
	Count   int64  `json:"count"`
	MaxSize *int64 `json:"max_size"`
}

type dedupGroupsResponse struct {
	Rows []dedupGroupRow `json:"rows"`
}

// DedupGroups serves the keyset-paged hash grouping pass. Node remains in
// charge of ranking, progress and the deletion workflow.
func (h *Handler) DedupGroups(w http.ResponseWriter, r *http.Request) {
	var req dedupGroupsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return
	}
	limit := req.Limit
	if limit < 1 {
		limit = 5000
	}
	if limit > 5000 {
		limit = 5000
	}
	db, err := h.open()
	if err != nil {
		h.unavailable(w, err)
		return
	}
	rows, err := db.QueryContext(r.Context(), `
		SELECT file_hash, COUNT(*), MAX(file_size)
		  FROM downloads
		 WHERE file_hash IS NOT NULL
		   AND file_hash > ?
		 GROUP BY file_hash
		 ORDER BY file_hash ASC
		 LIMIT ?`, req.AfterHash, limit)
	if err != nil {
		h.queryError(w, err, "database dedup groups query failed")
		return
	}
	defer rows.Close()
	out := dedupGroupsResponse{Rows: make([]dedupGroupRow, 0, limit)}
	for rows.Next() {
		var row dedupGroupRow
		var maxSize sql.NullInt64
		if err := rows.Scan(&row.Hash, &row.Count, &maxSize); err != nil {
			h.queryError(w, err, "database dedup groups scan failed")
			return
		}
		row.MaxSize = nullableInt64(maxSize)
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		h.queryError(w, err, "database dedup groups read failed")
		return
	}
	hash.WriteJSON(w, http.StatusOK, out)
}
